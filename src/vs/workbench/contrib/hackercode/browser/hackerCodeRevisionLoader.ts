/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getErrorMessage } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IHackerCodeModuleLoaderService, IHackerCodeRendererRefreshService } from '../../../../platform/hackercode/browser/hackerCodeRefresh.js';
import { IHackerCodeControlService, IHackerCodePatchDescriptor, IHackerCodePatchSource, IHackerCodeRevisionManifest, IHackerCodeState } from '../../../../platform/hackercode/common/hackerCode.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IHackerCodePatchRegistry, IHackerCodePreparedPatch } from './hackerCodePatchRegistry.js';

const PROTECTED_MODULE_PREFIXES = [
	'vs/platform/hackercode/',
	'vs/workbench/contrib/hackercode/'
] as const;

type HackerCodePatchFactory = IHackerCodePreparedPatch['factory'];
type HackerCodeModuleNamespace = Record<string, unknown>;
type HackerCodeModuleImporter = (url: string) => Promise<HackerCodeModuleNamespace>;
type HackerCodeApplyNewExports = (args: {
	oldExports: HackerCodeModuleNamespace;
	newSrc: string;
	config: { mode: 'patch-prototype' };
}) => ((newExports: HackerCodeModuleNamespace) => boolean) | undefined;

interface IHackerCodeHotReloadGlobal {
	$hotReload_applyNewExports?: HackerCodeApplyNewExports;
}

export interface IHackerCodePatchModuleCompiler {
	compile(
		revision: IHackerCodeRevisionManifest,
		descriptor: IHackerCodePatchDescriptor,
		source: IHackerCodePatchSource
	): Promise<IHackerCodePreparedPatch>;
}

interface IHackerCodePatchModuleCompilerOptions {
	readonly createObjectURL: (source: string) => string;
	readonly revokeObjectURL: (url: string) => void;
	readonly importModule: HackerCodeModuleImporter;
}

interface IHackerCodeRevisionPatchRegistry {
	prepareRevision(revisionId: string, patches: PromiseLike<readonly IHackerCodePreparedPatch[]>): Promise<void>;
	revertAll(): Promise<void>;
}

interface IHackerCodeRevisionLoaderServices {
	readonly controlService: IHackerCodeControlService;
	readonly patchRegistry: IHackerCodeRevisionPatchRegistry;
	readonly compiler: IHackerCodePatchModuleCompiler;
	readonly logService: ILogService;
}

class StaleHackerCodeRevisionLoadError extends Error {
	constructor() {
		super('HackerCode revision load was superseded');
	}
}

/**
 * Validates and returns a canonical renderer module specifier.
 */
export function validateHackerCodeModuleSpecifier(specifier: string): string {
	if (
		typeof specifier !== 'string'
		|| !/^vs\/[A-Za-z0-9_$.-]+(?:\/[A-Za-z0-9_$.-]+)*\.js$/.test(specifier)
		|| specifier.includes('/./')
		|| specifier.includes('/../')
		|| specifier.includes('?')
		|| specifier.includes('#')
	) {
		throw new Error(`Invalid HackerCode module specifier: ${specifier}`);
	}

	const normalized = specifier.toLowerCase();
	if (PROTECTED_MODULE_PREFIXES.some(prefix => normalized.startsWith(prefix))) {
		throw new Error(`HackerCode cannot import protected control-plane module: ${specifier}`);
	}
	return specifier;
}

/**
 * Extracts the required default patch factory from an evaluated ESM namespace.
 */
export function getHackerCodePatchFactory(module: HackerCodeModuleNamespace): HackerCodePatchFactory {
	const factory = module.default;
	if (!isHackerCodePatchFactory(factory)) {
		throw new Error('HackerCode patch modules must export a patch factory as default');
	}
	return factory;
}

function isHackerCodePatchFactory(value: unknown): value is HackerCodePatchFactory {
	return typeof value === 'function';
}

async function defaultModuleImporter(url: string): Promise<HackerCodeModuleNamespace> {
	return import(url);
}

function defaultApplyNewExports(args: Parameters<HackerCodeApplyNewExports>[0]): ReturnType<HackerCodeApplyNewExports> {
	return (globalThis as typeof globalThis & IHackerCodeHotReloadGlobal).$hotReload_applyNewExports?.(args);
}

/**
 * Evaluates revision patch sources as real ESM modules.
 */
export class HackerCodePatchModuleCompiler implements IHackerCodePatchModuleCompiler {
	private readonly options: IHackerCodePatchModuleCompilerOptions;

	constructor(options: Partial<IHackerCodePatchModuleCompilerOptions> = {}) {
		this.options = {
			createObjectURL: options.createObjectURL ?? (source => URL.createObjectURL(new Blob([source], { type: 'application/javascript' }))),
			revokeObjectURL: options.revokeObjectURL ?? (url => URL.revokeObjectURL(url)),
			importModule: options.importModule ?? defaultModuleImporter
		};
	}

	async compile(
		revision: IHackerCodeRevisionManifest,
		descriptor: IHackerCodePatchDescriptor,
		source: IHackerCodePatchSource
	): Promise<IHackerCodePreparedPatch> {
		const sourceName = createPatchSourceName(revision, descriptor);
		const moduleUrl = this.options.createObjectURL(`${source.content}\n//# sourceURL=${sourceName}\n`);
		let module: HackerCodeModuleNamespace;
		try {
			module = await this.options.importModule(moduleUrl);
		} finally {
			this.options.revokeObjectURL(moduleUrl);
		}

		return {
			id: `${revision.id}:${descriptor.fileName}:${descriptor.name}:${descriptor.sha256}`,
			name: descriptor.name,
			key: descriptor.sha256,
			factory: getHackerCodePatchFactory(module)
		};
	}
}

function createPatchSourceName(revision: IHackerCodeRevisionManifest, descriptor: IHackerCodePatchDescriptor): string {
	const safeName = descriptor.name.replace(/[^A-Za-z0-9_.-]/g, '_');
	return `hackercode-patch-${revision.id.slice(0, 12)}-${descriptor.fileName}-${safeName}.js`;
}

/**
 * Owns guarded renderer module imports and their refreshable namespaces.
 */
export class HackerCodeModuleLoader implements IHackerCodeModuleLoaderService {
	declare readonly _serviceBrand: undefined;

	private readonly moduleNamespaces = new Map<string, HackerCodeModuleNamespace>();
	private refreshCounter = 0;

	constructor(
		private readonly importModule: HackerCodeModuleImporter = defaultModuleImporter,
		private readonly fileRoot: string = globalThis._VSCODE_FILE_ROOT,
		private readonly applyNewExports: HackerCodeApplyNewExports = defaultApplyNewExports
	) {
	}

	async import(specifier: string): Promise<object> {
		const canonicalSpecifier = validateHackerCodeModuleSpecifier(specifier);
		const existing = this.moduleNamespaces.get(canonicalSpecifier);
		if (existing) {
			return existing;
		}

		const namespace = await this.importModule(this.resolve(canonicalSpecifier));
		this.moduleNamespaces.set(canonicalSpecifier, namespace);
		return namespace;
	}

	async refresh(specifier: string): Promise<void> {
		const canonicalSpecifier = validateHackerCodeModuleSpecifier(specifier);
		const oldExports = this.moduleNamespaces.get(canonicalSpecifier);
		if (!oldExports) {
			throw new Error(`HackerCode cannot refresh untracked module: ${canonicalSpecifier}`);
		}

		const url = new URL(this.resolve(canonicalSpecifier));
		url.searchParams.set('hackercodeRefresh', `${Date.now()}-${++this.refreshCounter}`);
		const newNamespace = await this.importModule(url.href);
		const acceptNewExports = this.applyNewExports({
			oldExports,
			newSrc: '',
			config: { mode: 'patch-prototype' }
		});
		if (!acceptNewExports) {
			throw new Error(`HackerCode module refresh was not handled: ${canonicalSpecifier}`);
		}

		const mutableNewExports = { ...newNamespace };
		if (!acceptNewExports(mutableNewExports)) {
			throw new Error(`HackerCode module refresh was rejected: ${canonicalSpecifier}`);
		}
	}

	private resolve(specifier: string): string {
		return new URL(specifier, this.fileRoot).href;
	}
}

class HackerCodeModuleLoaderService extends HackerCodeModuleLoader {
	constructor() {
		super();
	}
}

/**
 * Loads the active revision and registers its full preparation promise before
 * boot health checks revision readiness.
 */
export class HackerCodeRevisionLoader extends Disposable {
	private activeRevision: IHackerCodeRevisionManifest | undefined;
	private skipPromoted = false;
	private generation = 0;
	private stateEventGeneration = 0;
	private readonly initialization: Promise<void>;

	constructor(private readonly services: IHackerCodeRevisionLoaderServices) {
		super();
		this._register(services.controlService.onDidChangeState(state => {
			this.stateEventGeneration++;
			void this.acceptState(state);
		}));
		this.initialization = this.initialize();
		void this.initialization.catch(error => services.logService.error('[HackerCode] Failed to initialize the revision loader.', error));
	}

	get activeRevisionId(): string | undefined {
		return this.activeRevision?.id;
	}

	whenInitialized(): Promise<void> {
		return this.initialization;
	}

	async softReload(): Promise<void> {
		await this.initialization;
		const revision = this.activeRevision;
		if (!revision) {
			throw new Error('HackerCode has no active revision to reload');
		}

		const generation = ++this.generation;
		await this.services.patchRegistry.revertAll();
		await this.prepareRevision(revision, this.skipPromoted, generation);
	}

	private async initialize(): Promise<void> {
		const eventGeneration = this.stateEventGeneration;
		const state = await this.services.controlService.getState();
		if (this._store.isDisposed || eventGeneration !== this.stateEventGeneration) {
			return;
		}
		await this.acceptState(state);
	}

	private acceptState(state: IHackerCodeState): Promise<void> {
		if (this._store.isDisposed) {
			return Promise.resolve();
		}

		const revision = state.revisions.find(candidate => candidate.id === state.activeRevisionId);
		if (!revision) {
			this.services.logService.error(`[HackerCode] Active revision metadata is missing: ${state.activeRevisionId}`);
			return Promise.resolve();
		}

		const skipPromoted = state.skipPromoted === true;
		if (this.activeRevision?.id === revision.id && this.skipPromoted === skipPromoted) {
			this.activeRevision = revision;
			return Promise.resolve();
		}

		this.activeRevision = revision;
		this.skipPromoted = skipPromoted;
		const generation = ++this.generation;
		const preparation = this.prepareRevision(revision, skipPromoted, generation);
		void preparation.catch(error => {
			if (!(error instanceof StaleHackerCodeRevisionLoadError)) {
				this.services.logService.error(`[HackerCode] Failed to prepare revision ${revision.id}: ${getErrorMessage(error)}`, error);
			}
		});
		return preparation;
	}

	private prepareRevision(revision: IHackerCodeRevisionManifest, skipPromoted: boolean, generation: number): Promise<void> {
		const patches = this.loadRevision(revision, skipPromoted, generation);
		return this.services.patchRegistry.prepareRevision(revision.id, patches);
	}

	private async loadRevision(
		revision: IHackerCodeRevisionManifest,
		skipPromoted: boolean,
		generation: number
	): Promise<readonly IHackerCodePreparedPatch[]> {
		const promotedManifest = skipPromoted
			? { schemaVersion: 1 as const, layers: [] }
			: await this.services.controlService.getPromotedManifest();
		this.assertCurrent(revision.id, generation);
		const patches: IHackerCodePreparedPatch[] = [];
		for (const layer of promotedManifest.layers) {
			const sources = await this.services.controlService.readPromotedPatchSources(layer.id);
			this.assertCurrent(revision.id, generation);
			if (sources.length !== layer.patches.length) {
				throw new Error(`HackerCode promoted layer ${layer.id} returned an unexpected patch source count`);
			}
			const layerRevision: IHackerCodeRevisionManifest = {
				schemaVersion: 1,
				id: layer.id,
				baseline: layer.baseline,
				createdAt: layer.promotedAt,
				parentId: 'pristine',
				patches: layer.patches
			};
			patches.push(...await Promise.all(layer.patches.map((descriptor, index) => {
				const source = sources[index];
				if (source.name !== descriptor.name) {
					throw new Error(`HackerCode promoted patch source does not match manifest descriptor: ${descriptor.name}`);
				}
				return this.services.compiler.compile(layerRevision, descriptor, source);
			})));
		}

		if (promotedManifest.layers.some(layer => layer.id === revision.id)) {
			return patches;
		}
		const sources = await this.services.controlService.readPatchSources(revision.id);
		this.assertCurrent(revision.id, generation);
		if (sources.length !== revision.patches.length) {
			throw new Error(`HackerCode revision ${revision.id} returned an unexpected patch source count`);
		}

		patches.push(...await Promise.all(revision.patches.map((descriptor, index) => {
			const source = sources[index];
			if (source.name !== descriptor.name) {
				throw new Error(`HackerCode patch source does not match manifest descriptor: ${descriptor.name}`);
			}
			return this.services.compiler.compile(revision, descriptor, source);
		})));
		this.assertCurrent(revision.id, generation);
		return patches;
	}

	private assertCurrent(revisionId: string, generation: number): void {
		if (
			this._store.isDisposed
			|| generation !== this.generation
			|| this.activeRevision?.id !== revisionId
		) {
			throw new StaleHackerCodeRevisionLoadError();
		}
	}
}

export class HackerCodeRendererRefreshService extends Disposable implements IHackerCodeRendererRefreshService {
	declare readonly _serviceBrand: undefined;

	private readonly revisionLoader: HackerCodeRevisionLoader;

	constructor(
		@IHackerCodeControlService private readonly controlService: IHackerCodeControlService,
		@IHackerCodePatchRegistry patchRegistry: IHackerCodePatchRegistry,
		@IHackerCodeModuleLoaderService private readonly moduleLoaderService: IHackerCodeModuleLoaderService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@ILogService logService: ILogService,
	) {
		super();
		this.revisionLoader = this._register(new HackerCodeRevisionLoader({
			controlService,
			patchRegistry,
			compiler: new HackerCodePatchModuleCompiler(),
			logService
		}));
	}

	refresh(mode: 'soft' | 'hard'): Promise<void>;
	refresh(mode: 'module', specifier: string): Promise<void>;
	refresh(mode: 'soft' | 'module' | 'hard', specifier?: string): Promise<void> {
		switch (mode) {
			case 'soft':
				return this.soft();
			case 'module':
				if (!specifier) {
					return Promise.reject(new Error('A module specifier is required for module refresh'));
				}
				return this.module(specifier);
			case 'hard':
				return this.hard();
		}
	}

	soft(): Promise<void> {
		return this.revisionLoader.softReload();
	}

	module(specifier: string): Promise<void> {
		return this.moduleLoaderService.refresh(specifier);
	}

	async hard(): Promise<void> {
		await this.revisionLoader.whenInitialized();
		const revisionId = this.revisionLoader.activeRevisionId;
		if (!revisionId) {
			throw new Error('HackerCode has no active revision to reload');
		}
		await this.controlService.reloadRevision({
			revisionId,
			windowId: this.nativeHostService.windowId
		});
	}
}

class HackerCodeRevisionLoaderContribution implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.hackerCodeRevisionLoader';

	constructor(@IHackerCodeRendererRefreshService _refreshService: IHackerCodeRendererRefreshService) {
	}
}

registerSingleton(IHackerCodeModuleLoaderService, HackerCodeModuleLoaderService, InstantiationType.Delayed);
registerSingleton(IHackerCodeRendererRefreshService, HackerCodeRendererRefreshService, InstantiationType.Delayed);
registerWorkbenchContribution2(
	HackerCodeRevisionLoaderContribution.ID,
	HackerCodeRevisionLoaderContribution,
	WorkbenchPhase.BlockStartup
);
