/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The small, versioned message protocol between the driver's loopback UI
 * WebSocket server and the workbench view. This is deliberately separate
 * from the HackerCode control protocol (docs/hackercode/protocol-and-api.md):
 * it carries no control-plane authority, and the renderer that speaks it
 * never receives the control token.
 */

export const AGENT_UI_PROTOCOL_VERSION = 1;

export const CLIENT_MESSAGE_KINDS = Object.freeze([
	'hello',
	'setProviders',
	'createSession',
	'openSession',
	'closeSession',
	'listSessions',
	'sendTurn',
	'cancelTurn',
	'confirmResponse'
]);

export const SERVER_MESSAGE_KINDS = Object.freeze([
	'hello',
	'sessions',
	'sessionState',
	'delta',
	'toolCall',
	'toolResult',
	'confirmRequest',
	'controlState',
	'error'
]);

export function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates the outer shape of a client -> server message. Domain-specific
 * field validation for each `kind` happens where that message is handled.
 */
export function validateClientMessage(value) {
	if (!isRecord(value) || typeof value.kind !== 'string' || !CLIENT_MESSAGE_KINDS.includes(value.kind)) {
		throw new Error('Invalid agent UI client message');
	}
	return value;
}

export function serverMessage(kind, payload = {}) {
	if (!SERVER_MESSAGE_KINDS.includes(kind)) {
		throw new Error(`Unknown agent UI server message kind: ${kind}`);
	}
	return { kind, ...payload };
}
