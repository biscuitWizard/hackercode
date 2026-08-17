/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { describeEscapingFault, findEdits, findMatches, repairOverEscaping } from '../../browser/hackerCodeEditTools.js';

/** Applies what `findMatches` found, which is what the tool ultimately does. */
function applyFirst(content: string, search: string, replacement: string): string | undefined {
	const { matches } = findMatches(content, search, replacement);
	if (matches.length !== 1) {
		return undefined;
	}
	const [match] = matches;
	return content.slice(0, match.start) + match.text + content.slice(match.end);
}

suite('HackerCode edit matching', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const tabbed = 'export function greet(name: string): string {\n\treturn "Hello, " + name + "!";\n}\n';

	test('an exact match is replaced as given', () => {
		assert.strictEqual(applyFirst(tabbed, '\treturn "Hello, " + name + "!";', '\treturn `Hello, ${name}!`;'),
			'export function greet(name: string): string {\n\treturn `Hello, ${name}!`;\n}\n');
	});

	test('an exact match does not count as re-indented', () => {
		assert.strictEqual(findMatches(tabbed, '\treturn "Hello, " + name + "!";', 'x').reindented, false);
	});

	test('spaces match a tab-indented file, and the tabs are kept', () => {
		assert.strictEqual(applyFirst(tabbed, '    return "Hello, " + name + "!";', '    return `Hello, ${name}!`;'),
			'export function greet(name: string): string {\n\treturn `Hello, ${name}!`;\n}\n');
	});

	test('a multi-line block matches across mismatched indentation', () => {
		const search = 'export function greet(name: string): string {\n    return "Hello, " + name + "!";\n}';
		const replacement = 'export function greet(name: string): string {\n    return `Hello, ${name}!`;\n}';
		assert.strictEqual(applyFirst(tabbed, search, replacement),
			'export function greet(name: string): string {\n\treturn `Hello, ${name}!`;\n}\n');
	});

	test('an indentation level the model never showed is converted, not left in spaces', () => {
		const search = 'export function greet(name: string): string {\n    return "Hello, " + name + "!";\n}';
		const replacement = 'export function greet(name: string): string {\n    if (name) {\n        return `Hi ${name}`;\n    }\n    return "";\n}';
		assert.strictEqual(applyFirst(tabbed, search, replacement),
			'export function greet(name: string): string {\n\tif (name) {\n\t\treturn `Hi ${name}`;\n\t}\n\treturn "";\n}\n');
	});

	test('content still has to agree once whitespace is set aside', () => {
		assert.deepStrictEqual(findMatches(tabbed, '    return "Goodbye, " + name + "!";', 'x').matches, []);
	});

	test('every loose match is reported so an ambiguous edit is refused', () => {
		const twice = '\tconst a = 1;\n\nfunction f() {\n\tconst a = 1;\n}\n';
		assert.strictEqual(findMatches(twice, 'const a = 1;', 'const a = 2;').matches.length, 2);
	});

	test('an exact match wins over the loose ones', () => {
		const mixed = '\tvalue = 1;\n    value = 1;\n';
		const { matches, reindented } = findMatches(mixed, '    value = 1;', '    value = 2;');
		assert.strictEqual(reindented, false);
		assert.strictEqual(matches.length, 1);
		assert.strictEqual(mixed.slice(matches[0].start, matches[0].end), '    value = 1;');
	});

	test('blank lines around the search text do not stop it matching', () => {
		assert.strictEqual(applyFirst(tabbed, '\n    return "Hello, " + name + "!";\n', '    return `Hi`;'),
			'export function greet(name: string): string {\n\treturn `Hi`;\n}\n');
	});

	test('a CRLF file is matched by text written with bare newlines', () => {
		const crlf = 'function f() {\r\n\treturn 1;\r\n}\r\n';
		assert.strictEqual(applyFirst(crlf, '\treturn 1;', '\treturn 2;'), 'function f() {\r\n\treturn 2;\r\n}\r\n');
	});

	test('a block quoted with surrounding newlines does not gain blank lines', () => {
		const search = '\nexport function greet(name: string): string {\n    return "Hello, " + name + "!";\n}\n';
		const replacement = '\nexport function greet(name: string): string {\n    return `Hello, ${name}!`;\n}\n';
		assert.strictEqual(applyFirst(tabbed, search, replacement),
			'export function greet(name: string): string {\n\treturn `Hello, ${name}!`;\n}\n');
	});

	test('deleting text takes the line with it', () => {
		assert.strictEqual(applyFirst(tabbed, '    return "Hello, " + name + "!";', ''),
			'export function greet(name: string): string {\n}\n');
	});

	test('text the model never sent does not match an empty search', () => {
		assert.deepStrictEqual(findMatches(tabbed, '   \n  \n', 'x').matches, []);
	});
});

suite('HackerCode edit escaping faults', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a cut-short argument is named as double escaping, not just "not found"', () => {
		assert.match(describeEscapingFault('export function greet() {\\n    return \\'), /escaped a second time/);
	});

	test('backslash-n where line breaks belong is named', () => {
		assert.match(describeEscapingFault('const a = 1;\\nconst b = 2;'), /backslash-n/);
	});

	test('text that is merely wrong says nothing about escaping', () => {
		assert.strictEqual(describeEscapingFault('return "Goodbye";'), '');
	});

	test('a real line break rules out the escaping diagnosis', () => {
		assert.strictEqual(describeEscapingFault('const a = 1;\nconst path = "a\\nb";'), '');
	});
});

suite('HackerCode over-escaping repair', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a single line of code is left alone', () => {
		assert.strictEqual(repairOverEscaping('const a = "x";').text, 'const a = "x";');
	});

	test('escaped newlines in a one-line payload become line breaks', () => {
		assert.strictEqual(repairOverEscaping('const a = 1;\\nconst b = 2;\\nconst c = 3;').text,
			'const a = 1;\nconst b = 2;\nconst c = 3;');
	});

	test('quotes that are all escaped are unescaped', () => {
		assert.strictEqual(repairOverEscaping('return \\"Hello\\";').text, 'return "Hello";');
	});

	test('a genuinely escaped quote inside a string is preserved', () => {
		assert.strictEqual(repairOverEscaping('const a = "say \\"hi\\"";').text, 'const a = "say \\"hi\\"";');
	});

	test('a real line break stops the newline repair', () => {
		const text = 'const a = 1;\nconst path = "a\\nb";';
		assert.strictEqual(repairOverEscaping(text).text, text);
	});

	test('what was repaired is named so a wrong guess is visible', () => {
		assert.match(repairOverEscaping('a = 1;\\nb = 2;\\nc = \\"x\\";').note, /line breaks and double quotes/);
	});

	test('backslashes are never touched', () => {
		const text = 'const re = /a\\\\b/;';
		assert.strictEqual(repairOverEscaping(text).text, text);
	});

	test('template placeholders that are all escaped are unescaped', () => {
		assert.strictEqual(repairOverEscaping('return `Hello, \\${name}!`;').text, 'return `Hello, ${name}!`;');
	});

	test('a template placeholder meant literally is preserved', () => {
		const text = 'return `a \\${literal} and a ${real}`;';
		assert.strictEqual(repairOverEscaping(text).text, text);
	});
});

/** Applies what `findEdits` chose, escaping repairs and all. */
function apply(content: string, oldString: string, newString: string): string | undefined {
	const { matches } = findEdits(content, oldString, newString);
	if (matches.length !== 1) {
		return undefined;
	}
	const [match] = matches;
	return content.slice(0, match.start) + match.text + content.slice(match.end);
}

suite('HackerCode edit_file replacement repair', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('an over-escaped replacement is repaired even when oldString matched as sent', () => {
		const content = 'export function greet(name: string): string {\n\treturn "Hello, " + name + "!";\n}\n';
		assert.strictEqual(
			apply(content, '\treturn "Hello, " + name + "!";', '\treturn `Hello, \\${name}!`;'),
			'export function greet(name: string): string {\n\treturn `Hello, ${name}!`;\n}\n');
	});

	test('an over-escaped oldString and replacement are both read a level down', () => {
		const content = 'export function greet(name: string): string {\n\treturn "Hello, " + name + "!";\n}\n';
		assert.strictEqual(
			apply(content, 'export function greet(name: string): string {\\n    return \\"Hello, \\" + name + \\"!\\";\\n}', 'export function greet(name: string): string {\\n    return `Hello, \\${name}!`;\\n}'),
			'export function greet(name: string): string {\n\treturn `Hello, ${name}!`;\n}\n');
	});
});
