/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ProxyChannel } from '../../../base/parts/ipc/common/ipc.js';
import { InstantiationType, registerSingleton } from '../../instantiation/common/extensions.js';
import { IMainProcessService } from '../../ipc/common/mainProcessService.js';
import { HACKERCODE_CHAT_RELAY_CHANNEL, IHackerCodeChatRelayService } from '../common/hackerCodeChat.js';

// @ts-expect-error: interface is implemented by the main-process proxy returned from the constructor
export class NativeHackerCodeChatRelayService implements IHackerCodeChatRelayService {
	declare readonly _serviceBrand: undefined;

	constructor(@IMainProcessService mainProcessService: IMainProcessService) {
		return ProxyChannel.toService<IHackerCodeChatRelayService>(mainProcessService.getChannel(HACKERCODE_CHAT_RELAY_CHANNEL));
	}
}

registerSingleton(IHackerCodeChatRelayService, NativeHackerCodeChatRelayService, InstantiationType.Delayed);
