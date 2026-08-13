/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { IHackerCodeRevisionManifest, IHackerCodeState, orderHackerCodeRevisions, PRISTINE_REVISION_ID } from '../../../../platform/hackercode/common/hackerCode.js';
import { IQuickPickItem, QuickPickInput } from '../../../../platform/quickinput/common/quickInput.js';
import { IStatusbarEntry } from '../../../services/statusbar/browser/statusbar.js';
import { HACKERCODE_SELECT_REVISION_COMMAND_ID } from './hackerCodeVersionConstants.js';

const SHORT_REVISION_ID_LENGTH = 8;

export interface IHackerCodeRevisionQuickPickItem extends IQuickPickItem {
	readonly revisionId: string;
	readonly kind?: 'promote';
}

export function getShortHackerCodeRevisionId(revisionId: string): string {
	return revisionId.slice(0, SHORT_REVISION_ID_LENGTH);
}

export function createHackerCodeRevisionPicks(state: IHackerCodeState): QuickPickInput<IHackerCodeRevisionQuickPickItem>[] {
	const quarantinedById = new Map(state.quarantinedRevisions.map(quarantine => [quarantine.revisionId, quarantine]));
	const revisions = orderHackerCodeRevisions(state.revisions)
		.filter(revision => revision.id !== PRISTINE_REVISION_ID)
		.map(revision => {
			const quarantine = quarantinedById.get(revision.id);
			const isCurrent = revision.id === state.activeRevisionId;
			let detail: string | undefined;
			if (isCurrent && quarantine) {
				detail = localize('hackerCode.revision.currentQuarantined', "Current • Quarantined");
			} else if (isCurrent) {
				detail = localize('hackerCode.revision.current', "Current");
			} else if (quarantine) {
				detail = localize('hackerCode.revision.quarantined', "Quarantined");
			}

			const shortId = getShortHackerCodeRevisionId(revision.id);
			return {
				id: revision.id,
				revisionId: revision.id,
				label: quarantine ? `$(warning) ${shortId}` : shortId,
				ariaLabel: createRevisionAriaLabel(shortId, isCurrent, !!quarantine),
				description: getRevisionDescription(revision),
				detail,
				tooltip: quarantine?.reason
					? localize('hackerCode.revision.quarantinedReason', "Quarantined: {0}", quarantine.reason)
					: quarantine
						? localize('hackerCode.revision.quarantinedTooltip', "This revision is quarantined and cannot be selected.")
						: undefined,
				picked: isCurrent,
				pickable: !quarantine
			} satisfies IHackerCodeRevisionQuickPickItem;
		});

	const pristineIsCurrent = state.activeRevisionId === PRISTINE_REVISION_ID;
	const pristine: IHackerCodeRevisionQuickPickItem = {
		id: PRISTINE_REVISION_ID,
		revisionId: PRISTINE_REVISION_ID,
		label: localize('hackerCode.revision.pristineRecovery', "{0} Pristine", '$(shield)'),
		ariaLabel: pristineIsCurrent
			? localize('hackerCode.revision.pristineRecoveryCurrentAria', "Pristine recovery, current revision")
			: localize('hackerCode.revision.pristineRecoveryAria', "Pristine recovery"),
		description: localize('hackerCode.revision.pristineRecoveryDescription', "Source baseline, including promoted built-ins"),
		detail: pristineIsCurrent ? localize('hackerCode.revision.pristineCurrent', "Current") : undefined,
		picked: pristineIsCurrent
	};

	return [
		...revisions,
		{ type: 'separator', label: localize('hackerCode.revision.recoverySeparator', "Recovery") },
		pristine
	];
}

export function createHackerCodeStatusbarEntry(state: IHackerCodeState): IStatusbarEntry {
	const name = localize('hackerCode.status.name', "HackerCode Revision");
	if (state.activeRevisionId === PRISTINE_REVISION_ID) {
		const label = localize('hackerCode.status.pristineLabel', "Pristine");
		return {
			name,
			text: createStatusText(label),
			ariaLabel: localize('hackerCode.status.pristineAria', "HackerCode revision: Pristine"),
			tooltip: localize('hackerCode.status.pristineTooltip', "HackerCode is using the source baseline, including promoted built-ins. Select to change revision."),
			command: HACKERCODE_SELECT_REVISION_COMMAND_ID
		};
	}

	const shortId = getShortHackerCodeRevisionId(state.activeRevisionId);
	const isQuarantined = state.quarantinedRevisions.some(quarantine => quarantine.revisionId === state.activeRevisionId);
	const newestUsableRevision = orderHackerCodeRevisions(state.revisions).find(revision =>
		revision.id !== PRISTINE_REVISION_ID
		&& !state.quarantinedRevisions.some(quarantine => quarantine.revisionId === revision.id)
	);
	const isLatest = newestUsableRevision?.id === state.activeRevisionId;

	if (isQuarantined) {
		return {
			name,
			text: createStatusText(shortId),
			ariaLabel: localize('hackerCode.status.quarantinedAria', "HackerCode revision {0} is quarantined", shortId),
			tooltip: localize('hackerCode.status.quarantinedTooltip', "The active HackerCode revision {0} is quarantined. Select to recover.", shortId),
			command: HACKERCODE_SELECT_REVISION_COMMAND_ID,
			kind: 'warning'
		};
	}

	if (isLatest) {
		const label = localize('hackerCode.status.latestLabel', "latest");
		return {
			name,
			text: createStatusText(label),
			ariaLabel: localize('hackerCode.status.latestAria', "HackerCode revision: latest, {0}", shortId),
			tooltip: localize('hackerCode.status.latestTooltip', "HackerCode is using the latest revision ({0}). Select to change revision.", shortId),
			command: HACKERCODE_SELECT_REVISION_COMMAND_ID
		};
	}

	return {
		name,
		text: createStatusText(shortId),
		ariaLabel: localize('hackerCode.status.previousAria', "HackerCode revision: previous, {0}", shortId),
		tooltip: localize('hackerCode.status.previousTooltip', "HackerCode is using a previous revision ({0}). Select to change revision.", shortId),
		command: HACKERCODE_SELECT_REVISION_COMMAND_ID,
		kind: 'warning'
	};
}

function createStatusText(label: string): string {
	return localize('hackerCode.status.text', "{0} HackerCode: {1}", '$(versions)', label);
}

function getRevisionDescription(revision: IHackerCodeRevisionManifest): string {
	const description = revision.description?.trim();
	if (description) {
		return description;
	}

	const createdAt = new Date(revision.createdAt);
	return Number.isNaN(createdAt.getTime()) ? revision.createdAt : createdAt.toLocaleString();
}

function createRevisionAriaLabel(shortId: string, isCurrent: boolean, isQuarantined: boolean): string {
	if (isCurrent && isQuarantined) {
		return localize('hackerCode.revision.currentQuarantinedAria', "Revision {0}, current, quarantined", shortId);
	}
	if (isCurrent) {
		return localize('hackerCode.revision.currentAria', "Revision {0}, current", shortId);
	}
	if (isQuarantined) {
		return localize('hackerCode.revision.quarantinedAria', "Revision {0}, quarantined", shortId);
	}
	return localize('hackerCode.revision.aria', "Revision {0}", shortId);
}
