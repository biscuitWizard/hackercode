/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare module 'vscode' {

	/**
	 * A value that can be safely transferred through the HackerCode extension API.
	 *
	 * Values returned by renderer evaluation are serialized into this shape.
	 * Unsupported values, circular references, and values that exceed serialization
	 * limits are represented by descriptive strings.
	 */
	export type HackerCodeJsonValue =
		| null
		| boolean
		| number
		| string
		| readonly HackerCodeJsonValue[]
		| { readonly [key: string]: HackerCodeJsonValue };

	/**
	 * Source for one patch in a HackerCode revision.
	 */
	export interface HackerCodePatchSource {
		/**
		 * The stable, human-readable patch name.
		 */
		readonly name: string;

		/**
		 * JavaScript source for an ESM patch module. The module must export a
		 * default patch factory and perform reversible mutations through the
		 * context passed to that factory.
		 */
		readonly content: string;
	}

	/**
	 * Stored metadata for one patch in a HackerCode revision.
	 */
	export interface HackerCodePatchDescriptor {
		/**
		 * The stable, human-readable patch name.
		 */
		readonly name: string;

		/**
		 * The file name used by HackerCode's revision storage.
		 */
		readonly fileName: string;

		/**
		 * The lowercase SHA-256 digest of the patch content.
		 */
		readonly sha256: string;

		/**
		 * The patch size in bytes.
		 */
		readonly size: number;
	}

	/**
	 * A stored HackerCode revision.
	 */
	export interface HackerCodeRevision {
		readonly schemaVersion: 1;
		readonly id: string;
		readonly baseline: string;
		readonly createdAt: string;
		readonly description?: string;
		readonly parentId: string;
		readonly patches: readonly HackerCodePatchDescriptor[];
	}

	/**
	 * A HackerCode revision that cannot currently be activated.
	 */
	export interface HackerCodeQuarantinedRevision {
		readonly revisionId: string;
		readonly quarantinedAt: string;
		readonly reason?: string;
	}

	/**
	 * An in-progress HackerCode renderer boot.
	 */
	export interface HackerCodeBootAttempt {
		readonly revisionId: string;
		readonly windowId?: number;
		readonly startedAt: string;
	}

	/**
	 * Information about the current source checkout.
	 */
	export interface HackerCodeBaselineInfo {
		/**
		 * The current source-control baseline, when it can be determined.
		 */
		readonly current: string | undefined;

		/**
		 * Whether promoting a revision is supported by this source checkout.
		 */
		readonly promotionAvailable: boolean;
	}

	/**
	 * The current HackerCode control state.
	 */
	export interface HackerCodeState {
		readonly schemaVersion: 1;
		readonly activeRevisionId: string;
		readonly lastKnownGoodRevisionId: string;
		readonly revisions: readonly HackerCodeRevision[];
		readonly quarantinedRevisions: readonly HackerCodeQuarantinedRevision[];
		readonly bootAttempt?: HackerCodeBootAttempt;

		/**
		 * Whether source-controlled promoted patches are skipped for emergency recovery.
		 */
		readonly skipPromoted?: boolean;

		readonly baseline: HackerCodeBaselineInfo;
	}

	/**
	 * Options for creating a HackerCode revision.
	 */
	export interface HackerCodeCreateRevisionOptions {
		/**
		 * The source-control baseline against which every patch was produced.
		 */
		readonly baseline: string;

		readonly description?: string;
		readonly parentId?: string;
		readonly patches: readonly HackerCodePatchSource[];
	}

	/**
	 * The result of promoting the active HackerCode revision into the source checkout.
	 */
	export interface HackerCodePromoteResult {
		readonly revisionId: string;
		readonly previousHead: string;
		readonly newHead: string;
		readonly commitMessage: string;
	}

	/**
	 * Privileged HackerCode revision and renderer controls.
	 *
	 * This namespace is available only to extensions enabled for the `hackerCode`
	 * proposed API and while HackerCode control mode is enabled. It intentionally
	 * does not expose the control endpoint or its authorization token.
	 */
	export namespace hackerCode {
		/**
		 * Gets the current HackerCode state, including the source baseline and revisions.
		 */
		export function getState(): Thenable<HackerCodeState>;

		/**
		 * Lists all known HackerCode revisions.
		 */
		export function listRevisions(): Thenable<readonly HackerCodeRevision[]>;

		/**
		 * Gets a HackerCode revision by identifier.
		 *
		 * @param revisionId The revision identifier.
		 */
		export function getRevision(revisionId: string): Thenable<HackerCodeRevision | undefined>;

		/**
		 * Creates a stored HackerCode revision without activating it.
		 */
		export function createRevision(options: HackerCodeCreateRevisionOptions): Thenable<HackerCodeRevision>;

		/**
		 * Activates a HackerCode revision and reloads the current renderer window.
		 */
		export function selectRevision(revisionId: string): Thenable<HackerCodeState>;

		/**
		 * Enters HackerCode safe mode and reloads the current renderer window.
		 *
		 * @param reason An optional reason recorded with the recovery operation.
		 */
		export function enterSafeMode(reason?: string): Thenable<HackerCodeState>;

		/**
		 * Evaluates JavaScript source in the privileged HackerCode renderer runtime.
		 *
		 * The source is the body of an async function. It can access `runtime`,
		 * `instantiationService`, `getService`, and `refresh`. Its return value is
		 * converted to bounded JSON-safe data.
		 */
		export function evaluate(source: string): Thenable<HackerCodeJsonValue>;

		/**
		 * Refreshes applied HackerCode patches in the current renderer.
		 */
		export function refresh(mode: 'soft' | 'hard'): Thenable<void>;

		/**
		 * Refreshes one eligible renderer module.
		 *
		 * @param mode The module refresh mode.
		 * @param specifier The eligible module specifier to refresh.
		 */
		export function refresh(mode: 'module', specifier: string): Thenable<void>;

		/**
		 * Promotes the active non-pristine revision into the current source checkout.
		 *
		 * The main-process HackerCode control service owns applying and committing the
		 * promoted patches. Promotion is unavailable in built products.
		 */
		export function promoteActiveRevision(commitMessage?: string): Thenable<HackerCodePromoteResult>;
	}
}
