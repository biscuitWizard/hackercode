/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import { readAgentEndpointMetadata, startAgentUiServer } from './server.mjs';

async function withTempUserDataDir(run) {
	const userDataDir = await mkdtemp(join(tmpdir(), 'hc-agent-ui-'));
	try {
		await run(userDataDir);
	} finally {
		await rm(userDataDir, { recursive: true, force: true });
	}
}

function connect(port, token) {
	return new WebSocket(`ws://127.0.0.1:${port}/?tkn=${encodeURIComponent(token)}`);
}

function waitForOpenOrClose(socket) {
	return new Promise(resolve => {
		socket.once('open', () => resolve('open'));
		socket.once('close', () => resolve('close'));
		socket.once('error', () => resolve('error'));
	});
}

test('writes agent.json with 0600 permissions and a shape distinct from control.json semantics', async () => {
	await withTempUserDataDir(async userDataDir => {
		const uiServer = await startAgentUiServer({ userDataDir, onMessage: () => { } });
		try {
			const path = join(userDataDir, 'hackercode', 'agent.json');
			const mode = (await stat(path)).mode & 0o777;
			assert.equal(mode, 0o600);

			const metadata = await readAgentEndpointMetadata(userDataDir);
			assert.equal(metadata.protocol, 'ws');
			assert.equal(metadata.host, '127.0.0.1');
			assert.equal(metadata.port, uiServer.port);
			assert.equal(metadata.token, uiServer.token);
			assert.notEqual(metadata.token, undefined);
		} finally {
			await uiServer.dispose();
		}
	});
});

test('accepts a connection with the correct token and rejects one with an incorrect token', async () => {
	await withTempUserDataDir(async userDataDir => {
		const uiServer = await startAgentUiServer({ userDataDir, onMessage: () => { } });
		try {
			const good = connect(uiServer.port, uiServer.token);
			assert.equal(await waitForOpenOrClose(good), 'open');
			good.close();

			const bad = connect(uiServer.port, 'not-the-real-token');
			const outcome = await waitForOpenOrClose(bad);
			assert.notEqual(outcome, 'open');
		} finally {
			await uiServer.dispose();
		}
	});
});

test('routes validated client messages to onMessage and delivers sendTo/broadcast replies', async () => {
	await withTempUserDataDir(async userDataDir => {
		const received = [];
		const uiServer = await startAgentUiServer({
			userDataDir,
			onMessage: (connectionId, message) => {
				received.push(message);
				uiServer.sendTo(connectionId, { kind: 'hello', protocolVersion: 1 });
			}
		});
		try {
			const client = connect(uiServer.port, uiServer.token);
			await waitForOpenOrClose(client);
			const replyPromise = new Promise(resolve => client.once('message', data => resolve(JSON.parse(data.toString()))));
			client.send(JSON.stringify({ kind: 'hello', windowId: 7 }));
			const reply = await replyPromise;
			assert.deepEqual(reply, { kind: 'hello', protocolVersion: 1 });
			assert.deepEqual(received, [{ kind: 'hello', windowId: 7 }]);
			client.close();
		} finally {
			await uiServer.dispose();
		}
	});
});

test('rejects a malformed client message with a server-side error, without invoking onMessage', async () => {
	await withTempUserDataDir(async userDataDir => {
		let onMessageCalls = 0;
		const uiServer = await startAgentUiServer({ userDataDir, onMessage: () => { onMessageCalls++; } });
		try {
			const client = connect(uiServer.port, uiServer.token);
			await waitForOpenOrClose(client);
			const replyPromise = new Promise(resolve => client.once('message', data => resolve(JSON.parse(data.toString()))));
			client.send(JSON.stringify({ kind: 'not-a-real-kind' }));
			const reply = await replyPromise;
			assert.equal(reply.kind, 'error');
			assert.equal(onMessageCalls, 0);
			client.close();
		} finally {
			await uiServer.dispose();
		}
	});
});

test('dispose() removes agent.json and no test in this file ever logs the token', async () => {
	await withTempUserDataDir(async userDataDir => {
		const uiServer = await startAgentUiServer({ userDataDir, onMessage: () => { } });
		const path = join(userDataDir, 'hackercode', 'agent.json');
		await stat(path);
		await uiServer.dispose();
		await assert.rejects(readFile(path, 'utf8'), /ENOENT/);
	});
});
