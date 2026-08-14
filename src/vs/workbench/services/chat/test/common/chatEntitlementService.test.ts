/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ChatEntitlement, chatRequiresSetup, IChatSetupRequirement } from '../../common/chatEntitlementService.js';

suite('chatRequiresSetup', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function context(overrides: Partial<IChatSetupRequirement> = {}): IChatSetupRequirement {
		return {
			completed: true,
			disabled: false,
			untrusted: false,
			entitlement: ChatEntitlement.Pro,
			anonymous: false,
			hasByokModels: false,
			...overrides,
		};
	}

	test('setup is never required, whatever the reported state', () => {
		const states: Partial<IChatSetupRequirement>[] = [
			{},
			{ completed: false },
			{ disabled: true },
			{ untrusted: true },
			{ entitlement: ChatEntitlement.Available },
			{ entitlement: ChatEntitlement.Unknown },
			{ completed: false, entitlement: ChatEntitlement.Unknown, hasByokModels: false },
		];

		for (const overrides of states) {
			assert.strictEqual(chatRequiresSetup(context(overrides)), false, JSON.stringify(overrides));
		}
	});
});
