/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IHackerCodeState } from '../../../../platform/hackercode/common/hackerCode.js';

/**
 * TypeScript mirror of `scripts/hackercode-agent/ui/protocol.mjs`. This is a
 * deliberately separate, weaker protocol from the HackerCode control plane:
 * it carries no control-plane authority, and this workbench-side client never
 * receives (or needs) the control token. Keep the two files' message shapes
 * in sync by hand -- the driver is a standalone Node process and cannot share
 * TypeScript types with the workbench build.
 */

export const HACKERCODE_AGENT_UI_PROTOCOL_VERSION = 1;

export type HackerCodeAgentMode = 'ask' | 'plan' | 'agent';

export interface IHackerCodeAgentProviderConfig {
	readonly id: string;
	readonly label: string;
	readonly baseUrl: string;
	/** Only ever present on the `setProviders` client message; never echoed back by the driver. */
	readonly apiKey?: string;
	readonly models: readonly string[];
}

export interface IHackerCodeAgentToolCall {
	readonly id: string;
	readonly type: 'function';
	readonly function: {
		readonly name: string;
		readonly arguments: string;
	};
}

export interface IHackerCodeAgentChatMessage {
	readonly role: 'system' | 'user' | 'assistant' | 'tool';
	readonly content: string;
	readonly tool_calls?: readonly IHackerCodeAgentToolCall[];
	readonly tool_call_id?: string;
}

export interface IHackerCodeAgentSessionState {
	readonly id: string;
	title: string;
	mode: HackerCodeAgentMode;
	providerId?: string;
	model?: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly messages: IHackerCodeAgentChatMessage[];
}

export interface IHackerCodeAgentSessionSummary {
	readonly id: string;
	readonly title: string;
	readonly mode: HackerCodeAgentMode;
	readonly providerId?: string;
	readonly model?: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly messageCount: number;
}

export interface IHackerCodeAgentPromoteConfirmDetails {
	readonly revisionId: string;
	readonly windowId: number;
	readonly commitMessage?: string;
	readonly baseline?: string;
}

// ---- Client -> server messages ------------------------------------------

export type HackerCodeAgentClientMessage =
	| { readonly kind: 'hello'; readonly windowId?: number }
	| { readonly kind: 'setProviders'; readonly providers: readonly IHackerCodeAgentProviderConfig[] }
	| { readonly kind: 'createSession'; readonly title?: string; readonly mode?: HackerCodeAgentMode; readonly providerId?: string; readonly model?: string }
	| { readonly kind: 'openSession'; readonly sessionId: string }
	| { readonly kind: 'closeSession'; readonly sessionId: string }
	| { readonly kind: 'listSessions' }
	| { readonly kind: 'sendTurn'; readonly sessionId: string; readonly text: string; readonly mode?: HackerCodeAgentMode; readonly providerId?: string; readonly model?: string }
	| { readonly kind: 'cancelTurn'; readonly sessionId: string }
	| { readonly kind: 'confirmResponse'; readonly confirmId: string; readonly confirmed: boolean };

// ---- Server -> client messages ------------------------------------------

export type HackerCodeAgentTurnEvent =
	| { readonly type: 'content'; readonly delta: string }
	| { readonly type: 'tool_call_delta'; readonly index: number; readonly id?: string; readonly name?: string; readonly argumentsDelta?: string }
	| { readonly type: 'done'; readonly finishReason: string | null }
	| { readonly type: 'turn_complete'; readonly finishReason: string | null }
	| { readonly type: 'step_budget_exhausted'; readonly maxSteps: number };

export type HackerCodeAgentServerMessage =
	| { readonly kind: 'hello'; readonly protocolVersion: number }
	| { readonly kind: 'sessions'; readonly sessions: readonly IHackerCodeAgentSessionSummary[] }
	| { readonly kind: 'sessionState'; readonly sessionId: string; readonly session: IHackerCodeAgentSessionState }
	| ({ readonly kind: 'delta'; readonly sessionId: string; readonly step?: number } & HackerCodeAgentTurnEvent)
	| { readonly kind: 'toolCall'; readonly sessionId: string; readonly step?: number; readonly id: string; readonly name: string; readonly arguments: Record<string, unknown> }
	| { readonly kind: 'toolResult'; readonly sessionId: string; readonly step?: number; readonly id: string; readonly name: string; readonly result: unknown }
	| ({ readonly kind: 'confirmRequest'; readonly sessionId: string; readonly confirmId: string } & IHackerCodeAgentPromoteConfirmDetails)
	| { readonly kind: 'controlState'; readonly state: IHackerCodeState }
	| { readonly kind: 'error'; readonly sessionId?: string; readonly message: string };
