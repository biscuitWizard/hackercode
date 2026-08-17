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
	extractReasoning,
	extractTextContent,
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
	| { readonly type: 'thinking'; readonly delta: string }
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
		const response = await fetchOrExplain(url, {
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
	const response = await fetchOrExplain(url, { method: 'GET', headers: buildHeaders(endpoint, false) });
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
	thinking: string;
	readonly toolCalls: Map<number, { id: string; type: 'function'; function: { name: string; arguments: string } }>;
	finishReason: string | null;
}

async function consumeStream(body: ReadableStream<Uint8Array>, onEvent: ((event: HackerCodeStreamEvent) => void) | undefined): Promise<IHackerCodeAssistantMessage> {
	const state: IAssemblyState = { content: '', thinking: '', toolCalls: new Map(), finishReason: null };
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
	const content = extractTextContent(delta.content);
	if (content) {
		state.content += content;
		onEvent?.({ type: 'content', delta: content });
	}
	const thinking = extractReasoning(delta);
	if (thinking) {
		state.thinking += thinking;
		onEvent?.({ type: 'thinking', delta: thinking });
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
	const argumentsDelta = toArgumentsText(toolCallDelta.function?.arguments);
	if (typeof name === 'string') {
		accumulated.function.name += name;
	}
	if (argumentsDelta !== undefined) {
		accumulated.function.arguments += argumentsDelta;
	}
	onEvent?.({
		type: 'tool_call_delta',
		index,
		...(typeof toolCallDelta.id === 'string' ? { id: toolCallDelta.id } : {}),
		...(typeof name === 'string' ? { name } : {}),
		...(argumentsDelta !== undefined ? { argumentsDelta } : {})
	});
}

/**
 * `arguments` is a string of JSON in the OpenAI protocol, but providers do send
 * the object itself. Both are accepted so that the difference never reaches the
 * caller as a parse failure.
 */
function toArgumentsText(value: unknown): string | undefined {
	if (typeof value === 'string') {
		return value;
	}
	if (value !== null && typeof value === 'object') {
		return JSON.stringify(value);
	}
	return undefined;
}

function finalizeAssembly(state: IAssemblyState): IHackerCodeAssistantMessage {
	const toolCalls = [...state.toolCalls.entries()]
		.sort(([a], [b]) => a - b)
		.map(([index, value]) => ({ ...value, id: value.id || syntheticToolCallId(index) }))
		.filter(toolCall => toolCall.function.name.length > 0);
	return { content: state.content, thinking: state.thinking, toolCalls, finishReason: state.finishReason };
}

/**
 * The id correlates a tool result back to its call. A provider that omits it
 * would otherwise leave an empty one on the follow-up request, which strict
 * endpoints reject, so the position in the response stands in for it.
 */
function syntheticToolCallId(index: number): string {
	return `call_${index}`;
}

function assembleFromNonStreamingJson(body: string, onEvent: ((event: HackerCodeStreamEvent) => void) | undefined): IHackerCodeAssistantMessage {
	let parsed: any;
	try {
		parsed = JSON.parse(body);
	} catch {
		throw new HackerCodeChatEndpointError('Non-streaming provider response was not valid JSON', undefined, body);
	}
	const message = parsed?.choices?.[0]?.message ?? {};
	const content = extractTextContent(message.content);
	if (content) {
		onEvent?.({ type: 'content', delta: content });
	}
	const thinking = extractReasoning(message);
	if (thinking) {
		onEvent?.({ type: 'thinking', delta: thinking });
	}
	const toolCalls: IHackerCodeWireToolCall[] = Array.isArray(message.tool_calls)
		? message.tool_calls.map((toolCall: any, index: number) => ({
			id: typeof toolCall.id === 'string' && toolCall.id ? toolCall.id : syntheticToolCallId(index),
			type: 'function' as const,
			function: {
				name: toolCall.function?.name ?? '',
				arguments: toArgumentsText(toolCall.function?.arguments) ?? ''
			}
		}))
		: [];
	const finishReason = typeof parsed?.choices?.[0]?.finish_reason === 'string' ? parsed.choices[0].finish_reason : null;
	return { content, thinking, toolCalls, finishReason };
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
 * Fetches, and says what was being reached when it could not be.
 *
 * A request that never gets a reply fails as "fetch failed", which names
 * neither the address nor the reason. What a user needs to know is that
 * nothing is listening at the URL they configured, and what that URL was —
 * that is the difference between a bug report and a typo they can fix.
 */
async function fetchOrExplain(url: string, init: RequestInit): Promise<Response> {
	try {
		return await fetch(url, init);
	} catch (error) {
		if (isAbortError(error)) {
			throw error;
		}
		throw new HackerCodeChatEndpointError(`Could not reach ${url}: ${describeNetworkFailure(error)}. Check the provider's base URL in Settings, and that the service is running.`);
	}
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === 'AbortError';
}

/** The cause carries the useful part; the message is usually "fetch failed". */
function describeNetworkFailure(error: unknown): string {
	const cause = (error as { cause?: unknown })?.cause;
	const code = (cause as { code?: string })?.code;
	switch (code) {
		case 'ECONNREFUSED': return 'nothing is listening there';
		case 'ENOTFOUND': return 'the host name does not resolve';
		case 'ETIMEDOUT': return 'the connection timed out';
		case 'ECONNRESET': return 'the connection was reset';
		case 'CERT_HAS_EXPIRED': return 'its TLS certificate has expired';
		case 'DEPTH_ZERO_SELF_SIGNED_CERT': return 'its TLS certificate is self-signed';
		default: break;
	}
	const detail = cause instanceof Error ? cause.message : error instanceof Error ? error.message : String(error);
	return detail || 'the connection failed';
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
