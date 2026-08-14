/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../log/common/log.js';
import {
	IHackerCodeAssistantMessage,
	IHackerCodeChatCompletionRequest,
	IHackerCodeChatEndpoint,
	IHackerCodeChatRelayService
} from '../common/hackerCodeChat.js';
import { listModels, streamChatCompletion } from '../node/hackerCodeChatCompletions.js';

interface IInFlightRequest {
	readonly text: Emitter<string>;
	readonly cancellation: CancellationTokenSource;
}

/**
 * Runs the workbench's model provider requests from the main process, where
 * they are not subject to the renderer's origin restrictions, and relays the
 * response back over IPC.
 *
 * Each request owns its own text emitter, so a window only receives the deltas
 * of the requests it started.
 */
export class HackerCodeChatRelayService extends Disposable implements IHackerCodeChatRelayService {

	declare readonly _serviceBrand: undefined;

	private readonly _requests = new Map<string, IInFlightRequest>();

	constructor(
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	onDynamicDidStreamChatText(requestId: string): Event<string> {
		return this._request(requestId).text.event;
	}

	async startChatCompletion(request: IHackerCodeChatCompletionRequest): Promise<IHackerCodeAssistantMessage> {
		const inFlight = this._request(request.requestId);
		try {
			return await streamChatCompletion(request.endpoint, {
				model: request.model,
				messages: request.messages,
				tools: request.tools,
				token: inFlight.cancellation.token,
				onEvent: event => {
					if (event.type === 'content') {
						inFlight.text.fire(event.delta);
					}
				}
			});
		} catch (error) {
			this.logService.warn(`[HackerCode] Chat completion against ${request.endpoint.baseUrl} failed: ${error}`);
			throw error;
		} finally {
			this._release(request.requestId);
		}
	}

	async cancelChatCompletion(requestId: string): Promise<void> {
		this._requests.get(requestId)?.cancellation.cancel();
	}

	async listModels(endpoint: IHackerCodeChatEndpoint): Promise<string[]> {
		return listModels(endpoint);
	}

	/**
	 * The request record, created on first use. Either the renderer's stream
	 * subscription or the request itself can arrive first; the channel preserves
	 * the order the renderer sent them in.
	 */
	private _request(requestId: string): IInFlightRequest {
		let request = this._requests.get(requestId);
		if (!request) {
			request = { text: new Emitter<string>(), cancellation: new CancellationTokenSource() };
			this._requests.set(requestId, request);
		}
		return request;
	}

	private _release(requestId: string): void {
		const request = this._requests.get(requestId);
		if (!request) {
			return;
		}
		this._requests.delete(requestId);
		request.text.dispose();
		request.cancellation.dispose();
	}

	override dispose(): void {
		for (const requestId of [...this._requests.keys()]) {
			this._requests.get(requestId)?.cancellation.cancel();
			this._release(requestId);
		}
		super.dispose();
	}
}
