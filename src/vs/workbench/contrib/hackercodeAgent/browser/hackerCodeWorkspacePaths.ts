/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isAbsolute } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';

/**
 * Path handling shared by every tool the model can point at a file.
 *
 * Models are loose about paths in a way that is not worth fighting: within one
 * turn the same file is "src/a.ts", "/src/a.ts" and "./src/a.ts". A leading
 * slash in particular almost never means the root of the disk — it means the
 * root of the project — so rather than resolve one spelling and report that
 * the file does not exist, every reading is worked out and the one that is
 * actually there wins.
 */

/**
 * The readings of a model-supplied path, best first. An absolute path is taken
 * at its word before it is reinterpreted, so a genuine "/etc/hosts" still
 * resolves to itself.
 */
export function workspacePathCandidates(workspaceContextService: IWorkspaceContextService, path: string): URI[] {
	const folders = workspaceContextService.getWorkspace().folders;
	if (folders.length === 0) {
		if (isAbsolute(path)) {
			return [URI.file(path)];
		}
		throw new Error('No folder is open, so a workspace-relative path cannot be resolved.');
	}

	const candidates: URI[] = [];
	if (isAbsolute(path)) {
		candidates.push(folders[0].uri.with({ path }));
	}

	const normalized = path.replace(/^\.\/+/, '').replace(/^\/+/, '');
	if (!normalized) {
		candidates.push(folders[0].uri);
		return candidates;
	}

	// A path may be prefixed with the name of the folder it lives in, which is
	// how multi-root paths are shown to the model in the first place.
	for (const folder of folders) {
		if (normalized === folder.name) {
			candidates.push(folder.uri);
		} else if (normalized.startsWith(`${folder.name}/`)) {
			candidates.push(folder.uri.with({ path: `${folder.uri.path}/${normalized.slice(folder.name.length + 1)}` }));
		}
	}
	for (const folder of folders) {
		candidates.push(folder.uri.with({ path: `${folder.uri.path}/${normalized}` }));
	}
	return candidates;
}

/** The first reading of `path`, without asking the file system about any of them. */
export function resolveWorkspacePath(workspaceContextService: IWorkspaceContextService, path: string): URI {
	return workspacePathCandidates(workspaceContextService, path)[0];
}

/** The reading of `path` that exists, or the first one so the caller can report a sensible miss. */
export async function resolveExistingWorkspacePath(
	fileService: IFileService,
	workspaceContextService: IWorkspaceContextService,
	path: string
): Promise<URI> {
	const candidates = workspacePathCandidates(workspaceContextService, path);
	for (const candidate of candidates) {
		if (await fileService.exists(candidate)) {
			return candidate;
		}
	}
	return candidates[0];
}

/**
 * Where a file named `path` should be written. The one that already exists
 * wins, then the one whose directory already exists, so creating "src/new.ts"
 * lands beside its siblings instead of at the root of the disk.
 */
export async function resolveWritableWorkspacePath(
	fileService: IFileService,
	workspaceContextService: IWorkspaceContextService,
	path: string
): Promise<URI> {
	const candidates = workspacePathCandidates(workspaceContextService, path);
	for (const candidate of candidates) {
		if (await fileService.exists(candidate)) {
			return candidate;
		}
	}
	for (const candidate of candidates) {
		const parent = candidate.with({ path: candidate.path.replace(/\/[^/]*$/, '') || '/' });
		if (await fileService.exists(parent)) {
			return candidate;
		}
	}
	return candidates[0];
}

/** The spelling of a resource to show the model, so it can pass it back verbatim. */
export function toWorkspaceRelativePath(workspaceContextService: IWorkspaceContextService, resource: URI): string {
	const folders = workspaceContextService.getWorkspace().folders;
	const folder = workspaceContextService.getWorkspaceFolder(resource);
	if (!folder) {
		return resource.fsPath;
	}
	const relative = resource.path.slice(folder.uri.path.length).replace(/^\/+/, '');
	return folders.length > 1 ? `${folder.name}/${relative}` : relative;
}
