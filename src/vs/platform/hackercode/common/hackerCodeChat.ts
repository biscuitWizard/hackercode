/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

/**
 * The wire contract for talking to an OpenAI-compatible chat completions
 * endpoint, plus the relay service the workbench uses to reach one.
 *
 * The renderer cannot make these requests itself: its origin is
 * `vscode-file://vscode-app`, and no model provider sends the CORS headers a
 * browser context requires — least of all the local endpoints (Ollama, LM
 * Studio, llama.cpp, vLLM) that are the whole point of bringing your own key.
 * So the HTTP happens in the main process and the response is relayed back:
 * text arrives incrementally over {@link IHackerCodeChatRelayService.onDynamicDidStreamChatText},
 * and the assembled message resolves the `startChatCompletion` call.
 */

export interface IHackerCodeChatEndpoint {
	readonly baseUrl: string;
	readonly apiKey?: string;
}

/**
 * Routes a provider's docs tend to put on the URL people copy out of them.
 * `baseUrl` is the API root every route hangs off, but what a user has in
 * front of them is usually the full chat completions URL, and appending
 * `/chat/completions` to that produces a 404 with no hint as to why.
 */
const ROUTE_SUFFIXES = ['/chat/completions', '/completions', '/models'];

export function normalizeChatBaseUrl(baseUrl: string): string {
	let root = baseUrl.trim().replace(/\/+$/u, '');
	const lower = root.toLowerCase();
	for (const suffix of ROUTE_SUFFIXES) {
		if (lower.endsWith(suffix)) {
			root = root.slice(0, root.length - suffix.length).replace(/\/+$/u, '');
			break;
		}
	}
	return root;
}

export interface IHackerCodeWireToolCall {
	id: string;
	readonly type: 'function';
	readonly function: { name: string; arguments: string };
}

export type HackerCodeWireMessage =
	| { readonly role: 'system' | 'user'; readonly content: string }
	| { readonly role: 'assistant'; readonly content: string; readonly tool_calls?: readonly IHackerCodeWireToolCall[] }
	| { readonly role: 'tool'; readonly tool_call_id: string; readonly content: string };

export interface IHackerCodeWireTool {
	readonly type: 'function';
	readonly function: {
		readonly name: string;
		readonly description: string;
		readonly parameters: object;
	};
}

/** The fully assembled model turn, once its stream has ended. */
export interface IHackerCodeAssistantMessage {
	readonly content: string;
	readonly toolCalls: readonly IHackerCodeWireToolCall[];
	readonly finishReason: string | null;
}

export interface IHackerCodeChatCompletionRequest {
	/**
	 * Correlates this request with its text stream. The renderer subscribes to
	 * the matching dynamic event before starting the request.
	 */
	readonly requestId: string;
	readonly endpoint: IHackerCodeChatEndpoint;
	readonly model: string;
	readonly messages: readonly HackerCodeWireMessage[];
	readonly tools?: readonly IHackerCodeWireTool[];
}

export const HACKERCODE_CHAT_RELAY_CHANNEL = 'hackercodeChatRelay';

export const IHackerCodeChatRelayService = createDecorator<IHackerCodeChatRelayService>('hackerCodeChatRelayService');

export interface IHackerCodeChatRelayService {

	readonly _serviceBrand: undefined;

	/**
	 * The text deltas of one in-flight request, in order. Subscribe before
	 * calling {@link startChatCompletion} with the same `requestId`.
	 */
	onDynamicDidStreamChatText(requestId: string): Event<string>;

	/**
	 * Streams one chat completion turn, resolving with the assembled message.
	 * Rejects when the endpoint is unreachable or answers with an error status.
	 */
	startChatCompletion(request: IHackerCodeChatCompletionRequest): Promise<IHackerCodeAssistantMessage>;

	/** Aborts an in-flight request. A no-op once the request has finished. */
	cancelChatCompletion(requestId: string): Promise<void>;

	/** The model ids the endpoint advertises at `/models`. */
	listModels(endpoint: IHackerCodeChatEndpoint): Promise<string[]>;
}
