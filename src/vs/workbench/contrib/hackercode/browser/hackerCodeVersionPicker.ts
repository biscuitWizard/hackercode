/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getErrorMessage } from '../../../../base/common/errors.js';
import * as nls from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IHackerCodeControlService, PRISTINE_REVISION_ID } from '../../../../platform/hackercode/common/hackerCode.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { HACKERCODE_SELECT_REVISION_COMMAND_ID } from './hackerCodeVersionConstants.js';
import { createHackerCodeRevisionPicks, IHackerCodeRevisionQuickPickItem } from './hackerCodeVersionModel.js';

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: HACKERCODE_SELECT_REVISION_COMMAND_ID,
			title: nls.localize2('hackerCode.selectRevision', "Select Revision..."),
			category: nls.localize2('hackerCode.category', "HackerCode"),
			f1: true
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const controlService = accessor.get(IHackerCodeControlService);
		const dialogService = accessor.get(IDialogService);
		const logService = accessor.get(ILogService);
		const nativeHostService = accessor.get(INativeHostService);
		const notificationService = accessor.get(INotificationService);
		const quickInputService = accessor.get(IQuickInputService);

		let pick: IHackerCodeRevisionQuickPickItem | undefined;
		try {
			const state = await controlService.getState();
			const picks = createHackerCodeRevisionPicks(state);
			const activeIsPromotable = state.baseline.promotionAvailable
				&& state.activeRevisionId !== PRISTINE_REVISION_ID
				&& !state.quarantinedRevisions.some(quarantine => quarantine.revisionId === state.activeRevisionId);
			if (activeIsPromotable) {
				picks.unshift(
					{ type: 'separator', label: nls.localize('hackerCode.revision.actionsSeparator', "Actions") },
					{
						id: 'promote',
						kind: 'promote',
						revisionId: state.activeRevisionId,
						label: nls.localize('hackerCode.revision.promote', "{0} Promote Current Revision...", '$(git-commit)'),
						description: nls.localize('hackerCode.revision.promoteDescription', "Write built-in patch sources and create a git commit")
					}
				);
			}
			pick = await quickInputService.pick(picks, {
				title: nls.localize('hackerCode.selectRevision.title', "Select HackerCode Revision"),
				placeHolder: nls.localize('hackerCode.selectRevision.placeholder', "Select a revision to apply"),
				matchOnDescription: true,
				matchOnDetail: true
			});
		} catch (error) {
			logService.error('[HackerCode] Unable to open the revision picker.', error);
			notificationService.error(nls.localize(
				'hackerCode.selectRevision.openError',
				"Unable to open the HackerCode revision picker: {0}",
				getErrorMessage(error)
			));
			return;
		}

		if (!pick) {
			return;
		}

		try {
			if (pick.kind === 'promote') {
				const { confirmed } = await dialogService.confirm({
					type: 'warning',
					primaryButton: nls.localize('hackerCode.promote.confirmButton', "Promote and Commit"),
					message: nls.localize('hackerCode.promote.confirmMessage', "Promote the current HackerCode revision?"),
					detail: nls.localize(
						'hackerCode.promote.confirmDetail',
						"This writes the accepted patch modules into the source-controlled built-in promoted layer and creates a git commit containing only those files."
					)
				});
				if (!confirmed) {
					return;
				}
				const result = await controlService.promoteRevision({
					revisionId: pick.revisionId,
					windowId: nativeHostService.windowId
				});
				notificationService.info(nls.localize(
					'hackerCode.promote.success',
					"HackerCode revision {0} was promoted in commit {1}.",
					result.revisionId.slice(0, 8),
					result.newHead.slice(0, 8)
				));
				return;
			}
			await controlService.setRevision({ revisionId: pick.revisionId });
		} catch (error) {
			logService.error(`[HackerCode] Unable to process revision ${pick.revisionId}.`, error);
			notificationService.error(nls.localize(
				'hackerCode.selectRevision.actionError',
				"Unable to complete the HackerCode revision action: {0}",
				getErrorMessage(error)
			));
		}
	}
});
