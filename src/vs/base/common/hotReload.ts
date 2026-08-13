/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable } from './lifecycle.js';

let _isHotReloadEnabled = false;
let defaultHandlerRegistered = false;

export function enableHotReload(): void {
	_isHotReloadEnabled = true;
	const handlers = registerGlobalHotReloadHandler();
	if (!defaultHandlerRegistered) {
		defaultHandlerRegistered = true;
		handlers.add(patchPrototypeHotReloadHandler);
	}
}

export function isHotReloadEnabled(): boolean {
	return _isHotReloadEnabled;
}
export function registerHotReloadHandler(handler: HotReloadHandler): IDisposable {
	if (!isHotReloadEnabled()) {
		return { dispose() { } };
	} else {
		const handlers = registerGlobalHotReloadHandler();
		handlers.add(handler);
		return {
			dispose() { handlers.delete(handler); }
		};
	}
}

/**
 * Takes the old exports of the module to reload and returns a function to apply the new exports.
 * If `undefined` is returned, this handler is not able to handle the module.
 *
 * If no handler can apply the new exports, the module will not be reloaded.
 */
export type HotReloadHandler = (args: { oldExports: Record<string, unknown>; newSrc: string; config: IHotReloadConfig }) => AcceptNewExportsHandler | undefined;
export type AcceptNewExportsHandler = (newExports: Record<string, unknown>) => boolean;
export type IHotReloadConfig = HotReloadConfig;

function registerGlobalHotReloadHandler() {
	if (!hotReloadHandlers) {
		hotReloadHandlers = new Set();
	}

	const g = globalThis as unknown as GlobalThisAddition;
	if (!g.$hotReload_applyNewExports) {
		g.$hotReload_applyNewExports = args => {
			const args2 = { config: { mode: undefined }, ...args };

			const results: AcceptNewExportsHandler[] = [];
			for (const h of hotReloadHandlers!) {
				const result = h(args2);
				if (result) {
					results.push(result);
				}
			}
			if (results.length > 0) {
				return newExports => {
					let result = false;
					for (const r of results) {
						if (r(newExports)) {
							result = true;
						}
					}
					return result;
				};
			}
			return undefined;
		};
	}

	return hotReloadHandlers;
}

let hotReloadHandlers: Set<(args: { oldExports: Record<string, unknown>; newSrc: string; config: HotReloadConfig }) => AcceptNewExportsFn | undefined> | undefined = undefined;

interface HotReloadConfig {
	mode?: 'patch-prototype' | undefined;
}

interface GlobalThisAddition {
	$hotReload_applyNewExports?(args: { oldExports: Record<string, unknown>; newSrc: string; config?: HotReloadConfig }): AcceptNewExportsFn | undefined;
}

type AcceptNewExportsFn = (newExports: Record<string, unknown>) => boolean;

function hasPrototype(value: unknown): value is Function & { prototype: object } {
	return typeof value === 'function' && typeof value.prototype === 'object' && value.prototype !== null;
}

function patchPrototypeHotReloadHandler({ oldExports, config }: Parameters<HotReloadHandler>[0]): AcceptNewExportsHandler | undefined {
	if (config.mode !== 'patch-prototype') {
		return undefined;
	}

	return newExports => {
		for (const key in newExports) {
			const exportedItem = newExports[key];
			console.log(`[hot-reload] Patching prototype methods of '${key}'`, { exportedItem });
			const oldExportedItem = oldExports[key];
			if (hasPrototype(exportedItem) && hasPrototype(oldExportedItem)) {
				for (const prop of Object.getOwnPropertyNames(exportedItem.prototype)) {
					const descriptor = Object.getOwnPropertyDescriptor(exportedItem.prototype, prop);
					const oldDescriptor = Object.getOwnPropertyDescriptor(oldExportedItem.prototype, prop);
					if (!descriptor) {
						continue;
					}

					if (descriptor.value?.toString() !== oldDescriptor?.value?.toString()) {
						console.log(`[hot-reload] Patching prototype method '${key}.${prop}'`);
					}

					Object.defineProperty(oldExportedItem.prototype, prop, descriptor);
				}
				newExports[key] = oldExportedItem;
			}
		}
		return true;
	};
}
