/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event, Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IHackerCodeControlService, IHackerCodePatchDescriptor, IHackerCodeRevisionManifest, IHackerCodeState } from '../../../../../platform/hackercode/common/hackerCode.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { HackerCodeModuleLoader, HackerCodePatchModuleCompiler, HackerCodeRevisionLoader, getHackerCodePatchFactory, IHackerCodePatchModuleCompiler, validateHackerCodeModuleSpecifier } from '../../browser/hackerCodeRevisionLoader.js';
import { IHackerCodePreparedPatch } from '../../browser/hackerCodePatchRegistry.js';

const REVISION_ID = 'a'.repeat(64);
const PATCH_HASH = 'b'.repeat(64);
const PATCH_DESCRIPTOR: IHackerCodePatchDescriptor = {
	name: 'test patch',
	fileName: 'patch-0000.txt',
	sha256: PATCH_HASH,
	size: 32
};
const REVISION: IHackerCodeRevisionManifest = {
	schemaVersion: 1,
	id: REVISION_ID,
	baseline: 'test',
	createdAt: '2026-08-13T00:00:00.000Z',
	parentId: 'pristine',
	patches: [PATCH_DESCRIPTOR]
};
const STATE: IHackerCodeState = {
	schemaVersion: 1,
	activeRevisionId: REVISION_ID,
	lastKnownGoodRevisionId: 'pristine',
	revisions: [REVISION],
	quarantinedRevisions: [],
	baseline: { current: 'test', promotionAvailable: true }
};

function getThrownMessage(fn: () => void): string {
	try {
		fn();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error('Expected function to throw');
}

suite('HackerCodeRevisionLoader', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('validates module specifiers and protects control-plane modules', () => {
		assert.deepStrictEqual({
			valid: validateHackerCodeModuleSpecifier('vs/editor/common/core/range.js'),
			invalid: [
				'https://example.com/module.js',
				'/vs/editor/common/core/range.js',
				'vs/editor/../platform/service.js',
				'vs/editor/common/core/range.ts',
				'vs/editor/common/core/range.js?fresh=1',
				'vs/editor/common/core/range.js#fragment',
				'vs\\editor\\common\\core\\range.js'
			].map(specifier => getThrownMessage(() => validateHackerCodeModuleSpecifier(specifier))),
			protected: [
				'vs/platform/hackercode/common/hackerCode.js',
				'vs/workbench/contrib/HackerCode/browser/hackerCodePatchRegistry.js',
				'vs/workbench/contrib/HackerCodeAgent/browser/hackerCodeAgentTransport.js'
			].map(specifier => getThrownMessage(() => validateHackerCodeModuleSpecifier(specifier)))
		}, {
			valid: 'vs/editor/common/core/range.js',
			invalid: [
				'Invalid HackerCode module specifier: https://example.com/module.js',
				'Invalid HackerCode module specifier: /vs/editor/common/core/range.js',
				'Invalid HackerCode module specifier: vs/editor/../platform/service.js',
				'Invalid HackerCode module specifier: vs/editor/common/core/range.ts',
				'Invalid HackerCode module specifier: vs/editor/common/core/range.js?fresh=1',
				'Invalid HackerCode module specifier: vs/editor/common/core/range.js#fragment',
				'Invalid HackerCode module specifier: vs\\editor\\common\\core\\range.js'
			],
			protected: [
				'HackerCode cannot import protected control-plane module: vs/platform/hackercode/common/hackerCode.js',
				'HackerCode cannot import protected control-plane module: vs/workbench/contrib/HackerCode/browser/hackerCodePatchRegistry.js',
				'HackerCode cannot import protected control-plane module: vs/workbench/contrib/HackerCodeAgent/browser/hackerCodeAgentTransport.js'
			]
		});
	});

	test('requires a default patch factory', () => {
		const factory = () => undefined;
		assert.strictEqual(getHackerCodePatchFactory({ default: factory }), factory);
		assert.throws(() => getHackerCodePatchFactory({ default: {} }), /must export a patch factory as default/);
		assert.throws(() => getHackerCodePatchFactory({}), /must export a patch factory as default/);
	});

	test('evaluates patch modules and always revokes their object URL', async () => {
		let evaluatedSource = '';
		const revoked: string[] = [];
		const factory = () => undefined;
		const compiler = new HackerCodePatchModuleCompiler({
			createObjectURL: source => {
				evaluatedSource = source;
				return 'blob:test-patch';
			},
			revokeObjectURL: url => revoked.push(url),
			importModule: async url => {
				assert.strictEqual(url, 'blob:test-patch');
				return { default: factory };
			}
		});

		const patch = await compiler.compile(REVISION, PATCH_DESCRIPTOR, {
			name: PATCH_DESCRIPTOR.name,
			content: 'export default () => undefined;'
		});

		assert.deepStrictEqual({
			id: patch.id,
			name: patch.name,
			key: patch.key,
			factory: patch.factory,
			hasSourceName: evaluatedSource.includes('//# sourceURL=hackercode-patch-'),
			revoked
		}, {
			id: `${REVISION_ID}:patch-0000.txt:test patch:${PATCH_HASH}`,
			name: 'test patch',
			key: PATCH_HASH,
			factory,
			hasSourceName: true,
			revoked: ['blob:test-patch']
		});
	});

	test('caches imports and refreshes tracked module prototypes', async () => {
		const importUrls: string[] = [];
		const oldExports = { TestExport: class OldExport { } };
		const newExports = { TestExport: class NewExport { } };
		let appliedExports: Record<string, unknown> | undefined;
		const moduleLoader = new HackerCodeModuleLoader(
			async url => {
				importUrls.push(url);
				return importUrls.length === 1 ? oldExports : newExports;
			},
			'vscode-file://vscode-app/out/',
			args => {
				assert.deepStrictEqual(args, {
					oldExports,
					newSrc: '',
					config: { mode: 'patch-prototype' }
				});
				return exports => {
					appliedExports = exports;
					return true;
				};
			}
		);

		const first = await moduleLoader.import('vs/editor/common/core/range.js');
		const second = await moduleLoader.import('vs/editor/common/core/range.js');
		await moduleLoader.refresh('vs/editor/common/core/range.js');

		assert.deepStrictEqual({
			sameNamespace: first === second,
			importUrls: [
				importUrls[0],
				importUrls[1].replace(/\d+-1$/, '<cache>')
			],
			appliedExports
		}, {
			sameNamespace: true,
			importUrls: [
				'vscode-file://vscode-app/out/vs/editor/common/core/range.js',
				'vscode-file://vscode-app/out/vs/editor/common/core/range.js?hackercodeRefresh=<cache>'
			],
			appliedExports: newExports
		});
		await assert.rejects(moduleLoader.refresh('vs/editor/common/core/position.js'), /cannot refresh untracked module/);
	});

	test('soft reload forces source evaluation and revision reapplication', async () => {
		const stateEmitter = store.add(new Emitter<IHackerCodeState>());
		let sourceReads = 0;
		let compilations = 0;
		let preparations = 0;
		let reverts = 0;
		const controlService = upcastPartial<IHackerCodeControlService>({
			_serviceBrand: undefined,
			onDidChangeState: stateEmitter.event,
			getState: async () => STATE,
			getPromotedManifest: async () => ({ schemaVersion: 1, layers: [] }),
			readPatchSources: async () => {
				sourceReads++;
				return [{ name: PATCH_DESCRIPTOR.name, content: 'export default () => undefined;' }];
			}
		});
		const compiler: IHackerCodePatchModuleCompiler = {
			compile: async () => {
				compilations++;
				return {
					id: 'test',
					name: 'test',
					key: PATCH_HASH,
					factory: () => undefined
				};
			}
		};
		const patchRegistry = {
			async prepareRevision(_revisionId: string, patches: PromiseLike<readonly IHackerCodePreparedPatch[]>): Promise<void> {
				await patches;
				preparations++;
			},
			async revertAll(): Promise<void> {
				reverts++;
			}
		};
		const loader = store.add(new HackerCodeRevisionLoader({
			controlService,
			patchRegistry,
			compiler,
			logService: store.add(new NullLogService())
		}));

		await loader.whenInitialized();
		await loader.softReload();

		assert.deepStrictEqual({
			sourceReads,
			compilations,
			preparations,
			reverts
		}, {
			sourceReads: 2,
			compilations: 2,
			preparations: 2,
			reverts: 1
		});
	});

	test('loads promoted layers before the active overlay', async () => {
		const promotedRevisionId = 'c'.repeat(64);
		const promotedHash = 'd'.repeat(64);
		const compiledRevisionIds: string[] = [];
		let preparedPatchIds: readonly string[] = [];
		const controlService = upcastPartial<IHackerCodeControlService>({
			_serviceBrand: undefined,
			onDidChangeState: Event.None,
			getState: async () => STATE,
			getPromotedManifest: async () => ({
				schemaVersion: 1,
				layers: [{
					id: promotedRevisionId,
					baseline: 'e'.repeat(40),
					promotedAt: '2026-08-13T00:00:00.000Z',
					patches: [{
						name: 'promoted patch',
						fileName: `${promotedHash}.js`,
						sha256: promotedHash,
						size: 1
					}]
				}]
			}),
			readPromotedPatchSources: async () => [{ name: 'promoted patch', content: 'p' }],
			readPatchSources: async () => [{ name: PATCH_DESCRIPTOR.name, content: 'o' }]
		});
		const loader = store.add(new HackerCodeRevisionLoader({
			controlService,
			patchRegistry: {
				async prepareRevision(_revisionId: string, patches: PromiseLike<readonly IHackerCodePreparedPatch[]>): Promise<void> {
					preparedPatchIds = (await patches).map(patch => patch.id);
				},
				revertAll: async () => undefined
			},
			compiler: {
				compile: async revision => {
					compiledRevisionIds.push(revision.id);
					return {
						id: revision.id,
						name: revision.id,
						factory: () => undefined
					};
				}
			},
			logService: store.add(new NullLogService())
		}));

		await loader.whenInitialized();

		assert.deepStrictEqual({
			compiledRevisionIds,
			preparedPatchIds
		}, {
			compiledRevisionIds: [promotedRevisionId, REVISION_ID],
			preparedPatchIds: [promotedRevisionId, REVISION_ID]
		});
	});

	test('state event is disposable', () => {
		const controlService = upcastPartial<IHackerCodeControlService>({
			_serviceBrand: undefined,
			onDidChangeState: Event.None,
			getState: async () => STATE,
			getPromotedManifest: async () => ({ schemaVersion: 1, layers: [] })
		});
		const loader = new HackerCodeRevisionLoader({
			controlService,
			patchRegistry: {
				prepareRevision: async () => undefined,
				revertAll: async () => undefined
			},
			compiler: {
				compile: async () => ({
					id: 'test',
					name: 'test',
					factory: () => undefined
				})
			},
			logService: store.add(new NullLogService())
		});
		loader.dispose();
	});
});
