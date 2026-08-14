/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

/**
 * Non-secret provider configuration (id/label/baseUrl/models) lives in
 * regular settings; API keys never do -- see hackerCodeAgentSecrets.ts.
 */
export const HACKERCODE_AGENT_PROVIDERS_CONFIG_KEY = 'hackercode.agent.providers';

export interface IHackerCodeAgentProviderConfigValue {
	readonly id: string;
	readonly label: string;
	readonly baseUrl: string;
	readonly models: readonly string[];
}

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'hackercodeAgent',
	order: 100,
	title: localize('hackerCodeAgentConfigurationTitle', "HackerCode Agent"),
	type: 'object',
	properties: {
		[HACKERCODE_AGENT_PROVIDERS_CONFIG_KEY]: {
			type: 'array',
			scope: ConfigurationScope.APPLICATION,
			description: localize('hackerCodeAgent.providers.description', "OpenAI-compatible chat completions endpoints available to the HackerCode agent. API keys are stored separately in OS-backed secret storage, never here."),
			default: [],
			items: {
				type: 'object',
				required: ['id', 'label', 'baseUrl'],
				additionalProperties: false,
				properties: {
					id: {
						type: 'string',
						description: localize('hackerCodeAgent.providers.id', "A stable identifier for this provider (used to look up its API key in secret storage).")
					},
					label: {
						type: 'string',
						description: localize('hackerCodeAgent.providers.label', "A display name shown in the provider picker.")
					},
					baseUrl: {
						type: 'string',
						description: localize('hackerCodeAgent.providers.baseUrl', "The base URL of an OpenAI-compatible API, e.g. https://api.openai.com/v1.")
					},
					models: {
						type: 'array',
						items: { type: 'string' },
						default: [],
						description: localize('hackerCodeAgent.providers.models', "Model ids available at this endpoint. Use \"Fetch models\" in HackerCode settings to populate this from the endpoint's /models list.")
					}
				}
			}
		}
	}
});

export function readHackerCodeAgentProviderConfigs(configurationService: IConfigurationService): IHackerCodeAgentProviderConfigValue[] {
	const raw = configurationService.getValue<unknown>(HACKERCODE_AGENT_PROVIDERS_CONFIG_KEY);
	if (!Array.isArray(raw)) {
		return [];
	}
	const result: IHackerCodeAgentProviderConfigValue[] = [];
	for (const entry of raw) {
		if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.label !== 'string' || typeof entry.baseUrl !== 'string') {
			continue;
		}
		result.push({
			id: entry.id,
			label: entry.label,
			baseUrl: entry.baseUrl,
			models: Array.isArray(entry.models) ? entry.models.filter((model): model is string => typeof model === 'string') : []
		});
	}
	return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
