/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Node/JS port of src/vs/base/common/sseParser.ts, kept behaviorally identical
 * (same incremental `feed(chunk)` contract) so the driver's SSE handling
 * matches the one already reviewed and tested in the workbench. This file
 * intentionally does not import the TypeScript source: Node runs this script
 * directly, without the workbench's build pipeline.
 *
 * @see https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation
 */

const CR = 13; // '\r'
const LF = 10; // '\n'

export class SSEParser {
	/**
	 * @param {(event: { type: string, data: string, id?: string, retry?: number }) => void} onEvent
	 */
	constructor(onEvent) {
		this.dataBuffer = '';
		this.eventTypeBuffer = '';
		this.currentEventId = undefined;
		this.lastEventIdBuffer = undefined;
		this.reconnectionTime = undefined;
		this.buffer = [];
		this.endedOnCR = false;
		this.onEventHandler = onEvent;
		this.decoder = new TextDecoder('utf-8');
	}

	getLastEventId() {
		return this.lastEventIdBuffer;
	}

	getReconnectionTime() {
		return this.reconnectionTime;
	}

	/**
	 * @param {Uint8Array} chunk
	 */
	feed(chunk) {
		if (chunk.length === 0) {
			return;
		}

		let offset = 0;

		if (this.endedOnCR && chunk[0] === LF) {
			offset++;
		}
		this.endedOnCR = false;

		while (offset < chunk.length) {
			const indexCR = chunk.indexOf(CR, offset);
			const indexLF = chunk.indexOf(LF, offset);
			const index = indexCR === -1 ? indexLF : (indexLF === -1 ? indexCR : Math.min(indexCR, indexLF));
			if (index === -1) {
				break;
			}

			let str = '';
			for (const buf of this.buffer) {
				str += this.decoder.decode(buf, { stream: true });
			}
			str += this.decoder.decode(chunk.subarray(offset, index));
			this.processLine(str);

			this.buffer.length = 0;
			offset = index + (chunk[index] === CR && chunk[index + 1] === LF ? 2 : 1);
		}

		if (offset < chunk.length) {
			this.buffer.push(chunk.subarray(offset));
		} else {
			this.endedOnCR = chunk[chunk.length - 1] === CR;
		}
	}

	processLine(line) {
		if (!line.length) {
			this.dispatchEvent();
			return;
		}

		if (line.startsWith(':')) {
			return;
		}

		let field;
		let value;

		const colonIndex = line.indexOf(':');
		if (colonIndex === -1) {
			field = line;
			value = '';
		} else {
			field = line.substring(0, colonIndex);
			value = line.substring(colonIndex + 1);
			if (value.startsWith(' ')) {
				value = value.substring(1);
			}
		}

		this.processField(field, value);
	}

	processField(field, value) {
		switch (field) {
			case 'event':
				this.eventTypeBuffer = value;
				break;
			case 'data':
				this.dataBuffer += value;
				this.dataBuffer += '\n';
				break;
			case 'id':
				if (!value.includes('\0')) {
					this.currentEventId = this.lastEventIdBuffer = value;
				} else {
					this.currentEventId = undefined;
				}
				break;
			case 'retry':
				if (/^\d+$/.test(value)) {
					this.reconnectionTime = parseInt(value, 10);
				}
				break;
			// Ignore any other fields.
		}
	}

	dispatchEvent() {
		if (this.dataBuffer === '') {
			this.dataBuffer = '';
			this.eventTypeBuffer = '';
			return;
		}

		if (this.dataBuffer.endsWith('\n')) {
			this.dataBuffer = this.dataBuffer.substring(0, this.dataBuffer.length - 1);
		}

		const event = {
			type: this.eventTypeBuffer || 'message',
			data: this.dataBuffer
		};
		if (this.currentEventId !== undefined) {
			event.id = this.currentEventId;
		}
		if (this.reconnectionTime !== undefined) {
			event.retry = this.reconnectionTime;
		}

		this.onEventHandler(event);
		this.reset();
	}

	reset() {
		this.dataBuffer = '';
		this.eventTypeBuffer = '';
		this.currentEventId = undefined;
		// lastEventIdBuffer is not reset; it is used for reconnection.
	}
}
