/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { EditorInputCapabilities } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';

const hackerCodeAgentSettingsIcon = registerIcon('hackercode-agent-settings', Codicon.settingsGear, localize('hackerCodeAgentSettingsIcon', "Icon for HackerCode agent settings."));

export class HackerCodeAgentSettingsInput extends EditorInput {

	static readonly ID = 'workbench.input.hackerCodeAgentSettings';
	static readonly RESOURCE = URI.from({ scheme: 'hackercode-agent-settings', path: '/settings' });

	override get typeId(): string {
		return HackerCodeAgentSettingsInput.ID;
	}

	override get editorId(): string | undefined {
		return this.typeId;
	}

	override get resource(): URI | undefined {
		return HackerCodeAgentSettingsInput.RESOURCE;
	}

	override getName(): string {
		return localize('hackerCodeAgentSettingsTitle', "HackerCode Agent Settings");
	}

	override getIcon(): ThemeIcon | undefined {
		return hackerCodeAgentSettingsIcon;
	}

	override matches(other: EditorInput | unknown): boolean {
		return other instanceof HackerCodeAgentSettingsInput;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Singleton;
	}
}
