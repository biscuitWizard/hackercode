/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SSEParser } from './sseParser.mjs';

/**
 * A minimal streaming client for OpenAI-compatible `/chat/completions`
 * endpoints. This is the *only* module in the driver that performs outbound
 * HTTP to a model provider; everything else deals in already-assembled
 * messages and tool calls.
 *
 * A "provider" is `{ id, label, baseUrl, apiKey?, models }`. `baseUrl` is
 * used verbatim with `/chat/completions` and `/models` appended, matching
 * the OpenAI convention that many self-hosted and third-party servers copy.
 */

export class OpenAiCompatibleError extends Error {
	constructor(message, { status, body } = {}) {
		super(message);
		this.name = 'OpenAiCompatibleError';
		this.status = status;
		this.body = body;
	}
}

/**
 * Streams one chat completion turn, invoking `onEvent` for each incremental
 * piece of model output. Resolves with the fully assembled message once the
 * stream ends.
 *
 * @param {{ baseUrl: string, apiKey?: string }} provider
 * @param {{
 *   model: string,
 *   messages: unknown[],
 *   tools?: unknown[],
 *   signal?: AbortSignal,
 *   onEvent?: (event:
 *     | { type: 'content', delta: string }
 *     | { type: 'tool_call_delta', index: number, id?: string, name?: string, argumentsDelta?: string }
 *     | { type: 'done', finishReason: string | null }
 *   ) => void
 * }} request
 * @returns {Promise<{
 *   role: 'assistant',
 *   content: string,
 *   toolCalls: { id: string, type: 'function', function: { name: string, arguments: string } }[],
 *   finishReason: string | null
 * }>}
 */
export async function streamChatCompletion(provider, request) {
	const url = joinUrl(provider.baseUrl, '/chat/completions');
	const response = await fetch(url, {
		method: 'POST',
		headers: buildHeaders(provider),
		body: JSON.stringify({
			model: request.model,
			messages: request.messages,
			...(request.tools && request.tools.length > 0 ? { tools: request.tools } : {}),
			stream: true
		}),
		signal: request.signal
	});

	if (!response.ok) {
		const body = await safeReadText(response);
		throw new OpenAiCompatibleError(`Provider request failed: ${response.status} ${response.statusText}`, {
			status: response.status,
			body
		});
	}

	const contentType = response.headers.get('content-type') ?? '';
	if (!contentType.includes('text/event-stream') || !response.body) {
		// Some OpenAI-compatible servers ignore `stream: true` for certain
		// configurations. Fall back to treating the body as one JSON response
		// rather than failing outright.
		const body = await safeReadText(response);
		return assembleFromNonStreamingJson(body, request.onEvent);
	}

	return consumeStream(response.body, request.onEvent);
}

/**
 * @param {{ baseUrl: string, apiKey?: string }} provider
 * @returns {Promise<readonly string[]>}
 */
export async function listModels(provider) {
	const url = joinUrl(provider.baseUrl, '/models');
	const response = await fetch(url, { method: 'GET', headers: buildHeaders(provider, { json: false }) });
	if (!response.ok) {
		const body = await safeReadText(response);
		throw new OpenAiCompatibleError(`Failed to list models: ${response.status} ${response.statusText}`, {
			status: response.status,
			body
		});
	}
	const parsed = await response.json();
	const entries = Array.isArray(parsed?.data) ? parsed.data : [];
	return entries
		.map(entry => (typeof entry?.id === 'string' ? entry.id : undefined))
		.filter(id => id !== undefined)
		.sort();
}

async function consumeStream(body, onEvent) {
	const state = createAssemblyState();
	const parser = new SSEParser(event => handleSSEEvent(event, state, onEvent));

	const reader = body.getReader();
	try {
		let chunk;
		do {
			chunk = await reader.read();
			if (chunk.value) {
				parser.feed(chunk.value);
			}
		} while (!chunk.done);
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// Reader may already be released if the stream ended normally.
		}
	}

	onEvent?.({ type: 'done', finishReason: state.finishReason });
	return finalizeAssembly(state);
}

function createAssemblyState() {
	return {
		content: '',
		toolCalls: new Map(),
		finishReason: null
	};
}

function handleSSEEvent(event, state, onEvent) {
	if (event.data === '[DONE]') {
		return;
	}
	let payload;
	try {
		payload = JSON.parse(event.data);
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

function applyToolCallDelta(state, toolCallDelta, onEvent) {
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

function finalizeAssembly(state) {
	const toolCalls = [...state.toolCalls.entries()]
		.sort(([a], [b]) => a - b)
		.map(([, value]) => value)
		.filter(toolCall => toolCall.function.name.length > 0);
	return {
		role: 'assistant',
		content: state.content,
		toolCalls,
		finishReason: state.finishReason
	};
}

function assembleFromNonStreamingJson(body, onEvent) {
	let parsed;
	try {
		parsed = JSON.parse(body);
	} catch {
		throw new OpenAiCompatibleError('Non-streaming provider response was not valid JSON', { body });
	}
	const message = parsed?.choices?.[0]?.message ?? {};
	const content = typeof message.content === 'string' ? message.content : '';
	if (content) {
		onEvent?.({ type: 'content', delta: content });
	}
	const toolCalls = Array.isArray(message.tool_calls)
		? message.tool_calls.map(toolCall => ({
			id: typeof toolCall.id === 'string' ? toolCall.id : '',
			type: 'function',
			function: {
				name: toolCall.function?.name ?? '',
				arguments: toolCall.function?.arguments ?? ''
			}
		}))
		: [];
	const finishReason = typeof parsed?.choices?.[0]?.finish_reason === 'string' ? parsed.choices[0].finish_reason : null;
	onEvent?.({ type: 'done', finishReason });
	return { role: 'assistant', content, toolCalls, finishReason };
}

function buildHeaders(provider, { json = true } = {}) {
	const headers = {};
	if (json) {
		headers['content-type'] = 'application/json';
	}
	headers['accept'] = 'application/json, text/event-stream';
	if (provider.apiKey) {
		headers['authorization'] = `Bearer ${provider.apiKey}`;
	}
	return headers;
}

function joinUrl(baseUrl, path) {
	const trimmedBase = baseUrl.replace(/\/+$/u, '');
	const trimmedPath = path.replace(/^\/+/u, '');
	return `${trimmedBase}/${trimmedPath}`;
}

async function safeReadText(response) {
	try {
		return await response.text();
	} catch {
		return '';
	}
}
