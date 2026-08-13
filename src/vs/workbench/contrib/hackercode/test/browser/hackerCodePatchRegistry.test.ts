/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IHackerCodeModuleLoaderService } from '../../../../../platform/hackercode/browser/hackerCodeRefresh.js';
import { IHackerCodeControlService } from '../../../../../platform/hackercode/common/hackerCode.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IStatusbarService } from '../../../../services/statusbar/browser/statusbar.js';
import { HackerCodePatchRegistry, IHackerCodePreparedPatch } from '../../browser/hackerCodePatchRegistry.js';

suite('HackerCodePatchRegistry', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createRegistry(moduleLoaderService: IHackerCodeModuleLoaderService = upcastPartial<IHackerCodeModuleLoaderService>({
		_serviceBrand: undefined
	})): HackerCodePatchRegistry {
		const instantiationService = store.add(new TestInstantiationService());
		const statusbarService = upcastPartial<IStatusbarService>({
			_serviceBrand: undefined
		});
		const controlService = upcastPartial<IHackerCodeControlService>({
			_serviceBrand: undefined
		});
		const logService = store.add(new NullLogService());
		return store.add(new HackerCodePatchRegistry(instantiationService, statusbarService, moduleLoaderService, controlService, logService));
	}

	test('restores accessors and missing properties exactly', async () => {
		const registry = createRegistry();
		let accessorValue = 1;
		const target: Record<string, number> = {};
		Object.defineProperty(target, 'accessor', {
			get: () => accessorValue,
			set: (value: number) => accessorValue = value,
			configurable: true,
			enumerable: false
		});
		const originalAccessor = Object.getOwnPropertyDescriptor(target, 'accessor');

		await registry.applySet([{
			id: 'descriptors',
			name: 'Descriptors',
			factory: context => {
				context.defineProperty(target, 'accessor', {
					value: 7,
					configurable: true,
					enumerable: true,
					writable: false
				});
				context.defineProperty(target, 'missing', {
					value: 9,
					configurable: true,
					enumerable: false,
					writable: true
				});
			}
		}]);

		await registry.revertAll();

		assert.deepStrictEqual({
			accessor: Object.getOwnPropertyDescriptor(target, 'accessor'),
			missing: Object.getOwnPropertyDescriptor(target, 'missing'),
			value: target.accessor
		}, {
			accessor: originalAccessor,
			missing: undefined,
			value: 1
		});
	});

	test('reverts tracked disposables in LIFO order', async () => {
		const registry = createRegistry();
		const disposalOrder: string[] = [];

		await registry.applySet([{
			id: 'disposables',
			name: 'Disposables',
			factory: context => {
				context.track(toDisposable(() => disposalOrder.push('first')));
				context.track(toDisposable(() => disposalOrder.push('second')));
			}
		}]);
		await registry.revertAll();

		assert.deepStrictEqual(disposalOrder, ['second', 'first']);
	});

	test('delegates guarded module imports through the patch context', async () => {
		const namespace = { value: 42 };
		const importedSpecifiers: string[] = [];
		const registry = createRegistry(upcastPartial<IHackerCodeModuleLoaderService>({
			_serviceBrand: undefined,
			import: async specifier => {
				importedSpecifiers.push(specifier);
				return namespace;
			}
		}));
		let imported: object | undefined;

		await registry.applySet([{
			id: 'module-import',
			name: 'Module import',
			factory: async context => {
				imported = await context.import('vs/editor/common/core/range.js');
			}
		}]);

		assert.deepStrictEqual({
			importedSpecifiers,
			imported
		}, {
			importedSpecifiers: ['vs/editor/common/core/range.js'],
			imported: namespace
		});
		await registry.revertAll();
	});

	test('patchMethod preserves and restores the full descriptor', async () => {
		const registry = createRegistry();
		const target = {
			method(value: number): number {
				return value + 1;
			}
		};
		Object.defineProperty(target, 'method', {
			...Object.getOwnPropertyDescriptor(target, 'method'),
			enumerable: false
		});
		const originalDescriptor = Object.getOwnPropertyDescriptor(target, 'method');

		await registry.applySet([{
			id: 'method',
			name: 'Method',
			factory: context => context.patchMethod(target, 'method', original => value => original(value) * 2)
		}]);
		const patchedDescriptor = Object.getOwnPropertyDescriptor(target, 'method');
		const patchedValue = target.method(2);
		await registry.revertAll();

		assert.deepStrictEqual({
			patchedAttributes: {
				configurable: patchedDescriptor?.configurable,
				enumerable: patchedDescriptor?.enumerable,
				writable: patchedDescriptor?.writable
			},
			patchedValue,
			restoredDescriptor: Object.getOwnPropertyDescriptor(target, 'method'),
			restoredValue: target.method(2)
		}, {
			patchedAttributes: {
				configurable: originalDescriptor?.configurable,
				enumerable: originalDescriptor?.enumerable,
				writable: originalDescriptor?.writable
			},
			patchedValue: 6,
			restoredDescriptor: originalDescriptor,
			restoredValue: 3
		});
	});

	test('rolls back a failed patch immediately', async () => {
		const registry = createRegistry();
		const target = { value: 'original' };

		await assert.rejects(registry.applySet([{
			id: 'failure',
			name: 'Failure',
			factory: context => {
				context.defineProperty(target, 'value', { value: 'patched' });
				throw new Error('factory failure');
			}
		}]), /factory failure/);

		assert.deepStrictEqual({
			value: target.value,
			applied: registry.getAppliedPatches().length
		}, {
			value: 'original',
			applied: 0
		});
	});

	test('does not reapply an identical ordered set', async () => {
		const registry = createRegistry();
		let applications = 0;
		const patch: IHackerCodePreparedPatch = {
			id: 'stable',
			name: 'Stable',
			key: 'one',
			factory: () => {
				applications++;
			}
		};

		await registry.applySet([patch]);
		await registry.applySet([patch]);

		assert.strictEqual(applications, 1);
		await registry.revertAll();
	});

	test('reapplies a patch when its key changes', async () => {
		const registry = createRegistry();
		const target = { value: 0 };
		let applications = 0;

		function patch(key: string, value: number): IHackerCodePreparedPatch {
			return {
				id: 'versioned',
				name: 'Versioned',
				key,
				factory: context => {
					applications++;
					context.defineProperty(target, 'value', { value });
				}
			};
		}

		await registry.applySet([patch('one', 1)]);
		await registry.applySet([patch('two', 2)]);

		assert.deepStrictEqual({
			value: target.value,
			applications
		}, {
			value: 2,
			applications: 2
		});
		await registry.revertAll();
	});

	test('restores the previous set after failed convergence', async () => {
		const registry = createRegistry();
		const target = { value: 'original' };
		let previousApplications = 0;
		const previous: IHackerCodePreparedPatch = {
			id: 'previous',
			name: 'Previous',
			key: 'one',
			factory: context => {
				previousApplications++;
				context.defineProperty(target, 'value', { value: 'previous' });
			}
		};

		await registry.applySet([previous]);
		await assert.rejects(registry.applySet([{
			id: 'target',
			name: 'Target',
			key: 'one',
			factory: context => {
				context.defineProperty(target, 'value', { value: 'target' });
				throw new Error('target failure');
			}
		}]), /previous set was restored/);

		assert.deepStrictEqual({
			value: target.value,
			previousApplications,
			appliedIds: registry.getAppliedPatches().map(patch => patch.id)
		}, {
			value: 'previous',
			previousApplications: 2,
			appliedIds: ['previous']
		});
		await registry.revertAll();
	});
});
