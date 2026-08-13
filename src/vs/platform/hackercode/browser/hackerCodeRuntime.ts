/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IEnvironmentService } from '../../environment/common/environment.js';
import { IInstantiationService, ServiceIdentifier, ServicesAccessor, _util } from '../../instantiation/common/instantiation.js';
import { IHackerCodeRendererRefreshService } from './hackerCodeRefresh.js';

export interface IHackerCodeRuntime {
	readonly instantiationService: IInstantiationService;
	listServices(): readonly string[];
	getService(name: string): object;
	invoke<R>(fn: (accessor: ServicesAccessor) => R): R;
	refresh(mode: 'soft' | 'hard'): Promise<void>;
	refresh(mode: 'module', specifier: string): Promise<void>;
	soft(): Promise<void>;
	module(specifier: string): Promise<void>;
	hard(): Promise<void>;
}

type HackerCodeGlobal = typeof globalThis & {
	$hackercode?: unknown;
};

interface IEnvironmentServiceWithArgs extends IEnvironmentService {
	readonly args: {
		readonly 'hackercode-control'?: boolean;
	};
}

const installedRuntimes = new WeakMap<object, { readonly instantiationService: IInstantiationService; readonly runtime: IHackerCodeRuntime }>();

function hasArgs(environmentService: IEnvironmentService): environmentService is IEnvironmentServiceWithArgs {
	return 'args' in environmentService;
}

export function isHackerCodeRuntimeEnabled(environmentService: IEnvironmentService): boolean {
	return !environmentService.isBuilt || (hasArgs(environmentService) && environmentService.args['hackercode-control'] === true);
}

export function createHackerCodeRuntime(
	instantiationService: IInstantiationService,
	serviceIds: ReadonlyMap<string, ServiceIdentifier<unknown>> = _util.serviceIds
): IHackerCodeRuntime {
	return Object.freeze({
		instantiationService,

		listServices(): readonly string[] {
			// The decorator registry includes every service identifier created by loaded code.
			// Singleton descriptors omit services registered directly in a ServiceCollection.
			return [...serviceIds.keys()].sort();
		},

		getService(name: string): object {
			if (!name) {
				throw new Error('A service name is required');
			}

			const serviceIdentifier = serviceIds.get(name);
			if (!serviceIdentifier) {
				throw new Error(`Unknown service '${name}'. Use listServices() to inspect registered service identifiers.`);
			}

			try {
				const service = instantiationService.invokeFunction(accessor => accessor.get(serviceIdentifier));
				if (service === null || (typeof service !== 'object' && typeof service !== 'function')) {
					throw new Error(`Service '${name}' did not resolve to an object`);
				}
				return service;
			} catch (error) {
				if (error instanceof Error && error.message.startsWith(`Service '${name}'`)) {
					throw error;
				}
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`Unable to resolve service '${name}': ${message}`);
			}
		},

		invoke<R>(fn: (accessor: ServicesAccessor) => R): R {
			return instantiationService.invokeFunction(fn);
		},

		refresh(mode: 'soft' | 'module' | 'hard', specifier?: string): Promise<void> {
			return instantiationService.invokeFunction(accessor => {
				const refreshService = accessor.get(IHackerCodeRendererRefreshService);
				if (mode === 'module') {
					if (!specifier) {
						throw new Error('A module specifier is required for module refresh');
					}
					return refreshService.refresh(mode, specifier);
				}
				return refreshService.refresh(mode);
			});
		},

		soft(): Promise<void> {
			return instantiationService.invokeFunction(accessor => accessor.get(IHackerCodeRendererRefreshService).soft());
		},

		module(specifier: string): Promise<void> {
			return instantiationService.invokeFunction(accessor => accessor.get(IHackerCodeRendererRefreshService).module(specifier));
		},

		hard(): Promise<void> {
			return instantiationService.invokeFunction(accessor => accessor.get(IHackerCodeRendererRefreshService).hard());
		}
	});
}

export function installHackerCodeRuntime(instantiationService: IInstantiationService): IHackerCodeRuntime {
	const target = globalThis as HackerCodeGlobal;
	const existingDescriptor = Object.getOwnPropertyDescriptor(target, '$hackercode');
	if (existingDescriptor) {
		const existingRuntime = existingDescriptor.value;
		const installedRuntime = existingRuntime !== null && typeof existingRuntime === 'object'
			? installedRuntimes.get(existingRuntime)
			: undefined;
		if (
			installedRuntime
			&& installedRuntime.instantiationService === instantiationService
		) {
			return installedRuntime.runtime;
		}
		throw new Error('Cannot install HackerCode runtime: globalThis.$hackercode is already defined by an incompatible runtime');
	}

	const runtime = createHackerCodeRuntime(instantiationService);
	installedRuntimes.set(runtime, { instantiationService, runtime });
	Object.defineProperty(target, '$hackercode', {
		value: runtime,
		configurable: false,
		enumerable: false,
		writable: false
	});
	return runtime;
}
