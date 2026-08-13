/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
	buildSelfAuthoredToolPatch,
	buildToolCatalog,
	discoverPromotedTools,
	markToolsPromoted,
	readToolsLedger,
	recordToolInLedger,
	toolCommandId,
	validateToolDescriptor
} from './selfTools.mjs';

test('validateToolDescriptor enforces the tool name pattern', () => {
	const base = { description: 'd', parameters: {}, commandBody: 'return 1;' };
	assert.throws(() => validateToolDescriptor({ ...base, name: 'Bad-Name' }), /name/);
	assert.throws(() => validateToolDescriptor({ ...base, name: '1starts_with_digit' }), /name/);
	assert.doesNotThrow(() => validateToolDescriptor({ ...base, name: 'good_name_1' }));
});

test('buildSelfAuthoredToolPatch produces an ESM default factory with no top-level side effects', () => {
	const { patchName, content } = buildSelfAuthoredToolPatch({
		name: 'count_things',
		description: 'Counts things.',
		parameters: { type: 'object', properties: {} },
		commandBody: 'return { count: 1 };'
	});
	assert.equal(patchName, 'agent-tool-count_things');
	assert.match(content, /export default async function \(ctx\) \{/);
	assert.match(content, /ctx\.registerCommand\("hackercode\.agent\.tool\.count_things"/);
	assert.match(content, /export const agentTool = agentToolDescriptor;/);
	// Only "const"/"export" declarations appear before the factory: no bare
	// call expressions at top level.
	const beforeFactory = content.slice(0, content.indexOf('export default async function'));
	assert.doesNotMatch(beforeFactory, /^\s*[a-zA-Z_$][\w$]*\(/m);
});

test('toolCommandId is stable and namespaced', () => {
	assert.equal(toolCommandId('foo'), 'hackercode.agent.tool.foo');
});

test('tools ledger round-trips through disk with restrictive permissions', async () => {
	const userDataDir = await mkdtemp(join(tmpdir(), 'hc-agent-selftools-'));
	try {
		await recordToolInLedger(userDataDir, { name: 'a', description: 'A', parameters: {}, revisionId: 'r1', patchName: 'agent-tool-a', promoted: false });
		await recordToolInLedger(userDataDir, { name: 'b', description: 'B', parameters: {}, revisionId: 'r1', patchName: 'agent-tool-b', promoted: false });
		let ledger = await readToolsLedger(userDataDir);
		assert.equal(ledger.length, 2);
		assert.equal(ledger.every(entry => entry.promoted === false), true);

		await markToolsPromoted(userDataDir, 'r1');
		ledger = await readToolsLedger(userDataDir);
		assert.equal(ledger.every(entry => entry.promoted === true), true);
	} finally {
		await rm(userDataDir, { recursive: true, force: true });
	}
});

test('recordToolInLedger replaces an entry with the same name instead of duplicating it', async () => {
	const userDataDir = await mkdtemp(join(tmpdir(), 'hc-agent-selftools-'));
	try {
		await recordToolInLedger(userDataDir, { name: 'a', description: 'first', parameters: {}, revisionId: 'r1', patchName: 'agent-tool-a', promoted: false });
		await recordToolInLedger(userDataDir, { name: 'a', description: 'second', parameters: {}, revisionId: 'r2', patchName: 'agent-tool-a', promoted: false });
		const ledger = await readToolsLedger(userDataDir);
		assert.equal(ledger.length, 1);
		assert.equal(ledger[0].description, 'second');
	} finally {
		await rm(userDataDir, { recursive: true, force: true });
	}
});

test('discoverPromotedTools reads agentTool exports from the promoted manifest without executing patch factories', async () => {
	const repoRoot = await mkdtemp(join(tmpdir(), 'hc-agent-promoted-'));
	try {
		// Mirrors the real repository, whose root package.json declares
		// "type": "module" so every .js file under src/ is ESM regardless of
		// Node version; without it, only newer Node releases auto-detect ESM
		// syntax in extensionless-.js files.
		await writeFile(join(repoRoot, 'package.json'), JSON.stringify({ type: 'module' }));
		const promotedDir = join(repoRoot, 'src', 'vs', 'workbench', 'contrib', 'hackercode', 'browser', 'promoted');
		await mkdir(promotedDir, { recursive: true });
		const sideEffectFlagPath = join(promotedDir, 'side-effect-flag.json');

		await writeFile(join(promotedDir, 'deadbeef.js'), `
export const agentTool = { name: 'promoted_tool', description: 'A promoted tool.', parameters: { type: 'object', properties: {} } };
export default async function (ctx) {
	// If discovery ever invoked this factory, it would write the flag file.
	// eslint-disable-next-line no-undef
	require('node:fs').writeFileSync(${JSON.stringify(sideEffectFlagPath)}, 'ran');
	ctx.registerCommand('hackercode.agent.tool.promoted_tool', () => 42);
}
`);
		await writeFile(join(promotedDir, 'manifest.json'), JSON.stringify({
			schemaVersion: 1,
			layers: [{ id: 'r1', baseline: 'x', promotedAt: new Date().toISOString(), patches: [{ name: 'agent-tool-promoted_tool', fileName: 'deadbeef.js', sha256: 'x', size: 1 }] }]
		}));

		const discovered = await discoverPromotedTools(repoRoot);
		assert.equal(discovered.length, 1);
		assert.equal(discovered[0].name, 'promoted_tool');
		assert.equal(discovered[0].promoted, true);
		await assert.rejects(readFile(sideEffectFlagPath, 'utf8'), /ENOENT/, 'the factory must not have run');
	} finally {
		await rm(repoRoot, { recursive: true, force: true });
	}
});

test('buildToolCatalog merges ledger and promoted tools, with promoted winning on name conflict', async () => {
	const userDataDir = await mkdtemp(join(tmpdir(), 'hc-agent-catalog-'));
	const repoRoot = await mkdtemp(join(tmpdir(), 'hc-agent-catalog-repo-'));
	try {
		await recordToolInLedger(userDataDir, { name: 'shared', description: 'local draft', parameters: {}, revisionId: 'r1', patchName: 'agent-tool-shared', promoted: false });
		await recordToolInLedger(userDataDir, { name: 'local_only', description: 'still local', parameters: {}, revisionId: 'r1', patchName: 'agent-tool-local_only', promoted: false });

		await writeFile(join(repoRoot, 'package.json'), JSON.stringify({ type: 'module' }));
		const promotedDir = join(repoRoot, 'src', 'vs', 'workbench', 'contrib', 'hackercode', 'browser', 'promoted');
		await mkdir(promotedDir, { recursive: true });
		await writeFile(join(promotedDir, 'shared.js'), `export const agentTool = { name: 'shared', description: 'promoted version', parameters: {} };\nexport default async function () {}\n`);
		await writeFile(join(promotedDir, 'manifest.json'), JSON.stringify({
			schemaVersion: 1,
			layers: [{ id: 'r0', baseline: 'x', promotedAt: new Date().toISOString(), patches: [{ name: 'agent-tool-shared', fileName: 'shared.js', sha256: 'x', size: 1 }] }]
		}));

		const catalog = await buildToolCatalog({ userDataDir, repoRoot });
		const byName = new Map(catalog.map(entry => [entry.name, entry]));
		assert.equal(byName.get('shared').description, 'promoted version');
		assert.equal(byName.get('shared').promoted, true);
		assert.equal(byName.get('local_only').promoted, false);
	} finally {
		await rm(userDataDir, { recursive: true, force: true });
		await rm(repoRoot, { recursive: true, force: true });
	}
});
