/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tracks the ordered patch set that composes the agent's current working
 * revision within one driver session.
 *
 * This exists because of a specific, easy-to-miss rule in
 * docs/hackercode/operations.md: "The current loader does not recursively
 * load parent revisions ... Authors who want cumulative behavior must submit
 * the complete selected patch set." If a tool naively forwarded only the
 * patches mentioned in the model's latest call, defining a second tool would
 * silently drop the first one out of the active revision. This tracker keeps
 * the full ordered set locally (upsert by name) so every `createRevision`
 * call submits everything that should still be active.
 */
export class AgentPatchSet {
	/**
	 * @param {{ name: string, content: string }[]} [initialPatches]
	 */
	constructor(initialPatches = []) {
		this.patches = initialPatches.map(patch => ({ ...patch }));
	}

	/**
	 * Adds a patch, or replaces the existing patch with the same name,
	 * preserving that patch's position in the ordered set.
	 */
	upsert(patch) {
		const index = this.patches.findIndex(existing => existing.name === patch.name);
		if (index >= 0) {
			this.patches[index] = { ...patch };
		} else {
			this.patches.push({ ...patch });
		}
		return this.list();
	}

	upsertMany(patches) {
		for (const patch of patches) {
			this.upsert(patch);
		}
		return this.list();
	}

	remove(name) {
		this.patches = this.patches.filter(existing => existing.name !== name);
		return this.list();
	}

	list() {
		return this.patches.map(patch => ({ ...patch }));
	}

	reset(patches = []) {
		this.patches = patches.map(patch => ({ ...patch }));
	}
}
