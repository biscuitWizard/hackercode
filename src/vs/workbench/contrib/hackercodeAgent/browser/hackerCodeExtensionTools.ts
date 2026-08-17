/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { getErrorMessage } from '../../../../base/common/errors.js';
import { IJSONSchema } from '../../../../base/common/jsonSchema.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { localize } from '../../../../nls.js';
import { IExtensionGalleryService } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { areSameExtensions } from '../../../../platform/extensionManagement/common/extensionManagementUtil.js';
import { ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { ExtensionState, IExtensionsWorkbenchService } from '../../extensions/common/extensions.js';
import {
	CountTokensCallback,
	IPreparedToolInvocation,
	IToolData,
	IToolImpl,
	IToolInvocation,
	IToolInvocationPreparationContext,
	IToolResult,
	ToolDataSource,
	ToolProgress
} from '../../chat/common/tools/languageModelToolsService.js';

/**
 * Marketplace installation as a chat tool.
 *
 * Installing an extension runs third-party code in this window, so the tool is
 * treated the same way as the control-plane tools that mutate the runtime: it
 * is withheld outside Agent mode (see {@link isMutatingExtensionTool}) and it
 * always asks the user before it installs anything.
 */

export const enum HackerCodeExtensionToolId {
	InstallExtension = 'install_extension',
}

const MUTATING_EXTENSION_TOOLS: ReadonlySet<string> = new Set<string>([
	HackerCodeExtensionToolId.InstallExtension,
]);

export function isMutatingExtensionTool(toolId: string): boolean {
	return MUTATING_EXTENSION_TOOLS.has(toolId);
}

/** Marketplace identifiers are `<publisher>.<name>`, both restricted to this alphabet. */
const EXTENSION_ID_PATTERN = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/i;

/** How many near misses to offer back when an identifier does not resolve. */
const MAX_SUGGESTIONS = 5;

/**
 * Microsoft's Remote-SSH is not in the Open VSX gallery this build uses.
 * People (and models) still ask for it by that id; the working extension is
 * jeanp413's, and its command is `openremotessh.openEmptyWindow`.
 */
const REMOTE_SSH_ALIASES = new Map<string, string>([
	['ms-vscode-remote.remote-ssh', 'jeanp413.open-remote-ssh'],
	['ms-vscode-remote.remote-ssh-edit', 'jeanp413.open-remote-ssh'],
]);

function toolData(id: HackerCodeExtensionToolId, displayName: string, modelDescription: string, inputSchema: IJSONSchema): IToolData {
	return {
		id,
		displayName,
		modelDescription,
		inputSchema,
		source: ToolDataSource.Internal,
		tags: ['extensions'],
		toolReferenceName: id,
		canBeReferencedInPrompt: true
	};
}

export const HackerCodeExtensionToolData: readonly IToolData[] = [
	toolData(HackerCodeExtensionToolId.InstallExtension, 'Install Extension',
		'Installs an extension from the Marketplace by its identifier, which is "<publisher>.<name>" exactly as the Marketplace lists it, for example "ms-python.python". Do not guess an identifier from a product name: if the one you pass does not exist, this returns the closest Marketplace matches so you can pick the right one and call again. The user is always asked to confirm before anything is installed.',
		{
			type: 'object',
			properties: {
				id: { type: 'string', description: 'The Marketplace identifier, "<publisher>.<name>", e.g. "ms-python.python".' },
				preRelease: { type: 'boolean', description: 'Install the pre-release version instead of the latest stable one. Defaults to false.' }
			},
			required: ['id'],
			additionalProperties: false
		}),
];

export class HackerCodeExtensionTool extends Disposable implements IToolImpl {

	constructor(
		private readonly toolId: HackerCodeExtensionToolId,
		@IExtensionsWorkbenchService private readonly extensionsWorkbenchService: IExtensionsWorkbenchService,
		@IExtensionGalleryService private readonly extensionGalleryService: IExtensionGalleryService,
	) {
		super();
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		switch (this.toolId) {
			case HackerCodeExtensionToolId.InstallExtension: {
				const id = String((context.parameters as { id?: unknown })?.id ?? '');
				return {
					invocationMessage: localize('hackerCodeAgent.tool.installing', "Installing {0}", id),
					// Never auto-approvable: an extension is arbitrary code running
					// with the workbench's privileges for the rest of the session.
					confirmationMessages: {
						title: localize('hackerCodeAgent.tool.install.title', "Install extension?"),
						message: new MarkdownString(localize('hackerCodeAgent.tool.install.message', "`{0}` will be installed from the Marketplace and its code will run in this window.", id)),
						allowAutoConfirm: false
					}
				};
			}
		}
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		try {
			const value = await this._run(invocation.parameters, token);
			return { content: [{ kind: 'text', value }] };
		} catch (error) {
			const message = getErrorMessage(error);
			return { content: [{ kind: 'text', value: message }], toolResultError: message };
		}
	}

	private async _run(parameters: Record<string, any>, token: CancellationToken): Promise<string> {
		switch (this.toolId) {
			case HackerCodeExtensionToolId.InstallExtension:
				return this._installExtension(parameters, token);
		}
	}

	private async _installExtension(parameters: Record<string, any>, token: CancellationToken): Promise<string> {
		const requested = String(parameters.id ?? '').trim();
		if (!EXTENSION_ID_PATTERN.test(requested)) {
			throw new Error(`"${requested}" is not a Marketplace identifier. Use "<publisher>.<name>", e.g. "ms-python.python".`);
		}
		const id = REMOTE_SSH_ALIASES.get(requested.toLowerCase()) ?? requested;
		const preRelease = parameters.preRelease === true;

		await this.extensionsWorkbenchService.whenInitialized;

		const installed = this.extensionsWorkbenchService.installed.find(extension => areSameExtensions(extension.identifier, { id }));
		if (installed && installed.state === ExtensionState.Installed) {
			return `${id} is already installed (version ${installed.version}).`;
		}

		// Checked after the installed lookup so "already installed" still works
		// on a build with no gallery, and reported plainly: without this the
		// gallery miss below reads as "the extension does not exist".
		if (!this.extensionGalleryService.isEnabled()) {
			return 'No extension marketplace is configured in this build, so extensions cannot be installed. This needs an "extensionsGallery" entry in product.json.';
		}

		const [gallery] = await this.extensionsWorkbenchService.getExtensions([{ id, preRelease }], token);
		if (!gallery) {
			return `${id} does not exist in the Marketplace.${await this._suggestions(id, token)}`;
		}

		const canInstall = await this.extensionsWorkbenchService.canInstall(gallery);
		if (canInstall !== true) {
			return `${id} cannot be installed in this window: ${canInstall.value}`;
		}

		const result = await this.extensionsWorkbenchService.install(
			gallery,
			{ installPreReleaseVersion: preRelease },
			ProgressLocation.Notification
		);
		const alias = id !== requested ? ` Open VSX ships this as ${id}, not ${requested}.` : '';
		return `Installed ${result.displayName || result.name} (${id}) version ${result.version}.${alias} The window will reload so the extension can register its commands. After it comes back, run "Remote-SSH: Connect to Host..." from the Command Palette.`;
	}

	/**
	 * A wrong identifier is the common failure here, and the model cannot
	 * recover from a bare "not found". Search on the name half so it gets
	 * real identifiers to choose from instead of guessing again.
	 */
	private async _suggestions(id: string, token: CancellationToken): Promise<string> {
		try {
			const page = await this.extensionsWorkbenchService.queryGallery(
				{ text: id.split('.').pop() ?? id, pageSize: MAX_SUGGESTIONS },
				token
			);
			const matches = page.firstPage
				.slice(0, MAX_SUGGESTIONS)
				.map(extension => `${extension.identifier.id} (${extension.displayName})`);
			return matches.length > 0 ? ` Closest Marketplace matches: ${matches.join(', ')}.` : '';
		} catch {
			// A failed search must not mask the original "not found".
			return '';
		}
	}
}
