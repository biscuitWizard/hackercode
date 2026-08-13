/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const protectedHackerCodeObjects = new WeakSet<object>();

/**
 * Brands a HackerCode control-plane object so patch contexts cannot mutate it.
 *
 * This is a narrow guard for known objects, not a sandbox: arbitrary object
 * provenance cannot be inferred. The revision-load task adds the module-import
 * guard that prevents patches from importing control-plane modules directly.
 */
export function protectHackerCodeObject(target: object): void {
	protectedHackerCodeObjects.add(target);
}

/**
 * Returns whether an object is part of the protected HackerCode control plane.
 */
export function isProtectedHackerCodeObject(target: object): boolean {
	return protectedHackerCodeObjects.has(target);
}
