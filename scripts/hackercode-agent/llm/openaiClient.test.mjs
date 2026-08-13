/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAiCompatibleError, listModels, streamChatCompletion } from './openaiClient.mjs';

function fakeStreamingResponse(sseChunks) {
	const encoder = new TextEncoder();
	let index = 0;
	return {
		ok: true,
		status: 200,
		statusText: 'OK',
		headers: { get: name => (name === 'content-type' ? 'text/event-stream' : null) },
		body: {
			getReader: () => ({
				read: async () => {
					if (index >= sseChunks.length) {
						return { done: true, value: undefined };
					}
					const value = encoder.encode(sseChunks[index++]);
					return { done: false, value };
				},
				releaseLock: () => { }
			})
		}
	};
}

function withFakeFetch(t, implementation) {
	const original = globalThis.fetch;
	globalThis.fetch = implementation;
	t.after(() => { globalThis.fetch = original; });
}

test('assembles streamed content deltas and reports them incrementally', async t => {
	const events = [];
	withFakeFetch(t, async () => fakeStreamingResponse([
		'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
		'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
		'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
		'data: [DONE]\n\n'
	]));

	const result = await streamChatCompletion({ baseUrl: 'https://example.test/v1' }, {
		model: 'test-model',
		messages: [{ role: 'user', content: 'hi' }],
		onEvent: event => events.push(event)
	});

	assert.equal(result.content, 'Hello');
	assert.equal(result.finishReason, 'stop');
	assert.deepEqual(events.filter(e => e.type === 'content').map(e => e.delta), ['Hel', 'lo']);
	assert.equal(events.at(-1).type, 'done');
});

test('assembles tool_call deltas across chunks, keyed by index', async t => {
	withFakeFetch(t, async () => fakeStreamingResponse([
		'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"hc_get_state","arguments":""}}]}}]}\n\n',
		'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"a\\":"}}]}}]}\n\n',
		'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]}}]}\n\n',
		'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
		'data: [DONE]\n\n'
	]));

	const result = await streamChatCompletion({ baseUrl: 'https://example.test/v1' }, {
		model: 'test-model',
		messages: []
	});

	assert.equal(result.toolCalls.length, 1);
	assert.equal(result.toolCalls[0].id, 'call_1');
	assert.equal(result.toolCalls[0].function.name, 'hc_get_state');
	assert.equal(result.toolCalls[0].function.arguments, '{"a":1}');
	assert.equal(result.finishReason, 'tool_calls');
});

test('falls back to parsing a single JSON body when the server ignores stream:true', async t => {
	withFakeFetch(t, async () => ({
		ok: true,
		status: 200,
		statusText: 'OK',
		headers: { get: name => (name === 'content-type' ? 'application/json' : null) },
		text: async () => JSON.stringify({
			choices: [{ message: { content: 'hi there' }, finish_reason: 'stop' }]
		})
	}));

	const result = await streamChatCompletion({ baseUrl: 'https://example.test/v1' }, { model: 'm', messages: [] });
	assert.equal(result.content, 'hi there');
	assert.equal(result.finishReason, 'stop');
});

test('throws OpenAiCompatibleError with status on a non-ok response', async t => {
	withFakeFetch(t, async () => ({
		ok: false,
		status: 401,
		statusText: 'Unauthorized',
		headers: { get: () => null },
		text: async () => 'invalid api key'
	}));

	await assert.rejects(
		streamChatCompletion({ baseUrl: 'https://example.test/v1', apiKey: 'bad' }, { model: 'm', messages: [] }),
		error => error instanceof OpenAiCompatibleError && error.status === 401
	);
});

test('sends an authorization header only when an apiKey is configured', async t => {
	let capturedHeaders;
	withFakeFetch(t, async (_url, init) => {
		capturedHeaders = init.headers;
		return fakeStreamingResponse(['data: [DONE]\n\n']);
	});
	await streamChatCompletion({ baseUrl: 'https://example.test/v1', apiKey: 'secret-key' }, { model: 'm', messages: [] });
	assert.equal(capturedHeaders.authorization, 'Bearer secret-key');

	await streamChatCompletion({ baseUrl: 'https://example.test/v1' }, { model: 'm', messages: [] });
	assert.equal('authorization' in capturedHeaders, false);
});

test('listModels returns a sorted list of model ids', async t => {
	withFakeFetch(t, async () => ({
		ok: true,
		status: 200,
		statusText: 'OK',
		headers: { get: () => null },
		json: async () => ({ data: [{ id: 'zeta' }, { id: 'alpha' }] })
	}));
	const models = await listModels({ baseUrl: 'https://example.test/v1' });
	assert.deepEqual(models, ['alpha', 'zeta']);
});
