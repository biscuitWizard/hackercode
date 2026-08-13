/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A thin, domain-shaped wrapper around the reference `HackerCodeControlClient`
 * (see ../../hackercode-control.mjs). This module is the *only* place in the
 * agent driver that is allowed to speak the HackerCode JSON-RPC control
 * protocol. It never invents a second protocol: every method here maps to
 * exactly one call documented in docs/hackercode/protocol-and-api.md.
 *
 * It adds three things the raw client does not have:
 *  - automatic `baseline`/`parentId` derivation from the live control state,
 *    so a tool-calling model can never author those fields incorrectly;
 *  - pre-flight enforcement of the documented hard limits (patch count,
 *    per-patch size, eval source size) so violations fail fast, locally,
 *    before a wire round trip;
 *  - a narrow, typed-by-convention surface (one method per RPC) that is easy
 *    to unit test and easy to audit for "does this ever leak the token".
 */

export const HACKERCODE_LIMITS = Object.freeze({
	maxPatchesPerRevision: 64,
	maxPatchBytes: 1024 * 1024,
	maxEvalSourceBytes: 256 * 1024
});

export class HackerCodeControlSession {
	/**
	 * @param {import('../../hackercode-control.mjs').HackerCodeControlClient} client
	 */
	constructor(client) {
		this.client = client;
	}

	getState() {
		return this.client.request('getState');
	}

	listRevisions() {
		return this.client.request('listRevisions');
	}

	getRevision(revisionId) {
		return this.client.request('getRevision', { revisionId });
	}

	/**
	 * Creates a revision. `baseline` and `parentId` are derived from live
	 * control state unless explicitly overridden, so a caller (model or
	 * human) cannot author a stale or fabricated baseline.
	 *
	 * @param {{ description?: string, patches: { name: string, content: string }[], baseline?: string, parentId?: string }} request
	 */
	async createRevision(request) {
		assertPatchSet(request.patches);
		let baseline = request.baseline;
		let parentId = request.parentId;
		if (baseline === undefined || parentId === undefined) {
			const state = await this.getState();
			if (baseline === undefined) {
				if (typeof state.baseline?.current !== 'string' || state.baseline.current.length === 0) {
					throw new Error('Cannot derive a source baseline: state.baseline.current is unavailable. This is expected for a built product; supply baseline explicitly only if you understand promotion will be unavailable.');
				}
				baseline = state.baseline.current;
			}
			if (parentId === undefined) {
				parentId = state.activeRevisionId;
			}
		}
		return this.client.request('createRevision', {
			baseline,
			parentId,
			...(request.description === undefined ? {} : { description: request.description }),
			patches: request.patches.map(patch => ({ name: patch.name, content: patch.content }))
		});
	}

	/**
	 * @param {{ revisionId: string, windowId?: number, mode?: 'normal' | 'recover' }} request
	 */
	setRevision(request) {
		return this.client.request('setRevision', {
			revisionId: request.revisionId,
			mode: request.mode ?? 'normal',
			...(request.windowId === undefined ? {} : { windowId: request.windowId })
		});
	}

	reload(request) {
		return this.client.request('reload', { revisionId: request.revisionId, windowId: request.windowId });
	}

	safeMode(request = {}) {
		return this.client.request('safeMode', {
			...(request.reason === undefined ? {} : { reason: request.reason }),
			...(request.windowId === undefined ? {} : { windowId: request.windowId })
		});
	}

	/**
	 * @param {{ revisionId: string, windowId: number, commitMessage?: string }} request
	 */
	promote(request) {
		return this.client.request('promote', {
			revisionId: request.revisionId,
			windowId: request.windowId,
			...(request.commitMessage === undefined ? {} : { commitMessage: request.commitMessage })
		});
	}

	/**
	 * @param {{ source: string, windowId?: number }} request
	 */
	eval(request) {
		assertEvalSource(request.source);
		return this.client.request('eval', {
			source: request.source,
			...(request.windowId === undefined ? {} : { windowId: request.windowId })
		});
	}

	/**
	 * @param {{ mode: 'soft' | 'module' | 'hard', specifier?: string, windowId?: number }} request
	 */
	refresh(request) {
		if (request.mode === 'module' && !request.specifier) {
			throw new Error('module refresh requires a specifier');
		}
		if (request.mode !== 'module' && request.specifier !== undefined) {
			throw new Error('specifier is only valid for module refresh');
		}
		return this.client.request('refresh', {
			mode: request.mode,
			...(request.specifier === undefined ? {} : { specifier: request.specifier }),
			...(request.windowId === undefined ? {} : { windowId: request.windowId })
		});
	}

	close() {
		this.client.close();
	}
}

export function assertPatchSet(patches) {
	if (!Array.isArray(patches) || patches.length === 0) {
		throw new Error('A revision requires at least one patch');
	}
	if (patches.length > HACKERCODE_LIMITS.maxPatchesPerRevision) {
		throw new Error(`A revision may contain at most ${HACKERCODE_LIMITS.maxPatchesPerRevision} patches (got ${patches.length})`);
	}
	for (const patch of patches) {
		if (typeof patch?.name !== 'string' || patch.name.trim().length === 0) {
			throw new Error('Every patch requires a non-empty name');
		}
		if (typeof patch?.content !== 'string') {
			throw new Error(`Patch "${patch?.name}" is missing string content`);
		}
		const bytes = Buffer.byteLength(patch.content, 'utf8');
		if (bytes > HACKERCODE_LIMITS.maxPatchBytes) {
			throw new Error(`Patch "${patch.name}" is ${bytes} bytes, exceeding the ${HACKERCODE_LIMITS.maxPatchBytes}-byte limit`);
		}
	}
}

export function assertEvalSource(source) {
	if (typeof source !== 'string' || source.length === 0) {
		throw new Error('eval requires non-empty source');
	}
	const bytes = Buffer.byteLength(source, 'utf8');
	if (bytes > HACKERCODE_LIMITS.maxEvalSourceBytes) {
		throw new Error(`eval source is ${bytes} bytes, exceeding the ${HACKERCODE_LIMITS.maxEvalSourceBytes}-byte wire limit`);
	}
}
