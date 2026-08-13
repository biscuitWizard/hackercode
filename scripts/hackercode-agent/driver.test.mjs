/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createFakeSession } from './testUtil.mjs';
import { AgentDriver } from './driver.mjs';

function fakeUiServer() {
	const sent = [];
	return {
		sent,
		sendTo: (connectionId, message) => sent.push({ connectionId, message }),
		broadcast: message => sent.push({ connectionId: undefined, message })
	};
}

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

async function withTempUserDataDir(run) {
	const userDataDir = await mkdtemp(join(tmpdir(), 'hc-agent-driver-'));
	try {
		await run(userDataDir);
	} finally {
		await rm(userDataDir, { recursive: true, force: true });
	}
}

test('hello stores the connection windowId and replies with hello, controlState, and sessions', async () => {
	await withTempUserDataDir(async userDataDir => {
		const controlSession = createFakeSession();
		const uiServer = fakeUiServer();
		const driver = new AgentDriver({ controlSession, userDataDir, uiServer, providers: [] });

		await driver.handleMessage('conn-1', { kind: 'hello', windowId: 42 });

		assert.equal(driver.connectionWindowIds.get('conn-1'), 42);
		const kinds = uiServer.sent.map(entry => entry.message.kind);
		assert.deepEqual(kinds, ['hello', 'controlState', 'sessions']);
	});
});

test('createSession persists a session and broadcasts sessionState', async () => {
	await withTempUserDataDir(async userDataDir => {
		const controlSession = createFakeSession();
		const uiServer = fakeUiServer();
		const driver = new AgentDriver({ controlSession, userDataDir, uiServer, providers: [] });

		await driver.handleMessage('conn-1', { kind: 'createSession', title: 'My tab', mode: 'ask' });

		const sessionStateMessage = uiServer.sent.find(entry => entry.message.kind === 'sessionState');
		assert.ok(sessionStateMessage);
		assert.equal(sessionStateMessage.message.session.title, 'My tab');
		assert.equal(sessionStateMessage.message.session.mode, 'ask');
	});
});

test('sendTurn runs the agent loop, persists the transcript, and broadcasts the assistant reply', async t => {
	await withTempUserDataDir(async userDataDir => {
		const original = globalThis.fetch;
		globalThis.fetch = async () => fakeStreamingResponse(sseFromDeltas([{ content: 'hi there' }], 'stop'));
		t.after(() => { globalThis.fetch = original; });

		const controlSession = createFakeSession();
		const uiServer = fakeUiServer();
		const driver = new AgentDriver({
			controlSession,
			userDataDir,
			uiServer,
			providers: [{ id: 'p1', label: 'P1', baseUrl: 'https://example.test/v1', models: ['m1'] }]
		});

		await driver.handleMessage('conn-1', { kind: 'createSession', mode: 'ask', providerId: 'p1', model: 'm1' });
		const sessionId = uiServer.sent.find(entry => entry.message.kind === 'sessionState').message.sessionId;

		await driver.handleMessage('conn-1', { kind: 'sendTurn', sessionId, text: 'hello', mode: 'ask' });

		const finalState = uiServer.sent.filter(entry => entry.message.kind === 'sessionState').at(-1).message.session;
		assert.equal(finalState.messages.at(-1).role, 'assistant');
		assert.equal(finalState.messages.at(-1).content, 'hi there');
	});
});

test('hc_promote surfaces a confirmRequest and only calls promote once confirmResponse arrives', async t => {
	await withTempUserDataDir(async userDataDir => {
		const original = globalThis.fetch;
		let fetchCalls = 0;
		globalThis.fetch = async () => {
			fetchCalls++;
			// Only the first model turn requests hc_promote; once its tool
			// result comes back, the model finalizes so the turn does not
			// loop into a second, unanswered confirmation request.
			return fetchCalls === 1
				? fakeStreamingResponse(sseFromDeltas([
					{ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'hc_promote', arguments: '{"revisionId":"r1","windowId":5}' } }] }
				], 'tool_calls'))
				: fakeStreamingResponse(sseFromDeltas([{ content: 'promoted' }], 'stop'));
		};
		t.after(() => { globalThis.fetch = original; });

		const controlSession = createFakeSession();
		const uiServer = fakeUiServer();
		const driver = new AgentDriver({
			controlSession,
			userDataDir,
			uiServer,
			providers: [{ id: 'p1', label: 'P1', baseUrl: 'https://example.test/v1', models: ['m1'] }]
		});

		await driver.handleMessage('conn-1', { kind: 'createSession', mode: 'agent', providerId: 'p1', model: 'm1' });
		const sessionId = uiServer.sent.find(entry => entry.message.kind === 'sessionState').message.sessionId;

		const turnPromise = driver.handleSendTurn('conn-1', { sessionId, text: 'promote it', mode: 'agent' });

		// Wait for the confirmRequest to be broadcast before responding, since
		// hc_promote genuinely blocks on human confirmation.
		let confirmRequest;
		for (let attempt = 0; attempt < 50 && !confirmRequest; attempt++) {
			confirmRequest = uiServer.sent.find(entry => entry.message.kind === 'confirmRequest')?.message;
			if (!confirmRequest) {
				await new Promise(resolve => setTimeout(resolve, 10));
			}
		}
		assert.ok(confirmRequest, 'expected a confirmRequest to have been broadcast');
		assert.equal(confirmRequest.revisionId, 'r1');
		assert.equal(controlSession.calls.some(call => call.name === 'promote'), false, 'must not promote before confirmation');

		driver.handleConfirmResponse({ confirmId: confirmRequest.confirmId, confirmed: true });
		await turnPromise;

		assert.equal(controlSession.calls.some(call => call.name === 'promote'), true);
	});
});

test('cancelTurn aborts the in-flight request signal', async t => {
	await withTempUserDataDir(async userDataDir => {
		const original = globalThis.fetch;
		let capturedSignal;
		globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
			capturedSignal = init.signal;
			init.signal.addEventListener('abort', () => reject(new Error('aborted')));
		});
		t.after(() => { globalThis.fetch = original; });

		const controlSession = createFakeSession();
		const uiServer = fakeUiServer();
		const driver = new AgentDriver({
			controlSession,
			userDataDir,
			uiServer,
			providers: [{ id: 'p1', label: 'P1', baseUrl: 'https://example.test/v1', models: ['m1'] }]
		});

		await driver.handleMessage('conn-1', { kind: 'createSession', mode: 'ask', providerId: 'p1', model: 'm1' });
		const sessionId = uiServer.sent.find(entry => entry.message.kind === 'sessionState').message.sessionId;

		const turnPromise = driver.handleSendTurn('conn-1', { sessionId, text: 'hang', mode: 'ask' });
		while (!capturedSignal) {
			await new Promise(resolve => setTimeout(resolve, 5));
		}
		driver.handleCancelTurn({ sessionId });
		await turnPromise;

		assert.equal(capturedSignal.aborted, true);
		assert.equal(uiServer.sent.some(entry => entry.message.kind === 'error'), true);
	});
});
