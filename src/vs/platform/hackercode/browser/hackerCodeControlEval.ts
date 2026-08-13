/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IHackerCodeRuntime } from './hackerCodeRuntime.js';
import { HackerCodeSerializedValue, serializeHackerCodeControlValue } from './hackerCodeControlSerializer.js';

export interface IHackerCodeAsyncFunctionConstructor {
	new (...parameters: string[]): (...args: unknown[]) => Promise<unknown>;
}

/**
 * Runs source in the explicitly privileged HackerCode runtime scope.
 *
 * The browser path evaluates a Blob-backed ESM function because the workbench's
 * Trusted Types policy intentionally blocks string-based Function constructors.
 * The injected AsyncFunction constructor exists for focused tests only. Both
 * paths are gated by the root-authority token and intentionally execute
 * arbitrary JavaScript; neither may be exposed outside that gate.
 */
export async function executeHackerCodeControlEval(
	source: string,
	runtime: IHackerCodeRuntime,
	AsyncFunctionConstructor?: IHackerCodeAsyncFunctionConstructor
): Promise<HackerCodeSerializedValue> {
	const getService = (name: string) => runtime.getService(name);
	const refresh = (mode: 'soft' | 'hard' | 'module', specifier?: string): Promise<void> => {
		if (mode === 'module') {
			if (!specifier) {
				throw new Error('A module specifier is required for module refresh');
			}
			return runtime.refresh(mode, specifier);
		}
		return runtime.refresh(mode);
	};
	const evaluator = AsyncFunctionConstructor
		? new AsyncFunctionConstructor(createEvaluatorBody(source))
		: await createModuleEvaluator(source);
	const scope = {
		runtime,
		instantiationService: runtime.instantiationService,
		getService,
		refresh
	};
	const result = await evaluator(scope);
	return serializeHackerCodeControlValue(result);
}

function createEvaluatorBody(source: string): string {
	return [
		'"use strict";',
		'const { runtime, instantiationService, getService, refresh } = arguments[0];',
		source
	].join('\n');
}

async function createModuleEvaluator(source: string): Promise<(scope: object) => Promise<unknown>> {
	const moduleSource = [
		'export default async function hackerCodeControlEval(scope) {',
		'\tconst { runtime, instantiationService, getService, refresh } = scope;',
		source,
		'}',
		'//# sourceURL=hackercode-control-eval.js',
		''
	].join('\n');
	const moduleUrl = URL.createObjectURL(new Blob([moduleSource], { type: 'application/javascript' }));
	let module: Record<string, unknown>;
	try {
		module = await import(moduleUrl);
	} finally {
		URL.revokeObjectURL(moduleUrl);
	}
	if (typeof module.default !== 'function') {
		throw new Error('HackerCode eval module did not export an evaluator');
	}
	return module.default as (scope: object) => Promise<unknown>;
}

export async function executeHackerCodeControlRefresh(
	runtime: IHackerCodeRuntime,
	mode: 'soft' | 'hard' | 'module',
	specifier?: string
): Promise<null> {
	if (mode === 'module') {
		if (!specifier) {
			throw new Error('A module specifier is required for module refresh');
		}
		await runtime.refresh(mode, specifier);
	} else {
		await runtime.refresh(mode);
	}
	return null;
}
