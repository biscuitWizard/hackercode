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

/**
 * Pulls the visible reply out of a `content` field. OpenAI sends a string;
 * some compatible servers (and the Responses-shaped deltas OpenRouter uses
 * for Claude) send an array of parts, or null when the model is only calling
 * tools. All three have to become the same string or the user sees a turn
 * that ran tools and then said nothing.
 */
export function extractTextContent(value: unknown): string {
	if (typeof value === 'string') {
		return value;
	}
	if (!Array.isArray(value)) {
		return '';
	}
	const parts: string[] = [];
	for (const part of value) {
		if (typeof part === 'string') {
			parts.push(part);
			continue;
		}
		if (!part || typeof part !== 'object') {
			continue;
		}
		const record = part as { type?: unknown; text?: unknown };
		if ((record.type === 'text' || record.type === 'output_text') && typeof record.text === 'string') {
			parts.push(record.text);
		}
	}
	return parts.join('');
}

/**
 * Reasoning tokens. Claude via OpenRouter puts the entire narration here and
 * leaves `content` empty whenever it is about to call a tool. Dropping it is
 * how a 19-step turn ends with "Finished with 19 steps" and no reply.
 */
export function extractReasoning(value: unknown): string {
	if (!value || typeof value !== 'object') {
		return '';
	}
	const record = value as { reasoning?: unknown; reasoning_content?: unknown; thinking?: unknown };
	return extractTextContent(record.reasoning)
		|| extractTextContent(record.reasoning_content)
		|| extractTextContent(record.thinking);
}

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

/**
 * A user turn is plain text until it carries an image, at which point the
 * OpenAI shape requires the parts to be spelled out. Images travel as data
 * URLs because that is the one form every compatible endpoint accepts without
 * somewhere to host the file.
 */
export type HackerCodeWireContentPart =
	| { readonly type: 'text'; readonly text: string }
	| { readonly type: 'image_url'; readonly image_url: { readonly url: string } };

export type HackerCodeWireMessage =
	| { readonly role: 'system'; readonly content: string }
	| { readonly role: 'user'; readonly content: string | readonly HackerCodeWireContentPart[] }
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
	/** Reasoning tokens some providers (OpenRouter + Claude) send instead of `content`. */
	readonly thinking: string;
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
	 * Reasoning deltas of one in-flight request. Same subscribe-before-start
	 * rule as {@link onDynamicDidStreamChatText}.
	 */
	onDynamicDidStreamChatThinking(requestId: string): Event<string>;

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
