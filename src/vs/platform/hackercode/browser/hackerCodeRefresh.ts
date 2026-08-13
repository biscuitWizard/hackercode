/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';

export type HackerCodeRefreshMode = 'soft' | 'module' | 'hard';

export const IHackerCodeRendererRefreshService = createDecorator<IHackerCodeRendererRefreshService>('hackerCodeRendererRefreshService');

/**
 * Reloads HackerCode patches or renderer modules without exposing mutable
 * control-plane state through the global runtime.
 */
export interface IHackerCodeRendererRefreshService {
	readonly _serviceBrand: undefined;

	refresh(mode: 'soft' | 'hard'): Promise<void>;
	refresh(mode: 'module', specifier: string): Promise<void>;
	soft(): Promise<void>;
	module(specifier: string): Promise<void>;
	hard(): Promise<void>;
}

export const IHackerCodeModuleLoaderService = createDecorator<IHackerCodeModuleLoaderService>('hackerCodeModuleLoaderService');

/**
 * Imports renderer modules for patch contexts and owns the namespaces eligible
 * for module refresh.
 *
 * The specifier guard is a safety boundary, not a sandbox. A patch can still
 * obtain significant power from an ordinary reachable service.
 */
export interface IHackerCodeModuleLoaderService {
	readonly _serviceBrand: undefined;

	import(specifier: string): Promise<object>;
	refresh(specifier: string): Promise<void>;
}
