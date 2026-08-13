/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { activateRevisionAndWaitHealthy } from '../control/activation.mjs';
import { AgentPatchSet } from './patchSet.mjs';
import {
	buildSelfAuthoredToolPatch,
	recordToolInLedger,
	markToolsPromoted
} from './selfTools.mjs';

/**
 * OpenAI-compatible function-calling tool schemas. Every tool name here maps
 * 1:1 to a handler in {@link createToolHandlers}; the mode policy in
 * ./modes.mjs decides which of these are ever offered to the model for a
 * given turn.
 */
export const TOOL_DEFINITIONS = Object.freeze([
	toolDefinition('hc_get_state', 'Reads the current HackerCode control state: active revision, last-known-good, quarantines, boot attempt, and source baseline.', {
		type: 'object',
		properties: {},
		additionalProperties: false
	}),
	toolDefinition('hc_list_revisions', 'Lists all known HackerCode revisions (pristine plus every stored revision manifest).', {
		type: 'object',
		properties: {},
		additionalProperties: false
	}),
	toolDefinition('hc_list_services', 'Lists the names of every DI service currently resolvable in the renderer runtime. Use this to discover what hc_eval or a patch can call through ctx.getService.', {
		type: 'object',
		properties: {
			windowId: { type: 'integer', description: 'Optional target workbench window id; defaults to the focused window.' }
		},
		additionalProperties: false
	}),
	toolDefinition('hc_eval', 'Evaluates the body of an async function in the renderer runtime for read-only inspection or a one-shot probe. Has full renderer privilege; never use it to perform a mutation you want to keep -- encode accepted changes as a patch instead.', {
		type: 'object',
		properties: {
			source: { type: 'string', description: 'The body of an async function. May use runtime, instantiationService, getService, and refresh.' },
			windowId: { type: 'integer', description: 'Optional target workbench window id; defaults to the focused window.' }
		},
		required: ['source'],
		additionalProperties: false
	}),
	toolDefinition('hc_draft_patch', 'Records a proposed patch (name, ESM content, and rationale) in the transcript for human review. Performs no control-plane call; available in Plan mode.', {
		type: 'object',
		properties: {
			name: { type: 'string', description: 'A stable, human-readable patch name.' },
			content: { type: 'string', description: 'ESM source: export default async function (ctx) { ... }.' },
			rationale: { type: 'string', description: 'Why this patch is proposed and what it changes.' }
		},
		required: ['name', 'content'],
		additionalProperties: false
	}),
	toolDefinition('hc_create_revision', 'Creates (without activating) a revision. The given patches are merged by name into this session\'s running patch set, and the FULL merged set is submitted, because HackerCode does not recursively load parent revisions.', {
		type: 'object',
		properties: {
			description: { type: 'string' },
			patches: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						name: { type: 'string' },
						content: { type: 'string', description: 'ESM source: export default async function (ctx) { ... }.' }
					},
					required: ['name', 'content'],
					additionalProperties: false
				}
			}
		},
		required: ['patches'],
		additionalProperties: false
	}),
	toolDefinition('hc_activate_revision', 'Activates a revision and waits for a healthy boot (bootAttempt cleared, lastKnownGood matches, not quarantined) before optionally running a verification eval. Never retries the same revision on failure.', {
		type: 'object',
		properties: {
			revisionId: { type: 'string' },
			windowId: { type: 'integer' },
			mode: { type: 'string', enum: ['normal', 'recover'] },
			verifyEvalSource: { type: 'string', description: 'Optional async-function body run once the revision looks healthy, to confirm the intended behavior.' },
			timeoutMs: { type: 'integer', description: 'Health-poll deadline in milliseconds. Defaults to 60000.' }
		},
		required: ['revisionId'],
		additionalProperties: false
	}),
	toolDefinition('hc_refresh', 'Refreshes applied patches in the renderer: soft (reapply patch factories), module (a specifier already loaded through ctx.import), or hard (monitored window reload of the active revision).', {
		type: 'object',
		properties: {
			mode: { type: 'string', enum: ['soft', 'module', 'hard'] },
			specifier: { type: 'string', description: 'Required only for module mode.' },
			windowId: { type: 'integer' }
		},
		required: ['mode'],
		additionalProperties: false
	}),
	toolDefinition('hc_revert', 'Falls back to last-known-good or pristine and waits for healthy activation. Use this instead of hc_activate_revision when recovering.', {
		type: 'object',
		properties: {
			target: { type: 'string', enum: ['lastKnownGood', 'pristine'] },
			windowId: { type: 'integer' }
		},
		required: ['target'],
		additionalProperties: false
	}),
	toolDefinition('hc_safe_mode', 'Requests main-owned emergency safe mode: quarantines/falls back, sets skipPromoted, and reloads. Use when the renderer or endpoint is unhealthy and hc_revert is not enough.', {
		type: 'object',
		properties: {
			reason: { type: 'string' },
			windowId: { type: 'integer' }
		},
		additionalProperties: false
	}),
	toolDefinition('hc_define_tool', 'Authors a brand-new tool for yourself as a reversible patch: it exports a small JSON-schema descriptor plus a ctx.registerCommand factory. Creates (but does not activate) a revision containing it, merged with this session\'s existing patch set.', {
		type: 'object',
		properties: {
			name: { type: 'string', description: 'Tool name, matching ^[a-z][a-z0-9_]{0,63}$.' },
			description: { type: 'string' },
			parameters: { type: 'object', description: 'JSON Schema for the new tool\'s input.' },
			commandBody: { type: 'string', description: 'Body of an async function (input) receiving the tool call arguments, run via ctx.registerCommand.' }
		},
		required: ['name', 'description', 'parameters', 'commandBody'],
		additionalProperties: false
	}),
	toolDefinition('hc_promote', 'Requests promotion of the active revision into the source checkout as a real git commit. Always requires separate human confirmation; never happens automatically.', {
		type: 'object',
		properties: {
			revisionId: { type: 'string' },
			windowId: { type: 'integer' },
			commitMessage: { type: 'string' }
		},
		required: ['revisionId', 'windowId'],
		additionalProperties: false
	})
]);

function toolDefinition(name, description, parameters) {
	return { type: 'function', function: { name, description, parameters } };
}

/**
 * Builds the tool-name -> handler map for one agent session.
 *
 * @param {{
 *   session: import('../control/session.mjs').HackerCodeControlSession,
 *   userDataDir: string,
 *   patchSet?: AgentPatchSet,
 *   requestPromotionConfirmation: (details: {
 *     revisionId: string, windowId: number, commitMessage: string | undefined, baseline: string | undefined
 *   }) => Promise<boolean>
 * }} options
 */
export function createToolHandlers(options) {
	const { session, userDataDir, requestPromotionConfirmation } = options;
	const patchSet = options.patchSet ?? new AgentPatchSet();

	return {
		patchSet,

		async hc_get_state() {
			return session.getState();
		},

		async hc_list_revisions() {
			return session.listRevisions();
		},

		async hc_list_services(args = {}) {
			return session.eval({ source: 'return runtime.listServices();', windowId: args.windowId });
		},

		async hc_eval(args) {
			return session.eval({ source: args.source, windowId: args.windowId });
		},

		async hc_draft_patch(args) {
			// Intentionally makes no control-plane call: Plan mode may describe
			// a change but must not be able to mutate anything.
			return {
				drafted: true,
				name: args.name,
				content: args.content,
				rationale: args.rationale ?? null,
				note: 'Recorded for review. Switch to Agent mode and call hc_create_revision to actually submit it.'
			};
		},

		async hc_create_revision(args) {
			patchSet.upsertMany(args.patches);
			return session.createRevision({ description: args.description, patches: patchSet.list() });
		},

		async hc_activate_revision(args) {
			return activateRevisionAndWaitHealthy(session, {
				revisionId: args.revisionId,
				windowId: args.windowId,
				mode: args.mode,
				timeoutMs: args.timeoutMs,
				verify: args.verifyEvalSource
					? verifySession => verifySession.eval({ source: args.verifyEvalSource, windowId: args.windowId })
					: undefined
			});
		},

		async hc_refresh(args) {
			return session.refresh({ mode: args.mode, specifier: args.specifier, windowId: args.windowId });
		},

		async hc_revert(args) {
			const state = await session.getState();
			const revisionId = args.target === 'pristine' ? 'pristine' : state.lastKnownGoodRevisionId;
			return activateRevisionAndWaitHealthy(session, {
				revisionId,
				windowId: args.windowId,
				mode: 'recover'
			});
		},

		async hc_safe_mode(args) {
			return session.safeMode({ reason: args.reason, windowId: args.windowId });
		},

		async hc_define_tool(args) {
			const { patchName, content } = buildSelfAuthoredToolPatch(args);
			patchSet.upsert({ name: patchName, content });
			const revision = await session.createRevision({
				description: `Define agent tool: ${args.name}`,
				patches: patchSet.list()
			});
			await recordToolInLedger(userDataDir, {
				name: args.name,
				description: args.description,
				parameters: args.parameters,
				revisionId: revision.id,
				patchName,
				promoted: false
			});
			return {
				revision,
				note: 'Created but not activated. Call hc_activate_revision, verify, then hc_promote (with confirmation) only if you want this tool to survive a fresh install.'
			};
		},

		async hc_promote(args) {
			const confirmed = await requestPromotionConfirmation({
				revisionId: args.revisionId,
				windowId: args.windowId,
				commitMessage: args.commitMessage,
				baseline: (await session.getState()).baseline?.current
			});
			if (!confirmed) {
				return { ok: false, reason: 'declined', detail: 'Promotion requires explicit human confirmation and was not confirmed.' };
			}
			const result = await session.promote({
				revisionId: args.revisionId,
				windowId: args.windowId,
				commitMessage: args.commitMessage
			});
			await markToolsPromoted(userDataDir, args.revisionId);
			return { ok: true, result };
		}
	};
}
