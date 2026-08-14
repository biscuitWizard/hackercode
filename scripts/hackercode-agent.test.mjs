/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseFlags } from './hackercode-agent.mjs';

const SCRIPT_PATH = fileURLToPath(new URL('./hackercode-agent.mjs', import.meta.url));

test('parseFlags separates positionals from --flag/value pairs', () => {
	const { options, positionals } = parseFlags(['selftest', '--control-file', '/tmp/control.json', '--timeout-ms', '5000']);
	assert.deepEqual(positionals, ['selftest']);
	assert.equal(options.get('control-file'), '/tmp/control.json');
	assert.equal(options.get('timeout-ms'), '5000');
});

test('parseFlags treats a trailing flag with no following value as boolean true', () => {
	const { options } = parseFlags(['selftest', '--help']);
	assert.equal(options.get('help'), true);
});

test('--help prints usage and exits zero without requiring a control file', async () => {
	const { stdout } = await new Promise((resolve, reject) => {
		execFile(process.execPath, [SCRIPT_PATH, '--help'], (error, stdout, stderr) => {
			if (error) {
				reject(new Error(`${error.message}\n${stderr}`));
			} else {
				resolve({ stdout, stderr });
			}
		});
	});
	assert.match(stdout, /HackerCode control-plane CLI/);
	assert.match(stdout, /selftest/);
});

test('missing --control-file fails fast with a JSON error and nonzero exit, never printing a token-shaped value', async () => {
	const outcome = await new Promise(resolve => {
		execFile(process.execPath, [SCRIPT_PATH, 'selftest'], { env: { ...process.env, HACKERCODE_CONTROL_FILE: undefined } }, (error, stdout) => {
			resolve({ code: error?.code ?? 0, stdout });
		});
	});
	assert.notEqual(outcome.code, 0);
	const parsed = JSON.parse(outcome.stdout.trim().split('\n').pop());
	assert.equal(parsed.ok, false);
	assert.match(parsed.error.message, /--control-file/);
});
