/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { join } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { INativeWorkbenchEnvironmentService } from '../../../services/environment/electron-browser/environmentService.js';
import { IHackerCodeAgentEndpoint, IHackerCodeAgentEndpointService } from '../common/hackerCodeAgentEndpoint.js';

const AGENT_METADATA_RELATIVE_PATH = ['hackercode', 'agent.json'];

export class HackerCodeAgentEndpointService implements IHackerCodeAgentEndpointService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@INativeWorkbenchEnvironmentService private readonly environmentService: INativeWorkbenchEnvironmentService,
		@IFileService private readonly fileService: IFileService
	) { }

	async getEndpoint(): Promise<IHackerCodeAgentEndpoint | undefined> {
		const resource = URI.file(join(this.environmentService.userDataPath, ...AGENT_METADATA_RELATIVE_PATH));
		let raw: string;
		try {
			const content = await this.fileService.readFile(resource);
			raw = content.value.toString();
		} catch {
			// The driver is not running, or has not written its metadata yet.
			return undefined;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return undefined;
		}

		return validateEndpoint(parsed);
	}
}

function validateEndpoint(value: unknown): IHackerCodeAgentEndpoint | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const candidate = value as Record<string, unknown>;
	if (
		candidate.protocol !== 'ws'
		|| typeof candidate.host !== 'string'
		|| candidate.host.length === 0
		|| !Number.isSafeInteger(candidate.port)
		|| typeof candidate.token !== 'string'
		|| candidate.token.length === 0
		|| !Number.isSafeInteger(candidate.pid)
	) {
		return undefined;
	}
	return {
		protocol: 'ws',
		host: candidate.host,
		port: candidate.port as number,
		token: candidate.token,
		pid: candidate.pid as number
	};
}

registerSingleton(IHackerCodeAgentEndpointService, HackerCodeAgentEndpointService, InstantiationType.Delayed);
