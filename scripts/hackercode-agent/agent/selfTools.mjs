/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Self-authored agent tools are ordinary HackerCode patches, not a separate
 * mechanism. A tool patch exports both a small JSON-schema-shaped descriptor
 * (`agentTool`) and the usual reversible `ctx.registerCommand` factory.
 * Because the patch contract already forbids top-level side effects
 * (docs/hackercode/patch-authoring.md), it is safe for this Node driver to
 * `import()` a tool patch file directly off disk purely to read its exported
 * descriptor: nothing in the module runs except the top-level `const`/`export`
 * declarations, and the factory itself is never invoked here.
 *
 * Durability across fresh installs comes from the promoted-layer manifest
 * (src/vs/workbench/contrib/hackercode/browser/promoted/manifest.json): once
 * a tool's containing revision is promoted, its patch file ships in the
 * source tree and every future install can rediscover the tool by reading
 * that manifest, with no dependency on this driver's local state directory.
 */

export const TOOL_COMMAND_PREFIX = 'hackercode.agent.tool.';
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export function toolCommandId(name) {
	return `${TOOL_COMMAND_PREFIX}${name}`;
}

export function validateToolDescriptor(descriptor) {
	if (typeof descriptor?.name !== 'string' || !TOOL_NAME_PATTERN.test(descriptor.name)) {
		throw new Error('Tool name must match ^[a-z][a-z0-9_]{0,63}$');
	}
	if (typeof descriptor?.description !== 'string' || descriptor.description.trim().length === 0) {
		throw new Error('Tool description must be a non-empty string');
	}
	if (typeof descriptor?.parameters !== 'object' || descriptor.parameters === null || Array.isArray(descriptor.parameters)) {
		throw new Error('Tool parameters must be a JSON Schema object');
	}
	if (typeof descriptor?.commandBody !== 'string' || descriptor.commandBody.trim().length === 0) {
		throw new Error('Tool commandBody must be a non-empty JavaScript function body');
	}
	return descriptor;
}

/**
 * Builds the ESM patch source for a self-authored tool. `commandBody` is the
 * body of an async function receiving `(input, ctx)`; it is caller-authored
 * (model-authored) JavaScript and is exactly as privileged as any other
 * patch factory body. This function performs only structural validation
 * (see validateToolDescriptor) -- see architecture.md: narrow guards, not a
 * sandbox.
 *
 * @param {{ name: string, description: string, parameters: object, commandBody: string }} descriptor
 * @returns {{ patchName: string, content: string }}
 */
export function buildSelfAuthoredToolPatch(descriptor) {
	validateToolDescriptor(descriptor);
	const commandId = toolCommandId(descriptor.name);
	const content = `const agentToolDescriptor = ${JSON.stringify({
		name: descriptor.name,
		description: descriptor.description,
		parameters: descriptor.parameters
	}, null, '\t')};

export const agentTool = agentToolDescriptor;

export default async function (ctx) {
	ctx.registerCommand(${JSON.stringify(commandId)}, async (input) => {
${indent(descriptor.commandBody, '\t\t')}
	});
}
`;
	return { patchName: `agent-tool-${descriptor.name}`, content };
}

function indent(body, prefix) {
	return body
		.split('\n')
		.map(line => (line.length > 0 ? `${prefix}${line}` : line))
		.join('\n');
}

// --- Revision-local ledger (this driver's own bookkeeping; not durable across fresh installs) ---

function toolsLedgerPath(userDataDir) {
	return join(userDataDir, 'hackercode', 'agent', 'tools.json');
}

export async function readToolsLedger(userDataDir) {
	try {
		const raw = await readFile(toolsLedgerPath(userDataDir), 'utf8');
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

export async function writeToolsLedger(userDataDir, entries) {
	const path = toolsLedgerPath(userDataDir);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await writeFile(path, `${JSON.stringify(entries, null, '\t')}\n`, { mode: 0o600 });
	await chmod(path, 0o600);
}

/**
 * Records (or updates) one tool entry in the local ledger. Entries persist
 * across driver restarts for the current, not-yet-promoted revision content;
 * `promoted` is flipped to `true` once `hc_promote` succeeds for the
 * revision that defined the tool.
 */
export async function recordToolInLedger(userDataDir, entry) {
	const entries = await readToolsLedger(userDataDir);
	const filtered = entries.filter(existing => existing.name !== entry.name);
	filtered.push(entry);
	await writeToolsLedger(userDataDir, filtered);
	return filtered;
}

export async function markToolsPromoted(userDataDir, revisionId) {
	const entries = await readToolsLedger(userDataDir);
	const updated = entries.map(entry => (entry.revisionId === revisionId ? { ...entry, promoted: true } : entry));
	await writeToolsLedger(userDataDir, updated);
	return updated;
}

// --- Promoted-layer discovery (durable across fresh installs) ---

function repoRootFromThisFile() {
	const here = dirname(fileURLToPath(import.meta.url));
	return resolve(here, '..', '..', '..');
}

function promotedDirectory(repoRoot) {
	return join(repoRoot, 'src', 'vs', 'workbench', 'contrib', 'hackercode', 'browser', 'promoted');
}

/**
 * Reads the source-controlled promoted manifest and imports each promoted
 * patch file solely to collect its `agentTool` export, if present. Returns
 * an empty list (rather than throwing) when the manifest is absent, has no
 * layers, or a given patch file cannot be read -- discovery is best-effort
 * bookkeeping, not a security boundary.
 *
 * @param {string} [repoRoot]
 */
export async function discoverPromotedTools(repoRoot = repoRootFromThisFile()) {
	const directory = promotedDirectory(repoRoot);
	let manifest;
	try {
		manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
	} catch {
		return [];
	}
	const layers = Array.isArray(manifest?.layers) ? manifest.layers : [];
	const discovered = [];
	for (const layer of layers) {
		const patches = Array.isArray(layer?.patches) ? layer.patches : [];
		for (const patch of patches) {
			if (typeof patch?.fileName !== 'string') {
				continue;
			}
			const filePath = join(directory, patch.fileName);
			try {
				const moduleUrl = pathToFileURL(filePath).href;
				const namespace = await import(moduleUrl);
				if (namespace?.agentTool && typeof namespace.agentTool.name === 'string') {
					discovered.push({
						name: namespace.agentTool.name,
						description: namespace.agentTool.description ?? '',
						parameters: namespace.agentTool.parameters ?? { type: 'object', properties: {} },
						revisionId: layer.id,
						patchName: patch.name,
						promoted: true
					});
				}
			} catch {
				// A patch file that fails to import cannot contribute a tool;
				// this is discovery, so skip it rather than aborting the scan.
			}
		}
	}
	return discovered;
}

/**
 * Merges revision-local (this driver's ledger) and promoted (durable)
 * self-authored tools into one catalog, keyed by tool name. Promoted entries
 * win on conflict because they represent the durable, source-controlled
 * definition.
 */
export async function buildToolCatalog({ userDataDir, repoRoot } = {}) {
	const [ledgerEntries, promotedEntries] = await Promise.all([
		userDataDir ? readToolsLedger(userDataDir) : [],
		discoverPromotedTools(repoRoot)
	]);
	const byName = new Map();
	for (const entry of ledgerEntries) {
		byName.set(entry.name, entry);
	}
	for (const entry of promotedEntries) {
		byName.set(entry.name, entry);
	}
	return [...byName.values()];
}
