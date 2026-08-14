/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceTimeout } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { normalizeChatBaseUrl } from '../../../../platform/hackercode/common/hackerCodeChat.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IPreferencesService } from '../../../services/preferences/common/preferences.js';
import { nullExtensionDescription } from '../../../services/extensions/common/extensions.js';
import { ChatAgentLocation, ChatConfiguration, ChatModeKind, MANAGE_CHAT_COMMAND_ID } from '../../chat/common/constants.js';
import { ILanguageModelsService } from '../../chat/common/languageModels.js';
import { IChatAgentService } from '../../chat/common/participants/chatAgents.js';
import { ILanguageModelToolsService, ToolDataSource } from '../../chat/common/tools/languageModelToolsService.js';
import { HACKERCODE_AGENT_PROVIDERS_CONFIG_KEY, IHackerCodeAgentProviderConfigValue, readHackerCodeAgentProviderConfigs } from '../common/hackerCodeAgentConfiguration.js';
import { HACKERCODE_AGENT_ADD_PROVIDER_COMMAND_ID, HACKERCODE_AGENT_ID, HACKERCODE_AGENT_MANAGE_PROVIDERS_COMMAND_ID, HACKERCODE_AGENT_VENDOR } from '../common/hackerCodeAgentVendor.js';
import { deleteHackerCodeAgentProviderApiKey, readHackerCodeAgentProviderApiKey, writeHackerCodeAgentProviderApiKey } from '../common/hackerCodeAgentSecrets.js';
import { HackerCodeChatAgent } from './hackerCodeChatAgent.js';
import { HackerCodeControlTool, HackerCodeToolData, HackerCodeToolId, isMutatingHackerCodeTool } from './hackerCodeAgentTools.js';
import { HackerCodeCoreTool, HackerCodeCoreToolData, HackerCodeCoreToolId } from './hackerCodeCoreTools.js';
import { HackerCodeExtensionTool, HackerCodeExtensionToolData, HackerCodeExtensionToolId } from './hackerCodeExtensionTools.js';
import { HackerCodeLanguageModelProvider } from './hackerCodeLanguageModelProvider.js';
import '../common/hackerCodeAgentConfiguration.js';

/**
 * Wires the HackerCode agent into VS Code's built-in chat: the configured
 * OpenAI-compatible providers become selectable language models, the default
 * chat participant runs the tool-calling loop, and the HackerCode control
 * plane plus the workspace reading tools are registered as chat tools.
 *
 * There is no separate agent view and no external driver process; the chat
 * panel is the only surface.
 */
class HackerCodeAgentContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.hackerCodeAgent';

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@ILanguageModelsService languageModelsService: ILanguageModelsService,
		@IChatAgentService chatAgentService: IChatAgentService,
		@ILanguageModelToolsService toolsService: ILanguageModelToolsService,
	) {
		super();

		// Language models. The vendor descriptor must exist before the provider is
		// registered, and is removed again on dispose so a reload does not leave a
		// dangling vendor behind.
		const vendorDescriptor = {
			vendor: HACKERCODE_AGENT_VENDOR,
			displayName: 'HackerCode',
			managementCommand: HACKERCODE_AGENT_MANAGE_PROVIDERS_COMMAND_ID,
			configuration: undefined,
			when: undefined
		};
		languageModelsService.deltaLanguageModelChatProviderDescriptors([vendorDescriptor], []);
		this._register(toDisposable(() => languageModelsService.deltaLanguageModelChatProviderDescriptors([], [vendorDescriptor])));
		const provider = this._register(instantiationService.createInstance(HackerCodeLanguageModelProvider));
		this._register(languageModelsService.registerLanguageModelProvider(HACKERCODE_AGENT_VENDOR, provider));
		// After registration, so the resulting change event is observed: the chat
		// service resolves a provider's models on change, not on registration.
		provider.refreshModels();

		// Tools. Registered before the participants so the first turn already sees
		// the full set. The HackerCode tool set is the named group in both the
		// chat tools picker and Chat Customizations → Tools; without it the
		// tools dump into the anonymous Built-In bucket (or nowhere, in the
		// Customizations editor, which hides deprecated groupings).
		const hackerCodeToolSet = this._register(toolsService.createToolSet(
			ToolDataSource.Internal,
			'hackercode',
			'hackercode',
			{
				icon: ThemeIcon.fromId(Codicon.hubot.id),
				description: localize('hackerCodeAgent.toolSet.description', "HackerCode"),
				detail: localize('hackerCodeAgent.toolSet.detail', "Read the workspace and operate the HackerCode runtime patch control plane.")
			}
		));
		for (const data of HackerCodeToolData) {
			const tool = this._register(instantiationService.createInstance(HackerCodeControlTool, data.id as HackerCodeToolId));
			this._register(toolsService.registerTool(data, tool));
			this._register(hackerCodeToolSet.addTool(data));
			if (!isMutatingHackerCodeTool(data.id)) {
				this._register(toolsService.readToolSet.addTool(data));
			}
		}
		for (const data of HackerCodeCoreToolData) {
			const tool = this._register(instantiationService.createInstance(HackerCodeCoreTool, data.id as HackerCodeCoreToolId));
			this._register(toolsService.registerTool(data, tool));
			this._register(hackerCodeToolSet.addTool(data));
			this._register(toolsService.readToolSet.addTool(data));
		}
		for (const data of HackerCodeExtensionToolData) {
			const tool = this._register(instantiationService.createInstance(HackerCodeExtensionTool, data.id as HackerCodeExtensionToolId));
			this._register(toolsService.registerTool(data, tool));
			this._register(hackerCodeToolSet.addTool(data));
			// Deliberately not in the read tool set: installing is a mutation.
		}

		// Participants. One per mode, because the chat service resolves the default
		// agent by (location, mode) and that is how a participant learns its mode.
		for (const mode of [ChatModeKind.Ask, ChatModeKind.Edit, ChatModeKind.Agent]) {
			this._register(this._registerAgent(instantiationService, chatAgentService, mode));
		}
	}

	private _registerAgent(instantiationService: IInstantiationService, chatAgentService: IChatAgentService, mode: ChatModeKind): DisposableStore {
		const store = new DisposableStore();
		const id = `${HACKERCODE_AGENT_ID}.${mode}`;

		store.add(chatAgentService.registerAgent(id, {
			id,
			name: 'HackerCode',
			fullName: 'HackerCode',
			description: DESCRIPTIONS[mode],
			isDefault: true,
			isCore: true,
			modes: [mode],
			// Agent mode is only offered when agentic tool use is allowed at all.
			when: mode === ChatModeKind.Agent ? ContextKeyExpr.has(`config.${ChatConfiguration.AgentEnabled}`).serialize() : undefined,
			locations: [ChatAgentLocation.Chat],
			slashCommands: [],
			disambiguation: [],
			metadata: { themeIcon: mode === ChatModeKind.Agent ? Codicon.tools : Codicon.hubot },
			extensionId: nullExtensionDescription.identifier,
			extensionVersion: undefined,
			extensionDisplayName: nullExtensionDescription.name,
			extensionPublisherId: nullExtensionDescription.publisher
		}));

		const agent = store.add(instantiationService.createInstance(HackerCodeChatAgent, mode));
		store.add(chatAgentService.registerAgentImplementation(id, agent));

		return store;
	}
}

const DESCRIPTIONS: { readonly [K in ChatModeKind]?: string } = {
	[ChatModeKind.Ask]: localize('hackerCodeAgent.description.ask', "Ask about your code and the HackerCode runtime"),
	[ChatModeKind.Edit]: localize('hackerCodeAgent.description.edit', "Edit files in your workspace"),
	[ChatModeKind.Agent]: localize('hackerCodeAgent.description.agent', "Build, patch and operate the HackerCode runtime")
};

const HACKERCODE_CATEGORY = localize2('hackerCode', "HackerCode");

/**
 * The model picker's gear action for the HackerCode vendor: add a provider,
 * set an API key, or jump to the provider list in settings.
 */
class ManageHackerCodeProvidersAction extends Action2 {
	constructor() {
		super({
			id: HACKERCODE_AGENT_MANAGE_PROVIDERS_COMMAND_ID,
			title: localize2('hackerCodeAgent.manageProviders', "Manage Model Providers"),
			category: HACKERCODE_CATEGORY,
			f1: true,
			menu: [
				{ id: MenuId.MenubarPreferencesMenu, group: '2_configuration', order: 8 },
				{ id: MenuId.ChatTitleBarMenu, group: 'z_manage', order: 2 }
			]
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const configurationService = accessor.get(IConfigurationService);
		const secretStorageService = accessor.get(ISecretStorageService);
		const preferencesService = accessor.get(IPreferencesService);
		const commandService = accessor.get(ICommandService);
		const notificationService = accessor.get(INotificationService);

		// Loops rather than returning after each change: the settings editor
		// cannot render an array of objects, so this picker is the only place
		// the provider list is ever shown, and it has to reflect an edit the
		// moment the edit is made.
		for (; ;) {
			const providers = readHackerCodeAgentProviderConfigs(configurationService);
			// In parallel: a stalled secret store costs one timeout for the
			// whole list rather than one per provider.
			const providerItems: IQuickPickItem[] = await Promise.all(providers.map(async provider => ({
				id: provider.id,
				label: provider.label || provider.id,
				description: provider.baseUrl,
				detail: await describeProvider(secretStorageService, provider)
			})));

			const picked = await quickInputService.pick<IQuickPickItem>([
				...(providerItems.length
					? [{ type: 'separator', label: localize('hackerCodeAgent.providersGroup', "Providers") } satisfies IQuickPickSeparator, ...providerItems]
					: [{ type: 'separator', label: localize('hackerCodeAgent.noProviders', "No providers configured yet") } satisfies IQuickPickSeparator]),
				{ type: 'separator' } satisfies IQuickPickSeparator,
				{ id: '$add', label: `$(add) ${localize('hackerCodeAgent.addProviderPick', "Add a provider...")}` },
				{ id: '$models', label: `$(list-selection) ${localize('hackerCodeAgent.showModels', "Show models...")}` },
				{ id: '$settings', label: `$(json) ${localize('hackerCodeAgent.editProviders', "Edit providers in settings.json...")}` }
			], { placeHolder: localize('hackerCodeAgent.pickProvider', "HackerCode model providers") });

			if (!picked) {
				return;
			}
			if (picked.id === '$add') {
				await addHackerCodeProvider(quickInputService, configurationService, secretStorageService, notificationService);
				continue;
			}
			if (picked.id === '$models') {
				await commandService.executeCommand(MANAGE_CHAT_COMMAND_ID);
				return;
			}
			if (picked.id === '$settings') {
				await preferencesService.openSettings({ query: `@id:${HACKERCODE_AGENT_PROVIDERS_CONFIG_KEY}` });
				return;
			}

			const provider = providers.find(candidate => candidate.id === picked.id);
			if (provider) {
				await configureHackerCodeProvider(quickInputService, configurationService, secretStorageService, notificationService, provider);
			}
		}
	}
}

/**
 * OS-backed secret storage is a remote service that can fail or, on a machine
 * with no keyring, hang indefinitely. An unawaitable promise in here used to
 * take the whole picker down with it, silently, discarding whatever the user
 * had just typed -- so every secret operation is bounded and reported.
 */
const SECRET_STORAGE_TIMEOUT = 5000;

type ApiKeyStatus = 'set' | 'unset' | 'unavailable';

async function readApiKeyStatus(secretStorageService: ISecretStorageService, providerId: string): Promise<ApiKeyStatus> {
	try {
		const apiKey = await raceTimeout(readHackerCodeAgentProviderApiKey(secretStorageService, providerId), SECRET_STORAGE_TIMEOUT);
		return apiKey === undefined ? 'unavailable' : apiKey ? 'set' : 'unset';
	} catch {
		return 'unavailable';
	}
}

async function storeApiKey(
	notificationService: INotificationService,
	secretStorageService: ISecretStorageService,
	providerId: string,
	apiKey: string
): Promise<void> {
	const write = apiKey
		? writeHackerCodeAgentProviderApiKey(secretStorageService, providerId, apiKey)
		: deleteHackerCodeAgentProviderApiKey(secretStorageService, providerId);
	try {
		let timedOut = false;
		await raceTimeout(write, SECRET_STORAGE_TIMEOUT, () => { timedOut = true; });
		if (timedOut) {
			throw new Error(localize('hackerCodeAgent.secretTimeout', "the OS secret store did not respond"));
		}
	} catch (error) {
		notificationService.error(localize(
			'hackerCodeAgent.secretFailed',
			"The HackerCode provider was saved, but its API key could not be written to secret storage: {0}",
			toErrorMessage(error)
		));
	}
}

async function describeProvider(secretStorageService: ISecretStorageService, provider: IHackerCodeAgentProviderConfigValue): Promise<string> {
	const status = await readApiKeyStatus(secretStorageService, provider.id);
	const key = status === 'set'
		? localize('hackerCodeAgent.apiKeySet', "API key set")
		: status === 'unset'
			? localize('hackerCodeAgent.apiKeyMissing', "No API key")
			: localize('hackerCodeAgent.apiKeyUnavailable', "Secret storage unavailable");
	const models = provider.models.length
		? localize('hackerCodeAgent.modelCount', "{0} model(s)", provider.models.length)
		: localize('hackerCodeAgent.modelsDiscovered', "models discovered from /models");
	return `${key} \u00b7 ${models}`;
}

async function configureHackerCodeProvider(
	quickInputService: IQuickInputService,
	configurationService: IConfigurationService,
	secretStorageService: ISecretStorageService,
	notificationService: INotificationService,
	provider: IHackerCodeAgentProviderConfigValue
): Promise<void> {
	const hasApiKey = await readApiKeyStatus(secretStorageService, provider.id) === 'set';
	const action = await quickInputService.pick<IQuickPickItem>([
		{ id: '$key', label: localize('hackerCodeAgent.setApiKey', "Set API key") },
		...(hasApiKey ? [{ id: '$clearKey', label: localize('hackerCodeAgent.clearApiKey', "Remove API key") }] : []),
		{ id: '$baseUrl', label: localize('hackerCodeAgent.changeBaseUrl', "Change base URL"), description: provider.baseUrl },
		{ id: '$remove', label: localize('hackerCodeAgent.removeProvider', "Remove provider") }
	], { placeHolder: provider.label || provider.id });

	if (action?.id === '$key') {
		const apiKey = await quickInputService.input({
			password: true,
			prompt: localize('hackerCodeAgent.apiKeyPrompt', "The key is stored in OS-backed secret storage, never in settings.")
		});
		if (apiKey) {
			await storeApiKey(notificationService, secretStorageService, provider.id, apiKey);
		}
	} else if (action?.id === '$clearKey') {
		await storeApiKey(notificationService, secretStorageService, provider.id, '');
	} else if (action?.id === '$baseUrl') {
		const baseUrl = await quickInputService.input({
			value: provider.baseUrl,
			prompt: localize('hackerCodeAgent.add.baseUrlPrompt', "The base URL of an OpenAI-compatible API. A trailing /chat/completions is trimmed for you.")
		});
		if (baseUrl) {
			await writeProviders(configurationService, readHackerCodeAgentProviderConfigs(configurationService)
				.map(candidate => candidate.id === provider.id ? { ...candidate, baseUrl: normalizeChatBaseUrl(baseUrl) } : candidate));
		}
	} else if (action?.id === '$remove') {
		await writeProviders(configurationService, readHackerCodeAgentProviderConfigs(configurationService)
			.filter(candidate => candidate.id !== provider.id));
		await storeApiKey(notificationService, secretStorageService, provider.id, '');
	}
}

/**
 * Adds a provider entry to the settings list, so a first-run user can get to a
 * working model without hand-editing JSON.
 */
class AddHackerCodeProviderAction extends Action2 {
	constructor() {
		super({
			id: HACKERCODE_AGENT_ADD_PROVIDER_COMMAND_ID,
			title: localize2('hackerCodeAgent.addProvider', "Add Model Provider"),
			category: HACKERCODE_CATEGORY,
			f1: true
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await addHackerCodeProvider(
			accessor.get(IQuickInputService),
			accessor.get(IConfigurationService),
			accessor.get(ISecretStorageService),
			accessor.get(INotificationService)
		);
	}
}

async function addHackerCodeProvider(
	quickInputService: IQuickInputService,
	configurationService: IConfigurationService,
	secretStorageService: ISecretStorageService,
	notificationService: INotificationService
): Promise<void> {
	const label = await quickInputService.input({
		placeHolder: localize('hackerCodeAgent.add.labelPlaceholder', "A display name, e.g. OpenAI"),
		prompt: localize('hackerCodeAgent.add.labelPrompt', "What should this provider be called?")
	});
	if (!label) {
		return;
	}
	const baseUrl = await quickInputService.input({
		placeHolder: 'https://api.openai.com/v1',
		prompt: localize('hackerCodeAgent.add.baseUrlPrompt', "The base URL of an OpenAI-compatible API. A trailing /chat/completions is trimmed for you.")
	});
	if (!baseUrl) {
		return;
	}
	const apiKey = await quickInputService.input({
		password: true,
		prompt: localize('hackerCodeAgent.add.apiKeyPrompt', "API key, stored in OS-backed secret storage. Leave empty for an endpoint that needs none.")
	});
	if (apiKey === undefined) {
		return;
	}

	const existing = readHackerCodeAgentProviderConfigs(configurationService);
	const id = toProviderId(label, existing.map(provider => provider.id));
	// Settings before secret storage: settings is the durable record of what
	// the user typed, and the key can be retried from the provider's own menu.
	await writeProviders(configurationService, [...existing, { id, label, baseUrl: normalizeChatBaseUrl(baseUrl), models: [] }]);
	if (apiKey) {
		await storeApiKey(notificationService, secretStorageService, id, apiKey);
	}
}

function writeProviders(configurationService: IConfigurationService, providers: readonly IHackerCodeAgentProviderConfigValue[]): Promise<void> {
	return configurationService.updateValue(
		HACKERCODE_AGENT_PROVIDERS_CONFIG_KEY,
		providers,
		ConfigurationTarget.APPLICATION
	);
}

function toProviderId(label: string, taken: readonly string[]): string {
	const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'provider';
	if (!taken.includes(base)) {
		return base;
	}
	for (let index = 2; ; index++) {
		const candidate = `${base}-${index}`;
		if (!taken.includes(candidate)) {
			return candidate;
		}
	}
}

registerAction2(ManageHackerCodeProvidersAction);
registerAction2(AddHackerCodeProviderAction);

// BlockRestore, not AfterRestored: a restored chat session resolves the default
// agent while the window restores its UI state, and fails the turn if none is
// registered yet.
registerWorkbenchContribution2(HackerCodeAgentContribution.ID, HackerCodeAgentContribution, WorkbenchPhase.BlockRestore);
