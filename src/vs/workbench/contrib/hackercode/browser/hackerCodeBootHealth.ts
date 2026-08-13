/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { disposableWindowInterval, scheduleAtNextAnimationFrame } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { getErrorMessage } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IHackerCodeBootRequest, IHackerCodeControlService, PRISTINE_REVISION_ID } from '../../../../platform/hackercode/common/hackerCode.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IHackerCodePatchRegistry } from './hackerCodePatchRegistry.js';

const HEARTBEAT_INTERVAL = 2_000;

export class HackerCodeBootHealthContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.hackerCodeBootHealth';

	private readonly bootDisposables = this._register(new DisposableStore());
	private heartbeatPromise: Promise<void> | undefined;
	private failureHandled = false;
	private bootCompleted = false;
	private skipPromoted = false;

	constructor(
		@IHackerCodeControlService private readonly controlService: IHackerCodeControlService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@IHackerCodePatchRegistry private readonly patchRegistry: IHackerCodePatchRegistry,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		void this.initialize();
	}

	private async initialize(): Promise<void> {
		let revisionId: string | undefined;
		try {
			const state = await this.controlService.getState();
			if (this._store.isDisposed) {
				return;
			}

			revisionId = state.activeRevisionId;
			this.skipPromoted = state.skipPromoted === true;
			const request: IHackerCodeBootRequest = {
				revisionId: state.activeRevisionId,
				windowId: this.nativeHostService.windowId
			};
			await this.controlService.beginBoot(request);
			if (this._store.isDisposed) {
				return;
			}

			// AfterRestored contributions run on idle, so establish liveness before waiting for readiness.
			await this.controlService.heartbeat(request);
			if (this._store.isDisposed) {
				return;
			}
			this.bootDisposables.add(disposableWindowInterval(mainWindow, () => this.sendHeartbeat(request), HEARTBEAT_INTERVAL));

			await Promise.all([
				this.patchRegistry.whenRevisionReady(state.activeRevisionId),
				this.waitForAnimationFrame()
			]);
			if (this._store.isDisposed || this.failureHandled) {
				return;
			}

			this.bootDisposables.clear();
			await this.heartbeatPromise;
			if (this._store.isDisposed || this.failureHandled) {
				return;
			}

			await this.controlService.completeBoot(request);
			this.bootCompleted = true;
		} catch (error) {
			await this.handleBootError(error, revisionId);
		}
	}

	private waitForAnimationFrame(): Promise<void> {
		return new Promise(resolve => {
			this.bootDisposables.add(scheduleAtNextAnimationFrame(mainWindow, resolve));
		});
	}

	private sendHeartbeat(request: IHackerCodeBootRequest): void {
		if (this._store.isDisposed || this.failureHandled || this.bootCompleted || this.heartbeatPromise) {
			return;
		}

		let heartbeatPromise: Promise<void>;
		try {
			heartbeatPromise = this.controlService.heartbeat(request);
		} catch (error) {
			void this.handleBootError(error, request.revisionId);
			return;
		}
		this.heartbeatPromise = heartbeatPromise;
		void heartbeatPromise
			.catch(error => this.handleBootError(error, request.revisionId))
			.finally(() => {
				if (this.heartbeatPromise === heartbeatPromise) {
					this.heartbeatPromise = undefined;
				}
			});
	}

	private async handleBootError(error: unknown, revisionId: string | undefined): Promise<void> {
		if (this._store.isDisposed || this.failureHandled || this.bootCompleted) {
			return;
		}

		this.failureHandled = true;
		this.bootDisposables.clear();
		this.logService.error(`[HackerCode] Renderer boot health failed: ${getErrorMessage(error)}`, error);

		// Absolute pristine already skips promoted patches. Re-entering safe mode
		// from that state would create a reload loop.
		if (!revisionId || (revisionId === PRISTINE_REVISION_ID && this.skipPromoted)) {
			return;
		}

		try {
			await this.controlService.enterSafeMode({
				reason: localize(
					'hackercode.rendererBootFailed',
					"The HackerCode renderer failed to complete boot: {0}",
					getErrorMessage(error)
				),
				windowId: this.nativeHostService.windowId
			});
		} catch (safeModeError) {
			this.logService.error('[HackerCode] Failed to enter safe mode after a renderer boot error.', safeModeError);
		}
	}
}

registerWorkbenchContribution2(
	HackerCodeBootHealthContribution.ID,
	HackerCodeBootHealthContribution,
	WorkbenchPhase.AfterRestored
);
