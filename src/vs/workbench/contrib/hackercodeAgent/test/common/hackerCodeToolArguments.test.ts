/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	describeInvalidToolArguments,
	getInvalidToolArguments,
	parseToolCallArguments
} from '../../common/hackerCodeToolArguments.js';

suite('parseToolCallArguments', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function parsed(raw: string | undefined): object {
		const result = parseToolCallArguments(raw);
		assert.strictEqual(getInvalidToolArguments(result), undefined, `expected ${JSON.stringify(raw)} to parse`);
		return result;
	}

	function rejected(raw: string): string {
		const result = parseToolCallArguments(raw);
		const invalid = getInvalidToolArguments(result);
		assert.ok(invalid, `expected ${JSON.stringify(raw)} to be rejected`);
		assert.strictEqual(invalid.raw, raw);
		return invalid.reason;
	}

	test('parses what a well-behaved model sends', () => {
		assert.deepStrictEqual(parsed('{"path":"src/a.ts","limit":10}'), { path: 'src/a.ts', limit: 10 });
	});

	test('treats a missing or empty argument list as no arguments', () => {
		assert.deepStrictEqual(parsed(undefined), {});
		assert.deepStrictEqual(parsed(''), {});
		assert.deepStrictEqual(parsed('   \n  '), {});
		assert.deepStrictEqual(parsed('{}'), {});
	});

	test('unwraps a code fence', () => {
		assert.deepStrictEqual(parsed('```json\n{"path":"a.ts"}\n```'), { path: 'a.ts' });
		assert.deepStrictEqual(parsed('```\n{"path":"a.ts"}\n```'), { path: 'a.ts' });
	});

	test('ignores prose written around the object', () => {
		assert.deepStrictEqual(parsed('Here are the arguments: {"path":"a.ts"} — let me know!'), { path: 'a.ts' });
	});

	test('tolerates a trailing comma', () => {
		assert.deepStrictEqual(parsed('{"a":1,"b":[1,2,],}'), { a: 1, b: [1, 2] });
	});

	test('accepts the literals spelled the way other languages spell them', () => {
		assert.deepStrictEqual(parsed('{"a":True,"b":False,"c":None,"d":undefined}'), { a: true, b: false, c: null, d: null });
	});

	test('accepts single-quoted strings', () => {
		assert.deepStrictEqual(parsed(`{'path':'a.ts'}`), { path: 'a.ts' });
		assert.deepStrictEqual(parsed(`{'quote':'she said "hi"'}`), { quote: 'she said "hi"' });
	});

	test('unwraps arguments that were encoded twice', () => {
		assert.deepStrictEqual(parsed(JSON.stringify('{"path":"a.ts"}')), { path: 'a.ts' });
	});

	test('never rewrites the inside of a string', () => {
		assert.deepStrictEqual(parsed('{"text":"a, } None True \'x\'"}'), { text: `a, } None True 'x'` });
	});

	test('rejects arguments cut off mid-string rather than completing them', () => {
		// The dangerous case: closing the quote and the brace would parse, and
		// would hand the tool a path that is not the path the model meant.
		const result = parseToolCallArguments('{"path":"src/vs/workbench/very/long/pa');
		const invalid = getInvalidToolArguments(result);
		assert.ok(invalid);
		assert.strictEqual((result as { path?: string }).path, undefined);
	});

	test('rejects arguments cut off mid-object', () => {
		rejected('{"a":1,"b":2');
		rejected('{"a":{"b":1}');
	});

	test('rejects anything that is not an object', () => {
		assert.match(rejected('[1,2,3]'), /array/);
		assert.match(rejected('"just text"'), /string/);
		assert.match(rejected('42'), /number/);
		assert.match(rejected('null'), /null/);
	});

	test('reports what the model actually sent, not what a rewrite made of it', () => {
		const raw = '{"a": what?}';
		const result = parseToolCallArguments(raw);
		const invalid = getInvalidToolArguments(result);
		assert.ok(invalid);
		assert.strictEqual(invalid.raw, raw);
		assert.ok(invalid.reason.length > 0);
	});

	test('the marker cannot be mistaken for real arguments', () => {
		assert.strictEqual(getInvalidToolArguments({ path: 'a.ts' }), undefined);
		assert.strictEqual(getInvalidToolArguments({}), undefined);
		assert.strictEqual(getInvalidToolArguments(undefined), undefined);
	});

	test('the marker survives a round trip through serialization', () => {
		const result = JSON.parse(JSON.stringify(parseToolCallArguments('{oops')));
		assert.ok(getInvalidToolArguments(result));
	});

	test('the message tells the model what went wrong and what to do', () => {
		const invalid = getInvalidToolArguments(parseToolCallArguments('{"a": what?}'))!;
		const message = describeInvalidToolArguments('read_file', invalid);
		assert.ok(message.includes('read_file'));
		assert.ok(message.includes('{"a": what?}'));
		assert.ok(message.includes(invalid.reason));
	});

	test('quotes back only a bounded amount of the offending text', () => {
		const raw = `{"a":"${'x'.repeat(5000)}`;
		const invalid = getInvalidToolArguments(parseToolCallArguments(raw))!;
		const message = describeInvalidToolArguments('read_file', invalid);
		assert.ok(message.length < 2000, `message was ${message.length} characters`);
		assert.ok(message.includes('truncated'));
	});
});
