/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Mode -> allowed tool name policy. This is the single source of truth the
 * loop consults before ever sending a tool schema to the model or executing
 * a requested tool call, so "ask" and "plan" are structurally incapable of
 * mutating anything, independent of what the model attempts.
 */

export const AGENT_MODES = Object.freeze(['ask', 'plan', 'agent']);

const READ_ONLY_TOOLS = Object.freeze(['hc_get_state', 'hc_list_revisions', 'hc_list_services']);
const PLAN_TOOLS = Object.freeze([...READ_ONLY_TOOLS, 'hc_eval', 'hc_draft_patch']);
const AGENT_TOOLS = Object.freeze([
	...PLAN_TOOLS,
	'hc_create_revision',
	'hc_activate_revision',
	'hc_refresh',
	'hc_revert',
	'hc_safe_mode',
	'hc_define_tool',
	'hc_promote'
]);

const TOOLS_BY_MODE = Object.freeze({
	ask: READ_ONLY_TOOLS,
	plan: PLAN_TOOLS,
	agent: AGENT_TOOLS
});

export function isValidMode(mode) {
	return AGENT_MODES.includes(mode);
}

export function allowedToolNamesForMode(mode) {
	const allowed = TOOLS_BY_MODE[mode];
	if (!allowed) {
		throw new Error(`Unknown agent mode: ${mode}`);
	}
	return allowed;
}

export function isToolAllowedInMode(mode, toolName) {
	return allowedToolNamesForMode(mode).includes(toolName);
}
