/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
	HackerCodeControlClient,
	HackerCodeRpcError,
	loadCreateRevisionRequest,
	parseArguments
} from './hackercode-control.mjs';

test('parses commands and control-file environment without treating source as code', () => {
	assert.deepEqual(
		parseArguments([
			'eval',
			'--source',
			'return `$(still source)`;',
			'--window-id=7',
			'--timeout-ms',
			'50'
		], { HACKERCODE_CONTROL_FILE: '/tmp/private-control.json' }),
		{
			command: 'eval',
			controlFile: '/tmp/private-control.json',
			timeoutMs: 50,
			windowId: 7,
			input: {
				kind: 'inline',
				value: 'return `$(still source)`;'
			}
		}
	);
	assert.throws(
		() => parseArguments(['eval', '--source', 'return 1;', '--stdin'], { HACKERCODE_CONTROL_FILE: '/tmp/control.json' }),
		/requires exactly one/
	);
});

test('requires an exact promotion confirmation', () => {
	const base = [
		'promote',
		'--control-file',
		'/tmp/control.json',
		'--revision',
		'a'.repeat(64),
		'--window-id',
		'7'
	];
	assert.throws(() => parseArguments(base), /requires --confirm-promote/);
	assert.throws(() => parseArguments([...base, '--confirm-promote', 'b'.repeat(64)]), /exactly repeat/);
	assert.deepEqual(parseArguments([...base, '--confirm-promote', 'a'.repeat(64)]), {
		command: 'promote',
		controlFile: '/tmp/control.json',
		timeoutMs: 35_000,
		revisionId: 'a'.repeat(64),
		windowId: 7,
		commitMessage: undefined
	});
});

test('loads patch contentFile relative to the request without evaluating it', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'hackercode-control-test-'));
	try {
		await writeFile(join(directory, 'patch.mjs'), 'export default () => "$(not executed)";\n');
		await writeFile(join(directory, 'request.json'), JSON.stringify({
			baseline: 'baseline',
			description: 'test',
			patches: [{
				name: 'file patch',
				contentFile: 'patch.mjs'
			}, {
				name: 'inline patch',
				content: 'export default () => undefined;\n'
			}]
		}));

		assert.deepEqual(await loadCreateRevisionRequest(join(directory, 'request.json')), {
			baseline: 'baseline',
			description: 'test',
			patches: [{
				name: 'file patch',
				content: 'export default () => "$(not executed)";\n'
			}, {
				name: 'inline patch',
				content: 'export default () => undefined;\n'
			}]
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('correlates out-of-order JSON-RPC responses', async () => {
	const socket = new FakeSocket();
	const client = new HackerCodeControlClient(socket, { timeoutMs: 100 });
	try {
		const first = client.request('getState');
		const second = client.request('listRevisions');
		const sent = socket.sent.map(value => JSON.parse(value));

		socket.emit('message', Object.create({
			data: JSON.stringify({ jsonrpc: '2.0', id: sent[1].id, result: ['second'] })
		}));
		socket.emit('message', { data: JSON.stringify({ jsonrpc: '2.0', id: sent[0].id, result: { first: true } }) });

		assert.deepEqual(await Promise.all([first, second]), [{ first: true }, ['second']]);
	} finally {
		client.close();
	}
});

test('surfaces JSON-RPC errors and request timeouts', async () => {
	const socket = new FakeSocket();
	const client = new HackerCodeControlClient(socket, { timeoutMs: 20 });
	try {
		const failed = client.request('safeMode', {});
		const request = JSON.parse(socket.sent[0]);
		socket.emit('message', {
			data: JSON.stringify({
				jsonrpc: '2.0',
				id: request.id,
				error: { code: -32602, message: 'Invalid method parameters' }
			})
		});
		await assert.rejects(failed, error => error instanceof HackerCodeRpcError
			&& error.code === -32602
			&& error.message === 'Invalid method parameters');
		await assert.rejects(client.request('getState'), /timed out: getState/);
	} finally {
		client.close();
	}
});

class FakeSocket {
	readyState = 1;
	sent = [];
	listeners = new Map();

	addEventListener(type, listener) {
		const listeners = this.listeners.get(type) ?? new Set();
		listeners.add(listener);
		this.listeners.set(type, listeners);
	}

	removeEventListener(type, listener) {
		this.listeners.get(type)?.delete(listener);
	}

	send(value) {
		this.sent.push(value);
	}

	close() {
		this.readyState = 3;
		this.emit('close', {});
	}

	emit(type, event) {
		for (const listener of this.listeners.get(type) ?? []) {
			listener(event);
		}
	}
}
