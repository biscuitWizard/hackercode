/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { SSEParser } from '../../../base/common/sseParser.js';
import {
	HackerCodeWireMessage,
	IHackerCodeAssistantMessage,
	IHackerCodeChatEndpoint,
	IHackerCodeWireTool,
	IHackerCodeWireToolCall,
	normalizeChatBaseUrl
} from '../common/hackerCodeChat.js';

/**
 * A minimal streaming client for OpenAI-compatible `/chat/completions`
 * endpoints. This is the only module in the HackerCode agent stack that
 * performs outbound HTTP to a model provider; everything else deals in
 * already-assembled messages and tool calls.
 *
 * It runs in a node context (the main process) rather than the renderer,
 * because a browser context cannot reach these endpoints — see
 * `common/hackerCodeChat.ts`.
 *
 * `/chat/completions` and `/models` are appended to the configured `baseUrl`,
 * matching the OpenAI convention that many self-hosted and third-party servers
 * copy. See {@link normalizeChatBaseUrl} for what counts as a base URL.
 */

export type HackerCodeStreamEvent =
	| { readonly type: 'content'; readonly delta: string }
	| { readonly type: 'tool_call_delta'; readonly index: number; readonly id?: string; readonly name?: string; readonly argumentsDelta?: string };

export interface IHackerCodeChatRequest {
	readonly model: string;
	readonly messages: readonly HackerCodeWireMessage[];
	readonly tools?: readonly IHackerCodeWireTool[];
	readonly token: CancellationToken;
	readonly onEvent?: (event: HackerCodeStreamEvent) => void;
}

export class HackerCodeChatEndpointError extends Error {
	constructor(message: string, readonly status?: number, readonly body?: string) {
		super(message);
		this.name = 'HackerCodeChatEndpointError';
	}
}

/**
 * Streams one chat completion turn, invoking `onEvent` for each incremental
 * piece of model output, and resolves with the fully assembled message once
 * the stream ends.
 */
export async function streamChatCompletion(endpoint: IHackerCodeChatEndpoint, request: IHackerCodeChatRequest): Promise<IHackerCodeAssistantMessage> {
	const abortController = new AbortController();
	const cancelListener = request.token.onCancellationRequested(() => abortController.abort());
	const url = endpointUrl(endpoint.baseUrl, '/chat/completions');
	try {
		const response = await fetch(url, {
			method: 'POST',
			headers: buildHeaders(endpoint, true),
			body: JSON.stringify({
				model: request.model,
				messages: request.messages,
				...(request.tools && request.tools.length > 0 ? { tools: request.tools } : {}),
				stream: true
			}),
			signal: abortController.signal
		});

		if (!response.ok) {
			const body = await safeReadText(response);
			throw new HackerCodeChatEndpointError(
				`POST ${url} failed: ${response.status} ${response.statusText}${describeErrorBody(body)}`,
				response.status,
				body
			);
		}

		const contentType = response.headers.get('content-type') ?? '';
		if (!contentType.includes('text/event-stream') || !response.body) {
			// Some OpenAI-compatible servers ignore `stream: true`. Treat the body as
			// one JSON response rather than failing outright.
			return assembleFromNonStreamingJson(await safeReadText(response), request.onEvent);
		}

		return await consumeStream(response.body, request.onEvent);
	} finally {
		cancelListener.dispose();
	}
}

export async function listModels(endpoint: IHackerCodeChatEndpoint): Promise<string[]> {
	const url = endpointUrl(endpoint.baseUrl, '/models');
	const response = await fetch(url, { method: 'GET', headers: buildHeaders(endpoint, false) });
	if (!response.ok) {
		const body = await safeReadText(response);
		throw new HackerCodeChatEndpointError(
			`GET ${url} failed: ${response.status} ${response.statusText}${describeErrorBody(body)}`,
			response.status,
			body
		);
	}
	const body: unknown = await response.json();
	const entries: unknown[] = Array.isArray(body)
		? body
		: Array.isArray((body as { data?: unknown })?.data) ? (body as { data: unknown[] }).data : [];
	const ids = new Set<string>();
	for (const entry of entries) {
		const id = typeof entry === 'string' ? entry : (entry as { id?: unknown } | undefined)?.id;
		if (typeof id === 'string') {
			ids.add(id);
		}
	}
	return [...ids].sort();
}

interface IAssemblyState {
	content: string;
	readonly toolCalls: Map<number, { id: string; type: 'function'; function: { name: string; arguments: string } }>;
	finishReason: string | null;
}

async function consumeStream(body: ReadableStream<Uint8Array>, onEvent: ((event: HackerCodeStreamEvent) => void) | undefined): Promise<IHackerCodeAssistantMessage> {
	const state: IAssemblyState = { content: '', toolCalls: new Map(), finishReason: null };
	const parser = new SSEParser(event => handleSSEEvent(event.data, state, onEvent));

	const reader = body.getReader();
	try {
		for (; ;) {
			const chunk = await reader.read();
			if (chunk.value) {
				parser.feed(chunk.value);
			}
			if (chunk.done) {
				break;
			}
		}
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// The reader may already be released if the stream ended normally.
		}
	}

	return finalizeAssembly(state);
}

function handleSSEEvent(data: string, state: IAssemblyState, onEvent: ((event: HackerCodeStreamEvent) => void) | undefined): void {
	if (data === '[DONE]') {
		return;
	}
	let payload: any;
	try {
		payload = JSON.parse(data);
	} catch {
		return;
	}
	const choice = payload?.choices?.[0];
	if (!choice) {
		return;
	}
	if (typeof choice.finish_reason === 'string') {
		state.finishReason = choice.finish_reason;
	}
	const delta = choice.delta ?? {};
	if (typeof delta.content === 'string' && delta.content.length > 0) {
		state.content += delta.content;
		onEvent?.({ type: 'content', delta: delta.content });
	}
	if (Array.isArray(delta.tool_calls)) {
		for (const toolCallDelta of delta.tool_calls) {
			applyToolCallDelta(state, toolCallDelta, onEvent);
		}
	}
}

function applyToolCallDelta(state: IAssemblyState, toolCallDelta: any, onEvent: ((event: HackerCodeStreamEvent) => void) | undefined): void {
	const index = typeof toolCallDelta.index === 'number' ? toolCallDelta.index : 0;
	let accumulated = state.toolCalls.get(index);
	if (!accumulated) {
		accumulated = { id: '', type: 'function', function: { name: '', arguments: '' } };
		state.toolCalls.set(index, accumulated);
	}
	if (typeof toolCallDelta.id === 'string') {
		accumulated.id = toolCallDelta.id;
	}
	const name = toolCallDelta.function?.name;
	const argumentsDelta = toolCallDelta.function?.arguments;
	if (typeof name === 'string') {
		accumulated.function.name += name;
	}
	if (typeof argumentsDelta === 'string') {
		accumulated.function.arguments += argumentsDelta;
	}
	onEvent?.({
		type: 'tool_call_delta',
		index,
		...(typeof toolCallDelta.id === 'string' ? { id: toolCallDelta.id } : {}),
		...(typeof name === 'string' ? { name } : {}),
		...(typeof argumentsDelta === 'string' ? { argumentsDelta } : {})
	});
}

function finalizeAssembly(state: IAssemblyState): IHackerCodeAssistantMessage {
	const toolCalls = [...state.toolCalls.entries()]
		.sort(([a], [b]) => a - b)
		.map(([, value]) => value)
		.filter(toolCall => toolCall.function.name.length > 0);
	return { content: state.content, toolCalls, finishReason: state.finishReason };
}

function assembleFromNonStreamingJson(body: string, onEvent: ((event: HackerCodeStreamEvent) => void) | undefined): IHackerCodeAssistantMessage {
	let parsed: any;
	try {
		parsed = JSON.parse(body);
	} catch {
		throw new HackerCodeChatEndpointError('Non-streaming provider response was not valid JSON', undefined, body);
	}
	const message = parsed?.choices?.[0]?.message ?? {};
	const content = typeof message.content === 'string' ? message.content : '';
	if (content) {
		onEvent?.({ type: 'content', delta: content });
	}
	const toolCalls: IHackerCodeWireToolCall[] = Array.isArray(message.tool_calls)
		? message.tool_calls.map((toolCall: any) => ({
			id: typeof toolCall.id === 'string' ? toolCall.id : '',
			type: 'function' as const,
			function: {
				name: toolCall.function?.name ?? '',
				arguments: toolCall.function?.arguments ?? ''
			}
		}))
		: [];
	const finishReason = typeof parsed?.choices?.[0]?.finish_reason === 'string' ? parsed.choices[0].finish_reason : null;
	return { content, toolCalls, finishReason };
}

function buildHeaders(endpoint: IHackerCodeChatEndpoint, json: boolean): Record<string, string> {
	const headers: Record<string, string> = { accept: 'application/json, text/event-stream' };
	if (json) {
		headers['content-type'] = 'application/json';
	}
	if (endpoint.apiKey) {
		headers['authorization'] = `Bearer ${endpoint.apiKey}`;
	}
	return headers;
}

function endpointUrl(baseUrl: string, route: string): string {
	return `${normalizeChatBaseUrl(baseUrl)}/${route.replace(/^\/+/u, '')}`;
}

async function safeReadText(response: Response): Promise<string> {
	try {
		return await response.text();
	} catch {
		return '';
	}
}

/**
 * The provider's own explanation, for the error the user ends up reading. Only
 * the error message survives the trip to the renderer, so the body has to be
 * folded into it here.
 */
function describeErrorBody(body: string): string {
	const trimmed = body.trim();
	if (!trimmed) {
		return '';
	}
	let detail = trimmed;
	try {
		const parsed = JSON.parse(trimmed);
		const message = parsed?.error?.message ?? parsed?.message;
		if (typeof message === 'string' && message) {
			detail = message;
		}
	} catch {
		// Not JSON; the raw body is the best description available.
	}
	return ` - ${detail.length > 500 ? `${detail.slice(0, 500)}…` : detail}`;
}
