/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { createHash } from 'crypto';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IHackerCodeRevisionManifest } from '../../common/hackerCode.js';
import {
	appendHackerCodePromotedLayer,
	assertHackerCodePromotionBaseline,
	commitHackerCodePromotedFiles,
	createEmptyHackerCodePromotedManifest,
	HACKERCODE_PROMOTED_RELATIVE_PATH,
	IHackerCodeCommandRunner,
	validateHackerCodePromotedPatchContent
} from '../../node/hackerCodePromotion.js';

suite('HackerCode promotion', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const baseline = 'b'.repeat(40);

	test('preserves cumulative promoted layer order', () => {
		const first = createRevision('a'.repeat(64), baseline, 'first');
		const second = createRevision('c'.repeat(64), baseline, 'second');
		const manifest = appendHackerCodePromotedLayer(
			appendHackerCodePromotedLayer(createEmptyHackerCodePromotedManifest(), first, '2026-08-13T00:00:00.000Z'),
			second,
			'2026-08-13T00:01:00.000Z'
		);

		assert.deepStrictEqual({
			layerIds: manifest.layers.map(layer => layer.id),
			fileNames: manifest.layers.map(layer => layer.patches[0].fileName)
		}, {
			layerIds: [first.id, second.id],
			fileNames: first.patches.map(patch => `${patch.sha256}.js`).concat(second.patches.map(patch => `${patch.sha256}.js`))
		});
	});

	test('validates promoted content hashes and baselines', () => {
		const revision = createRevision('a'.repeat(64), baseline, 'content');
		const descriptor = {
			...revision.patches[0],
			fileName: `${revision.patches[0].sha256}.js`
		};

		assert.doesNotThrow(() => {
			assertHackerCodePromotionBaseline(revision, baseline);
			validateHackerCodePromotedPatchContent(descriptor, 'content');
		});
		assert.throws(() => assertHackerCodePromotionBaseline(revision, 'd'.repeat(40)), /does not match git HEAD/);
		assert.throws(() => validateHackerCodePromotedPatchContent(descriptor, 'changed'), /integrity validation/);
	});

	test('passes fixed git arguments without a shell', async () => {
		const invocations: Array<{ executable: string; args: readonly string[] }> = [];
		const runner: IHackerCodeCommandRunner = {
			async run(executable, args) {
				invocations.push({ executable, args });
				return { stdout: '', stderr: '' };
			}
		};
		const manifestPath = `${HACKERCODE_PROMOTED_RELATIVE_PATH}/manifest.json`;
		const patchPath = `${HACKERCODE_PROMOTED_RELATIVE_PATH}/${'a'.repeat(64)}.js`;
		const message = 'Promote $(not-a-command); safely';
		const paths = [manifestPath, patchPath].sort();

		await commitHackerCodePromotedFiles('/checkout with spaces', [patchPath, manifestPath], message, runner);

		assert.deepStrictEqual(invocations, [{
			executable: 'git',
			args: ['-C', '/checkout with spaces', 'add', '--', ...paths]
		}, {
			executable: 'git',
			args: ['-C', '/checkout with spaces', 'commit', '--only', '-m', message, '--', ...paths]
		}]);
	});
});

function createRevision(id: string, baseline: string, content: string): IHackerCodeRevisionManifest {
	const sha256 = createHash('sha256').update(content, 'utf8').digest('hex');
	return {
		schemaVersion: 1,
		id,
		baseline,
		createdAt: '2026-08-13T00:00:00.000Z',
		parentId: 'pristine',
		patches: [{
			name: `${id.slice(0, 1)} patch`,
			fileName: 'patch-0000.txt',
			sha256,
			size: Buffer.byteLength(content, 'utf8')
		}]
	};
}
