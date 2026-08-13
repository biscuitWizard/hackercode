/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { HackerCodeControlSerializedValue } from '../common/hackerCodeControlProtocol.js';

export type HackerCodeSerializedValue = HackerCodeControlSerializedValue;

export interface IHackerCodeSerializerOptions {
	readonly maxDepth?: number;
	readonly maxBreadth?: number;
	readonly maxBytes?: number;
}

const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_BREADTH = 100;
const DEFAULT_MAX_BYTES = 1024 * 1024;

/**
 * Converts privileged eval results to bounded JSON data without invoking
 * getters. Non-plain workbench and DOM instances are represented by a type
 * summary instead of recursively exposing their internals.
 */
export function serializeHackerCodeControlValue(
	value: unknown,
	options: IHackerCodeSerializerOptions = {}
): HackerCodeSerializedValue {
	const maxDepth = normalizeLimit(options.maxDepth, DEFAULT_MAX_DEPTH);
	const maxBreadth = normalizeLimit(options.maxBreadth, DEFAULT_MAX_BREADTH);
	const maxBytes = normalizeLimit(options.maxBytes, DEFAULT_MAX_BYTES);
	const ancestors = new Set<object>();
	const serialized = serializeValue(value, 0, maxDepth, maxBreadth, ancestors);
	const byteLength = new TextEncoder().encode(JSON.stringify(serialized)).byteLength;
	if (byteLength > maxBytes) {
		return `[Truncated: serialized result exceeded ${maxBytes} bytes]`;
	}
	return serialized;
}

function serializeValue(
	value: unknown,
	depth: number,
	maxDepth: number,
	maxBreadth: number,
	ancestors: Set<object>
): HackerCodeSerializedValue {
	switch (typeof value) {
		case 'undefined':
			return '[undefined]';
		case 'boolean':
		case 'string':
			return value;
		case 'number':
			return Number.isFinite(value) ? value : `[${String(value)}]`;
		case 'bigint':
			return `${value}n`;
		case 'symbol':
			return `[Symbol(${value.description ?? ''})]`;
		case 'function': {
			const name = readStringDescriptor(safeGetOwnDescriptor(value, 'name'));
			return `[Function${name ? ` ${name}` : ''}]`;
		}
		case 'object':
			break;
		default:
			return `[${typeof value}]`;
	}

	if (value === null) {
		return null;
	}
	if (ancestors.has(value)) {
		return '[Circular]';
	}
	if (depth >= maxDepth) {
		return `[Truncated: ${getConstructorName(value)}]`;
	}

	if (value instanceof Error) {
		return serializeError(value);
	}

	const prototype = safeGetPrototypeOf(value);
	const isArray = Array.isArray(value);
	if (!isArray && prototype !== Object.prototype && prototype !== null) {
		return summarizeInstance(value);
	}

	let descriptors: PropertyDescriptorMap;
	try {
		descriptors = Object.getOwnPropertyDescriptors(value);
	} catch {
		return `[Uninspectable: ${getConstructorName(value)}]`;
	}

	ancestors.add(value);
	try {
		if (isArray) {
			return serializeArray(descriptors, depth, maxDepth, maxBreadth, ancestors);
		}
		return serializeObject(descriptors, depth, maxDepth, maxBreadth, ancestors);
	} finally {
		ancestors.delete(value);
	}
}

function serializeArray(
	descriptors: PropertyDescriptorMap,
	depth: number,
	maxDepth: number,
	maxBreadth: number,
	ancestors: Set<object>
): HackerCodeSerializedValue {
	const lengthDescriptor = descriptors.length;
	const length = lengthDescriptor && hasOwnProperty(lengthDescriptor, 'value') && typeof lengthDescriptor.value === 'number'
		? lengthDescriptor.value
		: 0;
	const itemCount = Math.min(length, maxBreadth);
	const result: HackerCodeSerializedValue[] = [];
	for (let index = 0; index < itemCount; index++) {
		const descriptor = descriptors[String(index)];
		result.push(descriptor ? serializeDescriptor(descriptor, depth, maxDepth, maxBreadth, ancestors) : '[Empty]');
	}
	if (length > itemCount) {
		result.push(`[Truncated: ${length - itemCount} more items]`);
	}
	return result;
}

function serializeObject(
	descriptors: PropertyDescriptorMap,
	depth: number,
	maxDepth: number,
	maxBreadth: number,
	ancestors: Set<object>
): HackerCodeSerializedValue {
	const keys = Object.keys(descriptors);
	const result: { [key: string]: HackerCodeSerializedValue } = Object.create(null);
	for (const key of keys.slice(0, maxBreadth)) {
		result[key] = serializeDescriptor(descriptors[key], depth, maxDepth, maxBreadth, ancestors);
	}
	if (keys.length > maxBreadth) {
		const markerKey = hasOwnProperty(result, '$truncated') ? '$hackerCodeTruncated' : '$truncated';
		result[markerKey] = `${keys.length - maxBreadth} more properties`;
	}
	return result;
}

function serializeDescriptor(
	descriptor: PropertyDescriptor,
	depth: number,
	maxDepth: number,
	maxBreadth: number,
	ancestors: Set<object>
): HackerCodeSerializedValue {
	if (!hasOwnProperty(descriptor, 'value')) {
		if (descriptor.get && descriptor.set) {
			return '[Getter/Setter]';
		}
		return descriptor.get ? '[Getter]' : '[Setter]';
	}
	return serializeValue(descriptor.value, depth + 1, maxDepth, maxBreadth, ancestors);
}

function serializeError(error: Error): HackerCodeSerializedValue {
	const descriptors = safeGetDescriptors(error);
	if (!descriptors) {
		return `[Uninspectable: ${getConstructorName(error)}]`;
	}
	const name = readStringDescriptor(descriptors.name) ?? getConstructorName(error);
	const message = readStringDescriptor(descriptors.message) ?? '';
	const stack = readStringDescriptor(descriptors.stack);
	return {
		name,
		message,
		...(stack === undefined ? {} : { stack })
	};
}

function summarizeInstance(value: object): HackerCodeSerializedValue {
	const descriptors = safeGetDescriptors(value);
	const tagName = descriptors ? readStringDescriptor(descriptors.tagName) : undefined;
	return {
		$type: getConstructorName(value),
		...(tagName === undefined ? {} : { tagName })
	};
}

function getConstructorName(value: object): string {
	const prototype = safeGetPrototypeOf(value);
	let descriptor: PropertyDescriptor | undefined;
	try {
		descriptor = prototype ? Object.getOwnPropertyDescriptor(prototype, 'constructor') : undefined;
	} catch {
		return 'Object';
	}
	const constructor = descriptor && hasOwnProperty(descriptor, 'value') ? descriptor.value : undefined;
	return typeof constructor === 'function' && constructor.name ? constructor.name : 'Object';
}

function safeGetPrototypeOf(value: object): object | null | undefined {
	try {
		return Object.getPrototypeOf(value);
	} catch {
		return undefined;
	}
}

function safeGetDescriptors(value: object): PropertyDescriptorMap | undefined {
	try {
		return Object.getOwnPropertyDescriptors(value);
	} catch {
		return undefined;
	}
}

function safeGetOwnDescriptor(value: object, key: PropertyKey): PropertyDescriptor | undefined {
	try {
		return Object.getOwnPropertyDescriptor(value, key);
	} catch {
		return undefined;
	}
}

function readStringDescriptor(descriptor: PropertyDescriptor | undefined): string | undefined {
	return descriptor && hasOwnProperty(descriptor, 'value') && typeof descriptor.value === 'string' ? descriptor.value : undefined;
}

function hasOwnProperty<T extends object, K extends PropertyKey>(value: T, key: K): value is T & Record<K, unknown> {
	return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeLimit(value: number | undefined, fallback: number): number {
	return value === undefined || !Number.isSafeInteger(value) || value < 1 ? fallback : value;
}
