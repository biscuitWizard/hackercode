/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';
import { executeHackerCodeControlEval } from '../../../platform/hackercode/browser/hackerCodeControlEval.js';
import { HackerCodeSerializedValue } from '../../../platform/hackercode/browser/hackerCodeControlSerializer.js';
import { IHackerCodeRendererRefreshService } from '../../../platform/hackercode/browser/hackerCodeRefresh.js';
import { createHackerCodeRuntime, IHackerCodeRuntime, isHackerCodeRuntimeEnabled } from '../../../platform/hackercode/browser/hackerCodeRuntime.js';
import { IHackerCodeCreateRevisionRequest, IHackerCodeControlService, IHackerCodePromoteResult, IHackerCodeRevisionManifest, IHackerCodeState } from '../../../platform/hackercode/common/hackerCode.js';
import { HACKERCODE_CONTROL_MAX_EVAL_SOURCE_LENGTH } from '../../../platform/hackercode/common/hackerCodeControlProtocol.js';
import { IEnvironmentService } from '../../../platform/environment/common/environment.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { INativeHostService } from '../../../platform/native/common/native.js';
import { IExtHostContext, extHostNamedCustomer } from '../../services/extensions/common/extHostCustomers.js';
import { MainContext, MainThreadHackerCodeShape } from '../common/extHost.protocol.js';

type HackerCodeGlobal = typeof globalThis & {
	$hackercode?: IHackerCodeRuntime;
};

@extHostNamedCustomer(MainContext.MainThreadHackerCode)
export class MainThreadHackerCode extends Disposable implements MainThreadHackerCodeShape {

	constructor(
		_context: IExtHostContext,
		@IHackerCodeControlService private readonly controlService: IHackerCodeControlService,
		@IHackerCodeRendererRefreshService private readonly refreshService: IHackerCodeRendererRefreshService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
	}

	$getHackerCodeState(): Promise<IHackerCodeState> {
		this.assertEnabled();
		return this.controlService.getState();
	}

	$listHackerCodeRevisions(): Promise<readonly IHackerCodeRevisionManifest[]> {
		this.assertEnabled();
		return this.controlService.listRevisions();
	}

	$getHackerCodeRevision(revisionId: string): Promise<IHackerCodeRevisionManifest | undefined> {
		this.assertEnabled();
		return this.controlService.getRevision(revisionId);
	}

	$createHackerCodeRevision(request: IHackerCodeCreateRevisionRequest): Promise<IHackerCodeRevisionManifest> {
		this.assertEnabled();
		return this.controlService.createRevision(request);
	}

	$selectHackerCodeRevision(revisionId: string): Promise<IHackerCodeState> {
		this.assertEnabled();
		return this.controlService.setRevision({
			revisionId,
			windowId: this.nativeHostService.windowId
		});
	}

	$enterHackerCodeSafeMode(reason?: string): Promise<IHackerCodeState> {
		this.assertEnabled();
		return this.controlService.enterSafeMode({
			reason,
			windowId: this.nativeHostService.windowId
		});
	}

	$evaluateHackerCode(source: string): Promise<HackerCodeSerializedValue> {
		this.assertEnabled();
		if (source.length > HACKERCODE_CONTROL_MAX_EVAL_SOURCE_LENGTH) {
			throw new Error(localize(
				'hackerCode.extensionApi.evalSourceTooLarge',
				"HackerCode evaluation source exceeds the maximum length of {0} characters",
				HACKERCODE_CONTROL_MAX_EVAL_SOURCE_LENGTH
			));
		}
		const runtime = (globalThis as HackerCodeGlobal).$hackercode
			?? createHackerCodeRuntime(this.instantiationService);
		return executeHackerCodeControlEval(source, runtime);
	}

	$refreshHackerCode(mode: 'soft' | 'module' | 'hard', specifier?: string): Promise<void> {
		this.assertEnabled();
		if (mode === 'module') {
			if (!specifier) {
				throw new Error(localize(
					'hackerCode.extensionApi.moduleSpecifierRequired',
					"A module specifier is required for HackerCode module refresh"
				));
			}
			return this.refreshService.refresh(mode, specifier);
		}
		return this.refreshService.refresh(mode);
	}

	async $promoteActiveHackerCodeRevision(commitMessage?: string): Promise<IHackerCodePromoteResult> {
		this.assertEnabled();
		const state = await this.controlService.getState();
		return this.controlService.promoteRevision({
			revisionId: state.activeRevisionId,
			windowId: this.nativeHostService.windowId,
			commitMessage
		});
	}

	private assertEnabled(): void {
		if (!isHackerCodeRuntimeEnabled(this.environmentService)) {
			throw new Error(localize(
				'hackerCode.extensionApi.controlModeDisabled',
				"The HackerCode extension API is unavailable because HackerCode control mode is not enabled"
			));
		}
	}
}
