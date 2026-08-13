/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { enableHotReload } from '../../common/hotReload.js';

interface IHotReloadTestGlobal {
	$hotReload_applyNewExports?(args: {
		oldExports: Record<string, unknown>;
		newSrc: string;
		config: { mode: 'patch-prototype' };
	}): ((newExports: Record<string, unknown>) => boolean) | undefined;
}

suite('Hot reload', () => {
	test('late enable registers the default prototype handler idempotently', () => {
		class OldExport {
			value(): number {
				return 1;
			}
		}
		class NewExport {
			value(): number {
				return 2;
			}
		}

		enableHotReload();
		enableHotReload();
		const applyNewExports = (globalThis as typeof globalThis & IHotReloadTestGlobal).$hotReload_applyNewExports;
		const acceptNewExports = applyNewExports?.({
			oldExports: { TestExport: OldExport },
			newSrc: '',
			config: { mode: 'patch-prototype' }
		});
		const newExports: Record<string, unknown> = { TestExport: NewExport };

		assert.deepStrictEqual({
			handled: acceptNewExports?.(newExports),
			value: new OldExport().value(),
			exportPreserved: newExports.TestExport === OldExport
		}, {
			handled: true,
			value: 2,
			exportPreserved: true
		});
	});
});
