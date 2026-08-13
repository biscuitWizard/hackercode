/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { streamChatCompletion } from '../llm/openaiClient.mjs';
import { allowedToolNamesForMode, isValidMode } from './modes.mjs';
import { buildSystemPrompt } from './systemPrompt.mjs';
import { TOOL_DEFINITIONS } from './tools.mjs';

const DEFAULT_MAX_STEPS = 8;
const MAX_TOOL_RESULT_CHARS = 32 * 1024;

/**
 * Runs one user turn to completion: send messages + the mode-filtered tool
 * set, stream deltas out through `onEvent`, execute any tool calls the model
 * requests (re-checking mode policy per call, never trusting the model's
 * belief about what it is allowed to do), append results, and repeat until
 * the model stops calling tools or the step budget is exhausted.
 *
 * This is the one place that ties the LLM client, the tool policy, and the
 * control-plane tool handlers together; it holds no HTTP or control-plane
 * code itself.
 *
 * @param {{
 *   sessionState: import('../sessions.mjs').SessionState,
 *   controlSession: import('../control/session.mjs').HackerCodeControlSession,
 *   provider: { id: string, baseUrl: string, apiKey?: string },
 *   model: string,
 *   mode: 'ask' | 'plan' | 'agent',
 *   toolHandlers: Record<string, (args: object) => Promise<unknown>>,
 *   userText: string,
 *   onEvent?: (event: object) => void,
 *   maxSteps?: number,
 *   signal?: AbortSignal
 * }} params
 */
export async function runAgentTurn(params) {
	const {
		sessionState,
		controlSession,
		provider,
		model,
		mode,
		toolHandlers,
		userText,
		onEvent,
		maxSteps = DEFAULT_MAX_STEPS,
		signal
	} = params;

	if (!isValidMode(mode)) {
		throw new Error(`Unknown agent mode: ${mode}`);
	}

	sessionState.mode = mode;
	sessionState.messages.push({ role: 'user', content: userText });

	let controlState;
	try {
		controlState = await controlSession.getState();
	} catch {
		controlState = undefined;
	}

	const systemPrompt = buildSystemPrompt({ mode, controlState });
	const allowedNames = allowedToolNamesForMode(mode);
	const tools = TOOL_DEFINITIONS.filter(definition => allowedNames.includes(definition.function.name));

	for (let step = 0; step < maxSteps; step++) {
		const messages = [{ role: 'system', content: systemPrompt }, ...sessionState.messages];

		const assistantMessage = await streamChatCompletion(provider, {
			model,
			messages,
			tools,
			signal,
			onEvent: event => onEvent?.({ ...event, step })
		});

		sessionState.messages.push({
			role: 'assistant',
			content: assistantMessage.content,
			...(assistantMessage.toolCalls.length > 0 ? { tool_calls: assistantMessage.toolCalls } : {})
		});

		if (assistantMessage.toolCalls.length === 0) {
			onEvent?.({ type: 'turn_complete', step, finishReason: assistantMessage.finishReason });
			return sessionState;
		}

		for (const toolCall of assistantMessage.toolCalls) {
			const name = toolCall.function.name;
			let args;
			let result;
			try {
				args = parseToolArguments(toolCall.function.arguments);
				onEvent?.({ type: 'tool_call', step, id: toolCall.id, name, arguments: args });

				if (!allowedNames.includes(name)) {
					throw new Error(`Tool "${name}" is not permitted in "${mode}" mode.`);
				}
				const handler = toolHandlers[name];
				if (!handler) {
					throw new Error(`No handler is registered for tool "${name}".`);
				}
				result = await handler(args);
			} catch (error) {
				result = { ok: false, error: error instanceof Error ? error.message : String(error) };
			}

			onEvent?.({ type: 'tool_result', step, id: toolCall.id, name, result });
			sessionState.messages.push({
				role: 'tool',
				tool_call_id: toolCall.id,
				content: safeStringifyToolResult(result)
			});
		}
	}

	onEvent?.({ type: 'step_budget_exhausted', maxSteps });
	return sessionState;
}

function parseToolArguments(rawArguments) {
	if (!rawArguments || rawArguments.trim().length === 0) {
		return {};
	}
	try {
		return JSON.parse(rawArguments);
	} catch {
		throw new Error('Tool call arguments were not valid JSON');
	}
}

function safeStringifyToolResult(result) {
	let text;
	try {
		text = JSON.stringify(result);
	} catch {
		text = JSON.stringify({ ok: false, error: 'Tool result could not be serialized' });
	}
	if (text.length > MAX_TOOL_RESULT_CHARS) {
		return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n...[truncated ${text.length - MAX_TOOL_RESULT_CHARS} characters]`;
	}
	return text;
}
