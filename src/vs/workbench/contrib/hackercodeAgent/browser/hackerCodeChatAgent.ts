/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { StopWatch } from '../../../../base/common/stopwatch.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ChatModeKind } from '../../chat/common/constants.js';
import { IChatProgress } from '../../chat/common/chatService/chatService.js';
import {
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
import { buildHackerCodeSystemPrompt } from './hackerCodeAgentPrompt.js';
import { describeInvalidToolArguments, getInvalidToolArguments } from '../common/hackerCodeToolArguments.js';

/**
 * Tools that change the machine rather than describe it, and so are only ever
 * offered in Agent mode: the control-plane mutations and Marketplace installs.
 */
function isAgentModeOnlyTool(toolId: string): boolean {
	return isMutatingHackerCodeTool(toolId) || isMutatingExtensionTool(toolId);
}

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

	constructor(
		private readonly mode: ChatModeKind,
		@ILanguageModelsService private readonly languageModelsService: ILanguageModelsService,
		@ILanguageModelToolsService private readonly toolsService: ILanguageModelToolsService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
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
			{ role: ChatMessageRole.System, content: [{ type: 'text', value: buildHackerCodeSystemPrompt(this.mode) }] },
			...toHistoryMessages(history),
			{ role: ChatMessageRole.User, content: [{ type: 'text', value: request.message }] }
		];

		const countTokens: CountTokensCallback = (input, tokenizerToken) => this.languageModelsService.computeTokenLength(modelId, input, tokenizerToken);

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
			const toolUses: { toolCallId: string; name: string; parameters: object }[] = [];
			for await (const part of response.stream) {
				for (const one of Array.isArray(part) ? part : [part]) {
					if (one.type === 'text') {
						text += one.value;
						progress([{ kind: 'markdownContent', content: new MarkdownString(one.value) }]);
					} else if (one.type === 'tool_use') {
						toolUses.push({ toolCallId: one.toolCallId, name: one.name, parameters: one.parameters ?? {} });
					} else if (one.type === 'thinking') {
						progress([{ kind: 'thinking', value: one.value, id: one.id, metadata: one.metadata }]);
					}
				}
			}
			await response.result;

			messages.push({
				role: ChatMessageRole.Assistant,
				content: [
					...(text ? [{ type: 'text', value: text } satisfies IChatMessagePart] : []),
					...toolUses.map(use => ({ type: 'tool_use', name: use.name, toolCallId: use.toolCallId, parameters: use.parameters } satisfies IChatMessagePart))
				]
			});

			if (toolUses.length === 0) {
				return { timings: { firstProgress: firstProgress(), totalElapsed: stopWatch.elapsed() } };
			}

			for (const use of toolUses) {
				const result = await this._invokeTool(request, use, tools, countTokens, token);
				messages.push({ role: ChatMessageRole.User, content: [result] });
			}
		}

		if (token.isCancellationRequested) {
			return { timings: { firstProgress: firstProgress(), totalElapsed: stopWatch.elapsed() } };
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
		const toolResultPart = (value: string, isError?: boolean): IChatMessagePart => ({
			type: 'tool_result',
			toolCallId: use.toolCallId,
			value: [{ type: 'text', value: truncate(value) }],
			...(isError ? { isError: true } : {})
		});

		if (!tools.some(tool => tool.id === use.name)) {
			// The model asked for something outside the set it was offered, which
			// in Ask mode is the difference between reading and mutating.
			return toolResultPart(`The tool "${use.name}" is not available in this mode.`, true);
		}

		const invalidArguments = getInvalidToolArguments(use.parameters);
		if (invalidArguments) {
			// The tool is deliberately not run: the marker object is not the
			// arguments the model meant, and guessing at them is how a typo
			// turns into an edit nobody asked for.
			this.logService.warn(`[HackerCode] Malformed arguments for tool "${use.name}": ${invalidArguments.reason}`);
			return toolResultPart(describeInvalidToolArguments(use.name, invalidArguments), true);
		}

		try {
			const result = await this.toolsService.invokeTool({
				callId: use.toolCallId,
				toolId: use.name,
				parameters: use.parameters as Record<string, unknown>,
				context: { sessionResource: request.sessionResource, ...(request.workingDirectory ? { workingDirectory: request.workingDirectory } : {}) },
				chatRequestId: request.requestId,
				modelId: request.userSelectedModelId,
				userSelectedTools: this._requestTools.get(request.requestId) ?? request.userSelectedTools
			}, countTokens, token);
			return toolResultPart(toolResultToText(result), !!result.toolResultError);
		} catch (error) {
			if (isCancellationError(error) || token.isCancellationRequested) {
				throw error;
			}
			return toolResultPart(error instanceof Error ? error.message : String(error), true);
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
			if (this.mode !== ChatModeKind.Agent && isAgentModeOnlyTool(tool.id)) {
				continue;
			}
			result.push(tool);
		}
		return result;
	}
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
 * Replays prior turns as plain text. Tool calls from earlier turns are not
 * reconstructed: their results are already reflected in the assistant text,
 * and replaying `tool_use` parts without matching `tool_result` parts is
 * rejected by strict OpenAI-compatible endpoints.
 */
function toHistoryMessages(history: readonly IChatAgentHistoryEntry[]): IChatMessage[] {
	const messages: IChatMessage[] = [];
	for (const entry of history) {
		messages.push({ role: ChatMessageRole.User, content: [{ type: 'text', value: entry.request.message }] });
		const text = entry.response
			.map(part => part.kind === 'markdownContent' ? part.content.value : '')
			.filter(value => value.length > 0)
			.join('');
		if (text) {
			messages.push({ role: ChatMessageRole.Assistant, content: [{ type: 'text', value: text }] });
		}
	}
	return messages;
}

function truncate(text: string): string {
	if (text.length <= MAX_TOOL_RESULT_CHARS) {
		return text;
	}
	return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n...[truncated ${text.length - MAX_TOOL_RESULT_CHARS} characters]`;
}
