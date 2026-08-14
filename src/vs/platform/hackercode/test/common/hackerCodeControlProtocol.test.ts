/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { IJsonRpcRequest, JsonRpcError } from '../../../../base/common/jsonRpcProtocol.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import {
	HACKERCODE_CONTROL_MAX_EVAL_SOURCE_LENGTH,
	HackerCodeControlJsonRpcErrorCode,
	parseHackerCodeJsonRpcMessage,
	validateHackerCodeControlRequest
} from '../../common/hackerCodeControlProtocol.js';

suite('HackerCode control protocol', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses arbitrary JSON-RPC request method strings', () => {
		assert.deepStrictEqual(parseHackerCodeJsonRpcMessage({
			jsonrpc: '2.0',
			id: 7,
			method: 'future/controlMethod',
			params: { value: true }
		}), {
			kind: 'request',
			message: {
				jsonrpc: '2.0',
				id: 7,
				method: 'future/controlMethod',
				params: { value: true }
			}
		});
	});

	test('rejects malformed envelopes with a standard error', () => {
		assert.deepStrictEqual(parseHackerCodeJsonRpcMessage({
			jsonrpc: '1.0',
			id: 4,
			method: 'getState'
		}), {
			kind: 'invalid',
			response: {
				jsonrpc: '2.0',
				id: 4,
				error: {
					code: HackerCodeControlJsonRpcErrorCode.InvalidRequest,
					message: 'Invalid JSON-RPC 2.0 request'
				}
			}
		});
	});

	test('validates routing, eval bounds, and unknown methods', () => {
		const validRequest: IJsonRpcRequest = {
			jsonrpc: '2.0',
			id: 1,
			method: 'eval',
			params: { source: 'return 42;', windowId: 3 }
		};
		assert.deepStrictEqual(validateHackerCodeControlRequest(validRequest, 'main'), {
			source: 'return 42;',
			windowId: 3
		});

		// `assert.throws` with a validator callback is not portable across the
		// node and browser test shims, so assert on the caught code directly.
		function expectErrorCode(request: IJsonRpcRequest, target: 'main' | 'renderer', code: HackerCodeControlJsonRpcErrorCode): void {
			try {
				validateHackerCodeControlRequest(request, target);
			} catch (error) {
				assert.strictEqual((error as JsonRpcError).code, code);
				return;
			}
			assert.fail(`Expected ${request.method} to be rejected with code ${code}`);
		}

		expectErrorCode({
			...validRequest,
			params: { source: 'x'.repeat(HACKERCODE_CONTROL_MAX_EVAL_SOURCE_LENGTH + 1) }
		}, 'main', HackerCodeControlJsonRpcErrorCode.InvalidParams);

		expectErrorCode({
			...validRequest,
			method: 'getState'
		}, 'renderer', HackerCodeControlJsonRpcErrorCode.MethodNotFound);

		expectErrorCode({
			...validRequest,
			method: 'reload',
			params: { revisionId: 'pristine' }
		}, 'main', HackerCodeControlJsonRpcErrorCode.InvalidParams);

		assert.deepStrictEqual(validateHackerCodeControlRequest({
			...validRequest,
			method: 'promote',
			params: { revisionId: 'a'.repeat(64), windowId: 7, commitMessage: 'Promote patch' }
		}, 'main'), {
			revisionId: 'a'.repeat(64),
			windowId: 7,
			commitMessage: 'Promote patch'
		});
	});
});
