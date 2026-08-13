/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getErrorMessage } from '../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { CommandsRegistry, ICommandHandler } from '../../../../platform/commands/common/commands.js';
import { IHackerCodeModuleLoaderService } from '../../../../platform/hackercode/browser/hackerCodeRefresh.js';
import { IHackerCodeControlService } from '../../../../platform/hackercode/common/hackerCode.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService, _util } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { isProtectedHackerCodeObject, protectHackerCodeObject } from './hackerCodePatchProtection.js';

type HackerCodePatchMethod = (...arguments_: never[]) => unknown;

/**
 * The mutation surface available to a HackerCode patch.
 */
export interface IHackerCodePatchContext {
	defineProperty(target: object, key: PropertyKey, descriptor: PropertyDescriptor): void;
	patchMethod<T extends object, K extends keyof T>(
		target: T,
		key: K,
		wrap: (original: Extract<T[K], HackerCodePatchMethod>) => Extract<T[K], HackerCodePatchMethod>
	): void;
	track<T extends IDisposable>(disposable: T): T;
	registerCommand<Args extends unknown[]>(id: string, handler: ICommandHandler<Args>): IDisposable;
	addStatusBarEntry(entry: IStatusbarEntry, id: string, alignment: StatusbarAlignment, priority?: number): IStatusbarEntryAccessor;
	getService(name: string): object;
	/**
	 * Imports a guarded renderer module namespace. This boundary is not a
	 * sandbox: ordinary reachable services can still expose significant power.
	 */
	import(specifier: string): Promise<object>;
}

/**
 * A renderer patch that has been prepared for application.
 *
 * `key` is a content hash or version and must change when the factory's
 * behavior changes. Patch factories must perform reversible side effects only
 * through the supplied context so convergence can roll back atomically.
 */
export interface IHackerCodePreparedPatch {
	readonly id: string;
	readonly name: string;
	readonly key?: string;
	readonly factory: (context: IHackerCodePatchContext) => void | Promise<void>;
}

export const IHackerCodePatchRegistry = createDecorator<IHackerCodePatchRegistry>('hackerCodePatchRegistry');

/**
 * Applies and owns the active ordered set of renderer patches.
 */
export interface IHackerCodePatchRegistry {
	readonly _serviceBrand: undefined;
	readonly onDidChangeAppliedPatches: Event<readonly IHackerCodePreparedPatch[]>;

	applySet(patches: readonly IHackerCodePreparedPatch[]): Promise<void>;
	revertAll(): Promise<void>;
	getAppliedPatches(): readonly IHackerCodePreparedPatch[];

	/**
	 * Registers the asynchronous preparation and application for a revision.
	 * A later registration for the same revision supersedes an earlier one.
	 */
	prepareRevision(revisionId: string, patches: readonly IHackerCodePreparedPatch[] | PromiseLike<readonly IHackerCodePreparedPatch[]>): Promise<void>;

	/**
	 * Resolves when the registered patch set for a revision has been applied.
	 * Revisions without a registered preparation are immediately ready.
	 */
	whenRevisionReady(revisionId: string): Promise<void>;
}

interface IAppliedPatch {
	readonly patch: IHackerCodePreparedPatch;
	readonly context: HackerCodePatchContext;
}

interface IRevisionReadiness {
	readonly token: object;
	readonly promise: Promise<void>;
}

class HackerCodePatchApplicationError extends Error {
	constructor(
		readonly patch: IHackerCodePreparedPatch,
		readonly applicationError: unknown,
		readonly rollbackErrors: readonly unknown[]
	) {
		const rollbackMessage = rollbackErrors.length === 0 ? '' : ` Rollback also reported ${rollbackErrors.length} error(s).`;
		super(`HackerCode patch '${patch.name}' (${patch.id}) failed: ${getErrorMessage(applicationError)}.${rollbackMessage}`);
		this.name = 'HackerCodePatchApplicationError';
	}
}

function isObject(value: unknown): value is object {
	return value !== null && (typeof value === 'object' || typeof value === 'function');
}

function hasOwnProperty<T extends object, K extends PropertyKey>(value: T, key: K): value is T & Record<K, unknown> {
	return Object.prototype.hasOwnProperty.call(value, key);
}

function snapshotPatch(patch: IHackerCodePreparedPatch): IHackerCodePreparedPatch {
	return Object.freeze({
		id: patch.id,
		name: patch.name,
		key: patch.key,
		factory: patch.factory
	});
}

function protectInstalledRuntime(): void {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, '$hackercode');
	if (descriptor && isObject(descriptor.value)) {
		protectHackerCodeObject(descriptor.value);
	}
}

function assertReversibleDescriptor(original: PropertyDescriptor | undefined, descriptor: PropertyDescriptor): void {
	if (!original) {
		if (descriptor.configurable !== true) {
			throw new Error('A newly defined patch property must be configurable so it can be removed');
		}
		return;
	}

	if (original.configurable) {
		if (descriptor.configurable === false) {
			throw new Error('A patch cannot make a configurable property non-configurable');
		}
		return;
	}

	if (descriptor.configurable === true || (descriptor.enumerable !== undefined && descriptor.enumerable !== original.enumerable)) {
		throw new Error('A patch cannot change fixed property attributes');
	}

	if (hasOwnProperty(original, 'value')) {
		if (hasOwnProperty(descriptor, 'get') || hasOwnProperty(descriptor, 'set')) {
			throw new Error('A patch cannot replace a fixed data property with an accessor');
		}
		if (original.writable && descriptor.writable === false) {
			throw new Error('A patch cannot make a fixed writable property read-only');
		}
	} else if (hasOwnProperty(descriptor, 'value') || hasOwnProperty(descriptor, 'writable')) {
		throw new Error('A patch cannot replace a fixed accessor with a data property');
	}
}

class HackerCodePatchContext implements IHackerCodePatchContext {
	private readonly disposables = new DisposableStore();
	private readonly trackedDisposables = new Set<IDisposable>();
	private readonly undoStack: Array<() => void> = [];
	private active = true;

	constructor(
		private readonly instantiationService: IInstantiationService,
		private readonly statusbarService: IStatusbarService,
		private readonly moduleLoaderService: IHackerCodeModuleLoaderService
	) {
		protectHackerCodeObject(this);
	}

	defineProperty(target: object, key: PropertyKey, descriptor: PropertyDescriptor): void {
		this.assertActive();
		this.assertMutable(target);

		const original = Object.getOwnPropertyDescriptor(target, key);
		assertReversibleDescriptor(original, descriptor);
		Object.defineProperty(target, key, descriptor);
		this.undoStack.push(() => this.restoreDescriptor(target, key, original));
	}

	patchMethod<T extends object, K extends keyof T>(
		target: T,
		key: K,
		wrap: (original: Extract<T[K], HackerCodePatchMethod>) => Extract<T[K], HackerCodePatchMethod>
	): void {
		this.assertActive();
		this.assertMutable(target);

		const descriptor = Object.getOwnPropertyDescriptor(target, key);
		if (!descriptor || !hasOwnProperty(descriptor, 'value') || typeof descriptor.value !== 'function') {
			throw new Error(`Patch method '${String(key)}' must be an own callable data property`);
		}

		const original = descriptor.value as Extract<T[K], HackerCodePatchMethod>;
		const wrapped = wrap(original);
		if (typeof wrapped !== 'function') {
			throw new Error(`Patch method wrapper for '${String(key)}' must return a callable value`);
		}

		Object.defineProperty(target, key, { ...descriptor, value: wrapped });
		this.undoStack.push(() => Object.defineProperty(target, key, descriptor));
	}

	track<T extends IDisposable>(disposable: T): T {
		this.assertActive();
		if (this.trackedDisposables.has(disposable)) {
			return disposable;
		}

		this.trackedDisposables.add(disposable);
		this.disposables.add(disposable);
		this.undoStack.push(() => {
			if (this.trackedDisposables.delete(disposable)) {
				this.disposables.deleteAndLeak(disposable);
				disposable.dispose();
			}
		});
		return disposable;
	}

	registerCommand<Args extends unknown[]>(id: string, handler: ICommandHandler<Args>): IDisposable {
		return this.track(CommandsRegistry.registerCommand(id, handler));
	}

	addStatusBarEntry(entry: IStatusbarEntry, id: string, alignment: StatusbarAlignment, priority?: number): IStatusbarEntryAccessor {
		return this.track(this.statusbarService.addEntry(entry, id, alignment, priority));
	}

	getService(name: string): object {
		this.assertActive();
		if (!name) {
			throw new Error('A service name is required');
		}

		const serviceIdentifier = _util.serviceIds.get(name);
		if (!serviceIdentifier) {
			throw new Error(`Unknown service '${name}'`);
		}

		const service = this.instantiationService.invokeFunction(accessor => accessor.get(serviceIdentifier));
		if (!isObject(service)) {
			throw new Error(`Service '${name}' did not resolve to an object`);
		}
		if (name.toLowerCase().includes('hackercode')) {
			protectHackerCodeObject(service);
		}
		return service;
	}

	import(specifier: string): Promise<object> {
		this.assertActive();
		return this.moduleLoaderService.import(specifier);
	}

	revert(): readonly unknown[] {
		if (!this.active) {
			return [];
		}
		this.active = false;

		const errors: unknown[] = [];
		for (let index = this.undoStack.length - 1; index >= 0; index--) {
			try {
				this.undoStack[index]();
			} catch (error) {
				errors.push(error);
			}
		}
		this.undoStack.length = 0;

		try {
			this.disposables.dispose();
		} catch (error) {
			errors.push(error);
		}
		this.trackedDisposables.clear();
		return errors;
	}

	private assertActive(): void {
		if (!this.active) {
			throw new Error('This HackerCode patch context has already been reverted');
		}
	}

	private assertMutable(target: object): void {
		if (isProtectedHackerCodeObject(target)) {
			throw new Error('HackerCode patches cannot mutate protected runtime or control objects');
		}
	}

	private restoreDescriptor(target: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined): void {
		if (descriptor) {
			Object.defineProperty(target, key, descriptor);
		} else if (!Reflect.deleteProperty(target, key)) {
			throw new Error(`Unable to remove patched property '${String(key)}'`);
		}
	}
}

/**
 * Desktop renderer implementation of the HackerCode patch registry.
 */
export class HackerCodePatchRegistry extends Disposable implements IHackerCodePatchRegistry {
	declare readonly _serviceBrand: undefined;

	private readonly onDidChangeAppliedPatchesEmitter = this._register(new Emitter<readonly IHackerCodePreparedPatch[]>());
	readonly onDidChangeAppliedPatches = this.onDidChangeAppliedPatchesEmitter.event;

	private appliedPatches: IAppliedPatch[] = [];
	private operation = Promise.resolve();
	private pendingOperations = 0;
	private disposed = false;
	private readonly revisionReadiness = new Map<string, IRevisionReadiness>();

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IHackerCodeModuleLoaderService private readonly moduleLoaderService: IHackerCodeModuleLoaderService,
		@IHackerCodeControlService controlService: IHackerCodeControlService,
		@ILogService private readonly logService: ILogService
	) {
		super();
		protectHackerCodeObject(this);
		protectHackerCodeObject(controlService);
		protectInstalledRuntime();
	}

	applySet(patches: readonly IHackerCodePreparedPatch[]): Promise<void> {
		const target = patches.map(snapshotPatch);
		return this.enqueue(async () => {
			this.assertNotDisposed();
			this.validateTarget(target);
			if (this.isCurrentSet(target)) {
				return;
			}
			await this.converge(target);
		});
	}

	revertAll(): Promise<void> {
		return this.enqueue(async () => {
			this.assertNotDisposed();
			this.revertCurrentSet(true);
		});
	}

	getAppliedPatches(): readonly IHackerCodePreparedPatch[] {
		return this.appliedPatches.map(applied => applied.patch);
	}

	prepareRevision(revisionId: string, patches: readonly IHackerCodePreparedPatch[] | PromiseLike<readonly IHackerCodePreparedPatch[]>): Promise<void> {
		if (!revisionId) {
			return Promise.reject(new Error('A revision id is required'));
		}

		const token = {};
		const promise = (async () => {
			const preparedPatches = await patches;
			if (this.revisionReadiness.get(revisionId)?.token !== token) {
				return;
			}
			await this.applySet(preparedPatches);
		})();
		this.revisionReadiness.set(revisionId, { token, promise });
		return promise;
	}

	whenRevisionReady(revisionId: string): Promise<void> {
		return this.revisionReadiness.get(revisionId)?.promise ?? Promise.resolve();
	}

	override dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.revisionReadiness.clear();

		if (this.pendingOperations === 0) {
			try {
				this.revertCurrentSet(false);
			} catch (error) {
				this.logService.error('[HackerCode] Failed to revert patches while disposing the registry.', error);
			}
		} else {
			const cleanup = this.operation.then(
				() => this.revertCurrentSet(false),
				() => this.revertCurrentSet(false)
			);
			this.operation = cleanup.catch(error => {
				this.logService.error('[HackerCode] Failed to revert patches while disposing the registry.', error);
			});
		}

		super.dispose();
	}

	private enqueue(operation: () => Promise<void>): Promise<void> {
		this.pendingOperations++;
		const run = async () => {
			try {
				await operation();
			} finally {
				this.pendingOperations--;
			}
		};
		const result = this.operation.then(run, run);
		this.operation = result.catch(() => undefined);
		return result;
	}

	private async converge(target: readonly IHackerCodePreparedPatch[]): Promise<void> {
		const previousPatches = this.getAppliedPatches();
		const previousRecords = this.appliedPatches;
		this.appliedPatches = [];

		const previousRevertErrors = this.revertRecords(previousRecords, 'reverting the previous patch set');
		if (previousRevertErrors.length > 0) {
			this.fireChange();
			throw new AggregateError(previousRevertErrors, 'Unable to revert the previous HackerCode patch set');
		}

		const targetRecords: IAppliedPatch[] = [];
		try {
			for (const patch of target) {
				targetRecords.push(await this.applyPatch(patch));
			}
		} catch (applicationError) {
			const errors: unknown[] = [applicationError];
			errors.push(...this.revertRecords(targetRecords, 'rolling back the target patch set'));

			const restoredRecords: IAppliedPatch[] = [];
			let restored = true;
			try {
				for (const patch of previousPatches) {
					restoredRecords.push(await this.applyPatch(patch));
				}
			} catch (restoreError) {
				restored = false;
				errors.push(restoreError);
				errors.push(...this.revertRecords(restoredRecords, 'rolling back restoration of the previous patch set'));
			}

			this.appliedPatches = restored ? restoredRecords : [];
			if (!restored && previousPatches.length > 0) {
				this.fireChange();
			}

			const message = restored
				? 'Unable to apply the target HackerCode patch set; the previous set was restored'
				: 'Unable to apply the target HackerCode patch set or restore the previous set';
			throw new AggregateError(errors, `${message}: ${getErrorMessage(applicationError)}`);
		}

		this.appliedPatches = targetRecords;
		this.fireChange();
	}

	private async applyPatch(patch: IHackerCodePreparedPatch): Promise<IAppliedPatch> {
		protectInstalledRuntime();
		const context = new HackerCodePatchContext(this.instantiationService, this.statusbarService, this.moduleLoaderService);
		try {
			await patch.factory(context);
			return { patch, context };
		} catch (applicationError) {
			const rollbackErrors = context.revert();
			this.logRevertErrors(`rolling back failed patch '${patch.id}'`, rollbackErrors);
			throw new HackerCodePatchApplicationError(patch, applicationError, rollbackErrors);
		}
	}

	private revertCurrentSet(fireEvent: boolean): void {
		if (this.appliedPatches.length === 0) {
			return;
		}

		const records = this.appliedPatches;
		this.appliedPatches = [];
		const errors = this.revertRecords(records, 'reverting all patches');
		if (fireEvent) {
			this.fireChange();
		}
		if (errors.length > 0) {
			throw new AggregateError(errors, 'Unable to fully revert the HackerCode patch set');
		}
	}

	private revertRecords(records: readonly IAppliedPatch[], operation: string): readonly unknown[] {
		const errors: unknown[] = [];
		for (let index = records.length - 1; index >= 0; index--) {
			const applied = records[index];
			const patchErrors = applied.context.revert();
			if (patchErrors.length > 0) {
				errors.push(new AggregateError(patchErrors, `Errors ${operation}: '${applied.patch.name}' (${applied.patch.id})`));
			}
		}
		this.logRevertErrors(operation, errors);
		return errors;
	}

	private logRevertErrors(operation: string, errors: readonly unknown[]): void {
		if (errors.length > 0) {
			this.logService.error(`[HackerCode] Encountered ${errors.length} error(s) while ${operation}.`, new AggregateError(errors));
		}
	}

	private validateTarget(patches: readonly IHackerCodePreparedPatch[]): void {
		const identifiers = new Set<string>();
		for (const patch of patches) {
			if (!patch.id || !patch.name) {
				throw new Error('HackerCode patches require non-empty ids and names');
			}
			if (identifiers.has(patch.id)) {
				throw new Error(`Duplicate HackerCode patch id '${patch.id}'`);
			}
			identifiers.add(patch.id);
		}
	}

	private isCurrentSet(target: readonly IHackerCodePreparedPatch[]): boolean {
		return target.length === this.appliedPatches.length && target.every((patch, index) => {
			const current = this.appliedPatches[index].patch;
			return patch.id === current.id && patch.name === current.name && patch.key === current.key;
		});
	}

	private fireChange(): void {
		this.onDidChangeAppliedPatchesEmitter.fire(this.getAppliedPatches());
	}

	private assertNotDisposed(): void {
		if (this.disposed) {
			throw new Error('The HackerCode patch registry has been disposed');
		}
	}
}

registerSingleton(IHackerCodePatchRegistry, HackerCodePatchRegistry, InstantiationType.Delayed);
