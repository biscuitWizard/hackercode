/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AsyncIterableObject, DeferredPromise } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import {
	HackerCodeWireMessage,
	IHackerCodeChatEndpoint,
	IHackerCodeChatRelayService,
	IHackerCodeWireTool,
	IHackerCodeWireToolCall
} from '../../../../platform/hackercode/common/hackerCodeChat.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { nullExtensionDescription } from '../../../services/extensions/common/extensions.js';
import {
	ChatMessageRole,
	IChatMessage,
	IChatResponsePart,
	ILanguageModelChatMetadataAndIdentifier,
	ILanguageModelChatProvider,
	ILanguageModelChatRequestOptions,
	ILanguageModelChatResponse
} from '../../chat/common/languageModels.js';
import { HACKERCODE_AGENT_PROVIDERS_CONFIG_KEY } from '../common/hackerCodeAgentConfiguration.js';
import { HACKERCODE_AGENT_VENDOR } from '../common/hackerCodeAgentVendor.js';
import { getInvalidToolArguments, parseToolCallArguments } from '../common/hackerCodeToolArguments.js';
import { IResolvedHackerCodeAgentProvider, resolveHackerCodeAgentProviders } from './hackerCodeAgentProviders.js';

/**
 * Conservative context window used when a provider does not advertise one.
 * OpenAI-compatible `/models` responses rarely carry token limits, and the
 * chat UI only uses these for display and budget heuristics.
 */
const DEFAULT_MAX_INPUT_TOKENS = 128_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;

/**
 * Exposes every model of every configured HackerCode provider as a selectable
 * language model, and serves chat requests against the provider's
 * OpenAI-compatible endpoint.
 *
 * Model identifiers are `<vendor>:<providerId>/<modelId>` so a request can be
 * routed back to the endpoint and API key it came from. `providerId` is a
 * stable user-chosen id, so identifiers survive a base-URL change.
 *
 * The HTTP itself runs in the main process behind
 * {@link IHackerCodeChatRelayService}; see `platform/hackercode/common/hackerCodeChat.ts`
 * for why the renderer cannot make these requests.
 */
export class HackerCodeLanguageModelProvider extends Disposable implements ILanguageModelChatProvider {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	/** Model ids discovered from a provider's `/models` when its config lists none. */
	private readonly _discoveredModels = new Map<string, readonly string[]>();

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@IHackerCodeChatRelayService private readonly relayService: IHackerCodeChatRelayService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(HACKERCODE_AGENT_PROVIDERS_CONFIG_KEY)) {
				this._discoveredModels.clear();
				this._onDidChange.fire();
			}
		}));
		this._register(this.secretStorageService.onDidChangeSecret(() => this._onDidChange.fire()));
	}

	/**
	 * Asks the chat service to re-read our models. Registration alone does not
	 * resolve a provider, so the first call has to come from us.
	 */
	refreshModels(): void {
		this._onDidChange.fire();
	}

	async provideLanguageModelChatInfo(_options: { silent: boolean }, token: CancellationToken): Promise<ILanguageModelChatMetadataAndIdentifier[]> {
		const providers = await resolveHackerCodeAgentProviders(this.configurationService, this.secretStorageService);
		const result: ILanguageModelChatMetadataAndIdentifier[] = [];

		for (const provider of providers) {
			if (!provider.baseUrl) {
				continue;
			}
			const models = await this._modelsFor(provider, token);
			for (const model of models) {
				result.push({
					identifier: toModelIdentifier(provider.id, model),
					metadata: {
						extension: nullExtensionDescription.identifier,
						name: model,
						id: model,
						vendor: HACKERCODE_AGENT_VENDOR,
						version: '1.0',
						family: model,
						maxInputTokens: DEFAULT_MAX_INPUT_TOKENS,
						maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
						isDefaultForLocation: {},
						isUserSelectable: true,
						isBYOK: true,
						// All models share one vendor, so bucket them in the picker by the
						// provider they came from. Presentation only; routing stays by vendor.
						modelGroup: { id: provider.id },
						capabilities: { toolCalling: true, agentMode: true }
					}
				});
			}
		}

		return result;
	}

	/**
	 * The configured model list, or the endpoint's own `/models` list when the
	 * configuration leaves it empty. Discovery is cached until the provider
	 * configuration changes so the picker does not re-request on every open.
	 */
	private async _modelsFor(provider: IResolvedHackerCodeAgentProvider, token: CancellationToken): Promise<readonly string[]> {
		if (provider.models.length > 0) {
			return provider.models;
		}
		const cached = this._discoveredModels.get(provider.id);
		if (cached) {
			return cached;
		}
		try {
			const models = await this.relayService.listModels(provider);
			if (token.isCancellationRequested) {
				return [];
			}
			this._discoveredModels.set(provider.id, models);
			return models;
		} catch (error) {
			this.logService.warn(`[HackerCode] Could not list models for provider "${provider.id}": ${error}`);
			return [];
		}
	}

	async sendChatRequest(modelId: string, messages: IChatMessage[], _from: ExtensionIdentifier | undefined, options: ILanguageModelChatRequestOptions, token: CancellationToken): Promise<ILanguageModelChatResponse> {
		const parsed = parseModelIdentifier(modelId);
		if (!parsed) {
			throw new Error(`Not a HackerCode model identifier: ${modelId}`);
		}
		const providers = await resolveHackerCodeAgentProviders(this.configurationService, this.secretStorageService);
		const provider = providers.find(candidate => candidate.id === parsed.providerId);
		if (!provider) {
			throw new Error(`HackerCode provider "${parsed.providerId}" is no longer configured.`);
		}

		const endpoint: IHackerCodeChatEndpoint = { baseUrl: provider.baseUrl, apiKey: provider.apiKey };
		const wireMessages = toWireMessages(messages);
		const tools = toWireTools(options.tools);
		const requestId = generateUuid();

		// The stream is produced eagerly into an AsyncIterableObject so a slow
		// consumer cannot stall the relay, matching how the extension-host bridge
		// behaves for provider-supplied streams.
		const result = new DeferredPromise<void>();
		const stream = new AsyncIterableObject<IChatResponsePart>(async emitter => {
			const listeners = new DisposableStore();
			// Subscribe before starting, so no delta is missed: the channel delivers
			// the subscription before the request that produces the deltas.
			listeners.add(this.relayService.onDynamicDidStreamChatText(requestId)(delta => emitter.emitOne({ type: 'text', value: delta })));
			listeners.add(token.onCancellationRequested(() => this.relayService.cancelChatCompletion(requestId)));
			try {
				const message = await this.relayService.startChatCompletion({
					requestId,
					endpoint,
					model: parsed.modelId,
					messages: wireMessages,
					tools
				});
				for (const toolCall of message.toolCalls) {
					emitter.emitOne({
						type: 'tool_use',
						name: toolCall.function.name,
						toolCallId: toolCall.id,
						parameters: parseToolCallArguments(toolCall.function.arguments)
					});
				}
				result.complete(undefined);
			} catch (error) {
				result.error(error);
				throw error;
			} finally {
				listeners.dispose();
			}
		});

		return { stream, result: result.p };
	}

	async provideTokenCount(_modelId: string, message: string | IChatMessage, _token: CancellationToken): Promise<number> {
		const text = typeof message === 'string' ? message : messageToText(message);
		// A rough 4-characters-per-token estimate. OpenAI-compatible endpoints do
		// not expose a tokenizer, and callers use this only for budgeting.
		return Math.ceil(text.length / 4);
	}
}

export function toModelIdentifier(providerId: string, modelId: string): string {
	return `${HACKERCODE_AGENT_VENDOR}:${providerId}/${modelId}`;
}

export function parseModelIdentifier(identifier: string): { providerId: string; modelId: string } | undefined {
	const prefix = `${HACKERCODE_AGENT_VENDOR}:`;
	if (!identifier.startsWith(prefix)) {
		return undefined;
	}
	const rest = identifier.slice(prefix.length);
	const separator = rest.indexOf('/');
	if (separator <= 0 || separator === rest.length - 1) {
		return undefined;
	}
	return { providerId: rest.slice(0, separator), modelId: rest.slice(separator + 1) };
}

/**
 * Flattens the workbench's structured chat messages into the OpenAI wire
 * format. Tool results are hoisted into their own `tool` messages because the
 * OpenAI protocol carries them as separate turns rather than user content.
 */
function toWireMessages(messages: readonly IChatMessage[]): HackerCodeWireMessage[] {
	const result: HackerCodeWireMessage[] = [];

	for (const message of messages) {
		const text: string[] = [];
		const toolCalls: IHackerCodeWireToolCall[] = [];
		const toolResults: HackerCodeWireMessage[] = [];

		for (const part of message.content) {
			switch (part.type) {
				case 'text':
					text.push(part.value);
					break;
				case 'tool_use':
					toolCalls.push({
						id: part.toolCallId,
						type: 'function',
						function: { name: part.name, arguments: toWireArguments(part.parameters) }
					});
					break;
				case 'tool_result':
					toolResults.push({
						role: 'tool',
						tool_call_id: part.toolCallId,
						content: part.value.map(value => value.type === 'text' ? value.value : '').join('')
					});
					break;
				// Images, binary data and encrypted thinking have no representation in
				// the plain OpenAI chat-completions shape and are dropped.
			}
		}

		switch (message.role) {
			case ChatMessageRole.System:
				result.push({ role: 'system', content: text.join('') });
				break;
			case ChatMessageRole.Assistant:
				result.push({
					role: 'assistant',
					content: text.join(''),
					...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
				});
				break;
			case ChatMessageRole.User:
				if (text.length > 0 || toolResults.length === 0) {
					result.push({ role: 'user', content: text.join('') });
				}
				break;
		}

		result.push(...toolResults);
	}

	return result;
}

/**
 * Arguments that failed to parse go back to the provider as the model wrote
 * them, so the replayed turn is what actually happened and the marker object
 * stays an internal detail rather than something the model has to interpret.
 */
function toWireArguments(parameters: object | undefined): string {
	return getInvalidToolArguments(parameters)?.raw ?? JSON.stringify(parameters ?? {});
}

function toWireTools(tools: unknown): IHackerCodeWireTool[] | undefined {
	if (!Array.isArray(tools) || tools.length === 0) {
		return undefined;
	}
	return tools.map((tool: any) => ({
		type: 'function' as const,
		function: {
			name: tool.name,
			description: tool.description ?? '',
			parameters: tool.parametersSchema ?? { type: 'object', properties: {} }
		}
	}));
}

function messageToText(message: IChatMessage): string {
	return message.content.map(part => part.type === 'text' ? part.value : '').join('');
}
