/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';
import { activateRevisionAndWaitHealthy } from './activation.mjs';

const REVISION_ID = 'a'.repeat(64);

function sequenceSession(states, { setRevisionResult } = {}) {
	let call = 0;
	return {
		setRevision: async () => setRevisionResult ?? {},
		getState: async () => {
			const next = states[Math.min(call, states.length - 1)];
			call++;
			if (next instanceof Error) {
				throw next;
			}
			return next;
		}
	};
}

test('resolves ok once active/lastKnownGood/no-bootAttempt with no verify supplied', async () => {
	const session = sequenceSession([
		{ activeRevisionId: REVISION_ID, lastKnownGoodRevisionId: REVISION_ID, quarantinedRevisions: [] }
	]);
	const result = await activateRevisionAndWaitHealthy(session, { revisionId: REVISION_ID, pollIntervalMs: 5, timeoutMs: 1000 });
	assert.equal(result.ok, true);
});

test('runs verify only after healthy and returns its result', async () => {
	const session = sequenceSession([
		{ activeRevisionId: REVISION_ID, lastKnownGoodRevisionId: 'pristine', quarantinedRevisions: [], bootAttempt: { revisionId: REVISION_ID } },
		{ activeRevisionId: REVISION_ID, lastKnownGoodRevisionId: REVISION_ID, quarantinedRevisions: [] }
	]);
	let verifyCalls = 0;
	const result = await activateRevisionAndWaitHealthy(session, {
		revisionId: REVISION_ID,
		pollIntervalMs: 5,
		timeoutMs: 1000,
		verify: async () => { verifyCalls++; return { probe: true }; }
	});
	assert.equal(result.ok, true);
	assert.deepEqual(result.verification, { probe: true });
	assert.equal(verifyCalls, 1);
});

test('reports verification-failed without retrying activation when verify throws', async () => {
	const session = sequenceSession([
		{ activeRevisionId: REVISION_ID, lastKnownGoodRevisionId: REVISION_ID, quarantinedRevisions: [] }
	]);
	const result = await activateRevisionAndWaitHealthy(session, {
		revisionId: REVISION_ID,
		pollIntervalMs: 5,
		timeoutMs: 1000,
		verify: async () => { throw new Error('probe failed'); }
	});
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'verification-failed');
	assert.match(result.detail, /probe failed/);
});

test('is terminal on quarantine and never keeps polling', async () => {
	let calls = 0;
	const session = {
		setRevision: async () => ({}),
		getState: async () => {
			calls++;
			return {
				activeRevisionId: 'pristine',
				lastKnownGoodRevisionId: 'pristine',
				quarantinedRevisions: [{ revisionId: REVISION_ID, quarantinedAt: new Date().toISOString(), reason: 'baseline mismatch' }]
			};
		}
	};
	const result = await activateRevisionAndWaitHealthy(session, { revisionId: REVISION_ID, pollIntervalMs: 5, timeoutMs: 1000 });
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'quarantined');
	assert.equal(result.detail, 'baseline mismatch');
	assert.equal(calls, 1, 'must not keep polling once quarantined');
});

test('treats renderer-unavailable errors as transient during reload and keeps polling', async () => {
	const rendererUnavailable = Object.assign(new Error('Renderer unavailable'), { code: -32001 });
	const session = sequenceSession([
		rendererUnavailable,
		{ activeRevisionId: REVISION_ID, lastKnownGoodRevisionId: REVISION_ID, quarantinedRevisions: [] }
	]);
	const result = await activateRevisionAndWaitHealthy(session, { revisionId: REVISION_ID, pollIntervalMs: 5, timeoutMs: 1000 });
	assert.equal(result.ok, true);
});

test('times out rather than hanging forever when never healthy', async () => {
	const session = sequenceSession([
		{ activeRevisionId: 'other', lastKnownGoodRevisionId: 'pristine', quarantinedRevisions: [] }
	]);
	const result = await activateRevisionAndWaitHealthy(session, { revisionId: REVISION_ID, pollIntervalMs: 5, timeoutMs: 40 });
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'timeout');
});

test('reports activation-failed when setRevision itself rejects', async () => {
	const session = {
		setRevision: async () => { throw new Error('boom'); },
		getState: async () => { throw new Error('must not be called'); }
	};
	const result = await activateRevisionAndWaitHealthy(session, { revisionId: REVISION_ID, pollIntervalMs: 5, timeoutMs: 1000 });
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'activation-failed');
	assert.match(result.detail, /boom/);
});
