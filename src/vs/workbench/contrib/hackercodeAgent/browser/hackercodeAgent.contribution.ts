/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IPreferencesService } from '../../../services/preferences/common/preferences.js';
import { nullExtensionDescription } from '../../../services/extensions/common/extensions.js';
import { ChatAgentLocation, ChatConfiguration, ChatModeKind } from '../../chat/common/constants.js';
import { ILanguageModelsService } from '../../chat/common/languageModels.js';
import { IChatAgentService } from '../../chat/common/participants/chatAgents.js';
import { ILanguageModelToolsService, ToolDataSource } from '../../chat/common/tools/languageModelToolsService.js';
import { HACKERCODE_AGENT_PROVIDERS_CONFIG_KEY, IHackerCodeAgentProviderConfigValue, readHackerCodeAgentProviderConfigs } from '../common/hackerCodeAgentConfiguration.js';
import { HACKERCODE_AGENT_ADD_PROVIDER_COMMAND_ID, HACKERCODE_AGENT_ID, HACKERCODE_AGENT_MANAGE_PROVIDERS_COMMAND_ID, HACKERCODE_AGENT_VENDOR } from '../common/hackerCodeAgentVendor.js';
import { deleteHackerCodeAgentProviderApiKey, writeHackerCodeAgentProviderApiKey } from '../common/hackerCodeAgentSecrets.js';
import { HackerCodeChatAgent } from './hackerCodeChatAgent.js';
import { HackerCodeControlTool, HackerCodeToolData, HackerCodeToolId, isMutatingHackerCodeTool } from './hackerCodeAgentTools.js';
import { HackerCodeCoreTool, HackerCodeCoreToolData, HackerCodeCoreToolId } from './hackerCodeCoreTools.js';
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

		const providers = readHackerCodeAgentProviderConfigs(configurationService);
		const picked = await quickInputService.pick([
			{
				label: localize('hackerCodeAgent.addProviderPick', "Add a provider..."),
				detail: localize('hackerCodeAgent.addProviderPickDetail', "Name, base URL, and optional API key for an OpenAI-compatible endpoint"),
				id: '$add'
			},
			...providers.map(provider => ({
				label: provider.label || provider.id,
				description: provider.baseUrl,
				detail: localize('hackerCodeAgent.setApiKey', "Set the API key for this provider"),
				id: provider.id
			})),
			{
				label: localize('hackerCodeAgent.editProviders', "Edit providers in Settings..."),
				detail: localize('hackerCodeAgent.editProvidersDetail', "Open the HackerCode Agent section of Settings"),
				id: '$settings'
			}
		], { placeHolder: localize('hackerCodeAgent.pickProvider', "Configure a HackerCode model provider") });

		if (!picked) {
			return;
		}
		if (picked.id === '$add') {
			await addHackerCodeProvider(quickInputService, configurationService, secretStorageService);
			return;
		}
		if (picked.id === '$settings') {
			await preferencesService.openSettings({ query: `@id:${HACKERCODE_AGENT_PROVIDERS_CONFIG_KEY}` });
			return;
		}

		const apiKey = await quickInputService.input({
			password: true,
			placeHolder: localize('hackerCodeAgent.apiKeyPlaceholder', "Paste the API key, or leave empty to remove it"),
			prompt: localize('hackerCodeAgent.apiKeyPrompt', "The key is stored in OS-backed secret storage, never in settings.")
		});
		if (apiKey === undefined) {
			return;
		}
		if (apiKey) {
			await writeHackerCodeAgentProviderApiKey(secretStorageService, picked.id, apiKey);
		} else {
			await deleteHackerCodeAgentProviderApiKey(secretStorageService, picked.id);
		}
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
			accessor.get(ISecretStorageService)
		);
	}
}

async function addHackerCodeProvider(
	quickInputService: IQuickInputService,
	configurationService: IConfigurationService,
	secretStorageService: ISecretStorageService
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
		prompt: localize('hackerCodeAgent.add.baseUrlPrompt', "The base URL of an OpenAI-compatible API.")
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
	const next: IHackerCodeAgentProviderConfigValue[] = [...existing, { id, label, baseUrl, models: [] }];
	await configurationService.updateValue(
		HACKERCODE_AGENT_PROVIDERS_CONFIG_KEY,
		next,
		ConfigurationTarget.APPLICATION
	);
	if (apiKey) {
		await writeHackerCodeAgentProviderApiKey(secretStorageService, id, apiKey);
	}
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
