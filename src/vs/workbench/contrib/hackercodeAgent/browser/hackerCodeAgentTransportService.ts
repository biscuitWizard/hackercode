/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { getErrorMessage } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IHackerCodeAgentEndpointService } from '../common/hackerCodeAgentEndpoint.js';
import { HackerCodeAgentClientMessage, HackerCodeAgentServerMessage } from '../common/hackerCodeAgentProtocol.js';
import { HackerCodeAgentConnectionState, IHackerCodeAgentTransportService } from '../common/hackerCodeAgentTransport.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';

const INITIAL_RECONNECT_DELAY = 1_000;
const MAX_RECONNECT_DELAY = 30_000;

/**
 * Connects to the agent driver's loopback UI WebSocket server. Uses the
 * native browser `WebSocket` API directly (same approach as
 * `platform/agentHost/browser/webSocketClientTransport.ts` and HackerCode's
 * own eval channel) rather than that class, because this protocol is plain
 * JSON envelopes (`ui/protocol.mjs`), not JSON-RPC.
 */
export class HackerCodeAgentTransportService extends Disposable implements IHackerCodeAgentTransportService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeState = this._register(new Emitter<HackerCodeAgentConnectionState>());
	readonly onDidChangeState: Event<HackerCodeAgentConnectionState> = this._onDidChangeState.event;

	private readonly _onMessage = this._register(new Emitter<HackerCodeAgentServerMessage>());
	readonly onMessage: Event<HackerCodeAgentServerMessage> = this._onMessage.event;

	private readonly reconnectScheduler = this._register(new RunOnceScheduler(() => void this.doConnect(), INITIAL_RECONNECT_DELAY));

	private _state = HackerCodeAgentConnectionState.Disconnected;
	get state(): HackerCodeAgentConnectionState { return this._state; }

	private _lastError: string | undefined;
	get lastError(): string | undefined { return this._lastError; }

	private ws: WebSocket | undefined;
	private reconnectAttempt = 0;
	private connecting = false;
	private disposed = false;

	constructor(
		@IHackerCodeAgentEndpointService private readonly endpointService: IHackerCodeAgentEndpointService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@ILogService private readonly logService: ILogService
	) {
		super();
	}

	connect(): void {
		if (this._state !== HackerCodeAgentConnectionState.Disconnected) {
			return;
		}
		this.reconnectScheduler.cancel();
		void this.doConnect();
	}

	send(message: HackerCodeAgentClientMessage): boolean {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			return false;
		}
		try {
			this.ws.send(JSON.stringify(message));
			return true;
		} catch (error) {
			this.logService.warn(`[HackerCodeAgent] Failed to send UI message: ${getErrorMessage(error)}`);
			return false;
		}
	}

	private async doConnect(): Promise<void> {
		if (this.disposed || this.connecting) {
			return;
		}
		this.connecting = true;
		this.setState(HackerCodeAgentConnectionState.Connecting);

		try {
			const endpoint = await this.endpointService.getEndpoint();
			if (this.disposed) {
				return;
			}
			if (!endpoint) {
				throw new Error('HackerCode agent driver is not running');
			}

			await new Promise<void>((resolve, reject) => {
				const url = `${endpoint.protocol}://${endpoint.host}:${endpoint.port}/?tkn=${encodeURIComponent(endpoint.token)}`;
				const ws = new WebSocket(url);

				const onOpen = () => {
					cleanup();
					this.ws = ws;
					this._lastError = undefined;
					this.reconnectAttempt = 0;
					this.setState(HackerCodeAgentConnectionState.Connected);
					this.send({ kind: 'hello', windowId: this.nativeHostService.windowId });
					resolve();
				};
				const onError = () => {
					cleanup();
					reject(new Error('WebSocket connection to the agent driver failed'));
				};
				const onCloseBeforeOpen = () => {
					cleanup();
					reject(new Error('WebSocket connection to the agent driver closed before it opened'));
				};
				const cleanup = () => {
					ws.removeEventListener('open', onOpen);
					ws.removeEventListener('error', onError);
					ws.removeEventListener('close', onCloseBeforeOpen);
				};

				ws.addEventListener('open', onOpen);
				ws.addEventListener('error', onError);
				ws.addEventListener('close', onCloseBeforeOpen);

				ws.addEventListener('message', event => this.handleWireMessage(event));
				ws.addEventListener('close', () => this.handleClose(ws));
				ws.addEventListener('error', () => this.handleClose(ws));
			});
		} catch (error) {
			if (!this.disposed) {
				this._lastError = getErrorMessage(error);
				this.ws = undefined;
				this.setState(HackerCodeAgentConnectionState.Disconnected);
				this.scheduleReconnect();
			}
		} finally {
			this.connecting = false;
		}
	}

	private handleWireMessage(event: MessageEvent): void {
		if (typeof event.data !== 'string') {
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(event.data);
		} catch (error) {
			this.logService.warn(`[HackerCodeAgent] Malformed UI message: ${getErrorMessage(error)}`);
			return;
		}
		if (isServerMessage(parsed)) {
			this._onMessage.fire(parsed);
		}
	}

	private handleClose(ws: WebSocket): void {
		if (this.ws !== ws) {
			return;
		}
		this.ws = undefined;
		if (!this.disposed) {
			this.setState(HackerCodeAgentConnectionState.Disconnected);
			this.scheduleReconnect();
		}
	}

	private scheduleReconnect(): void {
		if (this.disposed) {
			return;
		}
		const delay = Math.min(INITIAL_RECONNECT_DELAY * (2 ** this.reconnectAttempt++), MAX_RECONNECT_DELAY);
		this.reconnectScheduler.schedule(delay);
	}

	private setState(state: HackerCodeAgentConnectionState): void {
		if (this._state === state) {
			return;
		}
		this._state = state;
		this._onDidChangeState.fire(state);
	}

	override dispose(): void {
		this.disposed = true;
		this.ws?.close();
		this.ws = undefined;
		super.dispose();
	}
}

function isServerMessage(value: unknown): value is HackerCodeAgentServerMessage {
	return typeof value === 'object' && value !== null && typeof (value as { kind?: unknown }).kind === 'string';
}

registerSingleton(IHackerCodeAgentTransportService, HackerCodeAgentTransportService, InstantiationType.Delayed);
