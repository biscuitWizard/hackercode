/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { getErrorMessage, isCancellationError } from '../../../../base/common/errors.js';
import { IJsonRpcRequest, JsonRpcError, JsonRpcMessage, JsonRpcProtocol } from '../../../../base/common/jsonRpcProtocol.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { WebSocketClientTransport } from '../../../../platform/agentHost/browser/webSocketClientTransport.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import {
	HACKERCODE_CONTROL_REGISTER_RENDERER_METHOD,
	HackerCodeControlJsonRpcErrorCode,
	IHackerCodeJsonRpcNullErrorResponse,
	IHackerCodeRendererEvalParams,
	IHackerCodeRendererRefreshParams,
	parseHackerCodeJsonRpcMessage,
	validateHackerCodeControlRequest
} from '../../../../platform/hackercode/common/hackerCodeControlProtocol.js';
import { IHackerCodeControlService } from '../../../../platform/hackercode/common/hackerCode.js';
import { executeHackerCodeControlEval, executeHackerCodeControlRefresh } from '../../../../platform/hackercode/browser/hackerCodeControlEval.js';
import { IHackerCodeRuntime, isHackerCodeRuntimeEnabled } from '../../../../platform/hackercode/browser/hackerCodeRuntime.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';

const INITIAL_RECONNECT_DELAY = 1_000;
const MAX_RECONNECT_DELAY = 30_000;
const REGISTRATION_TIMEOUT = 10_000;

type HackerCodeGlobal = typeof globalThis & {
	$hackercode?: IHackerCodeRuntime;
};

export class HackerCodeEvalChannelContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.hackerCodeEvalChannel';

	private readonly connection = this._register(new MutableDisposable<DisposableStore>());
	private readonly reconnectScheduler = this._register(new RunOnceScheduler(() => void this.connect(), INITIAL_RECONNECT_DELAY));
	private reconnectAttempt = 0;
	private connecting = false;
	private disposed = false;

	constructor(
		@IHackerCodeControlService private readonly controlService: IHackerCodeControlService,
		@IEnvironmentService environmentService: IEnvironmentService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
		@INativeHostService private readonly nativeHostService: INativeHostService
	) {
		super();
		if (isHackerCodeRuntimeEnabled(environmentService)) {
			void this.connect();
		}
	}

	private async connect(): Promise<void> {
		if (this.disposed || this.connecting) {
			return;
		}
		this.connecting = true;

		try {
			const endpoint = await this.controlService.getControlEndpoint();
			if (this.disposed) {
				return;
			}
			if (!endpoint) {
				throw new Error('HackerCode control endpoint is unavailable');
			}

			const store = new DisposableStore();
			this.connection.value = store;
			const address = `${endpoint.protocol}://${endpoint.host}:${endpoint.port}/`;
			const transport = store.add(this.instantiationService.createInstance(
				WebSocketClientTransport,
				address,
				endpoint.authorizationToken,
				undefined
			));
			const protocol = store.add(new JsonRpcProtocol(
				message => sendControlMessage(transport, message),
				{ handleRequest: request => this.handleRequest(request) }
			));
			store.add(transport.onMessage(message => this.handleWireMessage(transport, protocol, message)));
			store.add(transport.onClose(() => {
				if (this.connection.value === store) {
					this.connection.clear();
					this.scheduleReconnect();
				}
			}));

			await transport.connect();
			await this.sendRegistration(protocol);
			if (this.disposed || this.connection.value !== store) {
				return;
			}
			this.reconnectAttempt = 0;
		} catch (error) {
			if (!this.disposed) {
				this.connection.clear();
				this.logService.warn(`[HackerCode] Eval channel connection failed: ${getErrorMessage(error)}`);
				this.scheduleReconnect();
			}
		} finally {
			this.connecting = false;
		}
	}

	private async sendRegistration(protocol: JsonRpcProtocol): Promise<void> {
		const cancellation = new CancellationTokenSource();
		const timeout = setTimeout(() => cancellation.cancel(), REGISTRATION_TIMEOUT);
		try {
			await protocol.sendRequest({
				method: HACKERCODE_CONTROL_REGISTER_RENDERER_METHOD,
				params: { windowId: this.nativeHostService.windowId }
			}, cancellation.token);
		} catch (error) {
			if (cancellation.token.isCancellationRequested || isCancellationError(error)) {
				throw new Error('HackerCode eval channel registration timed out');
			}
			throw error;
		} finally {
			clearTimeout(timeout);
			cancellation.dispose(true);
		}
	}

	private async handleRequest(request: IJsonRpcRequest): Promise<unknown> {
		const params = validateHackerCodeControlRequest(request, 'renderer');
		const runtime = (globalThis as HackerCodeGlobal).$hackercode;
		if (!runtime) {
			throw new JsonRpcError(HackerCodeControlJsonRpcErrorCode.InternalError, 'HackerCode runtime is unavailable');
		}

		switch (request.method) {
			case 'eval':
				return executeHackerCodeControlEval((params as IHackerCodeRendererEvalParams).source, runtime);
			case 'refresh': {
				const refreshParams = params as IHackerCodeRendererRefreshParams;
				return executeHackerCodeControlRefresh(runtime, refreshParams.mode, refreshParams.specifier);
			}
			default:
				throw new JsonRpcError(HackerCodeControlJsonRpcErrorCode.MethodNotFound, `Method not found: ${request.method}`);
		}
	}

	private handleWireMessage(transport: WebSocketClientTransport, protocol: JsonRpcProtocol, value: unknown): void {
		const parsed = parseHackerCodeJsonRpcMessage(value);
		switch (parsed.kind) {
			case 'invalid':
				sendControlMessage(transport, parsed.response);
				return;
			case 'notification':
				// Control mutations require correlated JSON-RPC requests.
				return;
			case 'request':
			case 'response':
				void protocol.handleMessage(parsed.message);
				return;
		}
	}

	private scheduleReconnect(): void {
		if (this.disposed) {
			return;
		}
		const delay = Math.min(INITIAL_RECONNECT_DELAY * (2 ** this.reconnectAttempt++), MAX_RECONNECT_DELAY);
		this.reconnectScheduler.schedule(delay);
	}

	override dispose(): void {
		this.disposed = true;
		super.dispose();
	}
}

function sendControlMessage(
	transport: WebSocketClientTransport,
	message: JsonRpcMessage | IHackerCodeJsonRpcNullErrorResponse
): void {
	transport.send(message);
}

registerWorkbenchContribution2(
	HackerCodeEvalChannelContribution.ID,
	HackerCodeEvalChannelContribution,
	WorkbenchPhase.AfterRestored
);
