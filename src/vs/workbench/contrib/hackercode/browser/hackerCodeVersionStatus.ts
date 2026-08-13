/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getErrorMessage } from '../../../../base/common/errors.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IHackerCodeControlService, IHackerCodeState } from '../../../../platform/hackercode/common/hackerCode.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { createHackerCodeStatusbarEntry } from './hackerCodeVersionModel.js';

class HackerCodeVersionStatusContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.hackerCodeVersionStatus';

	private static readonly STATUS_ENTRY_ID = 'status.hackerCodeRevision';

	private readonly statusbarEntry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private stateVersion = 0;

	constructor(
		@IHackerCodeControlService private readonly controlService: IHackerCodeControlService,
		@ILogService private readonly logService: ILogService,
		@IStatusbarService private readonly statusbarService: IStatusbarService,
	) {
		super();

		this._register(this.controlService.onDidChangeState(state => {
			this.stateVersion++;
			this.updateStatusbarEntry(state);
		}));

		void this.initialize();
	}

	private async initialize(): Promise<void> {
		const stateVersion = this.stateVersion;
		try {
			const state = await this.controlService.getState();
			if (stateVersion === this.stateVersion) {
				this.updateStatusbarEntry(state);
			}
		} catch (error) {
			this.logService.error(`[HackerCode] Unable to initialize the revision status: ${getErrorMessage(error)}`, error);
		}
	}

	private updateStatusbarEntry(state: IHackerCodeState): void {
		const entry = createHackerCodeStatusbarEntry(state);
		if (this.statusbarEntry.value) {
			this.statusbarEntry.value.update(entry);
		} else {
			this.statusbarEntry.value = this.statusbarService.addEntry(
				entry,
				HackerCodeVersionStatusContribution.STATUS_ENTRY_ID,
				StatusbarAlignment.RIGHT,
				99
			);
		}
	}
}

registerWorkbenchContribution2(
	HackerCodeVersionStatusContribution.ID,
	HackerCodeVersionStatusContribution,
	WorkbenchPhase.AfterRestored
);
