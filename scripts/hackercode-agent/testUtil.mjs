/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared test doubles for the agent driver's own test suite. Not imported by
 * any non-test module.
 */

/**
 * A fake WebSocket matching the minimal surface `HackerCodeControlClient`
 * (../hackercode-control.mjs) requires, plus a scriptable `handler` so tests
 * can fake main-process JSON-RPC responses without a real endpoint.
 */
export class FakeControlSocket {
	constructor(handler) {
		this.readyState = 1;
		this.sent = [];
		this.listeners = new Map();
		this.handler = handler;
	}

	addEventListener(type, listener) {
		const listeners = this.listeners.get(type) ?? new Set();
		listeners.add(listener);
		this.listeners.set(type, listeners);
	}

	removeEventListener(type, listener) {
		this.listeners.get(type)?.delete(listener);
	}

	send(value) {
		this.sent.push(value);
		const request = JSON.parse(value);
		if (!this.handler) {
			return;
		}
		Promise.resolve(this.handler(request)).then(outcome => {
			if (!outcome) {
				return;
			}
			this.emit('message', { data: JSON.stringify(outcome) });
		});
	}

	close() {
		this.readyState = 3;
		this.emit('close', {});
	}

	emit(type, event) {
		for (const listener of this.listeners.get(type) ?? []) {
			listener(event);
		}
	}
}

/**
 * Builds a `{ jsonrpc, id, result }` or `{ jsonrpc, id, error }` response for
 * a captured request, matching the shape `HackerCodeControlClient` expects.
 */
export function respondOk(request, result) {
	return { jsonrpc: '2.0', id: request.id, result };
}

export function respondError(request, code, message) {
	return { jsonrpc: '2.0', id: request.id, error: { code, message } };
}

/**
 * A minimal fake `HackerCodeControlSession`-shaped object for unit tests
 * that only need to record calls and return scripted results, without a
 * real socket.
 */
export function createFakeSession(overrides = {}) {
	const calls = [];
	const record = (name, args) => calls.push({ name, args });
	const base = {
		calls,
		getState: async () => { record('getState', undefined); return overrides.state ?? { activeRevisionId: 'pristine', lastKnownGoodRevisionId: 'pristine', quarantinedRevisions: [], baseline: { current: 'a'.repeat(40) } }; },
		listRevisions: async () => { record('listRevisions', undefined); return overrides.revisions ?? []; },
		createRevision: async args => { record('createRevision', args); return overrides.createRevision ? overrides.createRevision(args) : { id: 'b'.repeat(64), ...args }; },
		setRevision: async args => { record('setRevision', args); return overrides.setRevision ? overrides.setRevision(args) : { activeRevisionId: args.revisionId }; },
		eval: async args => { record('eval', args); return overrides.eval ? overrides.eval(args) : null; },
		refresh: async args => { record('refresh', args); return overrides.refresh ? overrides.refresh(args) : null; },
		safeMode: async args => { record('safeMode', args); return overrides.safeMode ? overrides.safeMode(args) : {}; },
		promote: async args => { record('promote', args); return overrides.promote ? overrides.promote(args) : { revisionId: args.revisionId }; },
		close: () => { record('close', undefined); }
	};
	return { ...base, ...overrides.methods };
}
