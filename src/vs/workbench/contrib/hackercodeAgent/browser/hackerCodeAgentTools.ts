/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { getErrorMessage } from '../../../../base/common/errors.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { IJSONSchema } from '../../../../base/common/jsonSchema.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { executeHackerCodeControlEval } from '../../../../platform/hackercode/browser/hackerCodeControlEval.js';
import { IHackerCodeRuntime } from '../../../../platform/hackercode/browser/hackerCodeRuntime.js';
import {
	IHackerCodeControlService,
	IHackerCodePatchSource,
	IHackerCodeState,
	PRISTINE_REVISION_ID
} from '../../../../platform/hackercode/common/hackerCode.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import {
	CountTokensCallback,
	IPreparedToolInvocation,
	IToolData,
	IToolImpl,
	IToolInvocation,
	IToolInvocationPreparationContext,
	IToolResult,
	ToolDataSource,
	ToolProgress
} from '../../chat/common/tools/languageModelToolsService.js';

/**
 * The HackerCode control plane exposed as chat tools.
 *
 * These run in the renderer and talk to {@link IHackerCodeControlService}
 * directly. Read-only tools are available in every mode; the tools that mutate
 * the running runtime are listed in {@link MUTATING_HACKERCODE_TOOLS} and are
 * withheld outside Agent mode by the participant, so a non-Agent turn is
 * structurally incapable of changing the runtime.
 */

export const enum HackerCodeToolId {
	GetState = 'hc_get_state',
	ListRevisions = 'hc_list_revisions',
	ListServices = 'hc_list_services',
	Eval = 'hc_eval',
	CreateRevision = 'hc_create_revision',
	ActivateRevision = 'hc_activate_revision',
	Refresh = 'hc_refresh',
	Revert = 'hc_revert',
	SafeMode = 'hc_safe_mode',
	DefineTool = 'hc_define_tool',
	Promote = 'hc_promote',
}

/**
 * Tools that change the running runtime, the revision ledger, or the source
 * checkout. `hc_eval` is included: it has full renderer privilege and is only
 * nominally a read tool.
 */
const MUTATING_HACKERCODE_TOOLS: ReadonlySet<string> = new Set<string>([
	HackerCodeToolId.Eval,
	HackerCodeToolId.CreateRevision,
	HackerCodeToolId.ActivateRevision,
	HackerCodeToolId.Refresh,
	HackerCodeToolId.Revert,
	HackerCodeToolId.SafeMode,
	HackerCodeToolId.DefineTool,
	HackerCodeToolId.Promote,
]);

export function isMutatingHackerCodeTool(toolId: string): boolean {
	return MUTATING_HACKERCODE_TOOLS.has(toolId);
}

const HEALTH_POLL_INTERVAL_MS = 500;
const HEALTH_TIMEOUT_MS = 60_000;
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

type HackerCodeGlobal = typeof globalThis & { $hackercode?: IHackerCodeRuntime };

function toolData(id: HackerCodeToolId, displayName: string, modelDescription: string, inputSchema: IJSONSchema): IToolData {
	return {
		id,
		displayName,
		modelDescription,
		inputSchema,
		source: ToolDataSource.Internal,
		tags: ['hackercode'],
		// Listed in the tool picker and referenceable as `#<id>`. Without these two
		// the tool is still callable by the model but invisible to the user.
		toolReferenceName: id,
		canBeReferencedInPrompt: true
	};
}

const EMPTY_SCHEMA: IJSONSchema = { type: 'object', properties: {}, additionalProperties: false };

export const HackerCodeToolData: readonly IToolData[] = [
	toolData(HackerCodeToolId.GetState, 'HackerCode State',
		'Reads the current HackerCode control state: active revision, last-known-good, quarantines, boot attempt, and source baseline.',
		EMPTY_SCHEMA),
	toolData(HackerCodeToolId.ListRevisions, 'HackerCode Revisions',
		'Lists all known HackerCode revisions (pristine plus every stored revision manifest).',
		EMPTY_SCHEMA),
	toolData(HackerCodeToolId.ListServices, 'HackerCode Services',
		'Lists the names of every DI service currently resolvable in the renderer runtime. Use this to discover what hc_eval or a patch can call through ctx.getService.',
		EMPTY_SCHEMA),
	toolData(HackerCodeToolId.Eval, 'HackerCode Eval',
		'Evaluates the body of an async function in the renderer runtime for read-only inspection or a one-shot probe. Has full renderer privilege; never use it to perform a mutation you want to keep -- encode accepted changes as a patch instead.',
		{
			type: 'object',
			properties: {
				source: { type: 'string', description: 'The body of an async function. May use runtime, instantiationService, getService, and refresh.' }
			},
			required: ['source'],
			additionalProperties: false
		}),
	toolData(HackerCodeToolId.CreateRevision, 'HackerCode Create Revision',
		'Creates (without activating) a revision. The given patches are merged by name into the active revision\'s patch set and the FULL merged set is submitted, because HackerCode does not recursively load parent revisions.',
		{
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
	toolData(HackerCodeToolId.ActivateRevision, 'HackerCode Activate Revision',
		'Activates a revision and waits for a healthy boot (bootAttempt cleared, lastKnownGood matches, not quarantined) before optionally running a verification eval. Never retries the same revision on failure.',
		{
			type: 'object',
			properties: {
				revisionId: { type: 'string' },
				mode: { type: 'string', enum: ['normal', 'recover'] },
				verifyEvalSource: { type: 'string', description: 'Optional async-function body run once the revision looks healthy, to confirm the intended behavior.' },
				timeoutMs: { type: 'integer', description: 'Health-poll deadline in milliseconds. Defaults to 60000.' }
			},
			required: ['revisionId'],
			additionalProperties: false
		}),
	toolData(HackerCodeToolId.Refresh, 'HackerCode Refresh',
		'Refreshes applied patches in the renderer: soft (reapply patch factories), module (a specifier already loaded through ctx.import), or hard (monitored window reload of the active revision).',
		{
			type: 'object',
			properties: {
				mode: { type: 'string', enum: ['soft', 'module', 'hard'] },
				specifier: { type: 'string', description: 'Required only for module mode.' }
			},
			required: ['mode'],
			additionalProperties: false
		}),
	toolData(HackerCodeToolId.Revert, 'HackerCode Revert',
		'Falls back to last-known-good or pristine and waits for healthy activation. Use this instead of hc_activate_revision when recovering.',
		{
			type: 'object',
			properties: {
				target: { type: 'string', enum: ['lastKnownGood', 'pristine'] }
			},
			required: ['target'],
			additionalProperties: false
		}),
	toolData(HackerCodeToolId.SafeMode, 'HackerCode Safe Mode',
		'Requests main-owned emergency safe mode: quarantines/falls back, sets skipPromoted, and reloads. Use when the renderer is unhealthy and hc_revert is not enough.',
		{
			type: 'object',
			properties: { reason: { type: 'string' } },
			additionalProperties: false
		}),
	toolData(HackerCodeToolId.DefineTool, 'HackerCode Define Tool',
		'Authors a brand-new tool for yourself as a reversible patch: it exports a small JSON-schema descriptor plus a ctx.registerCommand factory. Creates (but does not activate) a revision containing it, merged with the active revision\'s patch set.',
		{
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
	toolData(HackerCodeToolId.Promote, 'HackerCode Promote',
		'Requests promotion of a revision into the source checkout as a real git commit. Always requires separate human confirmation; never happens automatically.',
		{
			type: 'object',
			properties: {
				revisionId: { type: 'string' },
				commitMessage: { type: 'string' }
			},
			required: ['revisionId'],
			additionalProperties: false
		}),
];

export class HackerCodeControlTool extends Disposable implements IToolImpl {

	constructor(
		private readonly toolId: HackerCodeToolId,
		@IHackerCodeControlService private readonly controlService: IHackerCodeControlService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
	) {
		super();
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		switch (this.toolId) {
			case HackerCodeToolId.Promote: {
				// Promotion writes a real git commit. This confirmation is the human
				// gate the control plane requires; it is never auto-approvable.
				const revisionId = String((context.parameters as { revisionId?: unknown })?.revisionId ?? '');
				return {
					invocationMessage: localize('hackerCodeAgent.tool.promoting', "Promoting revision {0}", revisionId),
					confirmationMessages: {
						title: localize('hackerCodeAgent.tool.promote.title', "Promote revision into the source checkout?"),
						message: new MarkdownString(localize('hackerCodeAgent.tool.promote.message', "This writes revision `{0}` into `src/vs/workbench/contrib/hackercode/browser/promoted/` as a real git commit.", revisionId)),
						allowAutoConfirm: false
					}
				};
			}
			case HackerCodeToolId.SafeMode:
				return {
					invocationMessage: localize('hackerCodeAgent.tool.safeMode', "Entering HackerCode safe mode"),
					confirmationMessages: {
						title: localize('hackerCodeAgent.tool.safeMode.title', "Enter HackerCode safe mode?"),
						message: new MarkdownString(localize('hackerCodeAgent.tool.safeMode.message', "This quarantines the active revision, skips promoted patches, and reloads the window."))
					}
				};
			default:
				return undefined;
		}
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		try {
			return asToolResult(await this._run(invocation.parameters, progress, token));
		} catch (error) {
			return { content: [{ kind: 'text', value: getErrorMessage(error) }], toolResultError: getErrorMessage(error) };
		}
	}

	private async _run(parameters: Record<string, any>, progress: ToolProgress, token: CancellationToken): Promise<unknown> {
		const windowId = this.nativeHostService.windowId;

		switch (this.toolId) {
			case HackerCodeToolId.GetState:
				return this.controlService.getState();

			case HackerCodeToolId.ListRevisions:
				return this.controlService.listRevisions();

			case HackerCodeToolId.ListServices:
				return { services: this._runtime().listServices() };

			case HackerCodeToolId.Eval:
				return executeHackerCodeControlEval(String(parameters.source), this._runtime());

			case HackerCodeToolId.CreateRevision:
				return this._createRevision(parameters.patches, parameters.description);

			case HackerCodeToolId.ActivateRevision:
				return this._activateAndWaitHealthy({
					revisionId: String(parameters.revisionId),
					windowId,
					mode: parameters.mode === 'recover' ? 'recover' : 'normal',
					timeoutMs: typeof parameters.timeoutMs === 'number' ? parameters.timeoutMs : HEALTH_TIMEOUT_MS,
					verifyEvalSource: typeof parameters.verifyEvalSource === 'string' ? parameters.verifyEvalSource : undefined
				}, progress, token);

			case HackerCodeToolId.Refresh: {
				const mode = parameters.mode as 'soft' | 'module' | 'hard';
				if (mode === 'hard') {
					const state = await this.controlService.getState();
					return this.controlService.reloadRevision({ revisionId: state.activeRevisionId, windowId });
				}
				if (mode === 'module') {
					await this._runtime().refresh('module', String(parameters.specifier ?? ''));
				} else {
					await this._runtime().refresh('soft');
				}
				return { ok: true, mode };
			}

			case HackerCodeToolId.Revert: {
				const state = await this.controlService.getState();
				const revisionId = parameters.target === 'pristine' ? PRISTINE_REVISION_ID : state.lastKnownGoodRevisionId;
				return this._activateAndWaitHealthy({ revisionId, windowId, mode: 'recover', timeoutMs: HEALTH_TIMEOUT_MS }, progress, token);
			}

			case HackerCodeToolId.SafeMode:
				return this.controlService.enterSafeMode({ reason: parameters.reason, windowId });

			case HackerCodeToolId.DefineTool: {
				const patch = buildSelfAuthoredToolPatch(parameters as ISelfAuthoredToolDescriptor);
				const revision = await this._createRevision([patch], `Define agent tool: ${parameters.name}`);
				return {
					revision,
					note: 'Created but not activated. Call hc_activate_revision, verify, then hc_promote (with confirmation) only if you want this tool to survive a fresh install.'
				};
			}

			case HackerCodeToolId.Promote:
				return this.controlService.promoteRevision({
					revisionId: String(parameters.revisionId),
					windowId,
					commitMessage: typeof parameters.commitMessage === 'string' ? parameters.commitMessage : undefined
				});
		}
	}

	/**
	 * Submits the union of the active revision's patches and the incoming ones,
	 * merged by name. The loader does not recursively load parent revisions, so
	 * a revision must always carry the complete set that should stay active.
	 */
	private async _createRevision(patches: unknown, description: unknown): Promise<unknown> {
		const incoming = readPatchSources(patches);
		const state = await this.controlService.getState();
		const existing = state.activeRevisionId === PRISTINE_REVISION_ID
			? []
			: await this.controlService.readPatchSources(state.activeRevisionId);

		const merged: IHackerCodePatchSource[] = [...existing];
		for (const patch of incoming) {
			const index = merged.findIndex(candidate => candidate.name === patch.name);
			if (index >= 0) {
				merged[index] = patch;
			} else {
				merged.push(patch);
			}
		}

		const baseline = state.baseline.current;
		if (!baseline) {
			throw new Error('The source baseline is unavailable, so a revision cannot be created.');
		}

		return this.controlService.createRevision({
			baseline,
			parentId: state.activeRevisionId,
			...(typeof description === 'string' ? { description } : {}),
			patches: merged
		});
	}

	/**
	 * Activates a revision and turns main's "selection persisted" response into
	 * an actual pass/fail judgement by polling the ledger across the renderer
	 * reload it triggers. Deliberately never retries the same revision: a
	 * quarantine is terminal for this call, and the model decides what to do
	 * next (a fresh revision, a fallback, or safe mode).
	 */
	private async _activateAndWaitHealthy(
		options: { revisionId: string; windowId: number; mode: 'normal' | 'recover'; timeoutMs: number; verifyEvalSource?: string },
		progress: ToolProgress,
		token: CancellationToken
	): Promise<unknown> {
		try {
			await this.controlService.setRevision({ revisionId: options.revisionId, windowId: options.windowId, mode: options.mode });
		} catch (error) {
			return { ok: false, reason: 'activation-failed', detail: getErrorMessage(error) };
		}

		progress.report({ message: localize('hackerCodeAgent.tool.waitingHealthy', "Waiting for a healthy boot of {0}", options.revisionId) });

		const deadline = Date.now() + options.timeoutMs;
		let lastState: IHackerCodeState | undefined;

		while (Date.now() < deadline && !token.isCancellationRequested) {
			try {
				const state = await this.controlService.getState();
				lastState = state;

				const quarantine = state.quarantinedRevisions.find(entry => entry.revisionId === options.revisionId);
				if (quarantine) {
					return {
						ok: false,
						reason: 'quarantined',
						detail: quarantine.reason ?? 'Revision was quarantined without a stated reason',
						state
					};
				}

				const isHealthy = state.activeRevisionId === options.revisionId
					&& state.bootAttempt === undefined
					&& state.lastKnownGoodRevisionId === options.revisionId;
				if (isHealthy) {
					if (!options.verifyEvalSource) {
						return { ok: true, state };
					}
					try {
						return { ok: true, state, verification: await executeHackerCodeControlEval(options.verifyEvalSource, this._runtime()) };
					} catch (error) {
						return { ok: false, reason: 'verification-failed', detail: getErrorMessage(error), state };
					}
				}
			} catch {
				// A window mid-reload cannot answer; main-owned state is the source of
				// truth, so transient failures are retried until the deadline rather
				// than treated as evidence of a bad revision.
			}

			await timeout(Math.min(HEALTH_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
		}

		return {
			ok: false,
			reason: 'timeout',
			detail: lastState
				? `Timed out waiting for healthy activation (active=${lastState.activeRevisionId}, bootAttempt=${lastState.bootAttempt?.revisionId ?? 'none'})`
				: 'Timed out waiting for healthy activation with no successful getState response',
			...(lastState ? { state: lastState } : {})
		};
	}

	private _runtime(): IHackerCodeRuntime {
		const runtime = (globalThis as HackerCodeGlobal).$hackercode;
		if (!runtime) {
			throw new Error('The HackerCode runtime is unavailable in this window.');
		}
		return runtime;
	}
}

interface ISelfAuthoredToolDescriptor {
	readonly name: string;
	readonly description: string;
	readonly parameters: object;
	readonly commandBody: string;
}

export const TOOL_COMMAND_PREFIX = 'hackercode.agent.tool.';

/**
 * Builds the ESM patch source for a self-authored tool. `commandBody` is the
 * body of an async function receiving the tool call arguments; it is
 * model-authored JavaScript and is exactly as privileged as any other patch
 * factory body. Only structural validation happens here -- narrow guards, not
 * a sandbox.
 */
export function buildSelfAuthoredToolPatch(descriptor: ISelfAuthoredToolDescriptor): IHackerCodePatchSource {
	if (typeof descriptor?.name !== 'string' || !TOOL_NAME_PATTERN.test(descriptor.name)) {
		throw new Error('Tool name must match ^[a-z][a-z0-9_]{0,63}$');
	}
	if (typeof descriptor.description !== 'string' || descriptor.description.trim().length === 0) {
		throw new Error('Tool description must be a non-empty string');
	}
	if (typeof descriptor.parameters !== 'object' || descriptor.parameters === null || Array.isArray(descriptor.parameters)) {
		throw new Error('Tool parameters must be a JSON Schema object');
	}
	if (typeof descriptor.commandBody !== 'string' || descriptor.commandBody.trim().length === 0) {
		throw new Error('Tool commandBody must be a non-empty JavaScript function body');
	}

	const commandId = `${TOOL_COMMAND_PREFIX}${descriptor.name}`;
	const body = descriptor.commandBody.split('\n').map(line => line.length > 0 ? `\t\t${line}` : line).join('\n');
	const content = `const agentToolDescriptor = ${JSON.stringify({ name: descriptor.name, description: descriptor.description, parameters: descriptor.parameters }, null, '\t')};

export const agentTool = agentToolDescriptor;

export default async function (ctx) {
	ctx.registerCommand(${JSON.stringify(commandId)}, async (input) => {
${body}
	});
}
`;
	return { name: `agent-tool-${descriptor.name}`, content };
}

function readPatchSources(value: unknown): IHackerCodePatchSource[] {
	if (!Array.isArray(value)) {
		throw new Error('"patches" must be an array of { name, content }.');
	}
	return value.map(entry => {
		const record = entry as { name?: unknown; content?: unknown };
		if (typeof record?.name !== 'string' || typeof record?.content !== 'string') {
			throw new Error('Every patch must have a string "name" and string "content".');
		}
		return { name: record.name, content: record.content };
	});
}

function asToolResult(value: unknown): IToolResult {
	return { content: [{ kind: 'text', value: JSON.stringify(value ?? null, undefined, '\t') }] };
}
