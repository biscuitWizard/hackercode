/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getErrorMessage } from '../../../../base/common/errors.js';
import { IJSONSchema } from '../../../../base/common/jsonSchema.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { localize } from '../../../../nls.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { QueryBuilder } from '../../../services/search/common/queryBuilder.js';
import { ISearchService, resultIsMatch } from '../../../services/search/common/search.js';
import {
	CountTokensCallback,
	IPreparedToolInvocation,
	IToolData,
	IToolImpl,
	IToolInvocation,
	IToolInvocationPreparationContext,
	IToolResult,
	ToolDataSource,
	ToolProgress
} from '../../chat/common/tools/languageModelToolsService.js';
import { resolveExistingWorkspacePath, toWorkspaceRelativePath } from './hackerCodeWorkspacePaths.js';

/**
 * The workspace reading tools an agent loop cannot work without: read a file,
 * list a directory, grep file contents, and find files by glob. VS Code's own
 * built-in tool set covers editing, terminals and web fetch but leaves reading
 * to the chat extension, so these live here.
 *
 * Paths are workspace-relative by default; an absolute path is accepted and
 * used as-is so the model can follow a path it saw in a search result.
 */

export const enum HackerCodeCoreToolId {
	ReadFile = 'read_file',
	ListDirectory = 'list_dir',
	GrepSearch = 'grep_search',
	FileSearch = 'file_search',
}

/** Caps chosen so one tool call cannot consume the whole context window. */
const MAX_FILE_CHARS = 64 * 1024;
const MAX_DIRECTORY_ENTRIES = 500;
const MAX_SEARCH_RESULTS = 100;

function toolData(id: HackerCodeCoreToolId, displayName: string, modelDescription: string, inputSchema: IJSONSchema): IToolData {
	return {
		id,
		displayName,
		modelDescription,
		inputSchema,
		source: ToolDataSource.Internal,
		runsInWorkspace: true,
		tags: ['workspace'],
		// Listed in the tool picker and referenceable as `#<id>`. Without these two
		// the tool is still callable by the model but invisible to the user.
		toolReferenceName: id,
		canBeReferencedInPrompt: true
	};
}

export const HackerCodeCoreToolData: readonly IToolData[] = [
	toolData(HackerCodeCoreToolId.ReadFile, 'Read File',
		'Reads the contents of a file in the workspace. Prefer reading a whole file over guessing a line range; use startLine/endLine only for very large files.',
		{
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Workspace-relative or absolute path to the file.' },
				startLine: { type: 'integer', description: 'Optional 1-based first line to read.' },
				endLine: { type: 'integer', description: 'Optional 1-based last line to read, inclusive.' }
			},
			required: ['path'],
			additionalProperties: false
		}),
	toolData(HackerCodeCoreToolId.ListDirectory, 'List Directory',
		'Lists the immediate children of a directory in the workspace, marking which entries are directories.',
		{
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Workspace-relative or absolute path to the directory. Defaults to the workspace root.' }
			},
			additionalProperties: false
		}),
	toolData(HackerCodeCoreToolId.GrepSearch, 'Search Text',
		'Searches file contents across the workspace and returns matching lines with their file and line number. Respects .gitignore and the user\'s search excludes.',
		{
			type: 'object',
			properties: {
				query: { type: 'string', description: 'The text or regular expression to search for.' },
				isRegex: { type: 'boolean', description: 'Treat the query as a regular expression. Defaults to false.' },
				caseSensitive: { type: 'boolean', description: 'Match case exactly. Defaults to false.' },
				includePattern: { type: 'string', description: 'Optional glob limiting which files are searched, e.g. "**/*.ts".' }
			},
			required: ['query'],
			additionalProperties: false
		}),
	toolData(HackerCodeCoreToolId.FileSearch, 'Find Files',
		'Finds files in the workspace whose path matches a glob pattern, e.g. "**/*.test.ts".',
		{
			type: 'object',
			properties: {
				pattern: { type: 'string', description: 'A glob pattern matched against workspace-relative paths.' }
			},
			required: ['pattern'],
			additionalProperties: false
		}),
];

export class HackerCodeCoreTool extends Disposable implements IToolImpl {

	constructor(
		private readonly toolId: HackerCodeCoreToolId,
		@IFileService private readonly fileService: IFileService,
		@ISearchService private readonly searchService: ISearchService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const parameters = context.parameters as { path?: string; query?: string; pattern?: string };
		switch (this.toolId) {
			case HackerCodeCoreToolId.ReadFile:
				return { invocationMessage: localize('hackerCodeAgent.tool.readFile', "Reading {0}", parameters.path ?? '') };
			case HackerCodeCoreToolId.ListDirectory:
				return { invocationMessage: localize('hackerCodeAgent.tool.listDir', "Listing {0}", parameters.path ?? '.') };
			case HackerCodeCoreToolId.GrepSearch:
				return { invocationMessage: localize('hackerCodeAgent.tool.grep', "Searching for \"{0}\"", parameters.query ?? '') };
			case HackerCodeCoreToolId.FileSearch:
				return { invocationMessage: localize('hackerCodeAgent.tool.findFiles', "Finding files matching {0}", parameters.pattern ?? '') };
		}
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		try {
			const value = await this._run(invocation.parameters, token);
			return { content: [{ kind: 'text', value }] };
		} catch (error) {
			const message = getErrorMessage(error);
			return { content: [{ kind: 'text', value: message }], toolResultError: message };
		}
	}

	private async _run(parameters: Record<string, any>, token: CancellationToken): Promise<string> {
		switch (this.toolId) {
			case HackerCodeCoreToolId.ReadFile:
				return this._readFile(parameters);
			case HackerCodeCoreToolId.ListDirectory:
				return this._listDirectory(parameters);
			case HackerCodeCoreToolId.GrepSearch:
				return this._grepSearch(parameters, token);
			case HackerCodeCoreToolId.FileSearch:
				return this._fileSearch(parameters, token);
		}
	}

	private async _readFile(parameters: Record<string, any>): Promise<string> {
		const resource = await this._resolveExisting(String(parameters.path ?? ''));
		const content = (await this.fileService.readFile(resource)).value.toString();
		const startLine = asPositiveInteger(parameters.startLine);
		const endLine = asPositiveInteger(parameters.endLine);

		if (startLine === undefined && endLine === undefined) {
			return truncate(content, MAX_FILE_CHARS);
		}

		const lines = content.split('\n');
		const from = Math.max(1, startLine ?? 1);
		const to = Math.min(lines.length, endLine ?? lines.length);
		const selected = lines.slice(from - 1, to).map((line, index) => `${from + index}: ${line}`);
		return truncate(selected.join('\n'), MAX_FILE_CHARS);
	}

	private async _listDirectory(parameters: Record<string, any>): Promise<string> {
		const resource = await this._resolveExisting(typeof parameters.path === 'string' ? parameters.path : '');
		const stat = await this.fileService.resolve(resource);
		if (!stat.isDirectory) {
			throw new Error(`${resource.fsPath} is not a directory.`);
		}
		const children = stat.children ?? [];
		const entries = children
			.slice(0, MAX_DIRECTORY_ENTRIES)
			.map(child => child.isDirectory ? `${child.name}/` : child.name)
			.sort();
		const suffix = children.length > MAX_DIRECTORY_ENTRIES
			? `\n...[${children.length - MAX_DIRECTORY_ENTRIES} more entries]`
			: '';
		return entries.length > 0 ? `${entries.join('\n')}${suffix}` : 'The directory is empty.';
	}

	private async _grepSearch(parameters: Record<string, any>, token: CancellationToken): Promise<string> {
		const folders = this.workspaceContextService.getWorkspace().folders.map(folder => folder.uri);
		if (folders.length === 0) {
			return 'No folder is open, so there is nothing to search.';
		}
		const queryBuilder = this.instantiationService.createInstance(QueryBuilder);
		const query = queryBuilder.text({
			pattern: String(parameters.query ?? ''),
			isRegExp: parameters.isRegex === true,
			isCaseSensitive: parameters.caseSensitive === true
		}, folders, {
			maxResults: MAX_SEARCH_RESULTS,
			previewOptions: { matchLines: 1, charsPerLine: 250 },
			...(typeof parameters.includePattern === 'string' && parameters.includePattern
				? { includePattern: parameters.includePattern }
				: {})
		});

		const complete = await this.searchService.textSearch(query, token);
		const lines: string[] = [];
		for (const fileMatch of complete.results) {
			const path = this._relative(fileMatch.resource);
			for (const result of fileMatch.results ?? []) {
				if (!resultIsMatch(result)) {
					continue;
				}
				const line = result.rangeLocations[0]?.source.startLineNumber;
				lines.push(`${path}:${line ?? '?'}: ${result.previewText.trim()}`);
			}
		}
		if (lines.length === 0) {
			return 'No matches found.';
		}
		return `${lines.join('\n')}${complete.limitHit ? '\n...[more matches were not returned]' : ''}`;
	}

	private async _fileSearch(parameters: Record<string, any>, token: CancellationToken): Promise<string> {
		const folders = this.workspaceContextService.getWorkspace().folders.map(folder => folder.uri);
		if (folders.length === 0) {
			return 'No folder is open, so there is nothing to search.';
		}
		const queryBuilder = this.instantiationService.createInstance(QueryBuilder);
		const query = queryBuilder.file(folders, {
			filePattern: String(parameters.pattern ?? ''),
			shouldGlobSearch: true,
			maxResults: MAX_SEARCH_RESULTS
		});

		const complete = await this.searchService.fileSearch(query, token);
		if (complete.results.length === 0) {
			return 'No files matched.';
		}
		const paths = complete.results.map(match => this._relative(match.resource)).sort();
		return `${paths.join('\n')}${complete.limitHit ? '\n...[more files were not returned]' : ''}`;
	}

	private _resolveExisting(path: string): Promise<URI> {
		return resolveExistingWorkspacePath(this.fileService, this.workspaceContextService, path);
	}

	private _relative(resource: URI): string {
		return toWorkspaceRelativePath(this.workspaceContextService, resource);
	}
}

function asPositiveInteger(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function truncate(text: string, max: number): string {
	if (text.length <= max) {
		return text;
	}
	return `${text.slice(0, max)}\n...[truncated ${text.length - max} characters]`;
}
