/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/hackerCodeAgentViewPane.css';
import { $, addDisposableListener, append, clearNode } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputBox.js';
import { ISelectOptionItem, SelectBox } from '../../../../base/browser/ui/selectBox/selectBox.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { renderMarkdown } from '../../../../base/browser/markdownRenderer.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService, IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { defaultButtonStyles, getInputBoxStyle, getSelectBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IAccessibleViewInformationService } from '../../../services/accessibility/common/accessibleViewInformationService.js';
import { HACKERCODE_AGENT_OPEN_SETTINGS_COMMAND_ID } from '../common/hackerCodeAgentCommands.js';
import { readHackerCodeAgentProviderConfigs } from '../common/hackerCodeAgentConfiguration.js';
import {
	HackerCodeAgentMode,
	HackerCodeAgentServerMessage,
	IHackerCodeAgentSessionState,
	IHackerCodeAgentSessionSummary
} from '../common/hackerCodeAgentProtocol.js';
import { HackerCodeAgentConnectionState, IHackerCodeAgentTransportService } from '../common/hackerCodeAgentTransport.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';

type ConfirmRequestMessage = Extract<HackerCodeAgentServerMessage, { kind: 'confirmRequest' }>;

interface ILiveToolCall {
	name: string;
	argsText: string;
	result?: unknown;
	hasResult: boolean;
}

const MODE_ITEMS: readonly { readonly id: HackerCodeAgentMode; readonly label: string }[] = [
	{ id: 'ask', label: localize('hackerCodeAgent.mode.ask', "Ask") },
	{ id: 'plan', label: localize('hackerCodeAgent.mode.plan', "Plan") },
	{ id: 'agent', label: localize('hackerCodeAgent.mode.agent', "Agent") }
];

export class HackerCodeAgentViewPane extends ViewPane {

	static readonly ID = 'workbench.view.hackerCodeAgent';

	private readonly viewDisposables = this._register(new DisposableStore());
	private readonly transcriptRenderDisposables = this._register(new DisposableStore());
	private readonly confirmRenderDisposables = this._register(new DisposableStore());
	private readonly tabsRenderDisposables = this._register(new DisposableStore());

	private tabsContainer!: HTMLElement;
	private statusText!: HTMLElement;
	private transcriptContainer!: HTMLElement;
	private confirmBanner!: HTMLElement;
	private providerSelect!: SelectBox;
	private modelSelect!: SelectBox;
	private modeSelect!: SelectBox;
	private composerInput!: InputBox;
	private sendButton!: Button;
	private cancelButton!: Button;

	private sessions: IHackerCodeAgentSessionSummary[] = [];
	private activeSessionId: string | undefined;
	private sessionState: IHackerCodeAgentSessionState | undefined;
	private awaitingNewSession = false;

	private pendingUserText: string | undefined;
	private draftAssistantText = '';
	private readonly liveToolCalls = new Map<string, ILiveToolCall>();
	private toolCallOrder: string[] = [];
	private turnInFlight = false;

	private pendingConfirm: ConfirmRequestMessage | undefined;

	private providerIds: string[] = [];
	private selectedProviderId: string | undefined;
	private selectedModel: string | undefined;
	private selectedMode: HackerCodeAgentMode = 'agent';

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@ICommandService private readonly commandService: ICommandService,
		@IHackerCodeAgentTransportService private readonly transportService: IHackerCodeAgentTransportService,
		accessibleViewInformationService?: IAccessibleViewInformationService
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService, accessibleViewInformationService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		const root = append(container, $('div.hackercode-agent-view'));

		this.tabsContainer = append(root, $('div.hca-tabs'));

		const statusRow = append(root, $('div.hca-status-row'));
		this.statusText = append(statusRow, $('span.hca-status-text'));
		const settingsLink = append(statusRow, $('span.hca-settings-link'));
		settingsLink.textContent = localize('hackerCodeAgent.openSettingsLink', "Settings");
		this.viewDisposables.add(addDisposableListener(settingsLink, 'click', () => {
			void this.commandService.executeCommand(HACKERCODE_AGENT_OPEN_SETTINGS_COMMAND_ID);
		}));

		this.transcriptContainer = append(root, $('div.hca-transcript'));

		this.confirmBanner = append(root, $('div.hca-confirm-banner'));

		const composer = append(root, $('div.hca-composer'));
		const pickerRow = append(composer, $('div.hca-picker-row'));

		const providerContainer = append(pickerRow, $('div.hca-provider-picker'));
		this.providerSelect = this.viewDisposables.add(new SelectBox([{ text: localize('hackerCodeAgent.noProviders', "No providers configured") }], 0, this.contextViewService, getSelectBoxStyles({})));
		this.providerSelect.render(providerContainer);
		this.viewDisposables.add(this.providerSelect.onDidSelect(selection => this.onProviderSelected(selection.index)));

		const modelContainer = append(pickerRow, $('div.hca-model-picker'));
		this.modelSelect = this.viewDisposables.add(new SelectBox([{ text: localize('hackerCodeAgent.noModels', "No models") }], 0, this.contextViewService, getSelectBoxStyles({})));
		this.modelSelect.render(modelContainer);
		this.viewDisposables.add(this.modelSelect.onDidSelect(selection => {
			this.selectedModel = this.currentProviderModels()[selection.index];
		}));

		const modeContainer = append(pickerRow, $('div.hca-mode-picker'));
		this.modeSelect = this.viewDisposables.add(new SelectBox(MODE_ITEMS.map(item => ({ text: item.label })), 2, this.contextViewService, getSelectBoxStyles({})));
		this.modeSelect.render(modeContainer);
		this.viewDisposables.add(this.modeSelect.onDidSelect(selection => {
			this.selectedMode = MODE_ITEMS[selection.index].id;
		}));

		const inputRow = append(composer, $('div.hca-input-row'));
		this.composerInput = this.viewDisposables.add(new InputBox(inputRow, undefined, {
			placeholder: localize('hackerCodeAgent.composerPlaceholder', "Message the HackerCode agent…"),
			flexibleHeight: true,
			flexibleMaxHeight: 160,
			inputBoxStyles: getInputBoxStyle({})
		}));
		this.viewDisposables.add(addDisposableListener(this.composerInput.inputElement, 'keydown', event => {
			const keyboardEvent = new StandardKeyboardEvent(event);
			if (keyboardEvent.keyCode === KeyCode.Enter && !keyboardEvent.shiftKey) {
				keyboardEvent.preventDefault();
				this.sendTurn();
			}
		}));

		this.sendButton = this.viewDisposables.add(new Button(inputRow, { ...defaultButtonStyles }));
		this.sendButton.label = localize('hackerCodeAgent.send', "Send");
		this.viewDisposables.add(this.sendButton.onDidClick(() => this.sendTurn()));

		this.cancelButton = this.viewDisposables.add(new Button(inputRow, { ...defaultButtonStyles, secondary: true }));
		this.cancelButton.label = localize('hackerCodeAgent.cancel', "Cancel");
		this.cancelButton.element.style.display = 'none';
		this.viewDisposables.add(this.cancelButton.onDidClick(() => {
			if (this.activeSessionId) {
				this.transportService.send({ kind: 'cancelTurn', sessionId: this.activeSessionId });
			}
		}));

		this.viewDisposables.add(this.transportService.onDidChangeState(() => this.renderStatus()));
		this.viewDisposables.add(this.transportService.onMessage(message => this.handleServerMessage(message)));
		this.viewDisposables.add(this.configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('hackercode.agent.providers')) {
				this.refreshProviders();
			}
		}));

		this.refreshProviders();
		this.renderStatus();
		this.renderTranscript();
		this.updateComposerEnablement();

		this.transportService.connect();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
	}

	override focus(): void {
		super.focus();
		this.composerInput?.focus();
	}

	// ---- Providers / pickers --------------------------------------------

	private refreshProviders(): void {
		const configs = readHackerCodeAgentProviderConfigs(this.configurationService);
		this.providerIds = configs.map(config => config.id);

		if (configs.length === 0) {
			this.providerSelect.setOptions([{ text: localize('hackerCodeAgent.noProviders', "No providers configured") }], 0);
			this.selectedProviderId = undefined;
			this.selectedModel = undefined;
			this.modelSelect.setOptions([{ text: localize('hackerCodeAgent.noModels', "No models") }], 0);
			this.updateComposerEnablement();
			return;
		}

		const items: ISelectOptionItem[] = configs.map(config => ({ text: config.label }));
		let selectedIndex = this.selectedProviderId ? configs.findIndex(config => config.id === this.selectedProviderId) : -1;
		if (selectedIndex < 0) {
			selectedIndex = 0;
		}
		this.providerSelect.setOptions(items, selectedIndex);
		this.selectedProviderId = configs[selectedIndex].id;
		this.onProviderSelected(selectedIndex);
	}

	private currentProviderModels(): readonly string[] {
		const configs = readHackerCodeAgentProviderConfigs(this.configurationService);
		return configs.find(config => config.id === this.selectedProviderId)?.models ?? [];
	}

	private onProviderSelected(index: number): void {
		this.selectedProviderId = this.providerIds[index];
		const models = this.currentProviderModels();
		if (models.length === 0) {
			this.modelSelect.setOptions([{ text: localize('hackerCodeAgent.noModels', "No models") }], 0);
			this.selectedModel = undefined;
		} else {
			let selectedIndex = this.selectedModel ? models.indexOf(this.selectedModel) : -1;
			if (selectedIndex < 0) {
				selectedIndex = 0;
			}
			this.modelSelect.setOptions(models.map(model => ({ text: model })), selectedIndex);
			this.selectedModel = models[selectedIndex];
		}
		this.updateComposerEnablement();
	}

	private syncPickersToSession(session: IHackerCodeAgentSessionState): void {
		if (session.mode) {
			this.selectedMode = session.mode;
			const modeIndex = MODE_ITEMS.findIndex(item => item.id === session.mode);
			if (modeIndex >= 0) {
				this.modeSelect.select(modeIndex);
			}
		}
		if (session.providerId && this.providerIds.includes(session.providerId)) {
			this.selectedProviderId = session.providerId;
			this.providerSelect.select(this.providerIds.indexOf(session.providerId));
			this.onProviderSelected(this.providerIds.indexOf(session.providerId));
		}
		if (session.model) {
			const models = this.currentProviderModels();
			const modelIndex = models.indexOf(session.model);
			if (modelIndex >= 0) {
				this.selectedModel = session.model;
				this.modelSelect.select(modelIndex);
			}
		}
	}

	// ---- Status -----------------------------------------------------------

	private renderStatus(): void {
		switch (this.transportService.state) {
			case HackerCodeAgentConnectionState.Connected:
				this.statusText.textContent = localize('hackerCodeAgent.status.connected', "Connected to agent driver");
				break;
			case HackerCodeAgentConnectionState.Connecting:
				this.statusText.textContent = localize('hackerCodeAgent.status.connecting', "Connecting to agent driver…");
				break;
			default: {
				const error = this.transportService.lastError;
				this.statusText.textContent = error
					? localize('hackerCodeAgent.status.disconnectedWithError', "Disconnected: {0}", error)
					: localize('hackerCodeAgent.status.disconnected', "Disconnected from agent driver");
			}
		}
	}

	// ---- Tabs ---------------------------------------------------------------

	private renderTabs(): void {
		this.tabsRenderDisposables.clear();
		clearNode(this.tabsContainer);
		for (const session of this.sessions) {
			const tab = append(this.tabsContainer, $('div.hca-tab'));
			tab.classList.toggle('active', session.id === this.activeSessionId);
			const title = append(tab, $('span.hca-tab-title'));
			title.textContent = session.title || localize('hackerCodeAgent.untitledSession', "New session");
			this.tabsRenderDisposables.add(addDisposableListener(title, 'click', () => this.openSession(session.id)));

			const close = append(tab, $('span.hca-tab-close.codicon.codicon-close'));
			this.tabsRenderDisposables.add(addDisposableListener(close, 'click', event => {
				event.stopPropagation();
				this.closeSession(session.id);
			}));
		}
		const newTab = append(this.tabsContainer, $('span.hca-new-tab.codicon.codicon-add'));
		this.tabsRenderDisposables.add(addDisposableListener(newTab, 'click', () => this.createSession()));
	}

	private openSession(sessionId: string): void {
		if (sessionId === this.activeSessionId) {
			return;
		}
		this.activeSessionId = sessionId;
		this.sessionState = undefined;
		this.resetDraftState();
		this.renderTabs();
		this.renderTranscript();
		this.updateComposerEnablement();
		this.transportService.send({ kind: 'openSession', sessionId });
	}

	private closeSession(sessionId: string): void {
		this.transportService.send({ kind: 'closeSession', sessionId });
		this.sessions = this.sessions.filter(session => session.id !== sessionId);
		if (this.activeSessionId === sessionId) {
			this.activeSessionId = undefined;
			this.sessionState = undefined;
			this.resetDraftState();
			if (this.sessions.length > 0) {
				this.openSession(this.sessions[0].id);
				return;
			}
		}
		this.renderTabs();
		this.renderTranscript();
		this.updateComposerEnablement();
	}

	private createSession(): void {
		this.awaitingNewSession = true;
		this.transportService.send({
			kind: 'createSession',
			mode: this.selectedMode,
			providerId: this.selectedProviderId,
			model: this.selectedModel
		});
	}

	// ---- Composer -----------------------------------------------------------

	private updateComposerEnablement(): void {
		const canSend = !!this.activeSessionId && !this.turnInFlight && !!this.selectedProviderId && !!this.selectedModel;
		this.sendButton.enabled = canSend;
		this.cancelButton.element.style.display = this.turnInFlight ? '' : 'none';
	}

	private sendTurn(): void {
		const text = this.composerInput.value.trim();
		if (!text || !this.activeSessionId || this.turnInFlight || !this.selectedProviderId || !this.selectedModel) {
			return;
		}
		this.composerInput.value = '';
		this.pendingUserText = text;
		this.draftAssistantText = '';
		this.liveToolCalls.clear();
		this.toolCallOrder = [];
		this.turnInFlight = true;
		this.updateComposerEnablement();
		this.renderTranscript();
		this.transportService.send({
			kind: 'sendTurn',
			sessionId: this.activeSessionId,
			text,
			mode: this.selectedMode,
			providerId: this.selectedProviderId,
			model: this.selectedModel
		});
	}

	private resetDraftState(): void {
		this.pendingUserText = undefined;
		this.draftAssistantText = '';
		this.liveToolCalls.clear();
		this.toolCallOrder = [];
		this.turnInFlight = false;
	}

	// ---- Server message handling --------------------------------------------

	private handleServerMessage(message: HackerCodeAgentServerMessage): void {
		switch (message.kind) {
			case 'hello':
				return;
			case 'sessions':
				this.sessions = [...message.sessions];
				this.renderTabs();
				if (!this.activeSessionId && this.sessions.length > 0 && !this.awaitingNewSession) {
					this.openSession(this.sessions[0].id);
				}
				return;
			case 'sessionState':
				if (this.awaitingNewSession) {
					this.awaitingNewSession = false;
					this.activeSessionId = message.sessionId;
				}
				if (message.sessionId !== this.activeSessionId) {
					return;
				}
				this.sessionState = message.session;
				this.resetDraftState();
				this.syncPickersToSession(message.session);
				this.renderTabs();
				this.renderTranscript();
				this.updateComposerEnablement();
				return;
			case 'delta':
				this.handleDelta(message);
				return;
			case 'toolCall':
				if (message.sessionId !== this.activeSessionId) {
					return;
				}
				if (!this.liveToolCalls.has(message.id)) {
					this.toolCallOrder.push(message.id);
				}
				this.liveToolCalls.set(message.id, { name: message.name, argsText: safeJsonStringify(message.arguments), hasResult: false });
				this.renderTranscript();
				return;
			case 'toolResult': {
				if (message.sessionId !== this.activeSessionId) {
					return;
				}
				const entry = this.liveToolCalls.get(message.id);
				if (entry) {
					entry.result = message.result;
					entry.hasResult = true;
				}
				this.renderTranscript();
				return;
			}
			case 'confirmRequest':
				this.pendingConfirm = message;
				this.renderConfirmBanner();
				return;
			case 'controlState':
				return;
			case 'error':
				this.renderErrorBanner(message.message);
				if (message.sessionId === this.activeSessionId) {
					this.turnInFlight = false;
					this.updateComposerEnablement();
				}
				return;
		}
	}

	private handleDelta(message: Extract<HackerCodeAgentServerMessage, { kind: 'delta' }>): void {
		if (message.sessionId !== this.activeSessionId) {
			return;
		}
		switch (message.type) {
			case 'content':
				this.draftAssistantText += message.delta;
				this.renderTranscript();
				return;
			case 'turn_complete':
			case 'step_budget_exhausted':
				this.turnInFlight = false;
				this.updateComposerEnablement();
				this.renderTranscript();
				return;
			case 'done':
			case 'tool_call_delta':
				return;
		}
	}

	// ---- Rendering: transcript -----------------------------------------------

	private renderTranscript(): void {
		this.transcriptRenderDisposables.clear();
		clearNode(this.transcriptContainer);

		if (!this.activeSessionId) {
			append(this.transcriptContainer, $('div.hca-empty-state')).textContent = localize('hackerCodeAgent.emptyState', "Create a session to start chatting with the HackerCode agent.");
			return;
		}
		if (!this.sessionState) {
			append(this.transcriptContainer, $('div.hca-empty-state')).textContent = localize('hackerCodeAgent.loadingSession', "Loading session…");
			return;
		}

		const toolResultsByCallId = new Map<string, string>();
		for (const message of this.sessionState.messages) {
			if (message.role === 'tool' && message.tool_call_id) {
				toolResultsByCallId.set(message.tool_call_id, message.content);
			}
		}

		for (const message of this.sessionState.messages) {
			if (message.role === 'system' || message.role === 'tool') {
				continue;
			}
			if (message.role === 'user') {
				this.renderUserMessage(message.content, false);
				continue;
			}
			this.renderAssistantMessage(message.content, (message.tool_calls ?? []).map(toolCall => ({
				name: toolCall.function.name,
				argsText: toolCall.function.arguments,
				result: toolResultsByCallId.has(toolCall.id) ? parseJsonSafely(toolResultsByCallId.get(toolCall.id)!) : undefined,
				hasResult: toolResultsByCallId.has(toolCall.id)
			})));
		}

		if (this.pendingUserText !== undefined) {
			this.renderUserMessage(this.pendingUserText, true);
		}

		if (this.turnInFlight || this.draftAssistantText.length > 0 || this.toolCallOrder.length > 0) {
			const liveCalls = this.toolCallOrder.map(id => this.liveToolCalls.get(id)).filter((call): call is ILiveToolCall => !!call);
			if (this.draftAssistantText.length > 0 || liveCalls.length > 0) {
				this.renderAssistantMessage(this.draftAssistantText, liveCalls, true);
			} else if (this.turnInFlight) {
				append(this.transcriptContainer, $('div.hca-thinking')).textContent = localize('hackerCodeAgent.thinking', "Thinking…");
			}
		}

		this.transcriptContainer.scrollTop = this.transcriptContainer.scrollHeight;
	}

	private renderUserMessage(content: string, pending: boolean): void {
		const row = append(this.transcriptContainer, $(`div.hca-message.user${pending ? '.pending' : ''}`));
		append(row, $('div.hca-message-role')).textContent = localize('hackerCodeAgent.roleUser', "You");
		const body = append(row, $('div.hca-message-body'));
		body.textContent = content;
	}

	private renderAssistantMessage(content: string, toolCalls: { name: string; argsText: string; result?: unknown; hasResult: boolean }[], pending = false): void {
		const row = append(this.transcriptContainer, $(`div.hca-message.assistant${pending ? '.pending' : ''}`));
		append(row, $('div.hca-message-role')).textContent = localize('hackerCodeAgent.roleAssistant', "Agent");
		if (content.length > 0) {
			const body = append(row, $('div.hca-message-body'));
			const rendered = this.transcriptRenderDisposables.add(renderMarkdown({ value: content }, { fillInIncompleteTokens: true }));
			append(body, rendered.element);
		}
		for (const toolCall of toolCalls) {
			this.renderToolCallRow(row, toolCall);
		}
	}

	private renderToolCallRow(container: HTMLElement, toolCall: { name: string; argsText: string; result?: unknown; hasResult: boolean }): void {
		const details = append(container, $('details.hca-tool-call'));
		append(details, $('summary')).textContent = toolCall.name;
		append(details, $('pre')).textContent = formatJsonText(toolCall.argsText);
		if (toolCall.hasResult) {
			append(details, $('pre')).textContent = safeJsonStringify(toolCall.result);
		} else {
			append(details, $('div')).textContent = localize('hackerCodeAgent.toolRunning', "Running…");
		}
	}

	// ---- Confirmation / error banners ------------------------------------------

	private renderConfirmBanner(): void {
		this.confirmRenderDisposables.clear();
		clearNode(this.confirmBanner);
		const confirm = this.pendingConfirm;
		if (!confirm) {
			this.confirmBanner.classList.remove('visible');
			return;
		}
		this.confirmBanner.classList.add('visible');
		append(this.confirmBanner, $('div.hca-confirm-title')).textContent = localize('hackerCodeAgent.confirmPromoteTitle', "Promote revision to source?");
		append(this.confirmBanner, $('div.hca-confirm-detail')).textContent = localize(
			'hackerCodeAgent.confirmPromoteDetail',
			"Revision {0} will be committed on top of baseline {1}.{2}",
			confirm.revisionId,
			confirm.baseline ?? localize('hackerCodeAgent.unknownBaseline', "unknown"),
			confirm.commitMessage ? ` "${confirm.commitMessage}"` : ''
		);
		const actions = append(this.confirmBanner, $('div.hca-confirm-actions'));
		const confirmButton = this.confirmRenderDisposables.add(new Button(actions, { ...defaultButtonStyles }));
		confirmButton.label = localize('hackerCodeAgent.confirm', "Confirm");
		this.confirmRenderDisposables.add(confirmButton.onDidClick(() => this.respondToConfirm(true)));
		const declineButton = this.confirmRenderDisposables.add(new Button(actions, { ...defaultButtonStyles, secondary: true }));
		declineButton.label = localize('hackerCodeAgent.decline', "Decline");
		this.confirmRenderDisposables.add(declineButton.onDidClick(() => this.respondToConfirm(false)));
	}

	private respondToConfirm(confirmed: boolean): void {
		if (!this.pendingConfirm) {
			return;
		}
		this.transportService.send({ kind: 'confirmResponse', confirmId: this.pendingConfirm.confirmId, confirmed });
		this.pendingConfirm = undefined;
		this.renderConfirmBanner();
	}

	private renderErrorBanner(message: string): void {
		const row = append(this.transcriptContainer, $('div.hca-message.assistant'));
		append(row, $('div.hca-message-role')).textContent = localize('hackerCodeAgent.roleError', "Error");
		append(row, $('div.hca-message-body')).textContent = message;
		this.transcriptContainer.scrollTop = this.transcriptContainer.scrollHeight;
	}
}

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value, undefined, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

function parseJsonSafely(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function formatJsonText(rawArguments: string): string {
	try {
		return JSON.stringify(JSON.parse(rawArguments), undefined, 2);
	} catch {
		return rawArguments;
	}
}
