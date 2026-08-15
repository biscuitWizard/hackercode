/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A tool call's arguments are JSON the model wrote by hand, one token at a
 * time, and models get it wrong often enough that treating it as a protocol
 * error is the wrong call: malformed arguments are the model's mistake to fix,
 * not the user's turn to lose. So nothing here throws. Either the text is
 * coerced into the object the model meant, or it comes back marked as invalid
 * with enough detail for the model to correct itself on the next step.
 */

/**
 * Marks arguments that could not be parsed. It is only ever present on the
 * object handed back in place of real arguments, and is named so that it
 * cannot collide with a property of a real tool schema. Being a plain property
 * rather than a symbol, it survives serialization and so arrives intact even
 * if the tool call crosses a process boundary.
 */
export const INVALID_TOOL_ARGUMENTS_KEY = '$hackerCodeInvalidArguments';

export interface IInvalidToolArguments {
	/** Exactly what the model sent, so it can be quoted back at it. */
	readonly raw: string;
	/** Why the parse failed, in the JSON parser's own words. */
	readonly reason: string;
}

/** How much of the offending text to quote back before it costs more context than it is worth. */
const MAX_QUOTED_ARGUMENTS = 1024;

/** Spellings from neighbouring languages that models reach for under pressure. */
const FOREIGN_LITERALS: ReadonlyArray<readonly [string, string]> = [
	['True', 'true'],
	['False', 'false'],
	['None', 'null'],
	['undefined', 'null'],
];

/**
 * Turns the raw `arguments` string of a tool call into the object to invoke the
 * tool with. Never throws: unparseable text yields an object carrying
 * {@link INVALID_TOOL_ARGUMENTS_KEY}, which callers detect with
 * {@link getInvalidToolArguments} and must never pass to a tool.
 */
export function parseToolCallArguments(rawArguments: string | undefined): object {
	const raw = rawArguments ?? '';

	// A tool that takes no arguments gets called with an empty string about as
	// often as with "{}".
	if (raw.trim().length === 0) {
		return {};
	}

	let reason: string | undefined;
	for (const candidate of candidates(raw)) {
		const attempt = tryParseObject(candidate);
		if (attempt.value) {
			return attempt.value;
		}
		// The first failure is the one worth reporting: it describes what the
		// model actually sent, rather than what one of the rewrites below made
		// of it.
		reason ??= attempt.error;
	}

	return { [INVALID_TOOL_ARGUMENTS_KEY]: { raw, reason: reason ?? 'Not a JSON object' } satisfies IInvalidToolArguments };
}

/**
 * Reads the marker back off an argument object, so a caller can tell arguments
 * that failed to parse from arguments that happen to be empty.
 */
export function getInvalidToolArguments(parameters: object | undefined): IInvalidToolArguments | undefined {
	const marker = (parameters as Record<string, unknown> | undefined)?.[INVALID_TOOL_ARGUMENTS_KEY];
	if (!marker || typeof marker !== 'object') {
		return undefined;
	}
	const { raw, reason } = marker as Partial<IInvalidToolArguments>;
	return typeof raw === 'string' && typeof reason === 'string' ? { raw, reason } : undefined;
}

/**
 * The tool result to give the model in place of running the tool. It names the
 * parser's complaint, quotes the text back, and says what to do about it,
 * because a model that cannot see its own mistake tends to repeat it.
 */
export function describeInvalidToolArguments(toolName: string, invalid: IInvalidToolArguments): string {
	const quoted = invalid.raw.length > MAX_QUOTED_ARGUMENTS
		? `${invalid.raw.slice(0, MAX_QUOTED_ARGUMENTS)}...[truncated]`
		: invalid.raw;
	return [
		`The arguments for "${toolName}" were not valid JSON, so the tool was not run: ${invalid.reason}.`,
		`You sent: ${quoted}`,
		'Call the tool again, passing a single valid JSON object that matches its input schema. Send the object on its own, with no code fences and no explanatory text around it.'
	].join('\n');
}

/**
 * The text to try, in order, from most to least faithful to what arrived.
 * Every rewrite here is lossless: it changes how the arguments are spelled and
 * never what they say. Text that is merely incomplete is deliberately left
 * alone, since finishing it off would invent argument values the model never
 * sent, and a tool acting on a half-written path or command is worse than a
 * tool that asks the model to try again.
 */
function* candidates(raw: string): Iterable<string> {
	yield raw;

	const unfenced = stripCodeFence(raw);
	if (unfenced !== raw) {
		yield unfenced;
	}

	const sliced = sliceToObject(unfenced);
	if (sliced !== unfenced) {
		yield sliced;
	}

	const respelled = respell(sliced);
	if (respelled !== undefined && respelled !== sliced) {
		yield respelled;
	}
}

function tryParseObject(text: string, depth = 0): { value?: object; error?: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}

	// Some providers double-encode, sending the argument object as a JSON
	// string rather than as JSON. If the string does not hold an object then it
	// was only ever a string, and saying so is more use than a parse error
	// about text the model never meant as JSON.
	if (typeof parsed === 'string' && depth === 0) {
		const nested = tryParseObject(parsed, depth + 1);
		if (nested.value) {
			return nested;
		}
	}

	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		return { error: `Expected a JSON object, got ${describeValue(parsed)}` };
	}
	return { value: parsed };
}

function describeValue(value: unknown): string {
	if (value === null) {
		return 'null';
	}
	return Array.isArray(value) ? 'an array' : `a ${typeof value}`;
}

/** Strips the code fence a model adds when it mistakes the argument slot for a message. */
function stripCodeFence(text: string): string {
	const fenced = /^\s*```[a-z0-9]*\s*\r?\n([\s\S]*?)\r?\n?\s*```\s*$/i.exec(text);
	return fenced ? fenced[1] : text;
}

/** Drops any prose a model wrapped around the object. */
function sliceToObject(text: string): string {
	const start = text.indexOf('{');
	if (start < 0) {
		return text;
	}
	const end = text.lastIndexOf('}');
	return end > start ? text.slice(start, end + 1) : text.slice(start);
}

/**
 * Rewrites the spellings that JSON rejects but models produce anyway: single
 * quotes, Python's literals, and a comma left before a closing bracket.
 * Returns `undefined` when the text runs out mid-string or mid-object, which
 * means it was truncated and no amount of respelling will recover it.
 */
function respell(text: string): string | undefined {
	const out: string[] = [];
	const closers: string[] = [];
	let quote: string | undefined;
	let escaped = false;

	for (let i = 0; i < text.length; i++) {
		const char = text[i];

		if (quote !== undefined) {
			if (escaped) {
				out.push(char);
				escaped = false;
			} else if (char === '\\') {
				out.push(char);
				escaped = true;
			} else if (char === quote) {
				out.push('"');
				quote = undefined;
			} else {
				// A single-quoted string may hold an unescaped double quote,
				// which has to be escaped now that the quoting has changed.
				out.push(char === '"' ? '\\"' : char);
			}
			continue;
		}

		if (char === '"' || char === '\'') {
			quote = char;
			out.push('"');
			continue;
		}
		if (char === '{' || char === '[') {
			closers.push(char === '{' ? '}' : ']');
			out.push(char);
			continue;
		}
		if (char === '}' || char === ']') {
			dropTrailingComma(out);
			closers.pop();
			out.push(char);
			continue;
		}

		const literal = readForeignLiteral(text, i);
		if (literal) {
			out.push(literal.json);
			i += literal.length - 1;
			continue;
		}
		out.push(char);
	}

	return quote !== undefined || closers.length > 0 ? undefined : out.join('');
}

function readForeignLiteral(text: string, index: number): { json: string; length: number } | undefined {
	if (index > 0 && isWordCharacter(text[index - 1])) {
		return undefined;
	}
	for (const [spelling, json] of FOREIGN_LITERALS) {
		if (text.startsWith(spelling, index) && !isWordCharacter(text[index + spelling.length])) {
			return { json, length: spelling.length };
		}
	}
	return undefined;
}

function isWordCharacter(char: string | undefined): boolean {
	return char !== undefined && /[\w$]/.test(char);
}

function dropTrailingComma(out: string[]): void {
	let last = out.length - 1;
	while (last >= 0 && /^\s+$/.test(out[last])) {
		last--;
	}
	if (last >= 0 && out[last] === ',') {
		out.splice(last, 1);
	}
}
