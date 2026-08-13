/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

/**
 * The stock source baseline, including source-controlled promoted patches.
 * Emergency safe mode uses `skipPromoted` for an absolute no-patch recovery.
 */
export const PRISTINE_REVISION_ID = 'pristine';

export const HACKERCODE_STORAGE_KEYS = {
	revisionLedger: 'hackercode.revisionLedger.v1'
} as const;

export interface IHackerCodePatchSource {
	readonly name: string;
	readonly content: string;
}

export interface IHackerCodePatchDescriptor {
	readonly name: string;
	readonly fileName: string;
	readonly sha256: string;
	readonly size: number;
}

export interface IHackerCodeRevisionManifest {
	readonly schemaVersion: 1;
	readonly id: string;
	readonly baseline: string;
	readonly createdAt: string;
	readonly description?: string;
	readonly parentId: string;
	readonly patches: readonly IHackerCodePatchDescriptor[];
}

export interface IHackerCodeQuarantinedRevision {
	readonly revisionId: string;
	readonly quarantinedAt: string;
	readonly reason?: string;
}

export interface IHackerCodeBootAttempt {
	readonly revisionId: string;
	readonly windowId?: number;
	readonly startedAt: string;
}

export interface IHackerCodeRevisionLedger {
	readonly schemaVersion: 1;
	readonly activeRevisionId: string;
	readonly lastKnownGoodRevisionId: string;
	readonly revisions: readonly IHackerCodeRevisionManifest[];
	readonly quarantinedRevisions: readonly IHackerCodeQuarantinedRevision[];
	readonly bootAttempt?: IHackerCodeBootAttempt;
	/**
	 * Emergency recovery mode. Normal pristine operation still includes
	 * source-controlled promoted patches.
	 */
	readonly skipPromoted?: boolean;
}

export interface IHackerCodeState extends IHackerCodeRevisionLedger {
	readonly baseline: IHackerCodeBaselineInfo;
}

export interface IHackerCodeBaselineInfo {
	readonly current: string | undefined;
	readonly promotionAvailable: boolean;
}

export interface IHackerCodePromotedLayer {
	readonly id: string;
	readonly baseline: string;
	readonly promotedAt: string;
	readonly patches: readonly IHackerCodePatchDescriptor[];
}

export interface IHackerCodePromotedManifest {
	readonly schemaVersion: 1;
	readonly layers: readonly IHackerCodePromotedLayer[];
}

export interface IHackerCodePromoteRequest {
	readonly revisionId: string;
	readonly windowId: number;
	readonly commitMessage?: string;
}

export interface IHackerCodePromoteResult {
	readonly revisionId: string;
	readonly previousHead: string;
	readonly newHead: string;
	readonly commitMessage: string;
}

export interface IHackerCodeCreateRevisionRequest {
	readonly baseline: string;
	readonly description?: string;
	readonly parentId?: string;
	readonly patches: readonly IHackerCodePatchSource[];
}

export interface IHackerCodeSetRevisionRequest {
	readonly revisionId: string;
	readonly windowId?: number;
	/**
	 * Recovery mode never activates an unknown or quarantined revision. Instead,
	 * it selects the current last-known-good revision, or pristine when needed.
	 */
	readonly mode?: 'normal' | 'recover';
}

export interface IHackerCodeReloadRevisionRequest {
	readonly revisionId: string;
	readonly windowId: number;
}

export interface IHackerCodeQuarantineRevisionRequest {
	readonly revisionId: string;
	readonly reason?: string;
}

export interface IHackerCodeBootRequest {
	readonly revisionId: string;
	readonly windowId: number;
}

export interface IHackerCodeSafeModeRequest {
	readonly reason?: string;
	readonly windowId?: number;
}

export interface IHackerCodeControlEndpoint {
	readonly protocol: 'ws' | 'wss';
	readonly host: string;
	readonly port: number;
	/**
	 * Root authority for the intentionally privileged control endpoint.
	 * Callers must neither log nor disclose this token.
	 */
	readonly authorizationToken: string;
	readonly pid: number;
}

export const IHackerCodeControlService = createDecorator<IHackerCodeControlService>('hackerCodeControlService');

export interface IHackerCodeControlService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeState: Event<IHackerCodeState>;

	getState(): Promise<IHackerCodeState>;
	listRevisions(): Promise<readonly IHackerCodeRevisionManifest[]>;
	getRevision(revisionId: string): Promise<IHackerCodeRevisionManifest | undefined>;
	createRevision(request: IHackerCodeCreateRevisionRequest): Promise<IHackerCodeRevisionManifest>;
	setRevision(request: IHackerCodeSetRevisionRequest): Promise<IHackerCodeState>;
	reloadRevision(request: IHackerCodeReloadRevisionRequest): Promise<IHackerCodeState>;
	promoteRevision(request: IHackerCodePromoteRequest): Promise<IHackerCodePromoteResult>;
	quarantineRevision(request: IHackerCodeQuarantineRevisionRequest): Promise<IHackerCodeState>;
	markRevisionHealthy(revisionId: string): Promise<IHackerCodeState>;
	beginBoot(request: IHackerCodeBootRequest): Promise<IHackerCodeState>;
	heartbeat(request: IHackerCodeBootRequest): Promise<void>;
	completeBoot(request: IHackerCodeBootRequest): Promise<IHackerCodeState>;
	enterSafeMode(request: IHackerCodeSafeModeRequest): Promise<IHackerCodeState>;
	readPatchSources(revisionId: string): Promise<readonly IHackerCodePatchSource[]>;
	getPromotedManifest(): Promise<IHackerCodePromotedManifest>;
	readPromotedPatchSources(layerId: string): Promise<readonly IHackerCodePatchSource[]>;
	getControlEndpoint(): Promise<IHackerCodeControlEndpoint | undefined>;
}

const PRISTINE_REVISION: IHackerCodeRevisionManifest = Object.freeze({
	schemaVersion: 1,
	id: PRISTINE_REVISION_ID,
	baseline: PRISTINE_REVISION_ID,
	createdAt: '1970-01-01T00:00:00.000Z',
	parentId: PRISTINE_REVISION_ID,
	patches: Object.freeze([])
});

export function getPristineHackerCodeRevision(): IHackerCodeRevisionManifest {
	return PRISTINE_REVISION;
}

export function createHackerCodeRevisionLedger(): IHackerCodeRevisionLedger {
	return {
		schemaVersion: 1,
		activeRevisionId: PRISTINE_REVISION_ID,
		lastKnownGoodRevisionId: PRISTINE_REVISION_ID,
		revisions: [PRISTINE_REVISION],
		quarantinedRevisions: [],
		bootAttempt: undefined,
		skipPromoted: false
	};
}

export function orderHackerCodeRevisions(revisions: readonly IHackerCodeRevisionManifest[]): readonly IHackerCodeRevisionManifest[] {
	return [...revisions].sort((first, second) => {
		if (first.id === PRISTINE_REVISION_ID && second.id === PRISTINE_REVISION_ID) {
			return 0;
		}
		if (first.id === PRISTINE_REVISION_ID) {
			return 1;
		}
		if (second.id === PRISTINE_REVISION_ID) {
			return -1;
		}

		const createdAtComparison = second.createdAt.localeCompare(first.createdAt);
		return createdAtComparison || first.id.localeCompare(second.id);
	});
}

export function normalizeHackerCodeRevisionLedger(ledger: IHackerCodeRevisionLedger | undefined): IHackerCodeRevisionLedger {
	if (!ledger || ledger.schemaVersion !== 1) {
		return createHackerCodeRevisionLedger();
	}

	const revisionsById = new Map<string, IHackerCodeRevisionManifest>();
	for (const revision of ledger.revisions) {
		if (revision.id !== PRISTINE_REVISION_ID && !revisionsById.has(revision.id)) {
			revisionsById.set(revision.id, revision);
		}
	}
	revisionsById.set(PRISTINE_REVISION_ID, PRISTINE_REVISION);

	const quarantinedRevisionIds = new Set<string>();
	const quarantinedRevisions: IHackerCodeQuarantinedRevision[] = [];
	for (const quarantine of ledger.quarantinedRevisions) {
		if (
			quarantine.revisionId !== PRISTINE_REVISION_ID
			&& revisionsById.has(quarantine.revisionId)
			&& !quarantinedRevisionIds.has(quarantine.revisionId)
		) {
			quarantinedRevisionIds.add(quarantine.revisionId);
			quarantinedRevisions.push(quarantine);
		}
	}

	const lastKnownGoodRevisionId = revisionsById.has(ledger.lastKnownGoodRevisionId)
		&& !quarantinedRevisionIds.has(ledger.lastKnownGoodRevisionId)
		? ledger.lastKnownGoodRevisionId
		: PRISTINE_REVISION_ID;
	const activeRevisionId = revisionsById.has(ledger.activeRevisionId)
		&& !quarantinedRevisionIds.has(ledger.activeRevisionId)
		? ledger.activeRevisionId
		: lastKnownGoodRevisionId;
	const bootAttempt = ledger.bootAttempt && revisionsById.has(ledger.bootAttempt.revisionId)
		? { ...ledger.bootAttempt }
		: undefined;

	return {
		schemaVersion: 1,
		activeRevisionId,
		lastKnownGoodRevisionId,
		revisions: orderHackerCodeRevisions([...revisionsById.values()]),
		quarantinedRevisions: [...quarantinedRevisions].sort((first, second) => first.revisionId.localeCompare(second.revisionId)),
		bootAttempt,
		skipPromoted: ledger.skipPromoted === true
	};
}

export function addHackerCodeRevision(ledger: IHackerCodeRevisionLedger, revision: IHackerCodeRevisionManifest): IHackerCodeRevisionLedger {
	if (ledger.revisions.some(candidate => candidate.id === revision.id)) {
		return normalizeHackerCodeRevisionLedger(ledger);
	}

	return normalizeHackerCodeRevisionLedger({
		...ledger,
		revisions: [...ledger.revisions, revision]
	});
}

export function getHackerCodeFallbackRevisionId(ledger: IHackerCodeRevisionLedger): string {
	const normalized = normalizeHackerCodeRevisionLedger(ledger);
	return normalized.lastKnownGoodRevisionId;
}

export function setHackerCodeRevision(ledger: IHackerCodeRevisionLedger, revisionId: string): IHackerCodeRevisionLedger {
	const normalized = normalizeHackerCodeRevisionLedger(ledger);
	if (!normalized.revisions.some(revision => revision.id === revisionId)) {
		throw new Error(`Unknown HackerCode revision: ${revisionId}`);
	}
	if (normalized.quarantinedRevisions.some(quarantine => quarantine.revisionId === revisionId)) {
		throw new Error(`Quarantined HackerCode revision cannot be activated: ${revisionId}`);
	}

	return {
		...normalized,
		activeRevisionId: revisionId,
		skipPromoted: false
	};
}

export function quarantineHackerCodeRevision(
	ledger: IHackerCodeRevisionLedger,
	revisionId: string,
	quarantinedAt: string,
	reason?: string
): IHackerCodeRevisionLedger {
	const normalized = normalizeHackerCodeRevisionLedger(ledger);
	if (revisionId === PRISTINE_REVISION_ID) {
		throw new Error('The pristine HackerCode revision cannot be quarantined');
	}
	if (!normalized.revisions.some(revision => revision.id === revisionId)) {
		throw new Error(`Unknown HackerCode revision: ${revisionId}`);
	}

	const quarantine: IHackerCodeQuarantinedRevision = reason === undefined
		? { revisionId, quarantinedAt }
		: { revisionId, quarantinedAt, reason };
	const quarantinedRevisions = [
		...normalized.quarantinedRevisions.filter(candidate => candidate.revisionId !== revisionId),
		quarantine
	];
	return normalizeHackerCodeRevisionLedger({
		...normalized,
		activeRevisionId: normalized.activeRevisionId === revisionId ? normalized.lastKnownGoodRevisionId : normalized.activeRevisionId,
		lastKnownGoodRevisionId: normalized.lastKnownGoodRevisionId === revisionId ? PRISTINE_REVISION_ID : normalized.lastKnownGoodRevisionId,
		quarantinedRevisions,
		bootAttempt: normalized.bootAttempt?.revisionId === revisionId ? undefined : normalized.bootAttempt
	});
}

export function markHackerCodeRevisionHealthy(ledger: IHackerCodeRevisionLedger, revisionId: string): IHackerCodeRevisionLedger {
	const normalized = normalizeHackerCodeRevisionLedger(ledger);
	if (!normalized.revisions.some(revision => revision.id === revisionId)) {
		throw new Error(`Unknown HackerCode revision: ${revisionId}`);
	}

	return normalizeHackerCodeRevisionLedger({
		...normalized,
		lastKnownGoodRevisionId: revisionId,
		quarantinedRevisions: normalized.quarantinedRevisions.filter(quarantine => quarantine.revisionId !== revisionId)
	});
}

function isIsoTimestamp(value: string): boolean {
	if (typeof value !== 'string') {
		return false;
	}
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

export function beginHackerCodeBoot(
	ledger: IHackerCodeRevisionLedger,
	revisionId: string,
	startedAt: string,
	windowId?: number
): IHackerCodeRevisionLedger {
	const normalized = normalizeHackerCodeRevisionLedger(ledger);
	if (normalized.activeRevisionId !== revisionId) {
		throw new Error(`HackerCode boot revision is not active: ${revisionId}`);
	}
	if (!isIsoTimestamp(startedAt)) {
		throw new Error('Invalid HackerCode boot start time');
	}
	if (windowId !== undefined && (!Number.isSafeInteger(windowId) || windowId <= 0)) {
		throw new Error('Invalid HackerCode boot window id');
	}

	return {
		...normalized,
		bootAttempt: {
			revisionId,
			...(windowId === undefined ? {} : { windowId }),
			startedAt
		}
	};
}

export function completeHackerCodeBoot(
	ledger: IHackerCodeRevisionLedger,
	revisionId: string,
	windowId?: number
): IHackerCodeRevisionLedger {
	const normalized = normalizeHackerCodeRevisionLedger(ledger);
	const bootAttempt = normalized.bootAttempt;
	if (
		normalized.activeRevisionId !== revisionId
		|| !bootAttempt
		|| bootAttempt.revisionId !== revisionId
		|| bootAttempt.windowId !== windowId
	) {
		throw new Error('HackerCode boot completion does not match the active attempt');
	}

	return markHackerCodeRevisionHealthy({
		...normalized,
		bootAttempt: undefined
	}, revisionId);
}

export function clearHackerCodeBootAttempt(ledger: IHackerCodeRevisionLedger): IHackerCodeRevisionLedger {
	return {
		...normalizeHackerCodeRevisionLedger(ledger),
		bootAttempt: undefined
	};
}

export function recoverHackerCodeBootAttempt(
	ledger: IHackerCodeRevisionLedger,
	quarantinedAt: string,
	reason: string
): IHackerCodeRevisionLedger {
	const normalized = normalizeHackerCodeRevisionLedger(ledger);
	const attemptedRevisionId = normalized.bootAttempt?.revisionId;
	if (!attemptedRevisionId || attemptedRevisionId === PRISTINE_REVISION_ID) {
		return clearHackerCodeBootAttempt(normalized);
	}

	return clearHackerCodeBootAttempt(quarantineHackerCodeRevision(normalized, attemptedRevisionId, quarantinedAt, reason));
}

export function enterHackerCodeSafeMode(
	ledger: IHackerCodeRevisionLedger,
	quarantinedAt: string,
	reason: string,
	forcePristine = false
): IHackerCodeRevisionLedger {
	const normalized = normalizeHackerCodeRevisionLedger(ledger);
	let safeLedger = normalized.activeRevisionId === PRISTINE_REVISION_ID
		? normalized
		: quarantineHackerCodeRevision(normalized, normalized.activeRevisionId, quarantinedAt, reason);
	if (forcePristine && safeLedger.activeRevisionId !== PRISTINE_REVISION_ID) {
		safeLedger = setHackerCodeRevision(safeLedger, PRISTINE_REVISION_ID);
	}

	return {
		...clearHackerCodeBootAttempt(safeLedger),
		skipPromoted: true
	};
}

export function resetHackerCodeLedgerAfterPromotion(ledger: IHackerCodeRevisionLedger): IHackerCodeRevisionLedger {
	return normalizeHackerCodeRevisionLedger({
		...ledger,
		activeRevisionId: PRISTINE_REVISION_ID,
		lastKnownGoodRevisionId: PRISTINE_REVISION_ID,
		bootAttempt: undefined,
		skipPromoted: false
	});
}
