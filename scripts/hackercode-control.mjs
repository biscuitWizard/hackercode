/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_TIMEOUT_MS = 35_000;
const OPEN_READY_STATE = 1;

const HELP = `HackerCode reference control driver

Usage:
  npm run hackercode:control -- --control-file <path> <command> [options]

The control file may instead be supplied with HACKERCODE_CONTROL_FILE.
Successful commands print one JSON object to stdout. RPC failures also print a
JSON error object and exit nonzero. The authentication token is never printed.

Commands:
  state
      Read the current ledger and baseline.
  list
      List known revisions.
  eval (--source <body> | --file <path> | --stdin) [--window-id <id>]
      Evaluate an async-function body in the renderer. Source is sent as data;
      this driver never evaluates it or passes it through a shell.
  create --request-file <path>
      Create, but do not activate, a revision. Each patch in the JSON request
      may use "contentFile" instead of "content"; paths are relative to the
      request file. Source files are read verbatim and never evaluated locally.
  select --revision <id> [--window-id <id>] [--recover]
      Activate a revision and reload the selected workbench window(s).
  refresh <soft|module|hard> [--specifier <module>] [--window-id <id>]
      Soft-reapply patches, refresh a tracked module, or hard-reload.
  safe-mode [--reason <text>] [--window-id <id>]
      Quarantine/fall back in main and reload in no-patch safe mode.
  promote --revision <id> --window-id <id>
      --confirm-promote <same-id> [--commit-message <one-line-message>]
      Promote the active revision and create a real git commit. Confirmation
      must exactly repeat the revision id.

Global options:
  --control-file <path>   Explicit token-bearing control.json path.
  --timeout-ms <ms>       Per-request/connect timeout (default: 35000).
  --help                  Show this workflow.

Agent workflow:
  1. state; use result.baseline.current for the create request.
  2. create; retain result.id from stdout.
  3. select that id; poll state until bootAttempt is absent and the id is
     lastKnownGood, then observe the intended behavior.
  4. use safe-mode for recovery. Promote only after validation and only with
     the exact repeated --confirm-promote value.
`;

export class HackerCodeRpcError extends Error {
	constructor(code, message, data) {
		super(message);
		this.name = 'HackerCodeRpcError';
		this.code = code;
		this.data = data;
	}
}

export class HackerCodeControlClient {
	constructor(socket, options = {}) {
		this.socket = socket;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.nextRequestId = 1;
		this.pending = new Map();
		this.disposed = false;
		this.listenerDisposers = [
			addSocketListener(socket, 'message', event => void this.handleMessage(event)),
			addSocketListener(socket, 'close', () => this.failAll(new Error('HackerCode control connection closed'))),
			addSocketListener(socket, 'error', () => this.failAll(new Error('HackerCode control connection failed')))
		];
	}

	request(method, params, timeoutMs = this.timeoutMs) {
		if (this.disposed || this.socket.readyState !== OPEN_READY_STATE) {
			return Promise.reject(new Error('HackerCode control connection is not open'));
		}
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
			return Promise.reject(new Error('RPC timeout must be a positive safe integer'));
		}

		const id = this.nextRequestId++;
		if (!Number.isSafeInteger(id) || id < 0) {
			return Promise.reject(new Error('HackerCode JSON-RPC request id space was exhausted'));
		}
		const request = {
			jsonrpc: '2.0',
			id,
			method,
			...(params === undefined ? {} : { params })
		};

		return new Promise((resolveRequest, rejectRequest) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				rejectRequest(new Error(`HackerCode RPC request timed out: ${method}`));
			}, timeoutMs);
			this.pending.set(id, {
				method,
				resolve: resolveRequest,
				reject: rejectRequest,
				timeout
			});
			try {
				this.socket.send(JSON.stringify(request));
			} catch {
				clearTimeout(timeout);
				this.pending.delete(id);
				rejectRequest(new Error(`Failed to send HackerCode RPC request: ${method}`));
			}
		});
	}

	async handleMessage(event) {
		let text;
		try {
			text = await socketMessageText(event);
		} catch {
			this.failAll(new Error('Received unreadable data from HackerCode control endpoint'));
			return;
		}

		let response;
		try {
			response = JSON.parse(text);
		} catch {
			this.failAll(new Error('Received invalid JSON from HackerCode control endpoint'));
			return;
		}
		if (!isRecord(response) || response.jsonrpc !== '2.0' || !Number.isSafeInteger(response.id) || response.id < 0) {
			this.failAll(new Error('Received an invalid JSON-RPC response'));
			return;
		}

		const pending = this.pending.get(response.id);
		if (!pending) {
			return;
		}
		const hasResult = Object.hasOwn(response, 'result');
		const hasError = Object.hasOwn(response, 'error');
		if (hasResult === hasError) {
			this.rejectPending(response.id, new Error(`Received a malformed response for HackerCode RPC request: ${pending.method}`));
			return;
		}
		if (hasResult) {
			this.resolvePending(response.id, response.result);
			return;
		}
		if (!isRecord(response.error)
			|| !Number.isSafeInteger(response.error.code)
			|| typeof response.error.message !== 'string') {
			this.rejectPending(response.id, new Error(`Received a malformed error for HackerCode RPC request: ${pending.method}`));
			return;
		}
		this.rejectPending(response.id, new HackerCodeRpcError(
			response.error.code,
			response.error.message,
			response.error.data
		));
	}

	resolvePending(id, result) {
		const pending = this.pending.get(id);
		if (!pending) {
			return;
		}
		clearTimeout(pending.timeout);
		this.pending.delete(id);
		pending.resolve(result);
	}

	rejectPending(id, error) {
		const pending = this.pending.get(id);
		if (!pending) {
			return;
		}
		clearTimeout(pending.timeout);
		this.pending.delete(id);
		pending.reject(error);
	}

	failAll(error) {
		for (const id of [...this.pending.keys()]) {
			this.rejectPending(id, error);
		}
	}

	close() {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		for (const dispose of this.listenerDisposers) {
			dispose();
		}
		this.failAll(new Error('HackerCode control client was closed'));
		try {
			this.socket.close();
		} catch {
			// The connection is already unusable.
		}
	}
}

export function parseArguments(argv, env = process.env) {
	const options = new Map();
	const positionals = [];
	const valueOptions = new Set([
		'control-file',
		'timeout-ms',
		'window-id',
		'source',
		'file',
		'request-file',
		'revision',
		'specifier',
		'reason',
		'confirm-promote',
		'commit-message'
	]);
	const booleanOptions = new Set(['help', 'stdin', 'recover']);

	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (!argument.startsWith('--')) {
			positionals.push(argument);
			continue;
		}
		const equalsIndex = argument.indexOf('=');
		const name = argument.slice(2, equalsIndex < 0 ? undefined : equalsIndex);
		if (!valueOptions.has(name) && !booleanOptions.has(name)) {
			throw new Error(`Unknown option: --${name}`);
		}
		if (options.has(name)) {
			throw new Error(`Option may only be supplied once: --${name}`);
		}
		if (booleanOptions.has(name)) {
			if (equalsIndex >= 0) {
				throw new Error(`Option does not accept a value: --${name}`);
			}
			options.set(name, true);
			continue;
		}
		const value = equalsIndex >= 0 ? argument.slice(equalsIndex + 1) : argv[++index];
		if (value === undefined || value.length === 0) {
			throw new Error(`Option requires a value: --${name}`);
		}
		options.set(name, value);
	}

	if (options.get('help') === true) {
		return { command: 'help' };
	}
	const command = positionals.shift();
	if (!command) {
		throw new Error('A command is required. Use --help for the workflow.');
	}
	const controlFile = options.get('control-file') ?? env.HACKERCODE_CONTROL_FILE;
	if (typeof controlFile !== 'string' || controlFile.length === 0) {
		throw new Error('Supply --control-file or HACKERCODE_CONTROL_FILE');
	}
	const timeoutMs = parsePositiveInteger(options.get('timeout-ms') ?? String(DEFAULT_TIMEOUT_MS), '--timeout-ms');
	const windowId = options.has('window-id')
		? parsePositiveInteger(options.get('window-id'), '--window-id')
		: undefined;

	const common = { command, controlFile: resolve(controlFile), timeoutMs };
	switch (command) {
		case 'state':
		case 'list':
			assertCommandShape(command, positionals, options, []);
			return common;
		case 'eval': {
			assertCommandShape(command, positionals, options, ['window-id', 'source', 'file', 'stdin']);
			const sources = ['source', 'file', 'stdin'].filter(name => options.has(name));
			if (sources.length !== 1) {
				throw new Error('eval requires exactly one of --source, --file, or --stdin');
			}
			return {
				...common,
				windowId,
				input: options.has('source') ? { kind: 'inline', value: options.get('source') }
					: options.has('file') ? { kind: 'file', value: resolve(options.get('file')) }
						: { kind: 'stdin' }
			};
		}
		case 'create':
			assertCommandShape(command, positionals, options, ['request-file']);
			if (!options.has('request-file')) {
				throw new Error('create requires --request-file');
			}
			return { ...common, requestFile: resolve(options.get('request-file')) };
		case 'select':
			assertCommandShape(command, positionals, options, ['revision', 'window-id', 'recover']);
			requireOption(options, 'revision', command);
			return {
				...common,
				revisionId: options.get('revision'),
				windowId,
				mode: options.has('recover') ? 'recover' : 'normal'
			};
		case 'refresh': {
			assertCommandShape(command, positionals.slice(1), options, ['window-id', 'specifier']);
			const mode = positionals[0];
			if (mode !== 'soft' && mode !== 'module' && mode !== 'hard') {
				throw new Error('refresh requires one mode: soft, module, or hard');
			}
			if (mode === 'module' && !options.has('specifier')) {
				throw new Error('module refresh requires --specifier');
			}
			if (mode !== 'module' && options.has('specifier')) {
				throw new Error('--specifier is only valid for module refresh');
			}
			return { ...common, mode, specifier: options.get('specifier'), windowId };
		}
		case 'safe-mode':
			assertCommandShape(command, positionals, options, ['window-id', 'reason']);
			return { ...common, windowId, reason: options.get('reason') };
		case 'promote':
			assertCommandShape(command, positionals, options, ['revision', 'window-id', 'confirm-promote', 'commit-message']);
			requireOption(options, 'revision', command);
			requireOption(options, 'window-id', command);
			requireOption(options, 'confirm-promote', command);
			if (options.get('confirm-promote') !== options.get('revision')) {
				throw new Error('--confirm-promote must exactly repeat --revision');
			}
			return {
				...common,
				revisionId: options.get('revision'),
				windowId,
				commitMessage: options.get('commit-message')
			};
		default:
			throw new Error(`Unknown command: ${command}`);
	}
}

export async function readControlMetadata(controlFile) {
	let parsed;
	try {
		parsed = JSON.parse(await readFile(controlFile, 'utf8'));
	} catch {
		throw new Error(`Unable to read a valid HackerCode control file: ${basename(controlFile)}`);
	}
	if (!isRecord(parsed)
		|| parsed.protocol !== 'ws'
		|| parsed.host !== '127.0.0.1'
		|| !Number.isSafeInteger(parsed.port)
		|| parsed.port <= 0
		|| parsed.port > 65_535
		|| typeof parsed.token !== 'string'
		|| parsed.token.length === 0
		|| !Number.isSafeInteger(parsed.pid)
		|| parsed.pid <= 0) {
		throw new Error(`Invalid HackerCode control metadata: ${basename(controlFile)}`);
	}
	return parsed;
}

export async function loadCreateRevisionRequest(requestFile) {
	let request;
	try {
		request = JSON.parse(await readFile(requestFile, 'utf8'));
	} catch {
		throw new Error(`Unable to read a valid revision request: ${basename(requestFile)}`);
	}
	if (!isRecord(request)
		|| !hasOnlyKeys(request, ['baseline', 'description', 'parentId', 'patches'])
		|| typeof request.baseline !== 'string'
		|| (request.description !== undefined && typeof request.description !== 'string')
		|| (request.parentId !== undefined && typeof request.parentId !== 'string')
		|| !Array.isArray(request.patches)) {
		throw new Error('Invalid createRevision request file');
	}

	const requestDirectory = dirname(requestFile);
	const patches = [];
	for (const patch of request.patches) {
		if (!isRecord(patch)
			|| !hasOnlyKeys(patch, ['name', 'content', 'contentFile'])
			|| typeof patch.name !== 'string'
			|| (typeof patch.content === 'string') === (typeof patch.contentFile === 'string')) {
			throw new Error('Each patch requires name and exactly one of content or contentFile');
		}
		const content = typeof patch.content === 'string'
			? patch.content
			: await readPatchContent(resolve(requestDirectory, patch.contentFile));
		patches.push({ name: patch.name, content });
	}
	return {
		baseline: request.baseline,
		...(request.description === undefined ? {} : { description: request.description }),
		...(request.parentId === undefined ? {} : { parentId: request.parentId }),
		patches
	};
}

export async function connectHackerCodeControl(metadata, options = {}) {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const WebSocketConstructor = options.WebSocketConstructor ?? await loadWebSocketConstructor();
	const url = `${metadata.protocol}://${metadata.host}:${metadata.port}/?tkn=${encodeURIComponent(metadata.token)}`;
	let socket;
	try {
		socket = new WebSocketConstructor(url);
	} catch {
		throw new Error('Failed to create HackerCode control connection');
	}

	try {
		await waitForSocketOpen(socket, timeoutMs);
	} catch {
		try {
			socket.close();
		} catch {
			// The failed connection is already closed.
		}
		throw new Error('Failed to connect to HackerCode control endpoint');
	}
	return new HackerCodeControlClient(socket, { timeoutMs });
}

async function executeCommand(parsed, client) {
	switch (parsed.command) {
		case 'state':
			return client.request('getState');
		case 'list':
			return client.request('listRevisions');
		case 'eval': {
			const source = parsed.input.kind === 'inline'
				? parsed.input.value
				: parsed.input.kind === 'file'
					? await readFile(parsed.input.value, 'utf8')
					: await readStandardInput();
			return client.request('eval', {
				source,
				...(parsed.windowId === undefined ? {} : { windowId: parsed.windowId })
			});
		}
		case 'create':
			return client.request('createRevision', await loadCreateRevisionRequest(parsed.requestFile));
		case 'select':
			return client.request('setRevision', {
				revisionId: parsed.revisionId,
				mode: parsed.mode,
				...(parsed.windowId === undefined ? {} : { windowId: parsed.windowId })
			});
		case 'refresh':
			return client.request('refresh', {
				mode: parsed.mode,
				...(parsed.specifier === undefined ? {} : { specifier: parsed.specifier }),
				...(parsed.windowId === undefined ? {} : { windowId: parsed.windowId })
			});
		case 'safe-mode':
			return client.request('safeMode', {
				...(parsed.reason === undefined ? {} : { reason: parsed.reason }),
				...(parsed.windowId === undefined ? {} : { windowId: parsed.windowId })
			});
		case 'promote':
			return client.request('promote', {
				revisionId: parsed.revisionId,
				windowId: parsed.windowId,
				...(parsed.commitMessage === undefined ? {} : { commitMessage: parsed.commitMessage })
			});
		default:
			throw new Error(`Unsupported command: ${parsed.command}`);
	}
}

async function main() {
	let metadata;
	let client;
	try {
		const parsed = parseArguments(process.argv.slice(2));
		if (parsed.command === 'help') {
			process.stdout.write(HELP);
			return;
		}
		metadata = await readControlMetadata(parsed.controlFile);
		assertLiveControlPid(metadata.pid);
		client = await connectHackerCodeControl(metadata, { timeoutMs: parsed.timeoutMs });
		const result = await executeCommand(parsed, client);
		writeJson({ ok: true, command: parsed.command, result });
	} catch (error) {
		const safeError = formatError(error, metadata?.token);
		writeJson({ ok: false, error: safeError });
		process.exitCode = 1;
	} finally {
		client?.close();
	}
}

function assertCommandShape(command, positionals, options, commandOptions) {
	if (positionals.length > 0) {
		throw new Error(`Unexpected positional argument for ${command}: ${positionals[0]}`);
	}
	const allowed = new Set(['control-file', 'timeout-ms', ...commandOptions]);
	for (const name of options.keys()) {
		if (!allowed.has(name)) {
			throw new Error(`Option --${name} is not valid for ${command}`);
		}
	}
}

function requireOption(options, name, command) {
	if (!options.has(name)) {
		throw new Error(`${command} requires --${name}`);
	}
}

function parsePositiveInteger(value, name) {
	if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
		throw new Error(`${name} must be a positive integer`);
	}
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed)) {
		throw new Error(`${name} must be a positive safe integer`);
	}
	return parsed;
}

function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value, allowedKeys) {
	return Object.keys(value).every(key => allowedKeys.includes(key));
}

function assertLiveControlPid(pid) {
	try {
		process.kill(pid, 0);
	} catch (error) {
		if (!(error instanceof Error && 'code' in error && error.code === 'EPERM')) {
			throw new Error(`HackerCode control endpoint pid is not live: ${pid}`);
		}
	}
}

async function readPatchContent(path) {
	try {
		return await readFile(path, 'utf8');
	} catch {
		throw new Error(`Unable to read patch content file: ${basename(path)}`);
	}
}

async function readStandardInput() {
	const chunks = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString('utf8');
}

async function loadWebSocketConstructor() {
	if (typeof globalThis.WebSocket === 'function') {
		return globalThis.WebSocket;
	}
	try {
		return (await import('ws')).default;
	} catch {
		throw new Error('No WebSocket implementation is available');
	}
}

function waitForSocketOpen(socket, timeoutMs) {
	if (socket.readyState === OPEN_READY_STATE) {
		return Promise.resolve();
	}
	return new Promise((resolveOpen, rejectOpen) => {
		const disposers = [];
		const finish = callback => {
			clearTimeout(timeout);
			for (const dispose of disposers) {
				dispose();
			}
			callback();
		};
		disposers.push(
			addSocketListener(socket, 'open', () => finish(resolveOpen)),
			addSocketListener(socket, 'error', () => finish(rejectOpen)),
			addSocketListener(socket, 'close', () => finish(rejectOpen))
		);
		const timeout = setTimeout(() => finish(rejectOpen), timeoutMs);
	});
}

function addSocketListener(socket, type, listener) {
	if (typeof socket.addEventListener === 'function') {
		socket.addEventListener(type, listener);
		return () => socket.removeEventListener(type, listener);
	}
	if (typeof socket.on === 'function') {
		socket.on(type, listener);
		return () => {
			if (typeof socket.off === 'function') {
				socket.off(type, listener);
			} else {
				socket.removeListener?.(type, listener);
			}
		};
	}
	throw new Error('Unsupported WebSocket implementation');
}

async function socketMessageText(event) {
	const data = isRecord(event) && 'data' in event ? event.data : event;
	if (typeof data === 'string') {
		return data;
	}
	if (Buffer.isBuffer(data)) {
		return data.toString('utf8');
	}
	if (data instanceof ArrayBuffer) {
		return Buffer.from(data).toString('utf8');
	}
	if (ArrayBuffer.isView(data)) {
		return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
	}
	if (data && typeof data.text === 'function') {
		return data.text();
	}
	throw new Error('Unsupported WebSocket message');
}

function formatError(error, token) {
	const rawMessage = error instanceof Error ? error.message : String(error);
	const message = redactText(rawMessage, token);
	if (error instanceof HackerCodeRpcError) {
		return {
			code: error.code,
			message
		};
	}
	return { message };
}

function redactText(value, token) {
	let result = value.replace(/([?&]tkn=)[^&\s]+/giu, '$1[REDACTED]');
	if (token) {
		result = result.split(token).join('[REDACTED]');
		result = result.split(encodeURIComponent(token)).join('[REDACTED]');
	}
	return result;
}

function writeJson(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

const entryPoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entryPoint === import.meta.url) {
	await main();
}
