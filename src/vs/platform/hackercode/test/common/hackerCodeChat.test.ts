/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { normalizeChatBaseUrl } from '../../common/hackerCodeChat.js';

suite('normalizeChatBaseUrl', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('leaves an API root alone', () => {
		assert.strictEqual(normalizeChatBaseUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1');
	});

	test('trims trailing slashes and surrounding whitespace', () => {
		assert.strictEqual(normalizeChatBaseUrl('  https://api.openai.com/v1//  '), 'https://api.openai.com/v1');
	});

	test('accepts the full chat completions URL a provider documents', () => {
		assert.strictEqual(
			normalizeChatBaseUrl('https://openrouter.ai/api/v1/chat/completions'),
			'https://openrouter.ai/api/v1'
		);
	});

	test('accepts the other routes that get pasted by mistake', () => {
		assert.strictEqual(normalizeChatBaseUrl('http://127.0.0.1:8722/v1/models'), 'http://127.0.0.1:8722/v1');
		assert.strictEqual(normalizeChatBaseUrl('http://127.0.0.1:8722/v1/completions'), 'http://127.0.0.1:8722/v1');
	});

	test('only strips one route, so a path that merely contains one survives', () => {
		assert.strictEqual(normalizeChatBaseUrl('https://proxy.example/chat/completions/v1'), 'https://proxy.example/chat/completions/v1');
	});
});
