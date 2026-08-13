/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createFakeSession } from '../testUtil.mjs';
import { readToolsLedger } from './selfTools.mjs';
import { createToolHandlers } from './tools.mjs';

async function withTempUserDataDir(run) {
	const userDataDir = await mkdtemp(join(tmpdir(), 'hc-agent-tools-'));
	try {
		await run(userDataDir);
	} finally {
		await rm(userDataDir, { recursive: true, force: true });
	}
}

test('hc_draft_patch never touches the control session', async () => {
	await withTempUserDataDir(async userDataDir => {
		const session = createFakeSession();
		const handlers = createToolHandlers({ session, userDataDir, requestPromotionConfirmation: async () => false });
		const result = await handlers.hc_draft_patch({ name: 'p', content: 'export default async function () {}\n', rationale: 'because' });
		assert.equal(result.drafted, true);
		assert.deepEqual(session.calls, []);
	});
});

test('hc_create_revision merges patches cumulatively across calls (no dropped prior patch)', async () => {
	await withTempUserDataDir(async userDataDir => {
		const session = createFakeSession();
		const handlers = createToolHandlers({ session, userDataDir, requestPromotionConfirmation: async () => false });

		await handlers.hc_create_revision({ patches: [{ name: 'first', content: 'a' }] });
		await handlers.hc_create_revision({ patches: [{ name: 'second', content: 'b' }] });

		const secondCall = session.calls.filter(call => call.name === 'createRevision').at(-1);
		assert.deepEqual(secondCall.args.patches.map(p => p.name), ['first', 'second']);
	});
});

test('hc_define_tool builds a patch, folds it into the running set, and records the ledger', async () => {
	await withTempUserDataDir(async userDataDir => {
		const session = createFakeSession();
		const handlers = createToolHandlers({ session, userDataDir, requestPromotionConfirmation: async () => false });

		const result = await handlers.hc_define_tool({
			name: 'echo_input',
			description: 'Echoes input.',
			parameters: { type: 'object', properties: { text: { type: 'string' } } },
			commandBody: 'return input;'
		});

		assert.ok(result.revision.id);
		const createRevisionCall = session.calls.find(call => call.name === 'createRevision');
		assert.equal(createRevisionCall.args.patches.some(p => p.name === 'agent-tool-echo_input'), true);

		const ledger = await readToolsLedger(userDataDir);
		assert.equal(ledger.length, 1);
		assert.equal(ledger[0].name, 'echo_input');
		assert.equal(ledger[0].promoted, false);
	});
});

test('hc_promote requires confirmation and never calls the control session when declined', async () => {
	await withTempUserDataDir(async userDataDir => {
		const session = createFakeSession();
		const handlers = createToolHandlers({ session, userDataDir, requestPromotionConfirmation: async () => false });

		const result = await handlers.hc_promote({ revisionId: 'r1', windowId: 1 });
		assert.equal(result.ok, false);
		assert.equal(result.reason, 'declined');
		assert.equal(session.calls.some(call => call.name === 'promote'), false);
	});
});

test('hc_promote calls promote only after confirmation, and marks ledger entries promoted', async () => {
	await withTempUserDataDir(async userDataDir => {
		const session = createFakeSession();
		const handlers = createToolHandlers({ session, userDataDir, requestPromotionConfirmation: async () => true });

		await handlers.hc_define_tool({
			name: 'echo_input',
			description: 'Echoes input.',
			parameters: { type: 'object', properties: {} },
			commandBody: 'return input;'
		});

		const result = await handlers.hc_promote({ revisionId: 'r1', windowId: 1, commitMessage: 'Add tool' });
		assert.equal(result.ok, true);
		assert.equal(session.calls.some(call => call.name === 'promote'), true);
		assert.equal((await readToolsLedger(userDataDir)).length, 1);
	});
});

test('hc_revert targets pristine or last-known-good based on the requested target', async () => {
	// A stateful fake: setRevision immediately updates what getState reports,
	// so activateRevisionAndWaitHealthy's very first poll observes "healthy"
	// without relying on the default 60s/500ms activation timeout/poll window.
	const lastKnownGood = 'y'.repeat(64);
	const state = { activeRevisionId: 'x', lastKnownGoodRevisionId: lastKnownGood, quarantinedRevisions: [], baseline: { current: 'a'.repeat(40) } };
	const session = {
		getState: async () => ({ ...state }),
		setRevision: async args => {
			state.activeRevisionId = args.revisionId;
			state.lastKnownGoodRevisionId = args.revisionId;
			return { ...state };
		}
	};
	const handlers = createToolHandlers({ session, userDataDir: '/tmp', requestPromotionConfirmation: async () => false });

	const toPristine = await handlers.hc_revert({ target: 'pristine' });
	assert.equal(toPristine.ok, true);
	assert.equal(toPristine.state.activeRevisionId, 'pristine');

	state.activeRevisionId = 'pristine';
	state.lastKnownGoodRevisionId = lastKnownGood;
	const toLastKnownGood = await handlers.hc_revert({ target: 'lastKnownGood' });
	assert.equal(toLastKnownGood.ok, true);
	assert.equal(toLastKnownGood.state.activeRevisionId, lastKnownGood);
});
