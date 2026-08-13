/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { executeHackerCodeControlEval, IHackerCodeAsyncFunctionConstructor } from '../../browser/hackerCodeControlEval.js';
import { IHackerCodeRuntime } from '../../browser/hackerCodeRuntime.js';
import { serializeHackerCodeControlValue } from '../../browser/hackerCodeControlSerializer.js';

suite('HackerCode control serializer', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('marks circular values without invoking getters', () => {
		let getterCalls = 0;
		const value: { self?: object; readonly dangerous?: string } = {};
		value.self = value;
		Object.defineProperty(value, 'dangerous', {
			enumerable: true,
			get: () => {
				getterCalls++;
				return 'secret';
			}
		});

		const serialized = toPlainJson(serializeHackerCodeControlValue(value));
		assert.deepStrictEqual({
			serialized,
			getterCalls
		}, {
			serialized: {
				self: '[Circular]',
				dangerous: '[Getter]'
			},
			getterCalls: 0
		});
	});

	test('limits traversal depth, breadth, and serialized bytes', () => {
		const value = {
			deep: { child: { value: true } },
			first: 1,
			second: 2
		};

		assert.deepStrictEqual(toPlainJson(serializeHackerCodeControlValue(value, {
			maxDepth: 2,
			maxBreadth: 2
		})), {
			deep: {
				child: '[Truncated: Object]'
			},
			first: 1,
			$truncated: '1 more properties'
		});
		assert.strictEqual(
			serializeHackerCodeControlValue('x'.repeat(1_000), { maxBytes: 100 }),
			'[Truncated: serialized result exceeded 100 bytes]'
		);
	});

	test('summarizes non-plain instances', () => {
		class WorkbenchThing {
			readonly value = 42;
		}

		assert.deepStrictEqual(serializeHackerCodeControlValue(new WorkbenchThing()), {
			$type: 'WorkbenchThing'
		});
	});
});

suite('HackerCode control eval', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('provides named privileged bindings through an injected AsyncFunction', async () => {
		let parameterNames: readonly string[] = [];
		let invocationArguments: readonly unknown[] = [];
		class Placeholder { }
		const AsyncFunctionConstructor = new Proxy(Placeholder, {
			construct: (_target, parameters) => {
				parameterNames = parameters as string[];
				return async (...args: unknown[]) => {
					invocationArguments = args;
					return { ok: true };
				};
			}
		}) as unknown as IHackerCodeAsyncFunctionConstructor;
		const instantiationService = { marker: 'instantiation' };
		const runtime = {
			instantiationService,
			getService: (name: string) => ({ name }),
			refresh: async () => undefined
		} as unknown as IHackerCodeRuntime;

		const result = await executeHackerCodeControlEval('return { ok: true };', runtime, AsyncFunctionConstructor);
		const scope = invocationArguments[0] as {
			readonly runtime: IHackerCodeRuntime;
			readonly instantiationService: object;
		};

		assert.deepStrictEqual({
			evaluatorSource: parameterNames[0],
			invocationBindingCount: invocationArguments.length,
			runtimeBinding: scope.runtime,
			instantiationBinding: scope.instantiationService,
			result: toPlainJson(result)
		}, {
			evaluatorSource: [
				'"use strict";',
				'const { runtime, instantiationService, getService, refresh } = arguments[0];',
				'return { ok: true };'
			].join('\n'),
			invocationBindingCount: 1,
			runtimeBinding: runtime,
			instantiationBinding: instantiationService,
			result: { ok: true }
		});
	});
});

function toPlainJson(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value));
}
