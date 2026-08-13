/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentPatchSet } from './patchSet.mjs';

test('upsert appends a new patch and preserves order of existing ones', () => {
	const set = new AgentPatchSet([{ name: 'a', content: '1' }]);
	set.upsert({ name: 'b', content: '2' });
	assert.deepEqual(set.list(), [{ name: 'a', content: '1' }, { name: 'b', content: '2' }]);
});

test('upsert replaces an existing patch in place, without reordering', () => {
	const set = new AgentPatchSet([{ name: 'a', content: '1' }, { name: 'b', content: '2' }]);
	set.upsert({ name: 'a', content: 'updated' });
	assert.deepEqual(set.list(), [{ name: 'a', content: 'updated' }, { name: 'b', content: '2' }]);
});

test('two sequential defineTool-style upserts keep both patches (the operations.md cumulative-set gotcha)', () => {
	const set = new AgentPatchSet();
	set.upsert({ name: 'agent-tool-first', content: 'first' });
	set.upsert({ name: 'agent-tool-second', content: 'second' });
	assert.deepEqual(set.list().map(p => p.name), ['agent-tool-first', 'agent-tool-second']);
});

test('remove drops only the named patch', () => {
	const set = new AgentPatchSet([{ name: 'a', content: '1' }, { name: 'b', content: '2' }]);
	set.remove('a');
	assert.deepEqual(set.list(), [{ name: 'b', content: '2' }]);
});

test('list() returns copies, so external mutation cannot corrupt internal state', () => {
	const set = new AgentPatchSet([{ name: 'a', content: '1' }]);
	const list = set.list();
	list[0].content = 'mutated externally';
	assert.equal(set.list()[0].content, '1');
});
