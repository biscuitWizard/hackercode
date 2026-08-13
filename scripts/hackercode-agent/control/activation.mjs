/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The health gate for revision activation.
 *
 * A successful `setRevision` response only proves that main persisted the
 * selection and started a reload (see docs/hackercode/operations.md, "Observe
 * healthy completion"). This module is the one place that turns that response
 * into an actual pass/fail judgement, by polling `getState` across the
 * renderer reload it triggers and running caller-supplied verification only
 * once the ledger looks healthy.
 *
 * It deliberately never retries activation of the same revision: if it comes
 * back quarantined, that is terminal for this call. The caller (agent loop)
 * decides what to do next (create a new revision, safe mode, or fall back).
 */

const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_TIMEOUT_MS = 60_000;
const RENDERER_UNAVAILABLE_CODE = -32001;

/**
 * @param {import('./session.mjs').HackerCodeControlSession} session
 * @param {{
 *   revisionId: string,
 *   windowId?: number,
 *   mode?: 'normal' | 'recover',
 *   pollIntervalMs?: number,
 *   timeoutMs?: number,
 *   verify?: (session: import('./session.mjs').HackerCodeControlSession) => Promise<unknown>
 * }} options
 * @returns {Promise<{
 *   ok: true, state: object, verification?: unknown
 * } | {
 *   ok: false, reason: 'quarantined' | 'timeout' | 'verification-failed' | 'activation-failed',
 *   detail: string, state?: object
 * }>}
 */
export async function activateRevisionAndWaitHealthy(session, options) {
	const {
		revisionId,
		windowId,
		mode = 'normal',
		pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
		timeoutMs = DEFAULT_TIMEOUT_MS,
		verify
	} = options;

	try {
		await session.setRevision({ revisionId, windowId, mode });
	} catch (error) {
		return { ok: false, reason: 'activation-failed', detail: describeError(error) };
	}

	const deadline = Date.now() + timeoutMs;
	let lastState;
	let lastError;

	while (Date.now() < deadline) {
		try {
			const state = await session.getState();
			lastState = state;

			const quarantine = (state.quarantinedRevisions ?? []).find(entry => entry.revisionId === revisionId);
			if (quarantine) {
				return {
					ok: false,
					reason: 'quarantined',
					detail: quarantine.reason ?? 'Revision was quarantined without a stated reason',
					state
				};
			}

			const isHealthy = state.activeRevisionId === revisionId
				&& state.bootAttempt === undefined
				&& state.lastKnownGoodRevisionId === revisionId;

			if (isHealthy) {
				if (!verify) {
					return { ok: true, state };
				}
				try {
					const verification = await verify(session);
					return { ok: true, state, verification };
				} catch (error) {
					return {
						ok: false,
						reason: 'verification-failed',
						detail: describeError(error),
						state
					};
				}
			}
		} catch (error) {
			// `Renderer unavailable` is the expected shape of a window mid-reload;
			// keep polling instead of treating it as fatal. Anything else is
			// recorded but also retried until the deadline, because main-owned
			// state (getState) is the source of truth and transient RPC hiccups
			// during a reload are not evidence of quarantine.
			lastError = error;
			if (!isTransientDuringReload(error)) {
				// Still retry: only getState's own success/failure content
				// (quarantine, healthy) is terminal here, not a transport error.
			}
		}

		await delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
	}

	return {
		ok: false,
		reason: 'timeout',
		detail: lastState
			? `Timed out waiting for healthy activation (active=${lastState.activeRevisionId}, bootAttempt=${lastState.bootAttempt?.revisionId ?? 'none'})`
			: describeError(lastError) || 'Timed out waiting for healthy activation with no successful getState response',
		state: lastState
	};
}

function isTransientDuringReload(error) {
	return error && typeof error === 'object' && error.code === RENDERER_UNAVAILABLE_CODE;
}

function describeError(error) {
	if (!error) {
		return '';
	}
	return error instanceof Error ? error.message : String(error);
}

function delay(ms) {
	return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}
