/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/hackerCodeAgentSettingsEditorPane.css';
import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { getErrorMessage } from '../../../../base/common/errors.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { HACKERCODE_AGENT_PROVIDERS_CONFIG_KEY, IHackerCodeAgentProviderConfigValue, readHackerCodeAgentProviderConfigs } from '../common/hackerCodeAgentConfiguration.js';
import { deleteHackerCodeAgentProviderApiKey, readHackerCodeAgentProviderApiKey, writeHackerCodeAgentProviderApiKey } from '../common/hackerCodeAgentSecrets.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { HackerCodeAgentSettingsInput } from './hackerCodeAgentSettingsInput.js';

interface IEditableProvider {
	id: string;
	label: string;
	baseUrl: string;
	models: string[];
	apiKey: string;
	hasStoredKey: boolean;
}

export class HackerCodeAgentSettingsEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.hackerCodeAgentSettings';

	private container: HTMLElement | undefined;
	private readonly renderDisposables = this._register(new DisposableStore());
	private providers: IEditableProvider[] = [];

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@INotificationService private readonly notificationService: INotificationService
	) {
		super(HackerCodeAgentSettingsEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = append(parent, $('div.hackercode-agent-settings-pane'));
	}

	override async setInput(input: HackerCodeAgentSettingsInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (token.isCancellationRequested || !this.container) {
			return;
		}
		await this.reload();
	}

	private async reload(): Promise<void> {
		const configs = readHackerCodeAgentProviderConfigs(this.configurationService);
		this.providers = await Promise.all(configs.map(async (config): Promise<IEditableProvider> => ({
			id: config.id,
			label: config.label,
			baseUrl: config.baseUrl,
			models: [...config.models],
			apiKey: '',
			hasStoredKey: (await readHackerCodeAgentProviderApiKey(this.secretStorageService, config.id)) !== undefined
		})));
		this.render();
	}

	private async persistProviders(): Promise<void> {
		const value: IHackerCodeAgentProviderConfigValue[] = this.providers.map(provider => ({
			id: provider.id,
			label: provider.label,
			baseUrl: provider.baseUrl,
			models: provider.models
		}));
		await this.configurationService.updateValue(HACKERCODE_AGENT_PROVIDERS_CONFIG_KEY, value, ConfigurationTarget.APPLICATION);
	}

	private render(): void {
		if (!this.container) {
			return;
		}
		this.renderDisposables.clear();
		clearNode(this.container);

		append(this.container, $('div.hca-settings-title')).textContent = localize('hackerCodeAgent.settings.title', "HackerCode Agent");
		append(this.container, $('div.hca-settings-description')).textContent = localize(
			'hackerCodeAgent.settings.description',
			"Configure OpenAI-compatible chat completions endpoints for the HackerCode agent. API keys are stored in OS-backed secret storage, not in settings.json."
		);

		for (const provider of this.providers) {
			this.renderProviderCard(provider);
		}

		const addRow = append(this.container, $('div.hca-add-provider-row'));
		const addButton = this.renderDisposables.add(new Button(addRow, { ...defaultButtonStyles }));
		addButton.label = localize('hackerCodeAgent.settings.addProvider', "+ Add provider");
		this.renderDisposables.add(addButton.onDidClick(() => {
			this.providers.push({ id: generateUuid(), label: 'New provider', baseUrl: '', models: [], apiKey: '', hasStoredKey: false });
			void this.persistProviders().then(() => this.render());
		}));
	}

	private renderProviderCard(provider: IEditableProvider): void {
		if (!this.container) {
			return;
		}
		const card = append(this.container, $('div.hca-provider-card'));

		this.renderTextField(card, localize('hackerCodeAgent.settings.label', "Label"), provider.label, value => {
			provider.label = value;
			void this.persistProviders();
		});

		this.renderTextField(card, localize('hackerCodeAgent.settings.baseUrl', "Base URL"), provider.baseUrl, value => {
			provider.baseUrl = value;
			void this.persistProviders();
		}, 'https://api.openai.com/v1');

		const keyRow = append(card, $('div.hca-field-row'));
		append(keyRow, $('label')).textContent = provider.hasStoredKey
			? localize('hackerCodeAgent.settings.apiKey.set', "API key (set — leave blank to keep it)")
			: localize('hackerCodeAgent.settings.apiKey.unset', "API key");
		const keyInput = append(keyRow, $('input.hca-text-input')) as HTMLInputElement;
		keyInput.type = 'password';
		keyInput.placeholder = provider.hasStoredKey ? '••••••••' : '';
		keyInput.autocomplete = 'off';
		this.renderDisposables.add(domChangeListener(keyInput, async () => {
			const value = keyInput.value.trim();
			if (value.length === 0) {
				return;
			}
			await writeHackerCodeAgentProviderApiKey(this.secretStorageService, provider.id, value);
			provider.hasStoredKey = true;
			keyInput.value = '';
			keyInput.placeholder = '••••••••';
		}));

		const modelsRow = append(card, $('div.hca-field-row'));
		append(modelsRow, $('label')).textContent = localize('hackerCodeAgent.settings.models', "Models");
		const modelsList = append(modelsRow, $('div.hca-models-list'));
		this.renderModelChips(modelsList, provider);

		const actions = append(card, $('div.hca-row-actions'));
		const fetchButton = this.renderDisposables.add(new Button(actions, { ...defaultButtonStyles, secondary: true }));
		fetchButton.label = localize('hackerCodeAgent.settings.fetchModels', "Fetch models");
		const status = append(actions, $('span.hca-status-text'));
		this.renderDisposables.add(fetchButton.onDidClick(async () => {
			fetchButton.enabled = false;
			status.textContent = localize('hackerCodeAgent.settings.fetching', "Fetching…");
			try {
				const apiKey = await readHackerCodeAgentProviderApiKey(this.secretStorageService, provider.id);
				const models = await fetchModelIds(provider.baseUrl, apiKey);
				provider.models = models;
				await this.persistProviders();
				status.textContent = localize('hackerCodeAgent.settings.fetched', "Found {0} models", models.length);
				this.renderModelChips(modelsList, provider);
			} catch (error) {
				status.textContent = getErrorMessage(error);
				this.notificationService.warn(localize('hackerCodeAgent.settings.fetchFailed', "Failed to fetch models: {0}", getErrorMessage(error)));
			} finally {
				fetchButton.enabled = true;
			}
		}));

		const removeButton = this.renderDisposables.add(new Button(actions, { ...defaultButtonStyles, secondary: true }));
		removeButton.label = localize('hackerCodeAgent.settings.remove', "Remove");
		this.renderDisposables.add(removeButton.onDidClick(async () => {
			this.providers = this.providers.filter(candidate => candidate.id !== provider.id);
			await deleteHackerCodeAgentProviderApiKey(this.secretStorageService, provider.id);
			await this.persistProviders();
			this.render();
		}));
	}

	private renderModelChips(container: HTMLElement, provider: IEditableProvider): void {
		clearNode(container);
		if (provider.models.length === 0) {
			const empty = append(container, $('span.hca-status-text'));
			empty.textContent = localize('hackerCodeAgent.settings.noModels', "No models yet");
			return;
		}
		for (const model of provider.models) {
			append(container, $('span.hca-model-chip')).textContent = model;
		}
	}

	private renderTextField(parent: HTMLElement, label: string, initialValue: string, onChange: (value: string) => void, placeholder?: string): void {
		const row = append(parent, $('div.hca-field-row'));
		append(row, $('label')).textContent = label;
		const input = append(row, $('input.hca-text-input')) as HTMLInputElement;
		input.value = initialValue;
		if (placeholder) {
			input.placeholder = placeholder;
		}
		this.renderDisposables.add(domChangeListener(input, () => onChange(input.value)));
	}

	override clearInput(): void {
		this.renderDisposables.clear();
		if (this.container) {
			clearNode(this.container);
		}
		super.clearInput();
	}

	override layout(): void {
		// no-op: CSS handles sizing
	}
}

function domChangeListener(input: HTMLInputElement, handler: () => void): { dispose(): void } {
	const listener = () => handler();
	input.addEventListener('blur', listener);
	return { dispose: () => input.removeEventListener('blur', listener) };
}

async function fetchModelIds(baseUrl: string, apiKey: string | undefined): Promise<string[]> {
	if (!baseUrl) {
		throw new Error('Set a base URL first');
	}
	const url = `${baseUrl.replace(/\/+$/, '')}/models`;
	const response = await fetch(url, {
		headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
	});
	if (!response.ok) {
		throw new Error(`${response.status} ${response.statusText}`);
	}
	const body: unknown = await response.json();
	const bodyRecord = body as { data?: unknown } | unknown[];
	const entries: unknown[] = Array.isArray(bodyRecord) ? bodyRecord : Array.isArray((bodyRecord as { data?: unknown }).data) ? (bodyRecord as { data: unknown[] }).data : [];
	const ids = new Set<string>();
	for (const entry of entries) {
		const id = typeof entry === 'string' ? entry : (entry as { id?: unknown } | undefined)?.id;
		if (typeof id === 'string') {
			ids.add(id);
		}
	}
	return [...ids].sort();
}
