/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { readHackerCodeAgentProviderConfigs } from '../common/hackerCodeAgentConfiguration.js';
import { readHackerCodeAgentProviderApiKey } from '../common/hackerCodeAgentSecrets.js';

export interface IResolvedHackerCodeAgentProvider {
	readonly id: string;
	readonly label: string;
	readonly baseUrl: string;
	readonly apiKey?: string;
	readonly models: readonly string[];
}

/**
 * Joins the non-secret provider configuration with API keys from secret
 * storage. Keys are never written back to settings, so a resolved provider
 * must stay in memory.
 */
export async function resolveHackerCodeAgentProviders(
	configurationService: IConfigurationService,
	secretStorageService: ISecretStorageService
): Promise<IResolvedHackerCodeAgentProvider[]> {
	const configs = readHackerCodeAgentProviderConfigs(configurationService);
	return Promise.all(configs.map(async config => {
		const apiKey = await readHackerCodeAgentProviderApiKey(secretStorageService, config.id);
		return {
			id: config.id,
			label: config.label,
			baseUrl: config.baseUrl,
			...(apiKey ? { apiKey } : {}),
			models: config.models
		};
	}));
}
