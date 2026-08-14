/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connectHackerCodeControl, readControlMetadata } from './hackercode-control.mjs';
import { activateRevisionAndWaitHealthy } from './hackercode-agent/control/activation.mjs';
import { HackerCodeControlSession } from './hackercode-agent/control/session.mjs';

/**
 * The headless control-plane CLI. The agent loop itself lives in the workbench
 * (src/vs/workbench/contrib/hackercodeAgent), which drives the built-in chat
 * directly; this script exists only for checks that must run without a chat
 * session, from a terminal or CI.
 */
const HELP = `HackerCode control-plane CLI

Usage:
  npm run hackercode:agent -- --control-file <path> <command> [options]

The control file may instead be supplied with HACKERCODE_CONTROL_FILE. This
CLI never prints the HackerCode control token or the authenticated URL.

Commands:
  selftest
      The minimal, LLM-free round trip: list services, create one reversible
      status-bar/command patch, activate it, wait for a healthy boot, verify
      the installed command through eval, then revert to pristine. Prints one
      JSON result and exits nonzero on any failed stage.

Global options:
  --control-file <path>   Explicit token-bearing control.json path.
  --timeout-ms <ms>        Per-request timeout (default: 35000).
  --help                   Show this help.
`;

async function main() {
	const argv = process.argv.slice(2);
	if (argv.includes('--help')) {
		process.stdout.write(HELP);
		return;
	}

	const { options, positionals } = parseFlags(argv);
	const command = positionals[0];
	if (!command) {
		throw new Error('A command is required. Use --help for usage.');
	}

	const controlFile = options.get('control-file') ?? process.env.HACKERCODE_CONTROL_FILE;
	if (!controlFile) {
		throw new Error('Supply --control-file or HACKERCODE_CONTROL_FILE');
	}
	const timeoutMs = options.has('timeout-ms') ? Number(options.get('timeout-ms')) : 35_000;

	const metadata = await readControlMetadata(resolve(controlFile));
	assertLiveControlPid(metadata.pid);
	const client = await connectHackerCodeControl(metadata, { timeoutMs });
	const session = new HackerCodeControlSession(client);

	try {
		switch (command) {
			case 'selftest':
				await runSelftest(session);
				return;
			default:
				throw new Error(`Unknown command: ${command}`);
		}
	} finally {
		session.close();
	}
}

async function runSelftest(session) {
	const marker = `hc-agent-selftest-${Date.now()}`;
	const commandId = 'hackercode.agent.selftest.marker';
	const statusBarEntryId = 'status.hackercode.agent.selftest';
	const patchContent = [
		'const STATUSBAR_RIGHT = 1; // StatusbarAlignment.RIGHT',
		'',
		'export default async function (ctx) {',
		`\tctx.registerCommand(${JSON.stringify(commandId)}, () => (${JSON.stringify({ marker })}));`,
		'\tctx.addStatusBarEntry({',
		`\t\tname: ${JSON.stringify('HackerCode Agent Selftest')},`,
		`\t\ttext: ${JSON.stringify('$(beaker) HackerCode agent selftest')},`,
		`\t\ttooltip: ${JSON.stringify('Reversible probe created by the agentic harness selftest')},`,
		`\t\tcommand: ${JSON.stringify(commandId)}`,
		`\t}, ${JSON.stringify(statusBarEntryId)}, STATUSBAR_RIGHT, 1);`,
		'}',
		''
	].join('\n');

	const state = await session.getState();
	const services = await session.eval({ source: 'return runtime.listServices().length;' });

	const revision = await session.createRevision({
		description: 'HackerCode agent selftest: reversible status-bar/command patch',
		baseline: state.baseline.current,
		parentId: state.activeRevisionId,
		patches: [{ name: 'agent-selftest-marker', content: patchContent }]
	});

	const activation = await activateRevisionAndWaitHealthy(session, {
		revisionId: revision.id,
		timeoutMs: 60_000,
		verify: verifySession => verifySession.eval({
			source: `const commandService = getService('commandService'); return await commandService.executeCommand(${JSON.stringify(commandId)});`
		})
	});

	if (!activation.ok) {
		writeJson({ ok: false, stage: 'activate', activation });
		process.exitCode = 1;
		return;
	}
	if (activation.verification?.marker !== marker) {
		writeJson({ ok: false, stage: 'verify', detail: 'Installed command did not return the expected marker', activation });
		process.exitCode = 1;
		return;
	}

	const revert = await activateRevisionAndWaitHealthy(session, {
		revisionId: 'pristine',
		mode: 'recover',
		timeoutMs: 60_000
	});
	if (!revert.ok) {
		writeJson({ ok: false, stage: 'revert', revert });
		process.exitCode = 1;
		return;
	}

	writeJson({
		ok: true,
		result: {
			initialServiceCount: services,
			createdRevisionId: revision.id,
			activated: true,
			verifiedMarker: marker,
			revertedToPristine: revert.state.activeRevisionId === 'pristine'
		}
	});
}

export function parseFlags(argv) {
	const options = new Map();
	const positionals = [];
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (!argument.startsWith('--')) {
			positionals.push(argument);
			continue;
		}
		const name = argument.slice(2);
		const hasValue = argv[index + 1] !== undefined && !argv[index + 1].startsWith('--');
		options.set(name, hasValue ? argv[++index] : true);
	}
	return { options, positionals };
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

function writeJson(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

function redactText(value, token) {
	let result = value.replace(/([?&]tkn=)[^&\s]+/giu, '$1[REDACTED]');
	if (token) {
		result = result.split(token).join('[REDACTED]');
		result = result.split(encodeURIComponent(token)).join('[REDACTED]');
	}
	return result;
}

const entryPoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entryPoint === import.meta.url) {
	main().catch(error => {
		const message = error instanceof Error ? error.message : String(error);
		writeJson({ ok: false, error: { message: redactText(message) } });
		process.exitCode = 1;
	});
}
