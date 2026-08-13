/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { IExtensionDescription } from '../../../platform/extensions/common/extensions.js';
import { HackerCodeSerializedValueDto, IMainContext, MainContext, MainThreadHackerCodeShape } from './extHost.protocol.js';

export class ExtHostHackerCode {

	private readonly proxy: MainThreadHackerCodeShape;

	constructor(mainContext: IMainContext) {
		this.proxy = mainContext.getProxy(MainContext.MainThreadHackerCode);
	}

	getState(_extension: IExtensionDescription): Promise<vscode.HackerCodeState> {
		return this.proxy.$getHackerCodeState();
	}

	listRevisions(_extension: IExtensionDescription): Promise<readonly vscode.HackerCodeRevision[]> {
		return this.proxy.$listHackerCodeRevisions();
	}

	getRevision(_extension: IExtensionDescription, revisionId: string): Promise<vscode.HackerCodeRevision | undefined> {
		return this.proxy.$getHackerCodeRevision(revisionId);
	}

	createRevision(_extension: IExtensionDescription, options: vscode.HackerCodeCreateRevisionOptions): Promise<vscode.HackerCodeRevision> {
		return this.proxy.$createHackerCodeRevision(options);
	}

	selectRevision(_extension: IExtensionDescription, revisionId: string): Promise<vscode.HackerCodeState> {
		return this.proxy.$selectHackerCodeRevision(revisionId);
	}

	enterSafeMode(_extension: IExtensionDescription, reason?: string): Promise<vscode.HackerCodeState> {
		return this.proxy.$enterHackerCodeSafeMode(reason);
	}

	async evaluate(_extension: IExtensionDescription, source: string): Promise<vscode.HackerCodeJsonValue> {
		return toHackerCodeJsonValue(await this.proxy.$evaluateHackerCode(source));
	}

	refresh(_extension: IExtensionDescription, mode: 'soft' | 'module' | 'hard', specifier?: string): Promise<void> {
		return this.proxy.$refreshHackerCode(mode, specifier);
	}

	promoteActiveRevision(_extension: IExtensionDescription, commitMessage?: string): Promise<vscode.HackerCodePromoteResult> {
		return this.proxy.$promoteActiveHackerCodeRevision(commitMessage);
	}
}

function toHackerCodeJsonValue(value: HackerCodeSerializedValueDto | unknown): vscode.HackerCodeJsonValue {
	if (value === null || typeof value === 'boolean' || typeof value === 'string') {
		return value;
	}
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(toHackerCodeJsonValue);
	}
	if (typeof value === 'object') {
		const result: { [key: string]: vscode.HackerCodeJsonValue } = {};
		for (const [key, entry] of Object.entries(value)) {
			result[key] = toHackerCodeJsonValue(entry);
		}
		return result;
	}
	throw new Error('HackerCode evaluation returned a non-JSON-safe value');
}
