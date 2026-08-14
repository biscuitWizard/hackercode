/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { HACKERCODE_AGENT_PROVIDERS_CONFIG_KEY } from '../common/hackerCodeAgentConfiguration.js';
import { HackerCodeAgentConnectionState, IHackerCodeAgentTransportService } from '../common/hackerCodeAgentTransport.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { resolveHackerCodeAgentProviders } from './hackerCodeAgentProviders.js';

/**
 * Pushes provider configuration (plus API keys resolved from secret
 * storage) to the driver whenever the socket connects or the settings
 * change. The driver holds these only in memory; plaintext keys are never
 * written to disk by the renderer and reach the driver only over this
 * loopback, token-authenticated socket.
 */
export class HackerCodeAgentProviderSyncContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.hackerCodeAgentProviderSync';

	constructor(
		@IHackerCodeAgentTransportService private readonly transportService: IHackerCodeAgentTransportService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService
	) {
		super();

		this._register(this.transportService.onDidChangeState(state => {
			if (state === HackerCodeAgentConnectionState.Connected) {
				void this.sync();
			}
		}));
		this._register(this.configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(HACKERCODE_AGENT_PROVIDERS_CONFIG_KEY)) {
				void this.sync();
			}
		}));
		this._register(this.secretStorageService.onDidChangeSecret(() => void this.sync()));
	}

	private async sync(): Promise<void> {
		if (this.transportService.state !== HackerCodeAgentConnectionState.Connected) {
			return;
		}
		const providers = await resolveHackerCodeAgentProviders(this.configurationService, this.secretStorageService);
		this.transportService.send({ kind: 'setProviders', providers });
	}
}

registerWorkbenchContribution2(
	HackerCodeAgentProviderSyncContribution.ID,
	HackerCodeAgentProviderSyncContribution,
	WorkbenchPhase.AfterRestored
);
