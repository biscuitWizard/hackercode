/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
	createSessionState,
	deleteSession,
	listSessionSummaries,
	loadSession,
	saveSession
} from './sessions.mjs';

test('saves, loads, lists, and deletes sessions with restrictive file permissions', async () => {
	const userDataDir = await mkdtemp(join(tmpdir(), 'hc-agent-sessions-'));
	try {
		const state = createSessionState({ title: 'My session', mode: 'plan', providerId: 'openai', model: 'gpt' });
		await saveSession(userDataDir, state);

		const path = join(userDataDir, 'hackercode', 'agent', 'sessions', `${state.id}.json`);
		const mode = (await stat(path)).mode & 0o777;
		assert.equal(mode, 0o600);

		const loaded = await loadSession(userDataDir, state.id);
		assert.equal(loaded.title, 'My session');
		assert.equal(loaded.mode, 'plan');

		const summaries = await listSessionSummaries(userDataDir);
		assert.equal(summaries.length, 1);
		assert.equal(summaries[0].id, state.id);

		await deleteSession(userDataDir, state.id);
		assert.deepEqual(await listSessionSummaries(userDataDir), []);
	} finally {
		await rm(userDataDir, { recursive: true, force: true });
	}
});

test('listSessionSummaries returns an empty list rather than throwing when no sessions exist yet', async () => {
	const userDataDir = await mkdtemp(join(tmpdir(), 'hc-agent-sessions-empty-'));
	try {
		assert.deepEqual(await listSessionSummaries(userDataDir), []);
	} finally {
		await rm(userDataDir, { recursive: true, force: true });
	}
});
