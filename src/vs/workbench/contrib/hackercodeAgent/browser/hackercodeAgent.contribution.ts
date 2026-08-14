/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewDescriptor, IViewsRegistry, ViewContainer, ViewContainerLocation } from '../../../common/views.js';
import '../common/hackerCodeAgentConfiguration.js';
import { HackerCodeAgentViewPane } from './hackerCodeAgentViewPane.js';
import './hackerCodeAgentProviderSync.js';
import './hackerCodeAgentSettings.contribution.js';
import './hackerCodeAgentTransportService.js';

const hackerCodeAgentViewIcon = registerIcon('hackercode-agent-view-icon', Codicon.hubot, localize('hackerCodeAgentViewIcon', "Icon for the HackerCode agent view."));

export const HackerCodeAgentViewContainerId = 'workbench.view.hackerCodeAgent.container';

const hackerCodeAgentViewContainer: ViewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: HackerCodeAgentViewContainerId,
	title: localize2('hackerCodeAgentViewContainer.label', "HackerCode Agent"),
	icon: hackerCodeAgentViewIcon,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [HackerCodeAgentViewContainerId, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: HackerCodeAgentViewContainerId,
	hideIfEmpty: true,
	order: 5
}, ViewContainerLocation.AuxiliaryBar, { doNotRegisterOpenCommand: true });

const hackerCodeAgentViewDescriptor: IViewDescriptor = {
	id: HackerCodeAgentViewPane.ID,
	containerIcon: hackerCodeAgentViewContainer.icon,
	containerTitle: hackerCodeAgentViewContainer.title.value,
	singleViewPaneContainerTitle: hackerCodeAgentViewContainer.title.value,
	name: localize2('hackerCodeAgentView.label', "HackerCode Agent"),
	canToggleVisibility: false,
	canMoveView: true,
	openCommandActionDescriptor: {
		id: HackerCodeAgentViewContainerId,
		title: hackerCodeAgentViewContainer.title,
		order: 5
	},
	ctorDescriptor: new SyncDescriptor(HackerCodeAgentViewPane)
};

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([hackerCodeAgentViewDescriptor], hackerCodeAgentViewContainer);
