/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import { runAgentTurn } from './agent/loop.mjs';
import { AgentPatchSet } from './agent/patchSet.mjs';
import { createToolHandlers } from './agent/tools.mjs';
import {
	createSessionState,
	deleteSession,
	listSessionSummaries,
	loadSession,
	saveSession
} from './sessions.mjs';
import { serverMessage } from './ui/protocol.mjs';

const CONFIRM_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Ties the control session, the UI transport, and the agent loop together.
 * This is the only module that knows about both "the control plane" and
 * "the UI protocol" at once; everything it delegates to (control/, agent/,
 * llm/, ui/) is independently unit-testable without this orchestration.
 */
export class AgentDriver {
	/**
	 * @param {{
	 *   controlSession: import('./control/session.mjs').HackerCodeControlSession,
	 *   userDataDir: string,
	 *   uiServer: { sendTo: Function, broadcast: Function },
	 *   providers?: Map<string, { id: string, label: string, baseUrl: string, apiKey?: string, models: string[] }>,
	 *   logger?: { warn: (message: string) => void }
	 * }} options
	 */
	constructor(options) {
		this.controlSession = options.controlSession;
		this.userDataDir = options.userDataDir;
		this.uiServer = options.uiServer;
		this.logger = options.logger;
		this.providers = new Map();
		if (options.providers) {
			this.setProviders(Array.isArray(options.providers) ? options.providers : [...options.providers.values()]);
		}

		/** @type {Map<string, { state: object, patchSet: AgentPatchSet, abortController?: AbortController }>} */
		this.sessions = new Map();
		/** @type {Map<string, number>} */
		this.connectionWindowIds = new Map();
		/** @type {Map<string, { resolve: (confirmed: boolean) => void, timeout: NodeJS.Timeout }>} */
		this.pendingConfirmations = new Map();
	}

	setProviders(providers) {
		this.providers = new Map(providers.map(provider => [provider.id, provider]));
	}

	async handleMessage(connectionId, message) {
		switch (message.kind) {
			case 'hello':
				if (Number.isSafeInteger(message.windowId)) {
					this.connectionWindowIds.set(connectionId, message.windowId);
				}
				this.uiServer.sendTo(connectionId, serverMessage('hello', { protocolVersion: 1 }));
				await this.sendControlState(connectionId);
				await this.sendSessionList(connectionId);
				return;
			case 'setProviders':
				this.setProviders(Array.isArray(message.providers) ? message.providers : []);
				return;
			case 'listSessions':
				return this.sendSessionList(connectionId);
			case 'createSession':
				return this.handleCreateSession(connectionId, message);
			case 'openSession':
				return this.handleOpenSession(connectionId, message);
			case 'closeSession':
				this.sessions.delete(message.sessionId);
				return;
			case 'sendTurn':
				return this.handleSendTurn(connectionId, message);
			case 'cancelTurn':
				return this.handleCancelTurn(message);
			case 'confirmResponse':
				return this.handleConfirmResponse(message);
			default:
				this.uiServer.sendTo(connectionId, serverMessage('error', { message: `Unhandled message kind: ${message.kind}` }));
		}
	}

	async sendControlState(connectionId) {
		try {
			const state = await this.controlSession.getState();
			this.uiServer.sendTo(connectionId, serverMessage('controlState', { state }));
		} catch (error) {
			this.uiServer.sendTo(connectionId, serverMessage('error', { message: `Failed to read control state: ${describeError(error)}` }));
		}
	}

	async sendSessionList(connectionId) {
		const sessions = await listSessionSummaries(this.userDataDir);
		this.uiServer.sendTo(connectionId, serverMessage('sessions', { sessions }));
	}

	async handleCreateSession(connectionId, message) {
		const state = createSessionState({
			title: message.title,
			mode: message.mode ?? 'agent',
			providerId: message.providerId,
			model: message.model
		});
		await saveSession(this.userDataDir, state);
		this.sessions.set(state.id, { state, patchSet: new AgentPatchSet() });
		this.uiServer.broadcast(serverMessage('sessionState', { sessionId: state.id, session: state }));
		await this.sendSessionList(connectionId);
	}

	async handleOpenSession(connectionId, message) {
		let entry = this.sessions.get(message.sessionId);
		if (!entry) {
			try {
				const state = await loadSession(this.userDataDir, message.sessionId);
				entry = { state, patchSet: new AgentPatchSet(state.patches ?? []) };
				this.sessions.set(state.id, entry);
			} catch {
				this.uiServer.sendTo(connectionId, serverMessage('error', { message: `Unknown session: ${message.sessionId}` }));
				return;
			}
		}
		this.uiServer.sendTo(connectionId, serverMessage('sessionState', { sessionId: entry.state.id, session: entry.state }));
	}

	async handleSendTurn(connectionId, message) {
		const entry = this.sessions.get(message.sessionId);
		if (!entry) {
			this.uiServer.sendTo(connectionId, serverMessage('error', { message: `Unknown session: ${message.sessionId}` }));
			return;
		}
		const provider = this.providers.get(message.providerId ?? entry.state.providerId);
		if (!provider) {
			this.uiServer.sendTo(connectionId, serverMessage('error', {
				sessionId: entry.state.id,
				message: 'No provider is configured. Open HackerCode settings (Ctrl+,) to add one.'
			}));
			return;
		}
		const model = message.model ?? entry.state.model;
		if (!model) {
			this.uiServer.sendTo(connectionId, serverMessage('error', { sessionId: entry.state.id, message: 'No model selected.' }));
			return;
		}

		entry.state.providerId = provider.id;
		entry.state.model = model;

		const defaultWindowId = this.connectionWindowIds.get(connectionId);
		const abortController = new AbortController();
		entry.abortController = abortController;

		const toolHandlers = withDefaultWindowId(
			createToolHandlers({
				session: this.controlSession,
				userDataDir: this.userDataDir,
				patchSet: entry.patchSet,
				requestPromotionConfirmation: details => this.requestConfirmation(entry.state.id, details)
			}),
			defaultWindowId
		);

		try {
			await runAgentTurn({
				sessionState: entry.state,
				controlSession: this.controlSession,
				provider,
				model,
				mode: message.mode ?? entry.state.mode,
				toolHandlers,
				userText: message.text,
				signal: abortController.signal,
				onEvent: event => this.uiServer.broadcast(serverMessage(eventKindToServerKind(event.type), {
					sessionId: entry.state.id,
					...event
				}))
			});
		} catch (error) {
			this.uiServer.broadcast(serverMessage('error', { sessionId: entry.state.id, message: describeError(error) }));
		} finally {
			entry.abortController = undefined;
			entry.state.patches = entry.patchSet.list();
			await saveSession(this.userDataDir, entry.state);
			this.uiServer.broadcast(serverMessage('sessionState', { sessionId: entry.state.id, session: entry.state }));
		}
	}

	handleCancelTurn(message) {
		const entry = this.sessions.get(message.sessionId);
		entry?.abortController?.abort();
	}

	requestConfirmation(sessionId, details) {
		const confirmId = randomUUID();
		this.uiServer.broadcast(serverMessage('confirmRequest', { sessionId, confirmId, ...details }));
		return new Promise(resolve => {
			const timeout = setTimeout(() => {
				this.pendingConfirmations.delete(confirmId);
				resolve(false);
			}, CONFIRM_TIMEOUT_MS);
			this.pendingConfirmations.set(confirmId, { resolve, timeout });
		});
	}

	handleConfirmResponse(message) {
		const pending = this.pendingConfirmations.get(message.confirmId);
		if (!pending) {
			return;
		}
		clearTimeout(pending.timeout);
		this.pendingConfirmations.delete(message.confirmId);
		pending.resolve(message.confirmed === true);
	}

	async deleteSessionById(sessionId) {
		this.sessions.delete(sessionId);
		await deleteSession(this.userDataDir, sessionId);
	}
}

function withDefaultWindowId(handlers, defaultWindowId) {
	if (defaultWindowId === undefined) {
		return handlers;
	}
	const wrapped = {};
	for (const [name, handler] of Object.entries(handlers)) {
		wrapped[name] = typeof handler === 'function'
			? args => handler({ ...args, windowId: args?.windowId ?? defaultWindowId })
			: handler;
	}
	return wrapped;
}

function eventKindToServerKind(type) {
	switch (type) {
		case 'content':
		case 'tool_call_delta':
		case 'done':
		case 'turn_complete':
		case 'step_budget_exhausted':
			return 'delta';
		case 'tool_call':
			return 'toolCall';
		case 'tool_result':
			return 'toolResult';
		default:
			return 'delta';
	}
}

function describeError(error) {
	return error instanceof Error ? error.message : String(error);
}
