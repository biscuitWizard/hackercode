/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';

/**
 * Provider API keys are stored in OS-backed secret storage
 * (`ISecretStorageService`, backed by Electron's `safeStorage`), keyed by
 * the provider's own stable `id` from `hackercode.agent.providers`. Unlike
 * `languageModels.ts`'s scheme, no random-key indirection is needed here:
 * the provider id is already a small, user-chosen, non-sensitive identifier
 * and is never round-tripped through settings as a secret placeholder.
 */
const SECRET_KEY_PREFIX = 'hackercode.agent.secret.';

export function hackerCodeAgentProviderSecretKey(providerId: string): string {
	return `${SECRET_KEY_PREFIX}${providerId}`;
}

export async function readHackerCodeAgentProviderApiKey(secretStorageService: ISecretStorageService, providerId: string): Promise<string | undefined> {
	return secretStorageService.get(hackerCodeAgentProviderSecretKey(providerId));
}

export async function writeHackerCodeAgentProviderApiKey(secretStorageService: ISecretStorageService, providerId: string, apiKey: string): Promise<void> {
	await secretStorageService.set(hackerCodeAgentProviderSecretKey(providerId), apiKey);
}

export async function deleteHackerCodeAgentProviderApiKey(secretStorageService: ISecretStorageService, providerId: string): Promise<void> {
	await secretStorageService.delete(hackerCodeAgentProviderSecretKey(providerId));
}
