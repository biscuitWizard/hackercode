/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceTimeout } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { OS, OperatingSystem } from '../../../../base/common/platform.js';
import { StopWatch } from '../../../../base/common/stopwatch.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { isChatRequestFileEntry, isImageVariableEntry, IChatRequestVariableEntry } from '../../chat/common/attachments/chatVariableEntries.js';
import { ChatModeKind } from '../../chat/common/constants.js';
import { IChatProgress } from '../../chat/common/chatService/chatService.js';
import {
	ChatImageMimeType,
	ChatMessageRole,
	IChatMessage,
	IChatMessagePart,
	ILanguageModelChatMetadata,
	ILanguageModelsService
} from '../../chat/common/languageModels.js';
import {
	IChatAgentHistoryEntry,
	IChatAgentImplementation,
	IChatAgentRequest,
	IChatAgentResult,
	UserSelectedTools
} from '../../chat/common/participants/chatAgents.js';
import { CountTokensCallback, ILanguageModelToolsService, IToolData, IToolResult } from '../../chat/common/tools/languageModelToolsService.js';
import { isMutatingHackerCodeTool } from './hackerCodeAgentTools.js';
import { isMutatingExtensionTool } from './hackerCodeExtensionTools.js';
import { HackerCodeCoreToolId } from './hackerCodeCoreTools.js';
import { HackerCodeEditToolId, isWorkspaceWriteTool } from './hackerCodeEditTools.js';
import { buildHackerCodeSystemPrompt, IHackerCodeEnvironment } from './hackerCodeAgentPrompt.js';
import { describeInvalidToolArguments, getInvalidToolArguments } from '../common/hackerCodeToolArguments.js';

/**
 * Tools that change the machine rather than describe it, and so are only ever
 * offered in Agent mode: the control-plane mutations and Marketplace installs.
 */
function isAgentModeOnlyTool(toolId: string): boolean {
	return isMutatingHackerCodeTool(toolId) || isMutatingExtensionTool(toolId);
}

/**
 * Tools that are registered but must never be offered to the model here.
 *
 * Three kinds. The edit tool asks an `ICodeMapperService` provider to work out
 * the edits, and the provider only ever came from the chat extension this
 * build does not have; with no provider it applies nothing and then waits
 * forever for edits that will never arrive, taking the turn down with it.
 * `create_file` and `edit_file` replace it.
 *
 * The confirmation tools put a widget in the transcript and block until the
 * user clicks it. They exist for asking permission, but a model reads them as
 * a way to talk, and answering "2+2" with a confirmation dialog stalls the
 * turn on a click the user has no reason to make. Anything worth saying goes
 * in the reply, and the tools that genuinely need consent ask for it
 * themselves.
 *
 * The last is the subagent tool, which re-enters the default agent — this one
 * — from inside its own tool loop, on a chat request that is still running.
 * That is a second turn writing into a transcript the first one owns, for the
 * sake of context management this agent does not otherwise do.
 */
const UNSUPPORTED_TOOLS: ReadonlySet<string> = new Set([
	'vscode_editFile_internal',
	'vscode_get_confirmation',
	'vscode_get_confirmation_with_options',
	'vscode_get_modified_files_confirmation',
	'vscode_askQuestions',
	'vscode_reviewPlan',
	'task_complete',
	'inline_chat_exit',
	'runSubagent',
]);

/**
 * How many model round trips one user turn may take before the loop gives up.
 * Each step is one model response plus the execution of every tool it asked
 * for, so a step budget bounds runaway tool loops without cutting off normal
 * multi-step work.
 */
const DEFAULT_MAX_STEPS = 24;

/** Guards against a single tool flooding the model's context window. */
const MAX_TOOL_RESULT_CHARS = 32 * 1024;

/**
 * How much of a tool result is replayed on later turns. The full result is
 * what the model needed at the time; on the turns after, its own summary of
 * what it found is in the conversation too, and a file quoted in full for
 * every remaining turn crowds out the conversation itself.
 */
const MAX_REPLAYED_TOOL_RESULT_CHARS = 2 * 1024;

/**
 * How many past turns are replayed with their tool calls intact. Older ones
 * fall back to prose, which is all the chat itself keeps anyway.
 */
const REMEMBERED_TURNS = 20;

/**
 * How many tool calls one model response may actually run.
 *
 * A response is supposed to carry a handful of calls to make at once. A model
 * that gets a tool wrong can instead emit the same call over and over inside
 * one response — a hundred of them has been seen — and running them all is
 * minutes of work whose every result is the same failure. Past this point the
 * batch is not a plan, it is a stuck model, and it is told so.
 */
const MAX_TOOL_CALLS_PER_STEP = 12;

/**
 * How many times one exact tool call may fail before the loop stops running
 * it. Two attempts is enough to rule out something transient; a third is the
 * model not reading the error.
 */
const REPEATED_FAILURE_LIMIT = 2;

/**
 * The default chat participant. Runs one user turn to completion: send the
 * conversation plus the enabled tool set, stream deltas into the chat, execute
 * the tools the model asks for, append their results, and repeat until the
 * model stops calling tools or the step budget is exhausted.
 *
 * This is the only place that ties the language model, the tool policy, and
 * the tool service together; it holds no HTTP and no provider code itself.
 */
export class HackerCodeChatAgent extends Disposable implements IChatAgentImplementation {

	/** Live tool-picker state, keyed by request id, updated while a turn runs. */
	private readonly _requestTools = new Map<string, UserSelectedTools>();

	/**
	 * What each finished turn actually sent to the model after the user's
	 * message: its own replies, the tools it called and what they returned.
	 * Kept here because the chat history a participant is handed has already
	 * dropped the tool calls, and a turn replayed without them reads as though
	 * the agent knew things by magic — it cannot then answer "why did you
	 * change that?", and it learns that files change when it says they do.
	 */
	private readonly _turnsByRequest = new Map<string, IChatMessage[]>();

	constructor(
		private readonly mode: ChatModeKind,
		@ILanguageModelsService private readonly languageModelsService: ILanguageModelsService,
		@ILanguageModelToolsService private readonly toolsService: ILanguageModelToolsService,
		@ILogService private readonly logService: ILogService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IEditorService private readonly editorService: IEditorService,
		@IFileService private readonly fileService: IFileService,
	) {
		super();
	}

	/**
	 * What the model would otherwise have to discover with tool calls, or
	 * worse, guess at: where the code is and what the user is looking at.
	 */
	private _environment(): IHackerCodeEnvironment {
		const activeResource = this.editorService.activeEditor?.resource;
		return {
			workspaceFolders: this.workspaceContextService.getWorkspace().folders.map(folder => folder.uri.fsPath),
			operatingSystem: OS === OperatingSystem.Windows ? 'Windows' : OS === OperatingSystem.Macintosh ? 'macOS' : 'Linux',
			...(activeResource ? { activeFile: activeResource.fsPath } : {})
		};
	}

	setRequestTools(requestId: string, tools: UserSelectedTools): void {
		this._requestTools.set(requestId, tools);
	}

	async invoke(request: IChatAgentRequest, progress: (parts: IChatProgress[]) => void, history: IChatAgentHistoryEntry[], token: CancellationToken): Promise<IChatAgentResult> {
		const stopWatch = new StopWatch(false);
		let firstProgress: number | undefined;
		const emit = (parts: IChatProgress[]) => {
			firstProgress ??= stopWatch.elapsed();
			progress(parts);
		};

		try {
			return await this._runTurn(request, emit, history, token, stopWatch, () => firstProgress);
		} catch (error) {
			if (isCancellationError(error) || token.isCancellationRequested) {
				return { timings: { firstProgress, totalElapsed: stopWatch.elapsed() } };
			}
			this.logService.error('[HackerCode] Agent turn failed', error);
			return {
				timings: { firstProgress, totalElapsed: stopWatch.elapsed() },
				errorDetails: { message: error instanceof Error ? error.message : String(error) }
			};
		} finally {
			this._requestTools.delete(request.requestId);
		}
	}

	private async _runTurn(
		request: IChatAgentRequest,
		progress: (parts: IChatProgress[]) => void,
		history: IChatAgentHistoryEntry[],
		token: CancellationToken,
		stopWatch: StopWatch,
		firstProgress: () => number | undefined
	): Promise<IChatAgentResult> {
		const modelId = request.userSelectedModelId;
		if (!modelId) {
			return {
				timings: { totalElapsed: stopWatch.elapsed() },
				errorDetails: { message: localize('hackerCodeAgent.noModel', "Pick a model to start chatting. Run \"HackerCode: Add Model Provider\" from the Command Palette, or add an OpenAI-compatible endpoint under Settings → HackerCode Agent.") }
			};
		}
		const model = this.languageModelsService.lookupLanguageModel(modelId);

		const messages: IChatMessage[] = [
			{ role: ChatMessageRole.System, content: [{ type: 'text', value: buildHackerCodeSystemPrompt(this.mode, this._environment()) }] },
			...toHistoryMessages(history, this._turnsByRequest),
			{ role: ChatMessageRole.User, content: [{ type: 'text', value: request.message }, ...toImageParts(request), ...await toFileParts(request, this.fileService)] }
		];
		// Everything this turn adds after the user's message is recorded as it
		// happens, so the next turn can replay it exactly and a turn that is
		// cancelled or fails still leaves behind what it did get done.
		const turn: IChatMessage[] = [];
		this._turnsByRequest.set(request.requestId, turn);
		for (const requestId of [...this._turnsByRequest.keys()].slice(0, -REMEMBERED_TURNS)) {
			this._turnsByRequest.delete(requestId);
		}
		const add = (message: IChatMessage) => {
			messages.push(message);
			turn.push(message);
		};

		const countTokens: CountTokensCallback = (input, tokenizerToken) => this.languageModelsService.computeTokenLength(modelId, input, tokenizerToken);

		// Narration between tool calls is folded into the collapsed "finished
		// with N steps" widget; only what the model says after its last tool
		// call renders as the reply. A turn that ends without that reads as
		// the agent having silently given up, so it is asked for one.
		let askedToSpeak = false;
		// The errors from the step just executed, if every tool in it failed.
		// A model that then stops has not done the work and usually says so by
		// asking the user for something the error already told it.
		let unrecoveredErrors: string[] = [];
		let askedToRetry = false;
		// How many times each exact call has already failed in this turn.
		const failedCalls = new Map<string, number>();
		// Text that arrived alongside tool calls. The chat UI folds that into
		// the "Finished with N steps" widget, so it is not a reply. Kept so a
		// turn that never writes a final message still has something to show.
		let lastNarration = '';
		let emittedReply = false;
		const toolSummaries: string[] = [];

		for (let step = 0; step < DEFAULT_MAX_STEPS; step++) {
			if (token.isCancellationRequested) {
				break;
			}

			const tools = this._toolsForRequest(request, model);
			const response = await this.languageModelsService.sendChatRequest(modelId, undefined, messages, {
				tools: tools.map(tool => ({
					type: 'function',
					name: tool.id,
					description: tool.modelDescription,
					parametersSchema: tool.inputSchema ?? { type: 'object', properties: {} }
				}))
			}, token);

			let text = '';
			let thinking = '';
			const toolUses: { toolCallId: string; name: string; parameters: object }[] = [];
			for await (const part of response.stream) {
				for (const one of Array.isArray(part) ? part : [part]) {
					if (one.type === 'text') {
						text += one.value;
					} else if (one.type === 'tool_use') {
						toolUses.push({ toolCallId: one.toolCallId, name: one.name, parameters: one.parameters ?? {} });
					} else if (one.type === 'thinking') {
						thinking += one.value;
						progress([{ kind: 'thinking', value: one.value, id: one.id ?? `think-${step}`, metadata: one.metadata }]);
					}
				}
			}
			await response.result;

			// Text that shares a response with tool calls is narration, not the
			// reply. Streaming it as markdown is what produced "Finished with
			// N steps" and a blank bubble: the renderer pins that markdown
			// into the collapsed widget and then there is nothing left.
			if (text.trim()) {
				if (toolUses.length > 0) {
					progress([{ kind: 'thinking', value: text, id: `narrate-${step}` }]);
					lastNarration = text;
				} else {
					progress([{ kind: 'markdownContent', content: new MarkdownString(text) }]);
					emittedReply = true;
				}
			} else if (thinking.trim() && toolUses.length === 0) {
				progress([{ kind: 'markdownContent', content: new MarkdownString(thinking) }]);
				emittedReply = true;
			} else if (thinking.trim()) {
				lastNarration = thinking;
			}

			add({
				role: ChatMessageRole.Assistant,
				content: [
					...(text ? [{ type: 'text', value: text } satisfies IChatMessagePart] : []),
					...toolUses.map(use => ({ type: 'tool_use', name: use.name, toolCallId: use.toolCallId, parameters: use.parameters } satisfies IChatMessagePart))
				]
			});

			if (toolUses.length === 0) {
				if (unrecoveredErrors.length > 0 && !askedToRetry) {
					// Every tool in the previous step failed and the model
					// answered with prose instead of trying again. The errors
					// these tools return say what was wrong with the call, so
					// the next attempt usually succeeds — where giving up hands
					// the user a question they cannot answer ("what is the path
					// to this file?") about a workspace the agent can see.
					askedToRetry = true;
					add({
						role: ChatMessageRole.User,
						content: [{
							type: 'text', value: [
								'Your last tool call failed and you stopped without doing the work:',
								...unrecoveredErrors.map(error => `- ${error}`),
								'Read the error, fix the arguments and call the tool again. Look things up with read_file, list_dir, grep_search or file_search rather than asking the user for them. Only stop and ask if what is missing is a decision that is genuinely theirs to make.'
							].join('\n')
						}]
					});
					continue;
				}
				if (!emittedReply && !askedToSpeak) {
					// One nudge, not a loop: the model finished its work but
					// never addressed the user, so ask it to, once.
					askedToSpeak = true;
					add({
						role: ChatMessageRole.User,
						content: [{ type: 'text', value: 'You ended your turn without replying. Write a short reply for the user now, in plain prose, saying what you found or changed. Do not call any more tools.' }]
					});
					continue;
				}
				if (!emittedReply) {
					progress([{ kind: 'markdownContent', content: new MarkdownString(fallbackReply(lastNarration, toolSummaries)) }]);
				}
				return { timings: { firstProgress: firstProgress(), totalElapsed: stopWatch.elapsed() } };
			}

			const errors: string[] = [];
			let anySucceeded = false;
			for (const planned of planToolCalls(toolUses)) {
				const signature = callSignature(planned.use);
				const failures = failedCalls.get(signature) ?? 0;
				// Every call gets a result, including the ones that were not
				// run: an OpenAI-compatible endpoint rejects the next request
				// if any tool call it sent is left unanswered.
				const skipped = planned.skipped ?? (failures >= REPEATED_FAILURE_LIMIT ? repeatedFailureAdvice(planned.use.name, failures) : undefined);
				const result = skipped
					? toolResultPart(planned.use.toolCallId, skipped, true)
					: await this._invokeTool(request, planned.use, tools, countTokens, token);
				if (isErrorResult(result)) {
					errors.push(`${planned.use.name}: ${describeToolResultPart(result)}`);
					if (!planned.skipped) {
						failedCalls.set(signature, failures + 1);
					}
				} else {
					anySucceeded = true;
				}
				add({ role: ChatMessageRole.User, content: [result] });
				toolSummaries.push(`${planned.use.name}: ${describeToolResultPart(result)}`);
			}
			unrecoveredErrors = anySucceeded ? [] : errors;
		}

		if (token.isCancellationRequested) {
			if (!emittedReply) {
				progress([{ kind: 'markdownContent', content: new MarkdownString(fallbackReply(lastNarration, toolSummaries)) }]);
			}
			return { timings: { firstProgress: firstProgress(), totalElapsed: stopWatch.elapsed() } };
		}

		if (!emittedReply) {
			progress([{ kind: 'markdownContent', content: new MarkdownString(fallbackReply(lastNarration, toolSummaries)) }]);
		}
		progress([{
			kind: 'warning',
			content: new MarkdownString(localize('hackerCodeAgent.stepBudget', "Stopped after {0} steps without finishing. Send another message to continue.", DEFAULT_MAX_STEPS))
		}]);
		return { timings: { firstProgress: firstProgress(), totalElapsed: stopWatch.elapsed() } };
	}

	/**
	 * Executes one tool call. Every failure — arguments that were not valid
	 * JSON, an unknown tool, one the mode forbids, or an error thrown by the
	 * tool — is turned into a tool result the model can read and react to,
	 * rather than aborting the turn. Nothing the model can get wrong should
	 * ever reach the user as a failed request.
	 */
	private async _invokeTool(
		request: IChatAgentRequest,
		use: { toolCallId: string; name: string; parameters: object },
		tools: readonly IToolData[],
		countTokens: CountTokensCallback,
		token: CancellationToken
	): Promise<IChatMessagePart> {
		const result = (value: string, isError?: boolean) => toolResultPart(use.toolCallId, value, isError);

		if (!tools.some(tool => tool.id === use.name)) {
			// The model asked for something outside the set it was offered, which
			// in Ask mode is the difference between reading and mutating.
			return result(`The tool "${use.name}" is not available in this mode.`, true);
		}

		const invalidArguments = getInvalidToolArguments(use.parameters);
		if (invalidArguments) {
			// The tool is deliberately not run: the marker object is not the
			// arguments the model meant, and guessing at them is how a typo
			// turns into an edit nobody asked for.
			this.logService.warn(`[HackerCode] Malformed arguments for tool "${use.name}": ${invalidArguments.reason}`);
			return result(describeInvalidToolArguments(use.name, invalidArguments), true);
		}

		const budget = toolTimeout(use.name);
		try {
			const invoked = await raceTimeout(this.toolsService.invokeTool({
				callId: use.toolCallId,
				toolId: use.name,
				parameters: use.parameters as Record<string, unknown>,
				context: { sessionResource: request.sessionResource, ...(request.workingDirectory ? { workingDirectory: request.workingDirectory } : {}) },
				chatRequestId: request.requestId,
				modelId: request.userSelectedModelId,
				userSelectedTools: this._requestTools.get(request.requestId) ?? request.userSelectedTools
			}, countTokens, token), budget);
			if (!invoked) {
				// A tool that never returns takes the whole turn with it: the
				// loop is still awaiting it, so nothing more is streamed and
				// the chat sits spinning with no way to tell a slow tool from
				// a dead one. It happens for real — anything served by the
				// extension host stops answering when that process crashes —
				// so the wait is bounded and the model is told, which at least
				// leaves the user with a reply.
				this.logService.warn(`[HackerCode] Tool "${use.name}" did not return within ${budget}ms`);
				return result(`The tool "${use.name}" did not return within ${Math.round(budget / 1000)} seconds and was abandoned. It may be unavailable. Try another way of doing this, or tell the user it is not responding.`, true);
			}
			return result(toolResultToText(invoked), !!invoked.toolResultError);
		} catch (error) {
			if (isCancellationError(error) || token.isCancellationRequested) {
				throw error;
			}
			return result(error instanceof Error ? error.message : String(error), true);
		}
	}

	/**
	 * The tools offered to the model for this request: everything the tool
	 * picker has enabled, minus the tools that mutate the running runtime or
	 * install code into it when the user is not in Agent mode. That last filter
	 * is a policy the model is never asked to respect — it simply never sees
	 * those tools, and {@link _invokeTool} rejects them if it guesses a name.
	 */
	private _toolsForRequest(request: IChatAgentRequest, model: ILanguageModelChatMetadata | undefined): IToolData[] {
		const enabled = this._requestTools.get(request.requestId) ?? request.userSelectedTools;
		const result: IToolData[] = [];
		for (const tool of this.toolsService.getTools(model)) {
			if (enabled && enabled[tool.id] === false) {
				continue;
			}
			if (UNSUPPORTED_TOOLS.has(tool.id)) {
				continue;
			}
			if (this.mode !== ChatModeKind.Agent && isAgentModeOnlyTool(tool.id)) {
				continue;
			}
			if (this.mode === ChatModeKind.Ask && isWorkspaceWriteTool(tool.id)) {
				continue;
			}
			result.push(tool);
		}
		return result;
	}
}

/**
 * The images attached to this turn, as message parts.
 *
 * An attachment the user can see in the input but that never reaches the model
 * is worse than one that was refused, so anything that is recognisably an
 * image is sent. Entries the workbench already decided to leave out — too
 * large, or dropped to fit the context — carry an `omittedState` and are
 * skipped, since their bytes are not there to send.
 */
/**
 * A turn must never end on a blank bubble. The chat UI collapses tool
 * narration into "Finished with N steps"; if the model then writes nothing,
 * that widget is the entire reply. This is the last line of defence: show
 * the last thing the model said, or a short account of the tools it ran.
 */
function fallbackReply(narration: string, toolSummaries: readonly string[]): string {
	if (narration.trim()) {
		return narration.trim();
	}
	if (toolSummaries.length > 0) {
		return ['I ran the tools but did not write a closing reply. Here is what happened:', ...toolSummaries.slice(-8).map(line => `- ${line}`)].join('\n');
	}
	return 'I finished without writing a reply. Send another message to continue.';
}

/** File attachments the user can see on the chip, inlined so the model can actually read them. */
async function toFileParts(request: IChatAgentRequest, fileService: IFileService): Promise<IChatMessagePart[]> {
	const parts: IChatMessagePart[] = [];
	for (const variable of request.variables?.variables ?? []) {
		if (!isChatRequestFileEntry(variable) || variable.omittedState) {
			continue;
		}
		const uri = IChatRequestVariableEntry.toUri(variable);
		if (!uri) {
			continue;
		}
		try {
			const contents = (await fileService.readFile(uri)).value.toString();
			parts.push({
				type: 'text',
				value: `\n\nAttached file \`${variable.name}\` (${uri.fsPath}):\n\`\`\`\n${truncate(contents, MAX_TOOL_RESULT_CHARS)}\n\`\`\``
			});
		} catch (error) {
			parts.push({
				type: 'text',
				value: `\n\nAttached file \`${variable.name}\` could not be read: ${error instanceof Error ? error.message : String(error)}`
			});
		}
	}
	return parts;
}

function toImageParts(request: IChatAgentRequest): IChatMessagePart[] {
	const parts: IChatMessagePart[] = [];
	for (const variable of request.variables?.variables ?? []) {
		if (!isImageVariableEntry(variable) || variable.omittedState) {
			continue;
		}
		const data = variable.value;
		if (!(data instanceof Uint8Array)) {
			continue;
		}
		parts.push({
			type: 'image_url',
			value: { mimeType: toChatImageMimeType(variable.mimeType), data: VSBuffer.wrap(data) }
		});
	}
	return parts;
}

/** Falls back to PNG, which is what the workbench encodes pasted images as. */
function toChatImageMimeType(mimeType: string | undefined): ChatImageMimeType {
	switch (mimeType?.toLowerCase()) {
		case 'image/jpeg':
		case 'image/jpg':
			return ChatImageMimeType.JPEG;
		case 'image/gif':
			return ChatImageMimeType.GIF;
		case 'image/webp':
			return ChatImageMimeType.WEBP;
		case 'image/bmp':
			return ChatImageMimeType.BMP;
		default:
			return ChatImageMimeType.PNG;
	}
}

interface IToolUse {
	readonly toolCallId: string;
	readonly name: string;
	readonly parameters: object;
}

/**
 * Decides which of a response's tool calls to actually run. Identical calls in
 * the same batch are answered once, and the batch is capped, so a model stuck
 * repeating itself costs one round trip and gets told what happened instead of
 * grinding through the same failure a hundred times.
 */
function planToolCalls(toolUses: readonly IToolUse[]): { use: IToolUse; skipped?: string }[] {
	const seen = new Set<string>();
	const planned: { use: IToolUse; skipped?: string }[] = [];
	let running = 0;

	let duplicates = 0;
	for (const use of toolUses) {
		const signature = callSignature(use);
		if (seen.has(signature)) {
			// Only the first repeat is explained. A model that emits the same
			// call thirty times is repeating itself, and thirty copies of the
			// same paragraph coming back is the same repetition handed to it
			// as input — the shortest possible answer is the one least likely
			// to keep it going.
			planned.push({
				use, skipped: duplicates++ === 0
					? `This is an exact repeat of another "${use.name}" call in the same response, so it was not run again. Read the result of the first one; if it failed, change the arguments before trying again.`
					: 'Duplicate call, ignored.'
			});
			continue;
		}
		seen.add(signature);
		if (running >= MAX_TOOL_CALLS_PER_STEP) {
			planned.push({ use, skipped: `Only the first ${MAX_TOOL_CALLS_PER_STEP} tool calls in a response are run, and this one came after them, so it was not run. Ask for a few things at a time and use each result before asking for more.` });
			continue;
		}
		running++;
		planned.push({ use });
	}
	return planned;
}

/**
 * How long a tool is given to answer.
 *
 * Reading a file, searching, and applying an edit are all sub-second work, so
 * a couple of minutes means something is wrong — the extension host has died,
 * say, and the search will never come back. Those get the short budget.
 *
 * Everything else gets a long one, because the two things a tool does that
 * legitimately take a while are running a build and waiting for the user to
 * click a confirmation, and cutting either of those short would abandon work
 * that was going to succeed.
 */
function toolTimeout(name: string): number {
	return FAST_TOOLS.has(name) ? 2 * 60 * 1000 : 15 * 60 * 1000;
}

const FAST_TOOLS: ReadonlySet<string> = new Set<string>([
	HackerCodeCoreToolId.ReadFile,
	HackerCodeCoreToolId.ListDirectory,
	HackerCodeCoreToolId.GrepSearch,
	HackerCodeCoreToolId.FileSearch,
	HackerCodeEditToolId.CreateFile,
	HackerCodeEditToolId.EditFile,
]);

function callSignature(use: IToolUse): string {
	return `${use.name}:${JSON.stringify(use.parameters)}`;
}

/**
 * What to say to a model that keeps making a call that keeps failing.
 *
 * Repeating an identical failing call is the one thing a model does that
 * cannot get better on its own: the arguments are the problem, and the same
 * arguments produce the same error. Left to run, the turn is spent on it, the
 * transcript fills with the same paragraph, and nothing is changed. Refusing
 * the call is only half of it — the model also needs a way out, and for the
 * editing tools there is a good one, since `create_file` asks only for the
 * text to end up with and never has to quote the file back.
 */
function repeatedFailureAdvice(name: string, failures: number): string {
	const escape = name === 'edit_file'
		? ' Do not send it a third time. Call create_file with the complete new contents of the file instead — it does not need to match any existing text.'
		: ' Do not send it again unchanged. Try a different approach, or tell the user what is blocking you.';
	return `This exact "${name}" call already failed ${failures} times in this turn, so it was not run again.${escape}`;
}

function toolResultPart(toolCallId: string, value: string, isError?: boolean): IChatMessagePart {
	return {
		type: 'tool_result',
		toolCallId,
		value: [{ type: 'text', value: truncate(value) }],
		...(isError ? { isError: true } : {})
	};
}

function isErrorResult(part: IChatMessagePart): boolean {
	return part.type === 'tool_result' && part.isError === true;
}

/**
 * The text of a tool result, shortened to its first line.
 *
 * This is only used to remind the model of an error it has already been sent
 * in full, so the opening sentence is the part worth repeating; an error that
 * quotes a whole file would otherwise be in the conversation twice.
 */
function describeToolResultPart(part: IChatMessagePart): string {
	if (part.type !== 'tool_result') {
		return '';
	}
	const text = part.value.map(one => typeof one === 'object' && 'value' in one && one.type === 'text' ? one.value : '').join('');
	return text.split('\n')[0].slice(0, 300);
}

function toolResultToText(result: IToolResult): string {
	const text = result.content
		.map(part => part.kind === 'text' ? part.value : '')
		.filter(value => value.length > 0)
		.join('\n');
	if (text) {
		return text;
	}
	if (typeof result.toolResultError === 'string') {
		return result.toolResultError;
	}
	return result.toolResultError ? 'The tool reported an error.' : 'The tool produced no output.';
}

/**
 * Replays prior turns, from what the agent sent rather than from what the
 * chat rendered.
 *
 * A turn that ran tools is replayed with those tool calls and their results
 * in place, because the alternative — describing them in the assistant's own
 * prose — is a sentence the model then imitates. Told often enough that it
 * ends its turns by writing "(tools used: edit_file)", it writes that line
 * instead of calling the tool, and reports a change nobody made.
 *
 * Turns from before this window opened, or from a previous session, are not
 * in the record; those fall back to the rendered prose, which at least keeps
 * the conversation coherent.
 */
function toHistoryMessages(history: readonly IChatAgentHistoryEntry[], turnsByRequest: ReadonlyMap<string, readonly IChatMessage[]>): IChatMessage[] {
	const messages: IChatMessage[] = [];
	for (const entry of history) {
		messages.push({ role: ChatMessageRole.User, content: [{ type: 'text', value: entry.request.message }] });

		const recorded = turnsByRequest.get(entry.request.requestId);
		if (recorded?.length) {
			messages.push(...recorded.map(shortenToolResults));
			continue;
		}

		const value = entry.response
			.map(part => part.kind === 'markdownContent' ? part.content.value : '')
			.join('')
			.trim();
		if (value) {
			messages.push({ role: ChatMessageRole.Assistant, content: [{ type: 'text', value }] });
		}
	}
	return messages;
}

/** The same message with any tool output in it cut down to replay size. */
function shortenToolResults(message: IChatMessage): IChatMessage {
	if (!message.content.some(part => part.type === 'tool_result')) {
		return message;
	}
	return {
		...message,
		content: message.content.map(part => part.type === 'tool_result'
			? {
				...part,
				value: part.value.map(one => one.type === 'text'
					? { ...one, value: truncate(one.value, MAX_REPLAYED_TOOL_RESULT_CHARS) }
					: one)
			}
			: part)
	} as IChatMessage;
}

function truncate(text: string, limit = MAX_TOOL_RESULT_CHARS): string {
	if (text.length <= limit) {
		return text;
	}
	return `${text.slice(0, limit)}\n...[truncated ${text.length - limit} characters]`;
}
