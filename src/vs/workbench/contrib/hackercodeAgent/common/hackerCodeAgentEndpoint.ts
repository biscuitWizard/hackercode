/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/**
 * Connection metadata for the agent driver's loopback UI WebSocket server,
 * as written to `<user-data-dir>/hackercode/agent.json` by
 * `scripts/hackercode-agent/ui/server.mjs`. This token is deliberately
 * weaker than the HackerCode control-plane token: it grants only agent-chat
 * UI access, never control authority.
 */
export interface IHackerCodeAgentEndpoint {
	readonly protocol: 'ws';
	readonly host: string;
	readonly port: number;
	readonly token: string;
	readonly pid: number;
}

export const IHackerCodeAgentEndpointService = createDecorator<IHackerCodeAgentEndpointService>('hackerCodeAgentEndpointService');

/**
 * Resolves the driver's UI endpoint from disk. Split out from
 * `IHackerCodeAgentTransportService` so that only this narrow, native-only
 * concern (locating the user data directory and reading a file) needs the
 * electron-browser layer; the actual WebSocket connection is plain browser
 * code, same as HackerCode's own eval channel.
 */
export interface IHackerCodeAgentEndpointService {
	readonly _serviceBrand: undefined;

	/** Returns `undefined` if the driver is not currently running. */
	getEndpoint(): Promise<IHackerCodeAgentEndpoint | undefined>;
}
