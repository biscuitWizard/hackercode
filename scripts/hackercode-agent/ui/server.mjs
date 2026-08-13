/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { serverMessage, validateClientMessage } from './protocol.mjs';

/**
 * The driver's own loopback WebSocket server for the workbench view. It
 * intentionally mirrors the on-disk metadata conventions of HackerCode's
 * control endpoint (127.0.0.1-only, ephemeral port, 0700 directory, 0600
 * file written via a temp-file-then-rename, timing-safe token comparison --
 * see hackerCodeControlService.ts `initializeControlEndpoint`) so that the
 * same operational hygiene applies to a second, deliberately weaker token:
 * this one grants only agent-chat UI access, never control-plane authority.
 */

const AGENT_METADATA_FILE_NAME = 'agent.json';
const HOST = '127.0.0.1';

export function generateAgentUiToken() {
	return randomBytes(32).toString('base64url');
}

function agentDirectory(userDataDir) {
	return join(userDataDir, 'hackercode');
}

function agentMetadataPath(userDataDir) {
	return join(agentDirectory(userDataDir), AGENT_METADATA_FILE_NAME);
}

export async function writeAgentEndpointMetadata(userDataDir, metadata) {
	const directory = agentDirectory(userDataDir);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const finalPath = agentMetadataPath(userDataDir);
	const temporaryPath = join(directory, `.${AGENT_METADATA_FILE_NAME}.${randomUUID()}.tmp`);
	await writeFile(temporaryPath, `${JSON.stringify(metadata, undefined, '\t')}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
	await chmod(temporaryPath, 0o600);
	await rename(temporaryPath, finalPath);
	await chmod(finalPath, 0o600);
}

export async function removeAgentEndpointMetadata(userDataDir, metadata) {
	try {
		const onDisk = JSON.parse(await readFile(agentMetadataPath(userDataDir), 'utf8'));
		if (onDisk.pid !== metadata.pid || onDisk.token !== metadata.token) {
			// A newer driver process already replaced the metadata; leave it alone.
			return;
		}
	} catch {
		return;
	}
	await rm(agentMetadataPath(userDataDir), { force: true });
}

export async function readAgentEndpointMetadata(userDataDir) {
	const parsed = JSON.parse(await readFile(agentMetadataPath(userDataDir), 'utf8'));
	if (parsed.protocol !== 'ws'
		|| parsed.host !== HOST
		|| !Number.isSafeInteger(parsed.port)
		|| typeof parsed.token !== 'string'
		|| parsed.token.length === 0) {
		throw new Error('Invalid HackerCode agent endpoint metadata');
	}
	return parsed;
}

function isMatchingToken(candidate, expected) {
	if (typeof candidate !== 'string') {
		return false;
	}
	const candidateBytes = Buffer.from(candidate, 'utf8');
	const expectedBytes = Buffer.from(expected, 'utf8');
	return candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes);
}

function extractToken(requestUrl) {
	try {
		const url = new URL(requestUrl, `http://${HOST}`);
		return url.searchParams.get('tkn') ?? undefined;
	} catch {
		return undefined;
	}
}

/**
 * Starts the loopback UI server and writes its metadata to
 * `<userDataDir>/hackercode/agent.json`. Callers supply `onMessage` to
 * handle validated client messages; this module never interprets message
 * bodies beyond the outer `{ kind }` envelope (see ./protocol.mjs).
 *
 * @param {{
 *   userDataDir: string,
 *   onMessage: (connectionId: string, message: object) => void,
 *   onConnectionClosed?: (connectionId: string) => void,
 *   logger?: { warn: (message: string) => void }
 * }} options
 */
export async function startAgentUiServer(options) {
	const { userDataDir, onMessage, onConnectionClosed, logger } = options;
	const token = generateAgentUiToken();
	const connections = new Map();

	const wss = new WebSocketServer({
		host: HOST,
		port: 0,
		verifyClient: (info, callback) => {
			callback(isMatchingToken(extractToken(info.req.url ?? ''), token));
		}
	});

	await new Promise((resolveListening, rejectListening) => {
		wss.once('listening', resolveListening);
		wss.once('error', rejectListening);
	});

	wss.on('connection', socket => {
		const connectionId = randomUUID();
		connections.set(connectionId, socket);

		socket.on('message', data => {
			let message;
			try {
				message = validateClientMessage(JSON.parse(data.toString('utf8')));
			} catch (error) {
				sendToConnection(connections, connectionId, serverMessage('error', {
					message: error instanceof Error ? error.message : 'Invalid message'
				}));
				return;
			}
			try {
				onMessage(connectionId, message);
			} catch (error) {
				logger?.warn?.(`Agent UI message handler failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		});

		socket.on('close', () => {
			connections.delete(connectionId);
			onConnectionClosed?.(connectionId);
		});

		socket.on('error', () => {
			// The 'close' handler performs cleanup; nothing else to do here.
		});
	});

	const address = wss.address();
	const metadata = {
		protocol: 'ws',
		host: HOST,
		port: address.port,
		token,
		pid: process.pid
	};
	await writeAgentEndpointMetadata(userDataDir, metadata);

	function sendTo(connectionId, message) {
		sendToConnection(connections, connectionId, message);
	}

	function broadcast(message) {
		for (const connectionId of connections.keys()) {
			sendToConnection(connections, connectionId, message);
		}
	}

	async function dispose() {
		for (const socket of connections.values()) {
			try {
				socket.close();
			} catch {
				// The socket may already be closing.
			}
		}
		connections.clear();
		await new Promise(resolveClosed => wss.close(resolveClosed));
		await removeAgentEndpointMetadata(userDataDir, metadata);
	}

	return { port: address.port, token, sendTo, broadcast, dispose };
}

function sendToConnection(connections, connectionId, message) {
	const socket = connections.get(connectionId);
	if (!socket || socket.readyState !== socket.OPEN) {
		return;
	}
	try {
		socket.send(JSON.stringify(message));
	} catch {
		// Best-effort delivery; a closed/erroring socket is handled by its own
		// 'close' event.
	}
}
