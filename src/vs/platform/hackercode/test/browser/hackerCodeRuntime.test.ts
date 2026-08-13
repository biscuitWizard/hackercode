/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { createHackerCodeRuntime } from '../../browser/hackerCodeRuntime.js';
import { createDecorator } from '../../../instantiation/common/instantiation.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../instantiation/common/serviceCollection.js';

const IRuntimeTestService = createDecorator<IRuntimeTestService>('hackerCodeRuntimeTestService');
const IMissingRuntimeTestService = createDecorator<IRuntimeTestService>('missingHackerCodeRuntimeTestService');

interface IRuntimeTestService {
	readonly _serviceBrand: undefined;
	readonly value: number;
}

suite('HackerCode runtime', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function createRuntime() {
		const service: IRuntimeTestService = {
			_serviceBrand: undefined,
			value: 42
		};
		const instantiationService = disposables.add(new InstantiationService(
			new ServiceCollection([IRuntimeTestService, service]),
			true
		));
		const serviceIds = new Map([
			['zetaService', IRuntimeTestService],
			['alphaService', IRuntimeTestService],
			['missingService', IMissingRuntimeTestService]
		]);
		return {
			runtime: createHackerCodeRuntime(instantiationService, serviceIds),
			service
		};
	}

	test('lists and resolves registered service identifiers', () => {
		const { runtime, service } = createRuntime();

		assert.deepStrictEqual({
			services: runtime.listServices(),
			resolved: runtime.getService('alphaService'),
			invoked: runtime.invoke(accessor => accessor.get(IRuntimeTestService))
		}, {
			services: ['alphaService', 'missingService', 'zetaService'],
			resolved: service,
			invoked: service
		});
	});

	test('reports unknown and unavailable services clearly', () => {
		const { runtime } = createRuntime();

		assert.throws(() => runtime.getService('unknownService'), /Unknown service 'unknownService'/);
		assert.throws(() => runtime.getService('missingService'), /Unable to resolve service 'missingService'/);
	});
});
