/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { HackerCodeAgentClientMessage, HackerCodeAgentServerMessage } from './hackerCodeAgentProtocol.js';

export const IHackerCodeAgentTransportService = createDecorator<IHackerCodeAgentTransportService>('hackerCodeAgentTransportService');

export const enum HackerCodeAgentConnectionState {
	Disconnected,
	Connecting,
	Connected
}

/**
 * Renderer-side client for the agent driver's loopback UI WebSocket server
 * (see `scripts/hackercode-agent/ui/server.mjs`). This is the *only* seam
 * between the workbench view and the external driver process; the view never
 * touches `agent.json` or the socket directly.
 *
 * Deliberately separate from `IHackerCodeControlService`: that service talks
 * to the Electron main process over IPC with full control-plane authority,
 * while this one talks to a plain external Node process with a weaker,
 * UI-only token that the driver mints independently.
 */
export interface IHackerCodeAgentTransportService {
	readonly _serviceBrand: undefined;

	readonly state: HackerCodeAgentConnectionState;
	readonly onDidChangeState: Event<HackerCodeAgentConnectionState>;

	/** Fires for every validated message received from the driver. */
	readonly onMessage: Event<HackerCodeAgentServerMessage>;

	/** Set when the last connection attempt failed; cleared on success. */
	readonly lastError: string | undefined;

	/**
	 * Connects (or reconnects) to the driver. Safe to call when already
	 * connected or connecting -- it is a no-op in that case. Failures are
	 * surfaced through `lastError` and `onDidChangeState`, not by throwing.
	 */
	connect(): void;

	/** Sends a message if connected. Returns whether it was sent. */
	send(message: HackerCodeAgentClientMessage): boolean;
}
