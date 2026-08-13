/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeSession } from '../testUtil.mjs';
import { createSessionState } from '../sessions.mjs';
import { runAgentTurn } from './loop.mjs';

function fakeStreamingResponse(sseText) {
	const encoder = new TextEncoder();
	let sent = false;
	return {
		ok: true,
		status: 200,
		statusText: 'OK',
		headers: { get: name => (name === 'content-type' ? 'text/event-stream' : null) },
		body: {
			getReader: () => ({
				read: async () => {
					if (sent) {
						return { done: true, value: undefined };
					}
					sent = true;
					return { done: false, value: encoder.encode(sseText) };
				},
				releaseLock: () => { }
			})
		}
	};
}

function sseFromDeltas(deltas, finishReason) {
	const lines = deltas.map(delta => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
	lines.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n`);
	lines.push('data: [DONE]\n\n');
	return lines.join('');
}

function queueFakeFetch(t, responses) {
	let call = 0;
	const original = globalThis.fetch;
	globalThis.fetch = async () => {
		const response = responses[Math.min(call, responses.length - 1)];
		call++;
		return response;
	};
	t.after(() => { globalThis.fetch = original; });
	return () => call;
}

const PROVIDER = { id: 'test', baseUrl: 'https://example.test/v1' };
const NOOP_HANDLERS = {
	hc_get_state: async () => ({ ok: true }),
	hc_create_revision: async () => { throw new Error('must not be called: not permitted in this mode'); }
};

test('finalizes on the first step when the model calls no tools', async t => {
	queueFakeFetch(t, [fakeStreamingResponse(sseFromDeltas([{ content: 'hello' }], 'stop'))]);
	const events = [];
	const sessionState = createSessionState({ mode: 'ask' });
	const controlSession = createFakeSession();

	await runAgentTurn({
		sessionState,
		controlSession,
		provider: PROVIDER,
		model: 'm',
		mode: 'ask',
		toolHandlers: NOOP_HANDLERS,
		userText: 'hi',
		onEvent: e => events.push(e)
	});

	assert.equal(sessionState.messages.at(-1).role, 'assistant');
	assert.equal(sessionState.messages.at(-1).content, 'hello');
	assert.equal(events.some(e => e.type === 'turn_complete'), true);
});

test('executes an allowed tool call, appends the tool result, and continues to a final answer', async t => {
	const toolCallSse = sseFromDeltas([
		{ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'hc_get_state', arguments: '{}' } }] }
	], 'tool_calls');
	const finalSse = sseFromDeltas([{ content: 'done' }], 'stop');
	queueFakeFetch(t, [fakeStreamingResponse(toolCallSse), fakeStreamingResponse(finalSse)]);

	const events = [];
	const sessionState = createSessionState({ mode: 'agent' });
	const controlSession = createFakeSession();
	let handlerCalled = false;

	await runAgentTurn({
		sessionState,
		controlSession,
		provider: PROVIDER,
		model: 'm',
		mode: 'agent',
		toolHandlers: { hc_get_state: async () => { handlerCalled = true; return { activeRevisionId: 'pristine' }; } },
		userText: 'check state',
		onEvent: e => events.push(e)
	});

	assert.equal(handlerCalled, true);
	const toolMessage = sessionState.messages.find(m => m.role === 'tool');
	assert.ok(toolMessage);
	assert.equal(JSON.parse(toolMessage.content).activeRevisionId, 'pristine');
	assert.equal(sessionState.messages.at(-1).content, 'done');
	assert.equal(events.some(e => e.type === 'tool_call' && e.name === 'hc_get_state'), true);
	assert.equal(events.some(e => e.type === 'tool_result' && e.name === 'hc_get_state'), true);
});

test('refuses a mutating tool call in ask mode even if the model hallucinates it, without invoking the handler', async t => {
	const toolCallSse = sseFromDeltas([
		{ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'hc_create_revision', arguments: '{"patches":[]}' } }] }
	], 'tool_calls');
	const finalSse = sseFromDeltas([{ content: 'ok, I will not do that' }], 'stop');
	queueFakeFetch(t, [fakeStreamingResponse(toolCallSse), fakeStreamingResponse(finalSse)]);

	const sessionState = createSessionState({ mode: 'ask' });
	const controlSession = createFakeSession();

	await runAgentTurn({
		sessionState,
		controlSession,
		provider: PROVIDER,
		model: 'm',
		mode: 'ask',
		toolHandlers: NOOP_HANDLERS,
		userText: 'please create a revision'
	});

	const toolMessage = sessionState.messages.find(m => m.role === 'tool');
	const parsed = JSON.parse(toolMessage.content);
	assert.equal(parsed.ok, false);
	assert.match(parsed.error, /not permitted in "ask" mode/);
});

test('stops after maxSteps and reports step_budget_exhausted instead of looping forever', async t => {
	const alwaysToolCall = sseFromDeltas([
		{ tool_calls: [{ index: 0, id: 'call_x', function: { name: 'hc_get_state', arguments: '{}' } }] }
	], 'tool_calls');
	const original = globalThis.fetch;
	// A fresh response object per call: reusing one already-consumed
	// streaming body across repeated fetch() calls would make every step
	// after the first observe an already-exhausted reader.
	globalThis.fetch = async () => fakeStreamingResponse(alwaysToolCall);
	t.after(() => { globalThis.fetch = original; });

	const events = [];
	const sessionState = createSessionState({ mode: 'agent' });
	const controlSession = createFakeSession();

	await runAgentTurn({
		sessionState,
		controlSession,
		provider: PROVIDER,
		model: 'm',
		mode: 'agent',
		toolHandlers: { hc_get_state: async () => ({ ok: true }) },
		userText: 'loop forever',
		maxSteps: 3,
		onEvent: e => events.push(e)
	});

	assert.equal(events.some(e => e.type === 'step_budget_exhausted'), true);
	assert.equal(events.filter(e => e.type === 'tool_call').length, 3);
});
