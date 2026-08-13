/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename, dirname, resolve, sep } from 'node:path';
import {
	connectHackerCodeControl,
	readControlMetadata
} from './hackercode-control.mjs';

const OPT_IN_ENVIRONMENT_VARIABLE = 'HACKERCODE_RUN_DESTRUCTIVE_RECOVERY_TEST';
const TOTAL_OPERATION_TIMEOUT_MS = 70_000;
const CLEANUP_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 500;

let client;
let metadata;
let operationTimedOut = false;
let badRevisionId;

try {
	if (process.env[OPT_IN_ENVIRONMENT_VARIABLE] !== '1') {
		throw new Error(`Refusing destructive recovery test: set ${OPT_IN_ENVIRONMENT_VARIABLE}=1`);
	}
	const controlFile = parseExplicitControlFile(process.argv.slice(2));
	assertIsolatedLauncherControlFile(controlFile);
	metadata = await readControlMetadata(controlFile);
	assertLivePid(metadata.pid);
	if (!isRecoveryTestEndpoint(metadata)) {
		throw new Error('Refusing destructive recovery test: target was not launched with --hackercode-destructive-recovery-test');
	}

	client = await connectHackerCodeControl(metadata, { timeoutMs: REQUEST_TIMEOUT_MS });
	const deadline = Date.now() + TOTAL_OPERATION_TIMEOUT_MS;
	const timeout = setTimeout(() => {
		operationTimedOut = true;
		client?.close();
	}, TOTAL_OPERATION_TIMEOUT_MS);
	try {
		const initialState = await waitForCompletedRendererBoot(client, deadline);
		if (initialState.activeRevisionId !== initialState.lastKnownGoodRevisionId) {
			throw new Error('Initial isolated profile is not at a known-good active revision');
		}
		if (typeof initialState.baseline?.current !== 'string' || initialState.baseline.current.length === 0) {
			throw new Error('Recovery test requires a source-checkout baseline');
		}

		const revision = await requestBeforeDeadline(client, 'createRevision', {
			baseline: initialState.baseline.current,
			description: `Destructive watchdog recovery test ${new Date().toISOString()}`,
			parentId: initialState.activeRevisionId,
			patches: [{
				name: 'destructive-watchdog-wedge',
				content: [
					'export default async function (ctx) {',
					'\tconst wedge = () => { while (true) { } };',
					"\tctx.registerCommand('hackercode.test.destructiveWatchdogWedge', wedge);",
					'\t// Invoke the installed action only after the harness observed a completed initial boot.',
					'\twedge();',
					'}',
					''
				].join('\n')
			}]
		}, deadline);
		badRevisionId = revision.id;

		const activation = await requestBeforeDeadline(client, 'setRevision', {
			revisionId: badRevisionId,
			mode: 'normal'
		}, deadline);
		if (activation.activeRevisionId !== badRevisionId || activation.bootAttempt?.revisionId !== badRevisionId) {
			throw new Error('Bad revision activation did not arm the boot watchdog');
		}

		const recoveredState = await pollState(client, deadline, state => {
			const quarantine = state.quarantinedRevisions?.find(entry => entry.revisionId === badRevisionId);
			return state.activeRevisionId === initialState.lastKnownGoodRevisionId
				&& state.bootAttempt === undefined
				&& state.skipPromoted === true
				&& quarantine?.reason?.toLowerCase().includes('watchdog');
		});
		const quarantine = recoveredState.quarantinedRevisions.find(entry => entry.revisionId === badRevisionId);
		writeJson({
			ok: true,
			test: 'hackercode-destructive-watchdog-recovery',
			result: {
				badRevisionId,
				recoveredRevisionId: recoveredState.activeRevisionId,
				lastKnownGoodRevisionId: recoveredState.lastKnownGoodRevisionId,
				quarantined: quarantine !== undefined,
				skipPromoted: recoveredState.skipPromoted === true
			}
		});
	} finally {
		clearTimeout(timeout);
	}
} catch (error) {
	writeJson({
		ok: false,
		test: 'hackercode-destructive-watchdog-recovery',
		error: {
			message: operationTimedOut
				? `Recovery test exceeded ${TOTAL_OPERATION_TIMEOUT_MS}ms`
				: error instanceof Error ? error.message : String(error)
		}
	});
	process.exitCode = 1;
} finally {
	await enterFinalSafeMode();
	client?.close();
}

async function waitForCompletedRendererBoot(controlClient, deadline) {
	let lastError;
	while (Date.now() < deadline) {
		try {
			const state = await requestBeforeDeadline(controlClient, 'getState', undefined, deadline);
			if (state.bootAttempt === undefined) {
				const renderer = await requestBeforeDeadline(controlClient, 'eval', {
					source: 'return { ready: true };'
				}, deadline);
				if (renderer?.ready === true) {
					const confirmed = await requestBeforeDeadline(controlClient, 'getState', undefined, deadline);
					if (confirmed.bootAttempt === undefined) {
						return confirmed;
					}
				}
			}
		} catch (error) {
			lastError = error;
		}
		await delayBeforeDeadline(deadline);
	}
	throw new Error(`Initial renderer boot did not complete${lastError instanceof Error ? `: ${lastError.message}` : ''}`);
}

async function pollState(controlClient, deadline, predicate) {
	let lastState;
	let lastError;
	while (Date.now() < deadline) {
		try {
			lastState = await requestBeforeDeadline(controlClient, 'getState', undefined, deadline);
			if (predicate(lastState)) {
				return lastState;
			}
		} catch (error) {
			lastError = error;
		}
		await delayBeforeDeadline(deadline);
	}
	const detail = lastState
		? `active=${lastState.activeRevisionId}, boot=${lastState.bootAttempt?.revisionId ?? 'none'}`
		: lastError instanceof Error ? lastError.message : 'no state received';
	throw new Error(`Watchdog recovery did not complete before timeout (${detail})`);
}

async function requestBeforeDeadline(controlClient, method, params, deadline) {
	const remaining = deadline - Date.now();
	if (remaining <= 0 || operationTimedOut) {
		throw new Error('Recovery test operation deadline expired');
	}
	return controlClient.request(method, params, Math.min(REQUEST_TIMEOUT_MS, remaining));
}

async function delayBeforeDeadline(deadline) {
	const remaining = deadline - Date.now();
	if (remaining <= 0 || operationTimedOut) {
		throw new Error('Recovery test operation deadline expired');
	}
	await new Promise(resolveDelay => setTimeout(resolveDelay, Math.min(POLL_INTERVAL_MS, remaining)));
}

async function enterFinalSafeMode() {
	if (!metadata || !isPidLive(metadata.pid)) {
		return;
	}
	let cleanupClient = client;
	try {
		if (!cleanupClient || operationTimedOut) {
			cleanupClient = await connectHackerCodeControl(metadata, { timeoutMs: CLEANUP_TIMEOUT_MS });
		}
		await cleanupClient.request('safeMode', {
			reason: badRevisionId
				? `Destructive recovery test cleanup for ${badRevisionId.slice(0, 8)}`
				: 'Destructive recovery test cleanup'
		}, CLEANUP_TIMEOUT_MS);
	} catch (error) {
		process.stderr.write(`HackerCode recovery test cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	} finally {
		if (cleanupClient !== client) {
			cleanupClient?.close();
		}
	}
}

function parseExplicitControlFile(argv) {
	let controlFile;
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (argument === '--control-file') {
			if (controlFile !== undefined || argv[index + 1] === undefined) {
				throw new Error('Supply exactly one explicit --control-file <path>');
			}
			controlFile = argv[++index];
		} else if (argument.startsWith('--control-file=')) {
			if (controlFile !== undefined || argument.length === '--control-file='.length) {
				throw new Error('Supply exactly one explicit --control-file <path>');
			}
			controlFile = argument.slice('--control-file='.length);
		} else {
			throw new Error(`Unknown recovery test argument: ${argument}`);
		}
	}
	if (!controlFile) {
		throw new Error('Recovery test requires explicit --control-file <path>');
	}
	return resolve(controlFile);
}

function assertIsolatedLauncherControlFile(controlFile) {
	const controlDirectory = dirname(controlFile);
	const userDataDirectory = dirname(controlDirectory);
	const pathSegments = resolve(controlFile).split(sep);
	if (basename(controlFile) !== 'control.json'
		|| basename(controlDirectory) !== 'hackercode'
		|| basename(userDataDirectory) !== 'user-data'
		|| !pathSegments.includes('hackercode-dev')) {
		throw new Error('Refusing destructive recovery test: control file is not under an isolated launch-skill user-data profile');
	}
}

function isRecoveryTestEndpoint(value) {
	return value.recoveryTest?.suppressDialog === true
		&& value.recoveryTest?.watchdogDelayMs === 20_000;
}

function assertLivePid(pid) {
	if (!isPidLive(pid)) {
		throw new Error(`Refusing destructive recovery test: endpoint pid ${pid} is not live`);
	}
}

function isPidLive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error instanceof Error && 'code' in error && error.code === 'EPERM';
	}
}

function writeJson(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}
