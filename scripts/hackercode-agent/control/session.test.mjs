/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';
import { HackerCodeControlClient } from '../../hackercode-control.mjs';
import { FakeControlSocket, respondOk } from '../testUtil.mjs';
import { HACKERCODE_LIMITS, HackerCodeControlSession, assertEvalSource, assertPatchSet } from './session.mjs';

function makeSession(handler) {
	const socket = new FakeControlSocket(handler);
	const client = new HackerCodeControlClient(socket, { timeoutMs: 200 });
	return { session: new HackerCodeControlSession(client), socket, client };
}

test('createRevision derives baseline and parentId from live state when omitted', async () => {
	const requests = [];
	const { session } = makeSession(request => {
		requests.push(request);
		if (request.method === 'getState') {
			return respondOk(request, {
				activeRevisionId: 'pristine',
				lastKnownGoodRevisionId: 'pristine',
				quarantinedRevisions: [],
				baseline: { current: 'a'.repeat(40), promotionAvailable: true }
			});
		}
		if (request.method === 'createRevision') {
			return respondOk(request, { id: 'b'.repeat(64), ...request.params });
		}
		throw new Error(`unexpected method ${request.method}`);
	});

	const revision = await session.createRevision({
		description: 'test',
		patches: [{ name: 'p', content: 'export default async function (ctx) {}\n' }]
	});

	assert.equal(revision.baseline, 'a'.repeat(40));
	assert.equal(revision.parentId, 'pristine');
	const createRequest = requests.find(r => r.method === 'createRevision');
	assert.equal(createRequest.params.baseline, 'a'.repeat(40));
	assert.equal(createRequest.params.parentId, 'pristine');
});

test('createRevision does not call getState when baseline and parentId are explicit', async () => {
	const methods = [];
	const { session } = makeSession(request => {
		methods.push(request.method);
		return respondOk(request, { id: 'c'.repeat(64), ...request.params });
	});

	await session.createRevision({
		baseline: 'd'.repeat(40),
		parentId: 'pristine',
		patches: [{ name: 'p', content: 'export default async function (ctx) {}\n' }]
	});

	assert.deepEqual(methods, ['createRevision']);
});

test('createRevision throws before any request when the patch set violates limits', async () => {
	const { session } = makeSession(() => { throw new Error('must not send a request'); });
	await assert.rejects(
		session.createRevision({ baseline: 'a'.repeat(40), parentId: 'pristine', patches: [] }),
		/at least one patch/
	);
	await assert.rejects(
		session.createRevision({
			baseline: 'a'.repeat(40),
			parentId: 'pristine',
			patches: Array.from({ length: HACKERCODE_LIMITS.maxPatchesPerRevision + 1 }, (_, i) => ({ name: `p${i}`, content: 'x' }))
		}),
		/at most 64 patches/
	);
});

test('assertPatchSet rejects an oversized patch', () => {
	assert.throws(
		() => assertPatchSet([{ name: 'big', content: 'x'.repeat(HACKERCODE_LIMITS.maxPatchBytes + 1) }]),
		/exceeding the 1048576-byte limit/
	);
});

test('assertEvalSource rejects source over the wire limit', () => {
	assert.throws(() => assertEvalSource('x'.repeat(HACKERCODE_LIMITS.maxEvalSourceBytes + 1)), /wire limit/);
	assert.throws(() => assertEvalSource(''), /non-empty/);
});

test('eval forwards windowId only when provided', async () => {
	const requests = [];
	const { session } = makeSession(request => {
		requests.push(request);
		return respondOk(request, 'ok');
	});
	await session.eval({ source: 'return 1;' });
	await session.eval({ source: 'return 1;', windowId: 7 });
	assert.equal('windowId' in requests[0].params, false);
	assert.equal(requests[1].params.windowId, 7);
});

test('refresh validates specifier/mode pairing before sending a request', () => {
	const { session } = makeSession(() => { throw new Error('must not send a request'); });
	assert.throws(() => session.refresh({ mode: 'module' }), /requires a specifier/);
	assert.throws(() => session.refresh({ mode: 'soft', specifier: 'vs/x.js' }), /only valid for module refresh/);
});
