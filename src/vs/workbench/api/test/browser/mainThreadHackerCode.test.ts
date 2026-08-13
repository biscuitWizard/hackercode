/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mock } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IHackerCodeRendererRefreshService } from '../../../../platform/hackercode/browser/hackerCodeRefresh.js';
import { IHackerCodeControlService, IHackerCodeCreateRevisionRequest, IHackerCodePromoteRequest, IHackerCodeRevisionManifest, IHackerCodeSafeModeRequest, IHackerCodeSetRevisionRequest, IHackerCodeState } from '../../../../platform/hackercode/common/hackerCode.js';
import { InstantiationService } from '../../../../platform/instantiation/common/instantiationService.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { nullExtensionDescription } from '../../../services/extensions/common/extensions.js';
import { MainThreadHackerCode } from '../../browser/mainThreadHackerCode.js';
import { ExtHostHackerCode } from '../../common/extHostHackerCode.js';
import { SingleProxyRPCProtocol } from '../common/testRPCProtocol.js';

suite('MainThreadHackerCode', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const revision: IHackerCodeRevisionManifest = {
		schemaVersion: 1,
		id: 'revision-1',
		baseline: 'baseline-1',
		createdAt: '2026-08-13T00:00:00.000Z',
		parentId: 'pristine',
		patches: []
	};
	const state: IHackerCodeState = {
		schemaVersion: 1,
		activeRevisionId: revision.id,
		lastKnownGoodRevisionId: 'pristine',
		revisions: [revision],
		quarantinedRevisions: [],
		baseline: {
			current: revision.baseline,
			promotionAvailable: true
		}
	};

	function createBridge(isBuilt = false): {
		readonly extHost: ExtHostHackerCode;
		readonly calls: {
			created: IHackerCodeCreateRevisionRequest[];
			selected: IHackerCodeSetRevisionRequest[];
			safeMode: IHackerCodeSafeModeRequest[];
			promoted: IHackerCodePromoteRequest[];
			refreshed: { mode: 'soft' | 'module' | 'hard'; specifier?: string }[];
		};
	} {
		const calls = {
			created: [] as IHackerCodeCreateRevisionRequest[],
			selected: [] as IHackerCodeSetRevisionRequest[],
			safeMode: [] as IHackerCodeSafeModeRequest[],
			promoted: [] as IHackerCodePromoteRequest[],
			refreshed: [] as { mode: 'soft' | 'module' | 'hard'; specifier?: string }[]
		};
		const controlService = new class extends mock<IHackerCodeControlService>() {
			override async getState(): Promise<IHackerCodeState> {
				return state;
			}
			override async listRevisions(): Promise<readonly IHackerCodeRevisionManifest[]> {
				return state.revisions;
			}
			override async getRevision(revisionId: string): Promise<IHackerCodeRevisionManifest | undefined> {
				return revisionId === revision.id ? revision : undefined;
			}
			override async createRevision(request: IHackerCodeCreateRevisionRequest): Promise<IHackerCodeRevisionManifest> {
				calls.created.push(request);
				return revision;
			}
			override async setRevision(request: IHackerCodeSetRevisionRequest): Promise<IHackerCodeState> {
				calls.selected.push(request);
				return state;
			}
			override async enterSafeMode(request: IHackerCodeSafeModeRequest): Promise<IHackerCodeState> {
				calls.safeMode.push(request);
				return state;
			}
			override async promoteRevision(request: IHackerCodePromoteRequest) {
				calls.promoted.push(request);
				return {
					revisionId: revision.id,
					previousHead: 'baseline-1',
					newHead: 'baseline-2',
					commitMessage: request.commitMessage ?? 'default'
				};
			}
		};
		const refreshService = new class extends mock<IHackerCodeRendererRefreshService>() {
			override async refresh(mode: 'soft' | 'module' | 'hard', specifier?: string): Promise<void> {
				calls.refreshed.push({ mode, specifier });
			}
		};
		const environmentService = new class extends mock<IEnvironmentService>() {
			override readonly isBuilt = isBuilt;
		};
		const nativeHostService = new class extends mock<INativeHostService>() {
			override readonly windowId = 17;
		};
		const instantiationService = store.add(new InstantiationService());
		const mainThread = store.add(new MainThreadHackerCode(
			SingleProxyRPCProtocol(null),
			controlService,
			refreshService,
			environmentService,
			nativeHostService,
			instantiationService
		));
		return {
			extHost: new ExtHostHackerCode(SingleProxyRPCProtocol(mainThread)),
			calls
		};
	}

	test('bridges revision operations with the current renderer window', async () => {
		const { extHost, calls } = createBridge();
		const createRequest = {
			baseline: revision.baseline,
			description: 'test revision',
			patches: [{ name: 'test', content: 'patch' }]
		};

		const result = await Promise.all([
			extHost.getState(nullExtensionDescription),
			extHost.listRevisions(nullExtensionDescription),
			extHost.getRevision(nullExtensionDescription, revision.id),
			extHost.createRevision(nullExtensionDescription, createRequest),
			extHost.selectRevision(nullExtensionDescription, revision.id),
			extHost.enterSafeMode(nullExtensionDescription, 'test recovery'),
			extHost.promoteActiveRevision(nullExtensionDescription, 'promote test')
		]);

		assert.deepStrictEqual({
			result,
			created: calls.created,
			selected: calls.selected,
			safeMode: calls.safeMode,
			promoted: calls.promoted
		}, {
			result: [
				state,
				state.revisions,
				revision,
				revision,
				state,
				state,
				{
					revisionId: revision.id,
					previousHead: 'baseline-1',
					newHead: 'baseline-2',
					commitMessage: 'promote test'
				}
			],
			created: [createRequest],
			selected: [{ revisionId: revision.id, windowId: 17 }],
			safeMode: [{ reason: 'test recovery', windowId: 17 }],
			promoted: [{ revisionId: revision.id, windowId: 17, commitMessage: 'promote test' }]
		});
	});

	test('serializes renderer evaluation and routes refresh modes', async () => {
		const { extHost, calls } = createBridge();

		const evaluated = await extHost.evaluate(nullExtensionDescription, 'return { ok: true, missing: undefined };');
		await extHost.refresh(nullExtensionDescription, 'soft');
		await extHost.refresh(nullExtensionDescription, 'module', 'vs/workbench/testModule');
		await extHost.refresh(nullExtensionDescription, 'hard');

		assert.deepStrictEqual({
			evaluated: toPlainJson(evaluated),
			refreshed: calls.refreshed
		}, {
			evaluated: { ok: true, missing: '[undefined]' },
			refreshed: [
				{ mode: 'soft', specifier: undefined },
				{ mode: 'module', specifier: 'vs/workbench/testModule' },
				{ mode: 'hard', specifier: undefined }
			]
		});
	});

	test('rejects calls when HackerCode control mode is disabled', async () => {
		const { extHost } = createBridge(true);

		await assert.rejects(
			async () => extHost.getState(nullExtensionDescription),
			/HackerCode control mode is not enabled/
		);
	});
});

function toPlainJson(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value));
}
