/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Agent chat session transcripts, persisted per user-data directory so a
 * fresh driver process (or a reconnecting view) can resume tabs. Sessions are
 * plain JSON with mode 0600, alongside the rest of HackerCode's agent state
 * (`<user-data-dir>/hackercode/agent/`). This is bookkeeping only: it holds
 * no control-plane authority and is never consulted for trust decisions.
 */

function sessionsDirectory(userDataDir) {
	return join(userDataDir, 'hackercode', 'agent', 'sessions');
}

function sessionPath(userDataDir, id) {
	return join(sessionsDirectory(userDataDir), `${id}.json`);
}

export function createSessionState({ title, mode = 'agent', providerId, model } = {}) {
	const now = new Date().toISOString();
	return {
		id: randomUUID(),
		title: title ?? 'New session',
		mode,
		providerId,
		model,
		createdAt: now,
		updatedAt: now,
		messages: [],
		patches: []
	};
}

export async function saveSession(userDataDir, sessionState) {
	const directory = sessionsDirectory(userDataDir);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	sessionState.updatedAt = new Date().toISOString();
	const path = sessionPath(userDataDir, sessionState.id);
	await writeFile(path, `${JSON.stringify(sessionState, null, '\t')}\n`, { mode: 0o600 });
	await chmod(path, 0o600);
	return sessionState;
}

export async function loadSession(userDataDir, id) {
	const raw = await readFile(sessionPath(userDataDir, id), 'utf8');
	return JSON.parse(raw);
}

export async function listSessionSummaries(userDataDir) {
	let entries;
	try {
		entries = await readdir(sessionsDirectory(userDataDir));
	} catch {
		return [];
	}
	const summaries = [];
	for (const entry of entries) {
		if (!entry.endsWith('.json')) {
			continue;
		}
		try {
			const state = await loadSession(userDataDir, entry.slice(0, -'.json'.length));
			summaries.push({
				id: state.id,
				title: state.title,
				mode: state.mode,
				providerId: state.providerId,
				model: state.model,
				createdAt: state.createdAt,
				updatedAt: state.updatedAt,
				messageCount: state.messages.length
			});
		} catch {
			// Skip a corrupt or partially written session file rather than
			// failing the whole listing.
		}
	}
	summaries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
	return summaries;
}

export async function deleteSession(userDataDir, id) {
	await rm(sessionPath(userDataDir, id), { force: true });
}
