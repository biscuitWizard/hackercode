/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import {
	addHackerCodeRevision,
	beginHackerCodeBoot,
	completeHackerCodeBoot,
	createHackerCodeRevisionLedger,
	enterHackerCodeSafeMode,
	IHackerCodeRevisionManifest,
	markHackerCodeRevisionHealthy,
	normalizeHackerCodeRevisionLedger,
	PRISTINE_REVISION_ID,
	quarantineHackerCodeRevision,
	recoverHackerCodeBootAttempt,
	resetHackerCodeLedgerAfterPromotion,
	setHackerCodeRevision
} from '../../common/hackerCode.js';

suite('HackerCode revision ledger', () => {
	const firstRevision = createRevision('a'.repeat(64), '2026-01-01T00:00:00.000Z');
	const secondRevision = createRevision('b'.repeat(64), '2026-02-01T00:00:00.000Z', firstRevision.id);

	test('creates a pristine ledger', () => {
		assert.deepStrictEqual(createHackerCodeRevisionLedger(), {
			schemaVersion: 1,
			activeRevisionId: PRISTINE_REVISION_ID,
			lastKnownGoodRevisionId: PRISTINE_REVISION_ID,
			revisions: [{
				schemaVersion: 1,
				id: PRISTINE_REVISION_ID,
				baseline: PRISTINE_REVISION_ID,
				createdAt: '1970-01-01T00:00:00.000Z',
				parentId: PRISTINE_REVISION_ID,
				patches: []
			}],
			quarantinedRevisions: [],
			bootAttempt: undefined,
			skipPromoted: false
		});
	});

	test('adds and deterministically orders revisions', () => {
		const ledger = addHackerCodeRevision(addHackerCodeRevision(createHackerCodeRevisionLedger(), firstRevision), secondRevision);

		assert.deepStrictEqual(ledger.revisions.map(revision => revision.id), [
			secondRevision.id,
			firstRevision.id,
			PRISTINE_REVISION_ID
		]);
	});

	test('normalizes a ledger written before boot attempts were added', () => {
		const normalized = normalizeHackerCodeRevisionLedger({
			schemaVersion: 1,
			activeRevisionId: PRISTINE_REVISION_ID,
			lastKnownGoodRevisionId: PRISTINE_REVISION_ID,
			revisions: createHackerCodeRevisionLedger().revisions,
			quarantinedRevisions: []
		});

		assert.deepStrictEqual(normalized.bootAttempt, undefined);
	});

	test('normalizes invalid active and last-known-good revisions', () => {
		const normalized = normalizeHackerCodeRevisionLedger({
			...addHackerCodeRevision(createHackerCodeRevisionLedger(), firstRevision),
			activeRevisionId: 'missing',
			lastKnownGoodRevisionId: firstRevision.id,
			quarantinedRevisions: [{
				revisionId: firstRevision.id,
				quarantinedAt: '2026-03-01T00:00:00.000Z'
			}]
		});

		assert.deepStrictEqual({
			activeRevisionId: normalized.activeRevisionId,
			lastKnownGoodRevisionId: normalized.lastKnownGoodRevisionId,
			quarantinedRevisionIds: normalized.quarantinedRevisions.map(entry => entry.revisionId)
		}, {
			activeRevisionId: PRISTINE_REVISION_ID,
			lastKnownGoodRevisionId: PRISTINE_REVISION_ID,
			quarantinedRevisionIds: [firstRevision.id]
		});
	});

	test('quarantines the active revision and falls back to last-known-good', () => {
		let ledger = addHackerCodeRevision(createHackerCodeRevisionLedger(), firstRevision);
		ledger = markHackerCodeRevisionHealthy(ledger, firstRevision.id);
		ledger = addHackerCodeRevision(ledger, secondRevision);
		ledger = setHackerCodeRevision(ledger, secondRevision.id);
		ledger = quarantineHackerCodeRevision(ledger, secondRevision.id, '2026-03-01T00:00:00.000Z', 'failed validation');

		assert.deepStrictEqual({
			activeRevisionId: ledger.activeRevisionId,
			lastKnownGoodRevisionId: ledger.lastKnownGoodRevisionId,
			quarantinedRevisions: ledger.quarantinedRevisions
		}, {
			activeRevisionId: firstRevision.id,
			lastKnownGoodRevisionId: firstRevision.id,
			quarantinedRevisions: [{
				revisionId: secondRevision.id,
				quarantinedAt: '2026-03-01T00:00:00.000Z',
				reason: 'failed validation'
			}]
		});
	});

	test('marking a revision healthy clears quarantine', () => {
		let ledger = addHackerCodeRevision(createHackerCodeRevisionLedger(), firstRevision);
		ledger = quarantineHackerCodeRevision(ledger, firstRevision.id, '2026-03-01T00:00:00.000Z');
		ledger = markHackerCodeRevisionHealthy(ledger, firstRevision.id);

		assert.deepStrictEqual({
			lastKnownGoodRevisionId: ledger.lastKnownGoodRevisionId,
			quarantinedRevisions: ledger.quarantinedRevisions
		}, {
			lastKnownGoodRevisionId: firstRevision.id,
			quarantinedRevisions: []
		});
	});

	test('begins and completes a matching boot attempt', () => {
		let ledger = addHackerCodeRevision(createHackerCodeRevisionLedger(), firstRevision);
		ledger = setHackerCodeRevision(ledger, firstRevision.id);
		ledger = beginHackerCodeBoot(ledger, firstRevision.id, '2026-03-01T00:00:00.000Z', 7);
		ledger = completeHackerCodeBoot(ledger, firstRevision.id, 7);

		assert.deepStrictEqual({
			activeRevisionId: ledger.activeRevisionId,
			lastKnownGoodRevisionId: ledger.lastKnownGoodRevisionId,
			bootAttempt: ledger.bootAttempt
		}, {
			activeRevisionId: firstRevision.id,
			lastKnownGoodRevisionId: firstRevision.id,
			bootAttempt: undefined
		});
	});

	test('rejects mismatched boot attempts and completions', () => {
		let ledger = addHackerCodeRevision(createHackerCodeRevisionLedger(), firstRevision);
		ledger = setHackerCodeRevision(ledger, firstRevision.id);

		assert.throws(() => beginHackerCodeBoot(ledger, PRISTINE_REVISION_ID, '2026-03-01T00:00:00.000Z', 7), /not active/);

		ledger = beginHackerCodeBoot(ledger, firstRevision.id, '2026-03-01T00:00:00.000Z', 7);
		assert.throws(() => completeHackerCodeBoot(ledger, firstRevision.id, 8), /does not match/);
		assert.throws(() => completeHackerCodeBoot(ledger, PRISTINE_REVISION_ID, 7), /does not match/);
	});

	test('recovers a stale boot attempt to the last-known-good revision', () => {
		let ledger = addHackerCodeRevision(createHackerCodeRevisionLedger(), firstRevision);
		ledger = markHackerCodeRevisionHealthy(ledger, firstRevision.id);
		ledger = addHackerCodeRevision(ledger, secondRevision);
		ledger = setHackerCodeRevision(ledger, secondRevision.id);
		ledger = beginHackerCodeBoot(ledger, secondRevision.id, '2026-03-01T00:00:00.000Z', 7);
		ledger = recoverHackerCodeBootAttempt(ledger, '2026-03-02T00:00:00.000Z', 'stale boot attempt');

		assert.deepStrictEqual({
			activeRevisionId: ledger.activeRevisionId,
			lastKnownGoodRevisionId: ledger.lastKnownGoodRevisionId,
			bootAttempt: ledger.bootAttempt,
			quarantinedRevisions: ledger.quarantinedRevisions
		}, {
			activeRevisionId: firstRevision.id,
			lastKnownGoodRevisionId: firstRevision.id,
			bootAttempt: undefined,
			quarantinedRevisions: [{
				revisionId: secondRevision.id,
				quarantinedAt: '2026-03-02T00:00:00.000Z',
				reason: 'stale boot attempt'
			}]
		});
	});

	test('clears a stale pristine boot without quarantining pristine', () => {
		const ledger = recoverHackerCodeBootAttempt(
			beginHackerCodeBoot(createHackerCodeRevisionLedger(), PRISTINE_REVISION_ID, '2026-03-01T00:00:00.000Z'),
			'2026-03-02T00:00:00.000Z',
			'stale boot attempt'
		);

		assert.deepStrictEqual({
			activeRevisionId: ledger.activeRevisionId,
			bootAttempt: ledger.bootAttempt,
			quarantinedRevisions: ledger.quarantinedRevisions
		}, {
			activeRevisionId: PRISTINE_REVISION_ID,
			bootAttempt: undefined,
			quarantinedRevisions: []
		});
	});

	test('forces pristine when command-line safe mode is requested', () => {
		let ledger = addHackerCodeRevision(createHackerCodeRevisionLedger(), firstRevision);
		ledger = markHackerCodeRevisionHealthy(ledger, firstRevision.id);
		ledger = addHackerCodeRevision(ledger, secondRevision);
		ledger = setHackerCodeRevision(ledger, secondRevision.id);
		ledger = enterHackerCodeSafeMode(ledger, '2026-03-02T00:00:00.000Z', 'command-line safe mode', true);

		assert.deepStrictEqual({
			activeRevisionId: ledger.activeRevisionId,
			lastKnownGoodRevisionId: ledger.lastKnownGoodRevisionId,
			quarantinedRevisionIds: ledger.quarantinedRevisions.map(entry => entry.revisionId),
			skipPromoted: ledger.skipPromoted
		}, {
			activeRevisionId: PRISTINE_REVISION_ID,
			lastKnownGoodRevisionId: firstRevision.id,
			quarantinedRevisionIds: [secondRevision.id],
			skipPromoted: true
		});
	});

	test('resets overlay state after promotion', () => {
		let ledger = addHackerCodeRevision(createHackerCodeRevisionLedger(), firstRevision);
		ledger = setHackerCodeRevision(ledger, firstRevision.id);
		ledger = beginHackerCodeBoot(ledger, firstRevision.id, '2026-03-01T00:00:00.000Z', 7);

		const reset = resetHackerCodeLedgerAfterPromotion(ledger);

		assert.deepStrictEqual({
			activeRevisionId: reset.activeRevisionId,
			lastKnownGoodRevisionId: reset.lastKnownGoodRevisionId,
			bootAttempt: reset.bootAttempt,
			skipPromoted: reset.skipPromoted
		}, {
			activeRevisionId: PRISTINE_REVISION_ID,
			lastKnownGoodRevisionId: PRISTINE_REVISION_ID,
			bootAttempt: undefined,
			skipPromoted: false
		});
	});

	test('rejects unsafe revision changes', () => {
		const ledger = addHackerCodeRevision(createHackerCodeRevisionLedger(), firstRevision);
		const quarantinedLedger = quarantineHackerCodeRevision(ledger, firstRevision.id, '2026-03-01T00:00:00.000Z');

		assert.throws(() => setHackerCodeRevision(ledger, 'missing'), /Unknown HackerCode revision/);
		assert.throws(() => setHackerCodeRevision(quarantinedLedger, firstRevision.id), /Quarantined HackerCode revision/);
		assert.throws(() => quarantineHackerCodeRevision(ledger, PRISTINE_REVISION_ID, '2026-03-01T00:00:00.000Z'), /cannot be quarantined/);
	});

	ensureNoDisposablesAreLeakedInTestSuite();
});

function createRevision(id: string, createdAt: string, parentId = PRISTINE_REVISION_ID): IHackerCodeRevisionManifest {
	return {
		schemaVersion: 1,
		id,
		baseline: 'baseline',
		createdAt,
		parentId,
		patches: [{
			name: `${id.slice(0, 1)}.patch`,
			fileName: 'patch-0000.txt',
			sha256: id,
			size: 1
		}]
	};
}
