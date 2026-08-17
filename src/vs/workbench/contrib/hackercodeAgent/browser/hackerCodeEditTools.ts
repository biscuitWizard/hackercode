/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { getErrorMessage } from '../../../../base/common/errors.js';
import { IJSONSchema } from '../../../../base/common/jsonSchema.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { isEqual } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { Position } from '../../../../editor/common/core/position.js';
import { Range } from '../../../../editor/common/core/range.js';
import { TextEdit } from '../../../../editor/common/languages.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { localize } from '../../../../nls.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IChatService } from '../../chat/common/chatService/chatService.js';
import { ChatModel } from '../../chat/common/model/chatModel.js';
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
import { resolveExistingWorkspacePath, resolveWritableWorkspacePath, toWorkspaceRelativePath } from './hackerCodeWorkspacePaths.js';

/**
 * The tools that let the agent change the workspace.
 *
 * VS Code ships `vscode_editFile_internal`, which hands a code block to an
 * `ICodeMapperService` provider and lets a second model work out the edits.
 * That provider only ever came from the chat extension, so in this build there
 * is none and the tool cannot apply anything. These two tools replace it with
 * edits the calling model states exactly, which needs no second model and no
 * provider: name a file and its new contents, or name the text to replace.
 *
 * Both route through the chat editing session, so an edit lands as a reviewable
 * diff the user can keep or undo, rather than a silent write behind their back.
 */

export const enum HackerCodeEditToolId {
	CreateFile = 'create_file',
	EditFile = 'edit_file',
}

/** Tools here write to the workspace, so Ask mode never offers them. */
export function isWorkspaceWriteTool(toolId: string): boolean {
	return toolId === HackerCodeEditToolId.CreateFile || toolId === HackerCodeEditToolId.EditFile;
}

/**
 * How long to wait for the editing session to finish applying before reporting
 * back. The wait exists so the model does not read a file it has just written
 * and see the old contents; it is bounded because a tool that never returns
 * costs the user the whole turn, which is worse than one that returns early.
 */
const APPLY_TIMEOUT_MS = 20_000;

function toolData(id: HackerCodeEditToolId, displayName: string, modelDescription: string, inputSchema: IJSONSchema): IToolData {
	return {
		id,
		displayName,
		modelDescription,
		inputSchema,
		source: ToolDataSource.Internal,
		runsInWorkspace: true,
		tags: ['workspace', 'edit'],
		toolReferenceName: id,
		canBeReferencedInPrompt: true
	};
}

export const HackerCodeEditToolData: readonly IToolData[] = [
	toolData(HackerCodeEditToolId.CreateFile, 'Create File',
		'Creates a new file with the given contents, or replaces the entire contents of an existing file. Use this for new files and for rewrites; use edit_file to change part of an existing file.',
		{
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Workspace-relative or absolute path to the file.' },
				content: { type: 'string', description: 'The complete contents of the file.' }
			},
			required: ['path', 'content'],
			additionalProperties: false
		}),
	toolData(HackerCodeEditToolId.EditFile, 'Edit File',
		'Replaces an exact stretch of text in an existing file. oldString must match the file byte for byte, including indentation, and must appear exactly once unless replaceAll is true — include a few surrounding lines to make it unique. Read the file first so the text you send matches.',
		{
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Workspace-relative or absolute path to the file.' },
				oldString: { type: 'string', description: 'The exact existing text to replace.' },
				newString: { type: 'string', description: 'The text to put in its place. Pass an empty string to delete.' },
				replaceAll: { type: 'boolean', description: 'Replace every occurrence instead of requiring exactly one. Defaults to false.' }
			},
			required: ['path', 'oldString', 'newString'],
			additionalProperties: false
		}),
];

export class HackerCodeEditTool extends Disposable implements IToolImpl {

	constructor(
		private readonly toolId: HackerCodeEditToolId,
		@IFileService private readonly fileService: IFileService,
		@ITextModelService private readonly textModelService: ITextModelService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IChatService private readonly chatService: IChatService,
	) {
		super();
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const path = String((context.parameters as { path?: string }).path ?? '');
		return {
			invocationMessage: this.toolId === HackerCodeEditToolId.CreateFile
				? localize('hackerCodeAgent.tool.createFile', "Writing {0}", path)
				: localize('hackerCodeAgent.tool.editFile', "Editing {0}", path)
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		try {
			const value = await this._run(invocation, token);
			return { content: [{ kind: 'text', value }] };
		} catch (error) {
			const message = getErrorMessage(error);
			return { content: [{ kind: 'text', value: message }], toolResultError: message };
		}
	}

	private async _run(invocation: IToolInvocation, token: CancellationToken): Promise<string> {
		const parameters = invocation.parameters as { path?: string; content?: string; oldString?: string; newString?: string; replaceAll?: boolean };
		const path = String(parameters.path ?? '');
		if (!path) {
			throw new Error('No path was given.');
		}
		const resource = this.toolId === HackerCodeEditToolId.CreateFile
			? await resolveWritableWorkspacePath(this.fileService, this.workspaceContextService, path)
			: await resolveExistingWorkspacePath(this.fileService, this.workspaceContextService, path);
		const relative = toWorkspaceRelativePath(this.workspaceContextService, resource);

		const { edits, summary } = this.toolId === HackerCodeEditToolId.CreateFile
			? await this._createFileEdits(resource, relative, String(parameters.content ?? ''))
			: await this._replaceEdits(resource, relative, parameters);

		await this._apply(invocation, resource, edits, token);
		return summary;
	}

	private async _createFileEdits(resource: URI, relative: string, requested: string): Promise<{ edits: TextEdit[]; summary: string }> {
		const { text: content, note } = repairOverEscaping(requested);
		const existing = await this._readIfExists(resource);
		if (existing === undefined) {
			return {
				edits: [{ range: new Range(1, 1, 1, 1), text: content }],
				summary: `Created ${relative} (${countLines(content)} lines).${note}`
			};
		}
		if (existing === content) {
			return { edits: [], summary: `${relative} already has exactly those contents; nothing was changed.` };
		}
		return {
			edits: [{ range: fullRange(existing), text: content }],
			summary: `Replaced the contents of ${relative} (${countLines(content)} lines).${note}`
		};
	}

	private async _replaceEdits(resource: URI, relative: string, parameters: { oldString?: string; newString?: string; replaceAll?: boolean }): Promise<{ edits: TextEdit[]; summary: string }> {
		const oldString = String(parameters.oldString ?? '');
		const newString = String(parameters.newString ?? '');
		if (!oldString) {
			throw new Error('oldString was empty. To create a file or replace all of its contents, use create_file.');
		}
		if (oldString === newString) {
			throw new Error('oldString and newString are identical, so there is nothing to change.');
		}

		const content = await this._readIfExists(resource);
		if (content === undefined) {
			throw new Error(`${relative} does not exist. Use create_file to create it.`);
		}

		const found = findEdits(content, oldString, newString);
		if (found.matches.length === 0) {
			// The file goes back with the error. Telling a model to "read the
			// file first" when it has just guessed at the contents only earns
			// another guess; showing it the text it failed to match is what
			// actually ends the retry loop.
			throw new Error([
				`oldString was not found in ${relative}, so nothing was changed.${describeEscapingFault(oldString)}`,
				`Here is what ${relative} actually contains. Copy the text to replace from this, exactly, including indentation:`,
				'',
				truncateForError(content),
				'',
				// A model that cannot quote the file back will not manage it on
				// the second try either, and the way out is a tool that never
				// asks it to: create_file only needs the text to end up with.
				`If matching text is giving you trouble, call create_file with the complete new contents of ${relative} instead.`,
			].join('\n'));
		}
		if (found.matches.length > 1 && parameters.replaceAll !== true) {
			throw new Error(`oldString appears ${found.matches.length} times in ${relative}. Include enough surrounding lines to identify one occurrence, or pass replaceAll: true to change all of them.`);
		}

		const targets = parameters.replaceAll === true ? found.matches : [found.matches[0]];
		const edits = targets.map(match => ({
			range: rangeAt(content, match.start, match.end - match.start),
			text: match.text
		}));
		const reindented = found.reindented ? ' The indentation was adjusted to match the file.' : '';
		return {
			edits,
			summary: (targets.length === 1
				? `Edited ${relative}.`
				: `Edited ${relative}, replacing ${targets.length} occurrences.`) + reindented
		};
	}

	private async _readIfExists(resource: URI): Promise<string | undefined> {
		// An open editor may hold changes that have not reached disk, and those
		// are what the edit has to line up with.
		const reference = await this.textModelService.createModelReference(resource).catch(() => undefined);
		if (reference) {
			try {
				return reference.object.textEditorModel.getValue();
			} finally {
				reference.dispose();
			}
		}
		return undefined;
	}

	/**
	 * Hands the edits to the chat editing session, which is what puts them on
	 * screen as a diff with keep and undo. Falls back to writing the file when
	 * there is no session, so a tool call outside the chat panel still does
	 * what it says rather than quietly doing nothing.
	 */
	private async _apply(invocation: IToolInvocation, resource: URI, edits: TextEdit[], token: CancellationToken): Promise<void> {
		if (edits.length === 0) {
			return;
		}

		const model = invocation.context
			? this.chatService.getSession(invocation.context.sessionResource) as ChatModel | undefined
			: undefined;
		const request = model?.getRequests().at(-1);
		if (!model || !request || !model.editingSession) {
			await this._writeDirectly(resource, edits);
			return;
		}

		// Only the edits themselves are reported. They become a textEditGroup,
		// which is what draws the diff and the changed-files bar. Announcing
		// the file with a fenced block and a codeblockUri as well used to seem
		// harmless, but consecutive markdown is merged before it is rendered,
		// so the edit marker ended up attached to whatever the model said next
		// and took the model's closing reply into the collapsed step group
		// with it. The user was then shown "Finished with N steps" and no
		// answer at all.
		model.acceptResponseProgress(request, { kind: 'textEdit', uri: resource, edits: [] });
		model.acceptResponseProgress(request, { kind: 'textEdit', uri: resource, edits });
		model.acceptResponseProgress(request, { kind: 'textEdit', uri: resource, edits: [], done: true });

		await this._waitForApply(model, resource, token);
	}

	private async _writeDirectly(resource: URI, edits: TextEdit[]): Promise<void> {
		const content = await this._readIfExists(resource) ?? '';
		await this.fileService.writeFile(resource, VSBuffer.fromString(applyEdits(content, edits)));
	}

	/**
	 * Waits for the session to finish streaming this file in. Returning early
	 * on timeout is deliberate: the edits are already queued, and the model
	 * getting on with its next step is better than a turn that never ends.
	 */
	private _waitForApply(model: ChatModel, resource: URI, token: CancellationToken): Promise<void> {
		const editingSession = model.editingSession;
		if (!editingSession) {
			return Promise.resolve();
		}
		return new Promise<void>(resolve => {
			let settled = false;
			let sawModification = false;
			const done = () => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					listener?.dispose();
					cancellation.dispose();
					resolve();
				}
			};
			const timer = setTimeout(done, APPLY_TIMEOUT_MS);
			const cancellation = token.onCancellationRequested(done);
			const listener: IDisposable = autorun(reader => {
				const entry = editingSession.entries.read(reader)?.find(candidate => isEqual(candidate.modifiedURI, resource));
				if (!entry) {
					return;
				}
				if (entry.isCurrentlyBeingModifiedBy.read(reader)) {
					sawModification = true;
				} else if (sawModification) {
					done();
				}
			});
		});
	}
}

/**
 * Undoes escaping that a model applied one time too many.
 *
 * File contents travel inside a JSON string, and a model that escapes them
 * again sends the two characters backslash-n where a line break belongs, or
 * backslash-quote where a quote belongs. Written out as given, the result is
 * not the file anyone asked for.
 *
 * Each kind of over-escaping is judged separately, and only on evidence that
 * real source could not plausibly produce:
 *
 * - Line breaks: the text has no line breaks at all, yet several "\n" in it.
 *   A file that is genuinely one line does not carry several of those.
 * - Quotes: every quote in the text is escaped and not one is bare. Source
 *   with an escaped quote inside a string always has the unescaped quotes
 *   that open and close that string, so "all escaped, none bare" does not
 *   occur in code that was escaped the right number of times.
 * - Template interpolation: every "${" is escaped and not one is bare. An
 *   escaped one means the literal characters, so a file where every single
 *   interpolation is the literal text is not what was written; and left
 *   alone it is the repair that hides best, because the code compiles and
 *   quietly prints "${name}".
 *
 * Backslashes are never touched: there is no comparable evidence for them,
 * and a wrong guess would corrupt every path and regex in the file. Whatever
 * is repaired is named in the tool result, so a wrong guess is visible.
 */
export function repairOverEscaping(text: string): { text: string; note: string } {
	let repaired = text;
	const repairs: string[] = [];

	if (!repaired.includes('\n') && (repaired.match(/\\n/g)?.length ?? 0) >= 2) {
		repaired = repaired.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
		repairs.push('line breaks');
	}
	for (const quote of ['"', '\'']) {
		if (onlyEscapedOccurrences(repaired, quote)) {
			repaired = repaired.split(`\\${quote}`).join(quote);
			repairs.push(quote === '"' ? 'double quotes' : 'single quotes');
		}
	}
	if (onlyEscapedOccurrences(repaired, '${')) {
		repaired = repaired.split('\\${').join('${');
		repairs.push('template placeholders');
	}

	return {
		text: repaired,
		note: repairs.length === 0 ? '' : ` The content arrived over-escaped; its ${repairs.join(' and ')} were written literally.`
	};
}

/** Whether every occurrence of `token` is backslash-escaped, and at least one is. */
function onlyEscapedOccurrences(text: string, token: string): boolean {
	let escaped = 0;
	let bare = 0;
	for (let i = 0; i < text.length; i++) {
		if (text[i] === '\\') {
			if (text.startsWith(token, i + 1)) {
				escaped++;
			}
			i++;
			continue;
		}
		if (text.startsWith(token, i)) {
			bare++;
		}
	}
	return escaped > 0 && bare === 0;
}

/**
 * The ways the model's text might have been meant, best first.
 *
 * Tool arguments arrive inside a JSON string, and a model that escapes them
 * again sends the two characters backslash-n where a line break belongs. Which
 * reading is right cannot be told from the text alone — source legitimately
 * contains "\n" — but it can be told from the file, so both are offered and
 * the caller keeps whichever one is in there. Line endings are matched to the
 * file for the same reason: a model that read a CRLF file writes back bare
 * newlines, because bare newlines are what it saw.
 *
 * The replacement gets no such oracle — it is not in the file yet — so in the
 * reading where the text was taken at face value it is still passed through
 * the conservative repair, which only acts on escaping that source could not
 * have produced. The two halves of one call are not always escaped alike: a
 * one-line `oldString` can match exactly while the `newString` beside it, the
 * only one long enough to carry line breaks, arrives escaped twice.
 */
/**
 * Where the replacement goes, and what it is once the escaping is settled.
 *
 * The file decides. Rather than working out up front whether the model's text
 * was escaped one time too many, each reading of it is tried against the file
 * and the one that is actually in there wins: a guess can be wrong, a match
 * cannot.
 */
export function findEdits(content: string, oldString: string, newString: string): { matches: IMatch[]; reindented: boolean } {
	let found: { matches: IMatch[]; reindented: boolean } = { matches: [], reindented: false };
	for (const [search, replacement] of readings(oldString, newString, content)) {
		found = findMatches(content, search, replacement);
		if (found.matches.length > 0) {
			break;
		}
	}
	return found;
}

function readings(oldString: string, newString: string, content: string): Array<[string, string]> {
	const toFileEol = (text: string) => content.includes('\r\n') && !text.includes('\r\n') ? text.replace(/\n/g, '\r\n') : text;
	const asSent: [string, string] = [toFileEol(oldString), toFileEol(repairOverEscaping(newString).text)];
	const unescaped = unescapeOnce(oldString);
	if (unescaped === oldString) {
		return [asSent];
	}
	return [asSent, [toFileEol(unescaped), toFileEol(unescapeOnce(newString))]];
}

/**
 * Reads the text as if it were still the contents of a JSON string.
 *
 * `\${` is in here even though JSON has no such escape: a model escaping its
 * output a second time escapes the interpolation marker along with everything
 * else, and a template literal that reaches the file as `` `Hello, \${name}` ``
 * is not a mistake the user will spot in a diff — it compiles, and prints the
 * word instead of the value. A literal `${` in real source is written that way
 * far less often than a model over-escapes one, and this reading is only used
 * when the plain one did not match the file at all.
 */
function unescapeOnce(text: string): string {
	return text.replace(/\\(\$\{|["'\\nrt])/g, (_, escaped: string) => {
		switch (escaped) {
			case 'n': return '\n';
			case 'r': return '\r';
			case 't': return '\t';
			default: return escaped;
		}
	});
}

/**
 * Names the over-escaping when the text carries its fingerprints, so a model
 * that cannot match its own text is told why rather than being handed the
 * file again and left to guess. A backslash at the very end is the telling
 * one: it is what a doubly-escaped quote leaves behind when the closing quote
 * it was hiding ends the argument early, cutting the text short.
 */
export function describeEscapingFault(oldString: string): string {
	const truncated = /\\$/.test(oldString);
	const literalNewlines = !oldString.includes('\n') && oldString.includes('\\n');
	if (!truncated && !literalNewlines) {
		return '';
	}
	return truncated
		? ' Your oldString ends in a backslash and is cut short, which happens when the text is escaped a second time: the escaped quote closed the argument early. Send oldString as plain text, with real line breaks and quotes written once.'
		: ' Your oldString contains the two characters backslash-n where line breaks should be, so it was escaped a second time. Send it as plain text with real line breaks.';
}

export interface IMatch {
	/** Offset in the file where the replaced text starts. */
	readonly start: number;
	/** Offset in the file just past the replaced text. */
	readonly end: number;
	/** What to put there, re-indented to the file if it had to be. */
	readonly text: string;
}

/**
 * Locates the text to replace, allowing for indentation the model got wrong.
 *
 * Models reproduce a file's characters faithfully and its leading whitespace
 * carelessly: a tab-indented file comes back with four spaces, or a nesting
 * level goes missing. Byte-exact matching turns that into "oldString was not
 * found", the model retries with the same whitespace, and the turn is spent
 * on a loop that cannot end.
 *
 * So an exact match is tried first, and only if there is none is the search
 * repeated over whole lines compared without their leading and trailing
 * whitespace. A match found that way replaces whole lines, and the new text
 * is re-indented from the indentation actually seen in the file, so a tab
 * file stays tabs. Content still has to agree character for character once
 * the whitespace is set aside — this forgives how the model typed the text,
 * not what it typed.
 */
export function findMatches(content: string, search: string, replacement: string): { matches: IMatch[]; reindented: boolean } {
	const exact = allOffsetsOf(content, search);
	if (exact.length > 0) {
		return { matches: exact.map(start => ({ start, end: start + search.length, text: replacement })), reindented: false };
	}

	const eol = content.includes('\r\n') ? '\r\n' : '\n';
	const contentLines = splitLines(content, eol);
	const searchLines = trimBlankEdges(splitLines(search, eol));
	if (searchLines.length === 0) {
		return { matches: [], reindented: false };
	}

	// A loose match covers whole lines and not the newline that ends them, so
	// the replacement is bounded the same way: blank first and last lines it
	// picked up from being quoted would otherwise land in the file as spacing
	// that nobody asked for.
	const replacementLines = trimBlankEdges(splitLines(replacement, eol)).map(line => line.text);

	const matches: IMatch[] = [];
	for (let start = 0; start + searchLines.length <= contentLines.length; start++) {
		const window = contentLines.slice(start, start + searchLines.length);
		if (!window.every((line, index) => line.text.trim() === searchLines[index].text.trim())) {
			continue;
		}
		const last = window[window.length - 1];
		if (replacementLines.length === 0) {
			// Deleting the text means deleting the lines, terminator included;
			// leaving it behind turns a deletion into a blank line.
			matches.push({ start: window[0].start, end: Math.min(last.end + eol.length, content.length), text: '' });
			continue;
		}
		const text = reindent(replacementLines, searchLines.map(line => line.text), window.map(line => line.text)).join(eol);
		matches.push({ start: window[0].start, end: last.end, text });
	}
	return { matches, reindented: matches.length > 0 };
}

interface ILine {
	readonly text: string;
	readonly start: number;
	/** Offset of the line's last character, not counting its terminator. */
	readonly end: number;
}

function splitLines(text: string, eol: string): ILine[] {
	const lines: ILine[] = [];
	let start = 0;
	for (;;) {
		const next = text.indexOf(eol, start);
		if (next < 0) {
			lines.push({ text: text.slice(start), start, end: text.length });
			return lines;
		}
		lines.push({ text: text.slice(start, next), start, end: next });
		start = next + eol.length;
	}
}

/** Blank first and last lines are an artefact of how the text was quoted. */
function trimBlankEdges(lines: ILine[]): ILine[] {
	let first = 0;
	let last = lines.length;
	while (first < last && lines[first].text.trim() === '') { first++; }
	while (last > first && lines[last - 1].text.trim() === '') { last--; }
	return lines.slice(first, last);
}

const INDENT = /^[\t ]*/;

/**
 * Rewrites the new text's indentation in the file's own terms.
 *
 * The matched lines say what each indentation the model used corresponds to
 * in the file, and that correspondence is applied to the new text. A line
 * indented in a way the model never showed — a block it is adding — is
 * converted with the deepest correspondence that prefixes it, which keeps
 * tabs as tabs; failing that it is left alone, since a wrong guess about
 * one added line is easier to see and fix than a rewritten file.
 */
function reindent(replacementLines: string[], searchLines: string[], matchedLines: string[]): string[] {
	const translation = new Map<string, string>();
	for (let i = 0; i < searchLines.length; i++) {
		if (searchLines[i].trim() === '') {
			continue;
		}
		translation.set(INDENT.exec(searchLines[i])![0], INDENT.exec(matchedLines[i])![0]);
	}
	if ([...translation].every(([from, to]) => from === to)) {
		return replacementLines;
	}

	const known = [...translation.keys()].sort((a, b) => b.length - a.length);
	return replacementLines.map(line => {
		const indent = INDENT.exec(line)![0];
		const exact = translation.get(indent);
		if (exact !== undefined) {
			return exact + line.slice(indent.length);
		}
		const prefix = known.find(candidate => candidate.length > 0 && indent.startsWith(candidate));
		if (prefix === undefined) {
			return line;
		}
		// One more level than the deepest known indent: repeat what that level
		// cost in the file for the extra depth the model asked for.
		const extra = indent.slice(prefix.length);
		const unit = translation.get(prefix)!;
		const depth = Math.round(extra.length / prefix.length);
		return unit + unit.repeat(Math.max(depth, 0)) + line.slice(indent.length);
	});
}

/** Enough of the file to edit against, without spending the context window on it. */
const MAX_ERROR_CONTENT_CHARS = 16 * 1024;

function truncateForError(content: string): string {
	return content.length <= MAX_ERROR_CONTENT_CHARS
		? content
		: `${content.slice(0, MAX_ERROR_CONTENT_CHARS)}\n...[truncated; use read_file with startLine and endLine to see the rest]`;
}

function countLines(text: string): number {
	return text.length === 0 ? 0 : text.split('\n').length;
}

function fullRange(content: string): Range {
	const end = positionAt(content, content.length);
	return new Range(1, 1, end.lineNumber, end.column);
}

function rangeAt(content: string, offset: number, length: number): Range {
	const start = positionAt(content, offset);
	const end = positionAt(content, offset + length);
	return new Range(start.lineNumber, start.column, end.lineNumber, end.column);
}

function positionAt(content: string, offset: number): Position {
	let line = 1;
	let lineStart = 0;
	for (let i = 0; i < offset; i++) {
		if (content.charCodeAt(i) === 10 /* \n */) {
			line++;
			lineStart = i + 1;
		}
	}
	return new Position(line, offset - lineStart + 1);
}

function allOffsetsOf(content: string, search: string): number[] {
	const offsets: number[] = [];
	let from = 0;
	for (;;) {
		const index = content.indexOf(search, from);
		if (index < 0) {
			return offsets;
		}
		offsets.push(index);
		from = index + search.length;
	}
}

/** Applies edits back-to-front so earlier offsets stay valid. */
function applyEdits(content: string, edits: TextEdit[]): string {
	const withOffsets = edits.map(edit => ({
		start: offsetAt(content, edit.range.startLineNumber, edit.range.startColumn),
		end: offsetAt(content, edit.range.endLineNumber, edit.range.endColumn),
		text: edit.text
	})).sort((a, b) => b.start - a.start);

	let result = content;
	for (const edit of withOffsets) {
		result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
	}
	return result;
}

function offsetAt(content: string, lineNumber: number, column: number): number {
	let offset = 0;
	for (let line = 1; line < lineNumber; line++) {
		const next = content.indexOf('\n', offset);
		if (next < 0) {
			return content.length;
		}
		offset = next + 1;
	}
	return Math.min(offset + column - 1, content.length);
}
