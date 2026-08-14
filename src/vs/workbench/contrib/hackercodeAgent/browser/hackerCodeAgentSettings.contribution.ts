/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { HACKERCODE_AGENT_OPEN_SETTINGS_COMMAND_ID } from '../common/hackerCodeAgentCommands.js';
import { HackerCodeAgentSettingsEditorPane } from './hackerCodeAgentSettingsEditorPane.js';
import { HackerCodeAgentSettingsInput } from './hackerCodeAgentSettingsInput.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		HackerCodeAgentSettingsEditorPane,
		HackerCodeAgentSettingsEditorPane.ID,
		localize('hackerCodeAgentSettingsEditorPaneTitle', "HackerCode Agent Settings")
	),
	[new SyncDescriptor(HackerCodeAgentSettingsInput)]
);

/**
 * Shadows the workbench's own `Ctrl+,` (`workbench.action.openSettings`,
 * registered at `KeybindingWeight.WorkbenchContrib`) by registering a
 * distinct command at a strictly higher weight for the same chord. Keybinding
 * resolution picks the highest-weight match for a given keystroke and
 * context, so this wins without touching or duplicating the original
 * command id.
 */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: HACKERCODE_AGENT_OPEN_SETTINGS_COMMAND_ID,
			title: localize2('hackerCodeAgent.openSettings', "Open HackerCode Agent Settings"),
			category: Categories.Preferences,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib + 50,
				when: undefined,
				primary: KeyMod.CtrlCmd | KeyCode.Comma
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		await editorService.openEditor(new HackerCodeAgentSettingsInput());
	}
});
