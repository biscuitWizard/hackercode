/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';
import { SSEParser } from './sseParser.mjs';

function toUint8Array(str) {
	return new TextEncoder().encode(str);
}

test('handles a basic data-only event', () => {
	const events = [];
	const parser = new SSEParser(event => events.push(event));
	parser.feed(toUint8Array('data: hello world\n\n'));
	assert.equal(events.length, 1);
	assert.equal(events[0].type, 'message');
	assert.equal(events[0].data, 'hello world');
});

test('joins multiple data fields with newlines', () => {
	const events = [];
	const parser = new SSEParser(event => events.push(event));
	parser.feed(toUint8Array('data: first line\ndata: second line\n\n'));
	assert.equal(events.length, 1);
	assert.equal(events[0].data, 'first line\nsecond line');
});

test('honors an explicit event type, including with CRLF', () => {
	const events = [];
	const parser = new SSEParser(event => events.push(event));
	parser.feed(toUint8Array('event: custom\r\ndata: hello world\r\n\r\n'));
	assert.equal(events.length, 1);
	assert.equal(events[0].type, 'custom');
	assert.equal(events[0].data, 'hello world');
});

test('reassembles events fed one byte at a time, across CR/LF/CRLF', () => {
	for (const lf of ['\n', '\r\n', '\r']) {
		const events = [];
		const parser = new SSEParser(event => events.push(event));
		const message = toUint8Array(`event: custom${lf}data: hello world${lf}${lf}event: custom2${lf}data: hello world2${lf}${lf}`);
		for (let i = 0; i < message.length; i++) {
			parser.feed(message.slice(i, i + 1));
		}
		assert.equal(events.length, 2, `line ending ${JSON.stringify(lf)}`);
		assert.deepEqual(events.map(e => e.data), ['hello world', 'hello world2']);
	}
});

test('ignores comment lines and dispatches only on a blank line', () => {
	const events = [];
	const parser = new SSEParser(event => events.push(event));
	parser.feed(toUint8Array(': this is a comment\ndata: real\n\n'));
	assert.equal(events.length, 1);
	assert.equal(events[0].data, 'real');
});

test('is directly usable to parse an OpenAI-style chunk stream, including [DONE]', () => {
	const events = [];
	const parser = new SSEParser(event => events.push(event));
	const chunks = [
		'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
		'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
		'data: [DONE]\n\n'
	];
	for (const chunk of chunks) {
		parser.feed(toUint8Array(chunk));
	}
	assert.equal(events.length, 3);
	assert.equal(JSON.parse(events[0].data).choices[0].delta.content, 'Hel');
	assert.equal(events[2].data, '[DONE]');
});
