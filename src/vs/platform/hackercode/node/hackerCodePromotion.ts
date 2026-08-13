/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'fs/promises';
import { join } from '../../../base/common/path.js';
import {
	IHackerCodePatchDescriptor,
	IHackerCodePatchSource,
	IHackerCodePromotedLayer,
	IHackerCodePromotedManifest,
	IHackerCodeRevisionManifest
} from '../common/hackerCode.js';

const REVISION_ID_PATTERN = /^[a-f0-9]{64}$/;
const GIT_HEAD_PATTERN = /^[a-f0-9]{40,64}$/;
const PROMOTED_PATCH_FILE_PATTERN = /^[a-f0-9]{64}\.js$/;
const MAX_PROMOTED_LAYERS = 1024;
const MAX_PATCHES_PER_LAYER = 64;
const MAX_PATCH_SIZE = 1024 * 1024;

export const HACKERCODE_PROMOTED_RELATIVE_PATH = 'src/vs/workbench/contrib/hackercode/browser/promoted';
export const HACKERCODE_PROMOTED_OUT_RELATIVE_PATH = 'out/vs/workbench/contrib/hackercode/browser/promoted';

export interface IHackerCodePromotedBundle {
	readonly manifest: IHackerCodePromotedManifest;
	readonly sourcesByLayer: ReadonlyMap<string, readonly IHackerCodePatchSource[]>;
}

export interface IHackerCodeCommandResult {
	readonly stdout: string;
	readonly stderr: string;
}

export interface IHackerCodeCommandRunner {
	run(executable: string, args: readonly string[]): Promise<IHackerCodeCommandResult>;
}

export class HackerCodeCommandRunner implements IHackerCodeCommandRunner {
	run(executable: string, args: readonly string[]): Promise<IHackerCodeCommandResult> {
		return new Promise((resolve, reject) => {
			execFile(executable, [...args], {
				encoding: 'utf8',
				maxBuffer: 1024 * 1024,
				windowsHide: true
			}, (error, stdout, stderr) => {
				if (error) {
					const detail = stderr.trim();
					reject(new Error(detail ? `${error.message}\n${detail}` : error.message, { cause: error }));
					return;
				}
				resolve({ stdout, stderr });
			});
		});
	}
}

export function createEmptyHackerCodePromotedManifest(): IHackerCodePromotedManifest {
	return { schemaVersion: 1, layers: [] };
}

export function assertHackerCodePromotionBaseline(revision: IHackerCodeRevisionManifest, head: string): void {
	if (!GIT_HEAD_PATTERN.test(head)) {
		throw new Error('Unable to determine a valid git HEAD for HackerCode promotion');
	}
	if (revision.baseline !== head) {
		throw new Error(`HackerCode revision baseline ${revision.baseline} does not match git HEAD ${head}`);
	}
}

export function appendHackerCodePromotedLayer(
	manifest: IHackerCodePromotedManifest,
	revision: IHackerCodeRevisionManifest,
	promotedAt: string
): IHackerCodePromotedManifest {
	if (!isIsoTimestamp(promotedAt)) {
		throw new Error('Invalid HackerCode promotion timestamp');
	}
	if (manifest.layers.some(layer => layer.id === revision.id)) {
		throw new Error(`HackerCode revision is already promoted: ${revision.id}`);
	}
	if (manifest.layers.length >= MAX_PROMOTED_LAYERS) {
		throw new Error(`HackerCode supports at most ${MAX_PROMOTED_LAYERS} promoted layers`);
	}

	const layer: IHackerCodePromotedLayer = {
		id: revision.id,
		baseline: revision.baseline,
		promotedAt,
		patches: revision.patches.map(patch => ({
			...patch,
			fileName: `${patch.sha256}.js`
		}))
	};
	return {
		schemaVersion: 1,
		layers: [...manifest.layers.map(cloneLayer), layer]
	};
}

export function parseHackerCodePromotedManifest(contents: string): IHackerCodePromotedManifest {
	let value: unknown;
	try {
		value = JSON.parse(contents);
	} catch {
		throw new Error('Invalid HackerCode promoted manifest JSON');
	}
	if (!isValidPromotedManifest(value)) {
		throw new Error('Invalid HackerCode promoted manifest');
	}
	return {
		schemaVersion: 1,
		layers: value.layers.map(cloneLayer)
	};
}

export function validateHackerCodePromotedPatchContent(descriptor: IHackerCodePatchDescriptor, content: string): void {
	const size = Buffer.byteLength(content, 'utf8');
	const hash = createHash('sha256').update(content, 'utf8').digest('hex');
	if (descriptor.fileName !== `${descriptor.sha256}.js` || size !== descriptor.size || hash !== descriptor.sha256) {
		throw new Error(`HackerCode promoted patch source failed integrity validation: ${descriptor.name}`);
	}
}

export async function readHackerCodePromotedBundle(directory: string): Promise<IHackerCodePromotedBundle> {
	const manifest = parseHackerCodePromotedManifest(await readFile(join(directory, 'manifest.json'), 'utf8'));
	const contentCache = new Map<string, string>();
	const sourcesByLayer = new Map<string, readonly IHackerCodePatchSource[]>();
	for (const layer of manifest.layers) {
		const sources: IHackerCodePatchSource[] = [];
		for (const descriptor of layer.patches) {
			let content = contentCache.get(descriptor.fileName);
			if (content === undefined) {
				content = await readFile(join(directory, descriptor.fileName), 'utf8');
				validateHackerCodePromotedPatchContent(descriptor, content);
				contentCache.set(descriptor.fileName, content);
			} else {
				validateHackerCodePromotedPatchContent(descriptor, content);
			}
			sources.push({ name: descriptor.name, content });
		}
		sourcesByLayer.set(layer.id, sources);
	}
	return { manifest, sourcesByLayer };
}

export async function writeHackerCodePromotedBundle(
	directory: string,
	manifest: IHackerCodePromotedManifest,
	contentByFileName: ReadonlyMap<string, string>
): Promise<readonly string[]> {
	const stagingDirectory = join(directory, `..promoted-staging-${randomUUID()}`);
	const writtenFiles: string[] = [];
	await mkdir(stagingDirectory, { recursive: false });
	try {
		const descriptors = collectDescriptors(manifest);
		for (const descriptor of descriptors.values()) {
			const content = contentByFileName.get(descriptor.fileName);
			if (content === undefined) {
				throw new Error(`Missing HackerCode promoted patch content: ${descriptor.fileName}`);
			}
			validateHackerCodePromotedPatchContent(descriptor, content);
			await writeFile(join(stagingDirectory, descriptor.fileName), content, { encoding: 'utf8', flag: 'wx' });
		}
		await writeFile(
			join(stagingDirectory, 'manifest.json'),
			`${JSON.stringify(manifest, undefined, '\t')}\n`,
			{ encoding: 'utf8', flag: 'wx' }
		);

		await mkdir(directory, { recursive: true });
		for (const descriptor of descriptors.values()) {
			const target = join(directory, descriptor.fileName);
			if (await exists(target)) {
				const existing = await readFile(target, 'utf8');
				validateHackerCodePromotedPatchContent(descriptor, existing);
				continue;
			}
			await rename(join(stagingDirectory, descriptor.fileName), target);
			writtenFiles.push(descriptor.fileName);
		}
		await rename(join(stagingDirectory, 'manifest.json'), join(directory, 'manifest.json'));
		return ['manifest.json', ...writtenFiles.sort()];
	} finally {
		await rm(stagingDirectory, { recursive: true, force: true });
	}
}

export async function getHackerCodeGitHead(
	appRoot: string,
	runner: IHackerCodeCommandRunner
): Promise<string> {
	const result = await runner.run('git', ['-C', appRoot, 'rev-parse', 'HEAD']);
	const head = result.stdout.trim();
	if (!GIT_HEAD_PATTERN.test(head)) {
		throw new Error('Unable to determine a valid git HEAD for HackerCode');
	}
	return head;
}

export async function commitHackerCodePromotedFiles(
	appRoot: string,
	repositoryRelativeFiles: readonly string[],
	message: string,
	runner: IHackerCodeCommandRunner
): Promise<void> {
	if (repositoryRelativeFiles.length === 0 || repositoryRelativeFiles.some(path => !isPromotedRepositoryPath(path))) {
		throw new Error('Invalid HackerCode promoted git path');
	}
	const paths = [...new Set(repositoryRelativeFiles)].sort();
	await runner.run('git', ['-C', appRoot, 'add', '--', ...paths]);
	await runner.run('git', ['-C', appRoot, 'commit', '--only', '-m', message, '--', ...paths]);
}

function collectDescriptors(manifest: IHackerCodePromotedManifest): Map<string, IHackerCodePatchDescriptor> {
	const descriptors = new Map<string, IHackerCodePatchDescriptor>();
	for (const layer of manifest.layers) {
		for (const descriptor of layer.patches) {
			const existing = descriptors.get(descriptor.fileName);
			if (existing && (existing.sha256 !== descriptor.sha256 || existing.size !== descriptor.size)) {
				throw new Error(`Conflicting HackerCode promoted patch descriptor: ${descriptor.fileName}`);
			}
			descriptors.set(descriptor.fileName, descriptor);
		}
	}
	return descriptors;
}

function isValidPromotedManifest(value: unknown): value is IHackerCodePromotedManifest {
	return isRecord(value)
		&& hasOnlyKeys(value, ['schemaVersion', 'layers'])
		&& value.schemaVersion === 1
		&& Array.isArray(value.layers)
		&& value.layers.length <= MAX_PROMOTED_LAYERS
		&& value.layers.every(isValidLayer)
		&& new Set(value.layers.map(layer => layer.id)).size === value.layers.length;
}

function isValidLayer(value: unknown): value is IHackerCodePromotedLayer {
	return isRecord(value)
		&& hasOnlyKeys(value, ['id', 'baseline', 'promotedAt', 'patches'])
		&& typeof value.id === 'string'
		&& REVISION_ID_PATTERN.test(value.id)
		&& typeof value.baseline === 'string'
		&& GIT_HEAD_PATTERN.test(value.baseline)
		&& typeof value.promotedAt === 'string'
		&& isIsoTimestamp(value.promotedAt)
		&& Array.isArray(value.patches)
		&& value.patches.length <= MAX_PATCHES_PER_LAYER
		&& value.patches.every(isValidDescriptor);
}

function isValidDescriptor(value: unknown): value is IHackerCodePatchDescriptor {
	return isRecord(value)
		&& hasOnlyKeys(value, ['name', 'fileName', 'sha256', 'size'])
		&& typeof value.name === 'string'
		&& value.name.length > 0
		&& value.name.length <= 128
		&& typeof value.fileName === 'string'
		&& PROMOTED_PATCH_FILE_PATTERN.test(value.fileName)
		&& typeof value.sha256 === 'string'
		&& REVISION_ID_PATTERN.test(value.sha256)
		&& value.fileName === `${value.sha256}.js`
		&& typeof value.size === 'number'
		&& Number.isSafeInteger(value.size)
		&& value.size >= 0
		&& value.size <= MAX_PATCH_SIZE;
}

function cloneLayer(layer: IHackerCodePromotedLayer): IHackerCodePromotedLayer {
	return {
		...layer,
		patches: layer.patches.map(patch => ({ ...patch }))
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwnProperty<T extends object, K extends PropertyKey>(value: T, key: K): value is T & Record<K, unknown> {
	return Object.prototype.hasOwnProperty.call(value, key);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).every(key => keys.includes(key));
}

function isIsoTimestamp(value: string): boolean {
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isPromotedRepositoryPath(path: string): boolean {
	return path === `${HACKERCODE_PROMOTED_RELATIVE_PATH}/manifest.json`
		|| new RegExp(`^${HACKERCODE_PROMOTED_RELATIVE_PATH}/[a-f0-9]{64}\\.js$`).test(path);
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if (error instanceof Error && hasOwnProperty(error, 'code') && error.code === 'ENOENT') {
			return false;
		}
		throw error;
	}
}
