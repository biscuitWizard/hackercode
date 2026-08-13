/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ProxyChannel } from '../../../base/parts/ipc/common/ipc.js';
import { InstantiationType, registerSingleton } from '../../instantiation/common/extensions.js';
import { IMainProcessService } from '../../ipc/common/mainProcessService.js';
import { IHackerCodeControlService } from '../common/hackerCode.js';

// @ts-expect-error: interface is implemented by the main-process proxy returned from the constructor
export class NativeHackerCodeControlService implements IHackerCodeControlService {
	declare readonly _serviceBrand: undefined;

	constructor(@IMainProcessService mainProcessService: IMainProcessService) {
		return ProxyChannel.toService<IHackerCodeControlService>(mainProcessService.getChannel('hackercodeControl'));
	}
}

registerSingleton(IHackerCodeControlService, NativeHackerCodeControlService, InstantiationType.Delayed);
