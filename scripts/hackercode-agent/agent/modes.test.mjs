/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';
import { allowedToolNamesForMode, isToolAllowedInMode, isValidMode } from './modes.mjs';
import { TOOL_DEFINITIONS } from './tools.mjs';

test('ask mode allows only read-only tools', () => {
	const allowed = allowedToolNamesForMode('ask');
	assert.deepEqual(allowed, ['hc_get_state', 'hc_list_revisions', 'hc_list_services']);
	for (const mutating of ['hc_create_revision', 'hc_activate_revision', 'hc_promote', 'hc_safe_mode', 'hc_define_tool']) {
		assert.equal(isToolAllowedInMode('ask', mutating), false, mutating);
	}
});

test('plan mode adds read-only probing but still forbids every mutation', () => {
	assert.equal(isToolAllowedInMode('plan', 'hc_eval'), true);
	assert.equal(isToolAllowedInMode('plan', 'hc_draft_patch'), true);
	for (const mutating of ['hc_create_revision', 'hc_activate_revision', 'hc_refresh', 'hc_revert', 'hc_safe_mode', 'hc_define_tool', 'hc_promote']) {
		assert.equal(isToolAllowedInMode('plan', mutating), false, mutating);
	}
});

test('agent mode allows every defined tool, and every defined tool is reachable by some mode', () => {
	const agentAllowed = new Set(allowedToolNamesForMode('agent'));
	for (const definition of TOOL_DEFINITIONS) {
		assert.equal(agentAllowed.has(definition.function.name), true, `agent mode should allow ${definition.function.name}`);
	}
});

test('rejects an unknown mode rather than silently allowing nothing or everything', () => {
	assert.equal(isValidMode('agent'), true);
	assert.equal(isValidMode('root'), false);
	assert.throws(() => allowedToolNamesForMode('root'), /Unknown agent mode/);
});
