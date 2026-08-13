/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'fs/promises';
import { RunOnceScheduler, Sequencer } from '../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../base/common/cancellation.js';
import { isCancellationError } from '../../../base/common/errors.js';
import { Emitter } from '../../../base/common/event.js';
import { IJsonRpcRequest, JsonRpcError, JsonRpcMessage, JsonRpcProtocol } from '../../../base/common/jsonRpcProtocol.js';
import { Disposable, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { join } from '../../../base/common/path.js';
import { localize } from '../../../nls.js';
import { IProtocolTransport } from '../../agentHost/common/state/sessionTransport.js';
import { JsonRpcParseErrorResponse, JsonRpcRequest, JsonRpcResponse } from '../../agentHost/common/state/sessionProtocol.js';
import { WebSocketProtocolServer } from '../../agentHost/node/webSocketTransport.js';
import { IDialogMainService } from '../../dialogs/electron-main/dialogMainService.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { ILogService } from '../../log/common/log.js';
import { IStateService } from '../../state/node/state.js';
import { IWindowsMainService } from '../../windows/electron-main/windows.js';
import {
	addHackerCodeRevision,
	beginHackerCodeBoot,
	completeHackerCodeBoot,
	createHackerCodeRevisionLedger,
	enterHackerCodeSafeMode,
	HACKERCODE_STORAGE_KEYS,
	IHackerCodeBaselineInfo,
	IHackerCodeBootAttempt,
	IHackerCodeBootRequest,
	IHackerCodeControlEndpoint,
	IHackerCodeControlService,
	IHackerCodeCreateRevisionRequest,
	IHackerCodePatchDescriptor,
	IHackerCodePatchSource,
	IHackerCodePromotedManifest,
	IHackerCodePromoteRequest,
	IHackerCodePromoteResult,
	IHackerCodeQuarantineRevisionRequest,
	IHackerCodeReloadRevisionRequest,
	IHackerCodeRevisionLedger,
	IHackerCodeRevisionManifest,
	IHackerCodeSafeModeRequest,
	IHackerCodeSetRevisionRequest,
	IHackerCodeState,
	markHackerCodeRevisionHealthy,
	normalizeHackerCodeRevisionLedger,
	orderHackerCodeRevisions,
	PRISTINE_REVISION_ID,
	quarantineHackerCodeRevision,
	recoverHackerCodeBootAttempt,
	resetHackerCodeLedgerAfterPromotion,
	setHackerCodeRevision
} from '../common/hackerCode.js';
import {
	HACKERCODE_CONTROL_REGISTER_RENDERER_METHOD,
	HackerCodeControlJsonRpcErrorCode,
	IHackerCodeEvalParams,
	IHackerCodeJsonRpcNullErrorResponse,
	IHackerCodeRefreshParams,
	IHackerCodeRendererRegistrationParams,
	parseHackerCodeJsonRpcMessage,
	validateHackerCodeControlRequest
} from '../common/hackerCodeControlProtocol.js';
import {
	appendHackerCodePromotedLayer,
	assertHackerCodePromotionBaseline,
	commitHackerCodePromotedFiles,
	getHackerCodeGitHead,
	HACKERCODE_PROMOTED_OUT_RELATIVE_PATH,
	HACKERCODE_PROMOTED_RELATIVE_PATH,
	HackerCodeCommandRunner,
	IHackerCodeCommandRunner,
	IHackerCodePromotedBundle,
	readHackerCodePromotedBundle,
	validateHackerCodePromotedPatchContent,
	writeHackerCodePromotedBundle
} from '../node/hackerCodePromotion.js';

const MAX_PATCH_COUNT = 64;
const MAX_PATCH_SOURCE_SIZE = 1024 * 1024;
const MAX_PATCH_NAME_LENGTH = 128;
const MAX_BASELINE_LENGTH = 256;
const MAX_DESCRIPTION_LENGTH = 4096;
const MAX_QUARANTINE_REASON_LENGTH = 1024;
const MAX_COMMIT_MESSAGE_LENGTH = 200;
const REVISION_ID_PATTERN = /^[a-f0-9]{64}$/;
const PATCH_FILE_NAME_PATTERN = /^patch-\d{4}\.txt$/;
const BOOT_WATCHDOG_DELAY = 20_000;
const HEARTBEAT_CHECK_INTERVAL = 5_000;
const HEARTBEAT_MISSES_BEFORE_PROMPT = 3;
const CONTROL_REQUEST_TIMEOUT = 30_000;
const CONTROL_HOST = '127.0.0.1';

type BootRuntimeKey = number | 'global';

interface IHackerCodeBootRuntime {
	readonly revisionId: string;
	readonly windowId?: number;
	readonly disposables: DisposableStore;
	readonly watchdog: RunOnceScheduler;
	readonly livenessCheck: RunOnceScheduler;
	lastHeartbeatAt: number;
	freezeMissCount: number;
	dialogOpen: boolean;
}

interface IHackerCodeControlEndpointMetadata {
	readonly protocol: 'ws';
	readonly host: typeof CONTROL_HOST;
	readonly port: number;
	readonly token: string;
	readonly pid: number;
	readonly recoveryTest?: {
		readonly suppressDialog: true;
		readonly watchdogDelayMs: typeof BOOT_WATCHDOG_DELAY;
	};
}

export class HackerCodeControlService extends Disposable implements IHackerCodeControlService {
	declare readonly _serviceBrand: undefined;

	private readonly revisionsPath: string;
	private readonly appRoot: string;
	private readonly isBuilt: boolean;
	private readonly promotedPath: string;
	private readonly promotedOutPath: string;
	private readonly commandRunner: IHackerCodeCommandRunner;
	private readonly suppressRecoveryDialog: boolean;
	private readonly controlDirectory: string;
	private readonly controlMetadataPath: string;
	private readonly mutationSequencer = new Sequencer();
	private readonly bootRuntimes = new Map<BootRuntimeKey, IHackerCodeBootRuntime>();
	private readonly controlConnections = new Set<HackerCodeControlConnection>();
	private readonly rendererConnections = new Map<number, HackerCodeControlConnection>();
	private readonly controlInitialization: Promise<void>;
	private readonly baselineInitialization: Promise<void>;
	private ledger: IHackerCodeRevisionLedger;
	private baselineHeadPromise: Promise<string> | undefined;
	private baselineHead: string | undefined;
	private controlEndpoint: IHackerCodeControlEndpoint | undefined;
	private controlMetadata: IHackerCodeControlEndpointMetadata | undefined;

	private readonly _onDidChangeState = this._register(new Emitter<IHackerCodeState>());
	readonly onDidChangeState = this._onDidChangeState.event;

	constructor(
		commandRunner: IHackerCodeCommandRunner | undefined,
		@IEnvironmentMainService environmentMainService: IEnvironmentMainService,
		@IStateService private readonly stateService: IStateService,
		@IWindowsMainService private readonly windowsMainService: IWindowsMainService,
		@IDialogMainService private readonly dialogMainService: IDialogMainService,
		@ILogService private readonly logService: ILogService
	) {
		super();

		this.appRoot = environmentMainService.appRoot;
		this.isBuilt = environmentMainService.isBuilt;
		this.suppressRecoveryDialog = !this.isBuilt && environmentMainService.args['hackercode-destructive-recovery-test'] === true;
		if (environmentMainService.args['hackercode-destructive-recovery-test']) {
			if (this.suppressRecoveryDialog) {
				this.logService.warn('[HackerCode] Destructive recovery test mode is suppressing the frozen-renderer dialog.');
			} else {
				this.logService.warn('[HackerCode] Ignoring destructive recovery test mode in a built product.');
			}
		}
		this.promotedPath = join(this.appRoot, this.isBuilt ? HACKERCODE_PROMOTED_OUT_RELATIVE_PATH : HACKERCODE_PROMOTED_RELATIVE_PATH);
		this.promotedOutPath = join(this.appRoot, HACKERCODE_PROMOTED_OUT_RELATIVE_PATH);
		this.commandRunner = commandRunner ?? new HackerCodeCommandRunner();
		this.controlDirectory = join(environmentMainService.userDataPath, 'hackercode');
		this.controlMetadataPath = join(this.controlDirectory, 'control.json');
		this.revisionsPath = join(this.controlDirectory, 'revisions');
		const storedLedger = stateService.getItem<IHackerCodeRevisionLedger>(HACKERCODE_STORAGE_KEYS.revisionLedger);
		this.ledger = isValidLedger(storedLedger)
			? normalizeHackerCodeRevisionLedger(storedLedger)
			: createHackerCodeRevisionLedger();

		const now = new Date().toISOString();
		if (environmentMainService.args['hackercode-safe-mode']) {
			this.logService.warn('[HackerCode] Safe mode requested from the command line.');
			this.ledger = enterHackerCodeSafeMode(
				this.ledger,
				now,
				localize('hackercode.commandLineSafeMode', "HackerCode safe mode was requested from the command line"),
				true
			);
		} else if (this.ledger.bootAttempt) {
			this.logService.warn(`[HackerCode] Recovering stale boot attempt for revision ${this.ledger.bootAttempt.revisionId}.`);
			this.ledger = recoverHackerCodeBootAttempt(
				this.ledger,
				now,
				localize('hackercode.staleBootAttempt', "The previous HackerCode boot did not complete")
			);
		}

		if (!storedLedger || JSON.stringify(storedLedger) !== JSON.stringify(this.ledger)) {
			this.persistLedger();
		}
		this._register(toDisposable(() => this.clearBootRuntimes()));
		this._register(toDisposable(() => this.disposeControlConnections()));

		const controlEnabled = !environmentMainService.isBuilt || environmentMainService.args['hackercode-control'] === true;
		this.controlInitialization = controlEnabled ? this.initializeControlEndpoint() : Promise.resolve();
		this.baselineInitialization = this.validateActiveRevisionBaseline('startup');
	}

	async getState(): Promise<IHackerCodeState> {
		await this.baselineInitialization;
		return this.cloneState();
	}

	async listRevisions(): Promise<readonly IHackerCodeRevisionManifest[]> {
		await this.baselineInitialization;
		return orderHackerCodeRevisions(this.ledger.revisions).map(cloneManifest);
	}

	async getRevision(revisionId: string): Promise<IHackerCodeRevisionManifest | undefined> {
		await this.baselineInitialization;
		validateRevisionId(revisionId);
		const revision = this.ledger.revisions.find(candidate => candidate.id === revisionId);
		if (!revision) {
			return undefined;
		}
		if (revisionId === PRISTINE_REVISION_ID) {
			return cloneManifest(revision);
		}

		return cloneManifest(await this.readStoredManifest(revisionId));
	}

	createRevision(request: IHackerCodeCreateRevisionRequest): Promise<IHackerCodeRevisionManifest> {
		return this.mutationSequencer.queue(async () => {
			await this.baselineInitialization;
			validateCreateRevisionRequest(request);
			await this.assertCurrentBaseline(request.baseline);
			const parentId = request.parentId ?? this.ledger.activeRevisionId;
			this.assertUsableRevision(parentId);

			const patchDescriptors = request.patches.map((patch, index): IHackerCodePatchDescriptor => ({
				name: patch.name,
				fileName: `patch-${String(index).padStart(4, '0')}.txt`,
				sha256: hashString(patch.content),
				size: Buffer.byteLength(patch.content, 'utf8')
			}));
			const revisionId = computeRevisionId(request, parentId, patchDescriptors);
			const manifest: IHackerCodeRevisionManifest = {
				schemaVersion: 1,
				id: revisionId,
				baseline: request.baseline,
				createdAt: new Date().toISOString(),
				...(request.description === undefined ? {} : { description: request.description }),
				parentId,
				patches: patchDescriptors
			};
			const existingRevision = this.ledger.revisions.find(revision => revision.id === revisionId);
			if (existingRevision) {
				const storedRevision = await this.readStoredManifest(revisionId);
				if (!manifestsHaveSameIdentity(storedRevision, manifest)) {
					throw new Error(`HackerCode revision identity collision: ${revisionId}`);
				}
				return cloneManifest(storedRevision);
			}

			await this.ensureRevisionStore();
			const storedRevision = await this.tryReadStoredManifest(revisionId);
			if (storedRevision) {
				if (!manifestsHaveSameIdentity(storedRevision, manifest)) {
					throw new Error(`HackerCode revision identity collision: ${revisionId}`);
				}
				this.updateLedger(addHackerCodeRevision(this.ledger, storedRevision));
				return cloneManifest(storedRevision);
			}

			await this.storeRevision(manifest, request.patches);
			this.updateLedger(addHackerCodeRevision(this.ledger, manifest));
			return cloneManifest(manifest);
		});
	}

	setRevision(request: IHackerCodeSetRevisionRequest): Promise<IHackerCodeState> {
		return this.mutationSequencer.queue(async () => {
			await this.baselineInitialization;
			validateSetRevisionRequest(request);
			await this.validateActiveRevisionBaseline('selection', true);
			let targetRevisionId = request.revisionId;
			if (!await this.validateRevisionBaseline(targetRevisionId, 'selection')) {
				if (request.mode !== 'recover') {
					throw new Error(`HackerCode revision baseline does not match the current source checkout: ${targetRevisionId}`);
				}
				targetRevisionId = this.ledger.lastKnownGoodRevisionId;
			}
			let updatedLedger: IHackerCodeRevisionLedger;
			try {
				updatedLedger = setHackerCodeRevision(this.ledger, targetRevisionId);
			} catch (error) {
				if (request.mode !== 'recover') {
					throw error;
				}
				updatedLedger = setHackerCodeRevision(this.ledger, this.ledger.lastKnownGoodRevisionId);
			}

			updatedLedger = beginHackerCodeBoot(updatedLedger, updatedLedger.activeRevisionId, new Date().toISOString(), request.windowId);
			this.updateLedger(updatedLedger);
			this.clearBootRuntimes();
			this.armBootMonitoring(updatedLedger.activeRevisionId, request.windowId);
			this.reloadWorkbenchWindows(request.windowId);
			return this.cloneState();
		});
	}

	reloadRevision(request: IHackerCodeReloadRevisionRequest): Promise<IHackerCodeState> {
		return this.mutationSequencer.queue(async () => {
			await this.baselineInitialization;
			validateReloadRevisionRequest(request);
			await this.validateActiveRevisionBaseline('reload', true);
			if (!await this.validateRevisionBaseline(request.revisionId, 'reload')) {
				this.reloadWorkbenchWindows(request.windowId);
				throw new Error(`HackerCode revision baseline does not match the current source checkout: ${request.revisionId}`);
			}
			if (this.ledger.activeRevisionId !== request.revisionId) {
				throw new Error('HackerCode can only reload the active revision');
			}

			this.updateLedger(beginHackerCodeBoot(this.ledger, request.revisionId, new Date().toISOString(), request.windowId));
			this.clearBootRuntimes();
			this.armBootMonitoring(request.revisionId, request.windowId);
			this.reloadWorkbenchWindows(request.windowId);
			return this.cloneState();
		});
	}

	promoteRevision(request: IHackerCodePromoteRequest): Promise<IHackerCodePromoteResult> {
		return this.mutationSequencer.queue(async () => {
			await this.baselineInitialization;
			validatePromoteRequest(request);
			if (this.isBuilt) {
				throw new Error('HackerCode promotion is only available from a source checkout');
			}
			await this.validateActiveRevisionBaseline('promotion', true);
			if (request.revisionId === PRISTINE_REVISION_ID || this.ledger.activeRevisionId !== request.revisionId) {
				throw new Error('HackerCode can only promote the active non-pristine revision');
			}
			this.assertUsableRevision(request.revisionId);
			this.assertWorkbenchWindow(request.windowId);
			const commitMessage = request.commitMessage ?? `HackerCode: promote revision ${request.revisionId.slice(0, 8)}`;
			validateCommitMessage(commitMessage);

			const revision = await this.readStoredManifest(request.revisionId);
			const previousHead = await this.getCurrentBaseline();
			try {
				assertHackerCodePromotionBaseline(revision, previousHead);
			} catch (error) {
				this.quarantineForBaselineMismatch(revision.id, previousHead, 'promotion');
				throw error;
			}

			const revisionSources = await this.readVerifiedPatchSources(revision);
			const promotedBundle = await readHackerCodePromotedBundle(this.promotedPath);
			const promotedManifest = createOrReusePromotedManifest(promotedBundle.manifest, revision);
			const contentByFileName = collectPromotedContent(promotedBundle);
			for (let index = 0; index < revision.patches.length; index++) {
				const descriptor = revision.patches[index];
				const source = revisionSources[index];
				if (source.name !== descriptor.name) {
					throw new Error(`HackerCode patch source does not match manifest descriptor: ${descriptor.name}`);
				}
				validateHackerCodePromotedPatchContent({ ...descriptor, fileName: `${descriptor.sha256}.js` }, source.content);
				contentByFileName.set(`${descriptor.sha256}.js`, source.content);
			}

			await writeHackerCodePromotedBundle(this.promotedPath, promotedManifest, contentByFileName);
			if (await isDirectory(this.promotedOutPath)) {
				try {
					await writeHackerCodePromotedBundle(this.promotedOutPath, promotedManifest, contentByFileName);
				} catch (error) {
					this.logService.warn('[HackerCode] Promoted sources were updated, but the development output mirror failed.', error);
				}
			}

			const repositoryFiles = [
				`${HACKERCODE_PROMOTED_RELATIVE_PATH}/manifest.json`,
				...new Set(revision.patches.map(patch => `${HACKERCODE_PROMOTED_RELATIVE_PATH}/${patch.sha256}.js`))
			];
			await commitHackerCodePromotedFiles(this.appRoot, repositoryFiles, commitMessage, this.commandRunner);
			this.baselineHeadPromise = undefined;
			const newHead = await this.getCurrentBaseline();
			this.updateLedger(resetHackerCodeLedgerAfterPromotion(this.ledger));
			this.clearBootRuntimes();
			return {
				revisionId: request.revisionId,
				previousHead,
				newHead,
				commitMessage
			};
		});
	}

	quarantineRevision(request: IHackerCodeQuarantineRevisionRequest): Promise<IHackerCodeState> {
		return this.mutationSequencer.queue(async () => {
			await this.baselineInitialization;
			validateQuarantineRevisionRequest(request);
			const updatedLedger = quarantineHackerCodeRevision(
				this.ledger,
				request.revisionId,
				new Date().toISOString(),
				request.reason
			);
			this.updateLedger(updatedLedger);
			this.clearBootRuntimes(request.revisionId);
			return this.cloneState();
		});
	}

	markRevisionHealthy(revisionId: string): Promise<IHackerCodeState> {
		return this.mutationSequencer.queue(async () => {
			await this.baselineInitialization;
			validateRevisionId(revisionId);
			this.updateLedger(markHackerCodeRevisionHealthy(this.ledger, revisionId));
			return this.cloneState();
		});
	}

	beginBoot(request: IHackerCodeBootRequest): Promise<IHackerCodeState> {
		return this.mutationSequencer.queue(async () => {
			await this.baselineInitialization;
			validateBootRequest(request);
			await this.validateActiveRevisionBaseline('apply', true);
			if (!await this.validateRevisionBaseline(request.revisionId, 'apply')) {
				throw new Error(`HackerCode revision baseline does not match the current source checkout: ${request.revisionId}`);
			}
			this.updateLedger(beginHackerCodeBoot(this.ledger, request.revisionId, new Date().toISOString(), request.windowId));
			this.armBootMonitoring(request.revisionId, request.windowId);
			return this.cloneState();
		});
	}

	heartbeat(request: IHackerCodeBootRequest): Promise<void> {
		return this.mutationSequencer.queue(async () => {
			validateBootRequest(request);
			if (this.ledger.activeRevisionId !== request.revisionId) {
				throw new Error(`HackerCode heartbeat revision is not active: ${request.revisionId}`);
			}

			const runtime = this.bootRuntimes.get(request.windowId);
			if (!runtime || runtime.revisionId !== request.revisionId) {
				throw new Error('HackerCode heartbeat does not match an active boot');
			}
			runtime.lastHeartbeatAt = Date.now();
			runtime.freezeMissCount = 0;
		});
	}

	completeBoot(request: IHackerCodeBootRequest): Promise<IHackerCodeState> {
		return this.mutationSequencer.queue(async () => {
			validateBootRequest(request);
			this.updateLedger(completeHackerCodeBoot(this.ledger, request.revisionId, request.windowId));
			this.clearBootRuntimes(request.revisionId);
			return this.cloneState();
		});
	}

	enterSafeMode(request: IHackerCodeSafeModeRequest): Promise<IHackerCodeState> {
		return this.mutationSequencer.queue(async () => {
			validateSafeModeRequest(request);
			const reason = request.reason ?? localize('hackercode.safeModeRequested', "HackerCode safe mode was requested");
			this.updateLedger(enterHackerCodeSafeMode(this.ledger, new Date().toISOString(), reason));
			this.clearBootRuntimes();
			this.reloadWorkbenchWindows(request.windowId);
			return this.cloneState();
		});
	}

	async readPatchSources(revisionId: string): Promise<readonly IHackerCodePatchSource[]> {
		await this.baselineInitialization;
		validateRevisionId(revisionId);
		if (revisionId === PRISTINE_REVISION_ID) {
			return [];
		}
		if (!this.ledger.revisions.some(revision => revision.id === revisionId)) {
			throw new Error(`Unknown HackerCode revision: ${revisionId}`);
		}
		await this.validateActiveRevisionBaseline('apply', true);
		if (!await this.validateRevisionBaseline(revisionId, 'apply')) {
			throw new Error(`HackerCode revision baseline does not match the current source checkout: ${revisionId}`);
		}

		const manifest = await this.readStoredManifest(revisionId);
		return this.readVerifiedPatchSources(manifest);
	}

	async getPromotedManifest(): Promise<IHackerCodePromotedManifest> {
		const bundle = await readHackerCodePromotedBundle(this.promotedPath);
		return {
			schemaVersion: 1,
			layers: bundle.manifest.layers.map(layer => ({
				...layer,
				patches: layer.patches.map(patch => ({ ...patch }))
			}))
		};
	}

	async readPromotedPatchSources(layerId: string): Promise<readonly IHackerCodePatchSource[]> {
		validateRevisionId(layerId);
		const bundle = await readHackerCodePromotedBundle(this.promotedPath);
		const sources = bundle.sourcesByLayer.get(layerId);
		if (!sources) {
			throw new Error(`Unknown HackerCode promoted layer: ${layerId}`);
		}
		return sources.map(source => ({ ...source }));
	}

	async getControlEndpoint(): Promise<IHackerCodeControlEndpoint | undefined> {
		await this.controlInitialization;
		return this.controlEndpoint ? { ...this.controlEndpoint } : undefined;
	}

	private async initializeControlEndpoint(): Promise<void> {
		// Possession of this token is root authority for the intentionally
		// privileged control channel. It must never be logged.
		const authorizationToken = randomBytes(32).toString('base64url');
		let server: WebSocketProtocolServer | undefined;
		try {
			const createdServer = await WebSocketProtocolServer.create({
				host: CONTROL_HOST,
				port: 0,
				connectionTokenValidate: candidate => isMatchingControlToken(candidate, authorizationToken)
			}, this.logService);
			if (this._store.isDisposed) {
				void createdServer.whenListening.catch(() => undefined);
				createdServer.dispose();
				return;
			}
			server = this._register(createdServer);
			this._register(server.onConnection(transport => this.acceptControlConnection(transport)));
			await server.whenListening;

			const port = server.boundPort;
			if (port === undefined) {
				throw new Error('HackerCode control server did not report a bound port');
			}

			const metadata: IHackerCodeControlEndpointMetadata = {
				protocol: 'ws',
				host: CONTROL_HOST,
				port,
				token: authorizationToken,
				pid: process.pid,
				...(this.suppressRecoveryDialog ? {
					recoveryTest: {
						suppressDialog: true,
						watchdogDelayMs: BOOT_WATCHDOG_DELAY
					}
				} : {})
			};
			await this.writeControlEndpointMetadata(metadata);
			if (this._store.isDisposed) {
				await this.removeControlEndpointMetadata(metadata);
				server.dispose();
				return;
			}
			this.controlMetadata = metadata;
			this.controlEndpoint = {
				protocol: metadata.protocol,
				host: metadata.host,
				port: metadata.port,
				authorizationToken,
				pid: metadata.pid
			};
		} catch (error) {
			server?.dispose();
			this.controlEndpoint = undefined;
			this.logService.error('[HackerCode] Failed to start the control endpoint.', error);
		}
	}

	private acceptControlConnection(transport: IProtocolTransport): void {
		const connection = new HackerCodeControlConnection(
			transport,
			request => this.handleControlRequest(connection, request),
			() => this.onControlConnectionClosed(connection)
		);
		this.controlConnections.add(connection);
	}

	private async handleControlRequest(connection: HackerCodeControlConnection, request: IJsonRpcRequest): Promise<unknown> {
		const params = validateHackerCodeControlRequest(request, 'main');
		switch (request.method) {
			case 'getState':
				return this.getState();
			case 'listRevisions':
				return this.listRevisions();
			case 'createRevision':
				return this.createRevision(params as IHackerCodeCreateRevisionRequest);
			case 'promote':
				return this.promoteRevision(params as IHackerCodePromoteRequest);
			case 'setRevision':
				return this.setRevision(params as IHackerCodeSetRevisionRequest);
			case 'safeMode':
				return this.enterSafeMode(params as IHackerCodeSafeModeRequest);
			case 'reload':
				return this.reloadRevision(params as IHackerCodeReloadRevisionRequest);
			case 'eval':
				return this.forwardRendererRequest('eval', params as IHackerCodeEvalParams);
			case 'refresh':
				return this.forwardRendererRequest('refresh', params as IHackerCodeRefreshParams);
			case HACKERCODE_CONTROL_REGISTER_RENDERER_METHOD:
				return this.registerRendererConnection(connection, params as IHackerCodeRendererRegistrationParams);
			default:
				throw new JsonRpcError(HackerCodeControlJsonRpcErrorCode.MethodNotFound, `Method not found: ${request.method}`);
		}
	}

	private registerRendererConnection(connection: HackerCodeControlConnection, params: IHackerCodeRendererRegistrationParams): null {
		const codeWindow = this.windowsMainService.getWindowById(params.windowId);
		if (!codeWindow || codeWindow.config?.isSessionsWindow || codeWindow.profile?.isAgentsWindowProfile) {
			throw new JsonRpcError(HackerCodeControlJsonRpcErrorCode.InvalidParams, 'Renderer registration does not identify a workbench window');
		}
		if (connection.rendererWindowId !== undefined && connection.rendererWindowId !== params.windowId) {
			throw new JsonRpcError(HackerCodeControlJsonRpcErrorCode.InvalidRequest, 'A renderer connection cannot change its window id');
		}

		const previousConnection = this.rendererConnections.get(params.windowId);
		if (previousConnection && previousConnection !== connection) {
			previousConnection.dispose();
		}
		connection.rendererWindowId = params.windowId;
		this.rendererConnections.set(params.windowId, connection);
		return null;
	}

	private async forwardRendererRequest(method: 'eval' | 'refresh', params: IHackerCodeEvalParams | IHackerCodeRefreshParams): Promise<unknown> {
		const connection = this.getRendererConnection(params.windowId);
		const forwardedParams = method === 'eval'
			? { source: (params as IHackerCodeEvalParams).source }
			: {
				mode: (params as IHackerCodeRefreshParams).mode,
				...((params as IHackerCodeRefreshParams).specifier === undefined ? {} : { specifier: (params as IHackerCodeRefreshParams).specifier })
			};
		const cancellation = new CancellationTokenSource();
		const timeout = setTimeout(() => cancellation.cancel(), CONTROL_REQUEST_TIMEOUT);
		try {
			return await connection.sendRequest(method, forwardedParams, cancellation.token);
		} catch (error) {
			if (cancellation.token.isCancellationRequested) {
				throw new JsonRpcError(HackerCodeControlJsonRpcErrorCode.RequestTimeout, `Renderer ${method} request timed out`);
			}
			if (isCancellationError(error)) {
				throw new JsonRpcError(HackerCodeControlJsonRpcErrorCode.RendererUnavailable, 'Renderer connection closed');
			}
			throw error;
		} finally {
			clearTimeout(timeout);
			cancellation.dispose(true);
		}
	}

	private getRendererConnection(windowId: number | undefined): HackerCodeControlConnection {
		const targetWindow = windowId === undefined
			? this.windowsMainService.getFocusedWindow()
			: this.windowsMainService.getWindowById(windowId);
		if (!targetWindow) {
			throw new JsonRpcError(HackerCodeControlJsonRpcErrorCode.RendererUnavailable, 'No target workbench window is available');
		}
		const connection = this.rendererConnections.get(targetWindow.id);
		if (!connection) {
			throw new JsonRpcError(HackerCodeControlJsonRpcErrorCode.RendererUnavailable, `Window ${targetWindow.id} has no control renderer`);
		}
		return connection;
	}

	private onControlConnectionClosed(connection: HackerCodeControlConnection): void {
		this.controlConnections.delete(connection);
		const windowId = connection.rendererWindowId;
		if (windowId !== undefined && this.rendererConnections.get(windowId) === connection) {
			this.rendererConnections.delete(windowId);
		}
	}

	private disposeControlConnections(): void {
		for (const connection of [...this.controlConnections]) {
			connection.dispose();
		}
		this.controlConnections.clear();
		this.rendererConnections.clear();
	}

	private async writeControlEndpointMetadata(metadata: IHackerCodeControlEndpointMetadata): Promise<void> {
		await mkdir(this.controlDirectory, { recursive: true, mode: 0o700 });
		await setRestrictiveDirectoryMode(this.controlDirectory);
		const temporaryPath = join(this.controlDirectory, `.control-${process.pid}-${randomUUID()}.tmp`);
		let published = false;
		try {
			await writeFile(temporaryPath, `${JSON.stringify(metadata, undefined, '\t')}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
			await chmod(temporaryPath, 0o600);
			await rename(temporaryPath, this.controlMetadataPath);
			published = true;
			await chmod(this.controlMetadataPath, 0o600);
		} catch (error) {
			await rm(temporaryPath, { force: true });
			if (published) {
				await rm(this.controlMetadataPath, { force: true });
			}
			throw error;
		}
	}

	private async removeControlEndpointMetadata(metadata: IHackerCodeControlEndpointMetadata): Promise<void> {
		try {
			const contents = await readFile(this.controlMetadataPath, 'utf8');
			const current = JSON.parse(contents) as Partial<IHackerCodeControlEndpointMetadata>;
			if (current.pid === metadata.pid && current.token === metadata.token) {
				await rm(this.controlMetadataPath, { force: true });
			}
		} catch (error) {
			if (!isFileNotFoundError(error)) {
				// Do not attach the parse/read error: parser diagnostics can
				// include snippets from the token-bearing metadata file.
				this.logService.warn('[HackerCode] Failed to remove stale control endpoint metadata.');
			}
		}
	}

	private armBootMonitoring(revisionId: string, windowId?: number): void {
		const key: BootRuntimeKey = windowId ?? 'global';
		this.disposeBootRuntime(key);
		if (windowId !== undefined) {
			const globalRuntime = this.bootRuntimes.get('global');
			if (globalRuntime?.revisionId === revisionId) {
				this.disposeBootRuntime('global');
			}
		}

		const disposables = new DisposableStore();
		const runtime: IHackerCodeBootRuntime = {
			revisionId,
			...(windowId === undefined ? {} : { windowId }),
			disposables,
			watchdog: disposables.add(new RunOnceScheduler(() => this.onBootWatchdog(key, revisionId), BOOT_WATCHDOG_DELAY)),
			livenessCheck: disposables.add(new RunOnceScheduler(() => this.checkBootLiveness(key, revisionId), HEARTBEAT_CHECK_INTERVAL)),
			lastHeartbeatAt: Date.now(),
			freezeMissCount: 0,
			dialogOpen: false
		};
		this.bootRuntimes.set(key, runtime);
		runtime.watchdog.schedule();
		runtime.livenessCheck.schedule();
	}

	private onBootWatchdog(key: BootRuntimeKey, revisionId: string): void {
		const runtime = this.bootRuntimes.get(key);
		if (!runtime || runtime.revisionId !== revisionId) {
			return;
		}

		this.logService.error(`[HackerCode] Boot watchdog expired for revision ${revisionId}. Entering safe mode.`);
		void this.enterSafeMode({
			reason: localize('hackercode.bootWatchdogExpired', "The HackerCode boot watchdog expired"),
			windowId: runtime.windowId
		}).catch(error => this.logService.error('[HackerCode] Failed to enter safe mode after boot watchdog expiry.', error));
	}

	private checkBootLiveness(key: BootRuntimeKey, revisionId: string): void {
		const runtime = this.bootRuntimes.get(key);
		if (!runtime || runtime.revisionId !== revisionId || runtime.dialogOpen) {
			return;
		}

		if (Date.now() - runtime.lastHeartbeatAt >= HEARTBEAT_CHECK_INTERVAL) {
			runtime.freezeMissCount++;
		} else {
			runtime.freezeMissCount = 0;
		}
		if (runtime.freezeMissCount >= HEARTBEAT_MISSES_BEFORE_PROMPT) {
			if (this.suppressRecoveryDialog) {
				this.logService.warn(`[HackerCode] Suppressing the frozen-renderer dialog for destructive recovery test revision ${revisionId}; waiting for the boot watchdog.`);
				return;
			}
			runtime.dialogOpen = true;
			void this.promptForFrozenBoot(key, runtime).catch(error => this.logService.error('[HackerCode] Boot recovery failed.', error));
			return;
		}
		runtime.livenessCheck.schedule();
	}

	private async promptForFrozenBoot(key: BootRuntimeKey, runtime: IHackerCodeBootRuntime): Promise<void> {
		const codeWindow = runtime.windowId === undefined
			? this.windowsMainService.getFocusedWindow()
			: this.windowsMainService.getWindowById(runtime.windowId);
		const browserWindow = codeWindow?.win;
		if (runtime.windowId !== undefined && (!browserWindow || browserWindow.isDestroyed())) {
			this.logService.error(`[HackerCode] Window ${runtime.windowId} stopped responding during boot and cannot show a recovery dialog. Entering safe mode automatically.`);
			await this.enterSafeMode({
				reason: localize('hackercode.windowUnavailableDuringBoot', "A HackerCode window became unavailable during boot"),
				windowId: runtime.windowId
			});
			return;
		}

		try {
			const result = await this.dialogMainService.showMessageBox({
				type: 'warning',
				buttons: [
					localize('hackercode.revertAndReload', "Revert and Reload"),
					localize('hackercode.wait', "Wait")
				],
				defaultId: 0,
				cancelId: 1,
				title: localize('hackercode.notRespondingTitle', "HackerCode Is Not Responding"),
				message: localize('hackercode.notRespondingMessage', "HackerCode did not report that the workbench is responsive."),
				detail: localize('hackercode.notRespondingDetail', "Revert to the last known good revision and reload, or wait for this revision to recover.")
			}, browserWindow ?? undefined);

			const currentRuntime = this.bootRuntimes.get(key);
			if (currentRuntime !== runtime) {
				return;
			}
			runtime.dialogOpen = false;
			if (result.response === 0) {
				await this.enterSafeMode({
					reason: localize('hackercode.unresponsiveBoot', "HackerCode became unresponsive during boot"),
					windowId: runtime.windowId
				});
			} else {
				runtime.lastHeartbeatAt = Date.now();
				runtime.freezeMissCount = 0;
				runtime.watchdog.schedule();
				runtime.livenessCheck.schedule();
			}
		} catch (error) {
			this.logService.error('[HackerCode] Failed to show the boot recovery dialog. Entering safe mode automatically.', error);
			await this.enterSafeMode({
				reason: localize('hackercode.recoveryDialogFailed', "The HackerCode recovery dialog failed"),
				windowId: runtime.windowId
			});
		}
	}

	private reloadWorkbenchWindows(windowId?: number): void {
		const windows = windowId === undefined
			? this.windowsMainService.getWindows()
			: [this.windowsMainService.getWindowById(windowId)].filter(window => window !== undefined);
		for (const window of windows) {
			// Session/agents windows use a separate workbench and must not load HackerCode patches.
			if (window.config?.isSessionsWindow || window.profile?.isAgentsWindowProfile) {
				continue;
			}
			window.reload();
		}
	}

	private clearBootRuntimes(revisionId?: string): void {
		for (const [key, runtime] of this.bootRuntimes) {
			if (revisionId === undefined || runtime.revisionId === revisionId) {
				this.disposeBootRuntime(key);
			}
		}
	}

	private disposeBootRuntime(key: BootRuntimeKey): void {
		const runtime = this.bootRuntimes.get(key);
		if (runtime) {
			this.bootRuntimes.delete(key);
			runtime.disposables.dispose();
		}
	}

	private assertUsableRevision(revisionId: string): void {
		validateRevisionId(revisionId);
		setHackerCodeRevision(this.ledger, revisionId);
	}

	private async validateActiveRevisionBaseline(context: string, refreshBaseline = false): Promise<void> {
		if (this.isBuilt) {
			return;
		}
		try {
			await this.getCurrentBaseline(refreshBaseline);
			const visited = new Set<string>();
			while (this.ledger.activeRevisionId !== PRISTINE_REVISION_ID && !visited.has(this.ledger.activeRevisionId)) {
				visited.add(this.ledger.activeRevisionId);
				if (await this.validateRevisionBaseline(this.ledger.activeRevisionId, context)) {
					return;
				}
			}
		} catch (error) {
			this.baselineHeadPromise = undefined;
			this.logService.error('[HackerCode] Unable to validate the active revision against git HEAD.', error);
			const visited = new Set<string>();
			while (this.ledger.activeRevisionId !== PRISTINE_REVISION_ID && !visited.has(this.ledger.activeRevisionId)) {
				visited.add(this.ledger.activeRevisionId);
				this.updateLedger(quarantineHackerCodeRevision(
					this.ledger,
					this.ledger.activeRevisionId,
					new Date().toISOString(),
					localize('hackercode.baselineUnavailable', "The source checkout baseline could not be verified")
				));
			}
		}
	}

	private async validateRevisionBaseline(revisionId: string, context: string, refreshBaseline = false): Promise<boolean> {
		if (this.isBuilt || revisionId === PRISTINE_REVISION_ID) {
			return true;
		}
		const revision = this.ledger.revisions.find(candidate => candidate.id === revisionId);
		if (!revision) {
			return true;
		}
		const head = await this.getCurrentBaseline(refreshBaseline);
		if (revision.baseline === head) {
			return true;
		}
		this.quarantineForBaselineMismatch(revisionId, head, context);
		return false;
	}

	private quarantineForBaselineMismatch(revisionId: string, head: string, context: string): void {
		this.logService.warn(`[HackerCode] Quarantining revision ${revisionId}: baseline does not match git HEAD during ${context}.`);
		this.updateLedger(quarantineHackerCodeRevision(
			this.ledger,
			revisionId,
			new Date().toISOString(),
			localize('hackercode.baselineMismatch', "Revision baseline does not match the current source checkout ({0})", head)
		));
		this.clearBootRuntimes(revisionId);
	}

	private async assertCurrentBaseline(baseline: string): Promise<void> {
		if (!this.isBuilt) {
			const head = await this.getCurrentBaseline(true);
			if (baseline !== head) {
				throw new Error(`HackerCode revision baseline must match the current git HEAD: ${head}`);
			}
		}
	}

	private getCurrentBaseline(refresh = false): Promise<string> {
		if (refresh) {
			this.baselineHeadPromise = undefined;
		}
		if (!this.baselineHeadPromise) {
			this.baselineHeadPromise = getHackerCodeGitHead(this.appRoot, this.commandRunner).then(head => {
				this.baselineHead = head;
				return head;
			});
		}
		return this.baselineHeadPromise;
	}

	private assertWorkbenchWindow(windowId: number): void {
		const window = this.windowsMainService.getWindowById(windowId);
		if (!window || window.config?.isSessionsWindow || window.profile?.isAgentsWindowProfile) {
			throw new Error('HackerCode promotion requires a workbench window');
		}
	}

	private async readVerifiedPatchSources(manifest: IHackerCodeRevisionManifest): Promise<readonly IHackerCodePatchSource[]> {
		const revisionPath = this.getRevisionPath(manifest.id);
		const sources: IHackerCodePatchSource[] = [];
		for (const patch of manifest.patches) {
			const content = await readFile(join(revisionPath, patch.fileName), 'utf8');
			if (Buffer.byteLength(content, 'utf8') !== patch.size || hashString(content) !== patch.sha256) {
				throw new Error(`HackerCode patch source failed integrity validation: ${patch.name}`);
			}
			sources.push({ name: patch.name, content });
		}
		return sources;
	}

	private cloneState(): IHackerCodeState {
		return cloneState(this.ledger, {
			current: this.baselineHead,
			promotionAvailable: !this.isBuilt && this.baselineHead !== undefined
		});
	}

	private async ensureRevisionStore(): Promise<void> {
		const controlPath = join(this.revisionsPath, '..');
		await mkdir(controlPath, { recursive: true, mode: 0o700 });
		await mkdir(this.revisionsPath, { recursive: true, mode: 0o700 });
		await setRestrictiveDirectoryMode(controlPath);
		await setRestrictiveDirectoryMode(this.revisionsPath);
	}

	private async storeRevision(manifest: IHackerCodeRevisionManifest, patches: readonly IHackerCodePatchSource[]): Promise<void> {
		const revisionPath = this.getRevisionPath(manifest.id);
		const stagingPath = join(this.revisionsPath, `.staging-${manifest.id}-${randomUUID()}`);
		await mkdir(stagingPath, { mode: 0o700 });

		try {
			for (let index = 0; index < patches.length; index++) {
				await writeFile(join(stagingPath, manifest.patches[index].fileName), patches[index].content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
			}
			await writeFile(join(stagingPath, 'manifest.json'), `${JSON.stringify(manifest, undefined, '\t')}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
			await rename(stagingPath, revisionPath);
			await setRestrictiveDirectoryMode(revisionPath);
		} catch (error) {
			await rm(stagingPath, { recursive: true, force: true });
			const existing = await this.tryReadStoredManifest(manifest.id);
			if (!existing || !manifestsHaveSameIdentity(existing, manifest)) {
				throw error;
			}
		}
	}

	private async tryReadStoredManifest(revisionId: string): Promise<IHackerCodeRevisionManifest | undefined> {
		const manifestPath = join(this.getRevisionPath(revisionId), 'manifest.json');
		try {
			await stat(manifestPath);
		} catch (error) {
			if (isFileNotFoundError(error)) {
				return undefined;
			}
			throw error;
		}

		return this.readStoredManifest(revisionId);
	}

	private async readStoredManifest(revisionId: string): Promise<IHackerCodeRevisionManifest> {
		const manifestPath = join(this.getRevisionPath(revisionId), 'manifest.json');
		const contents = await readFile(manifestPath, 'utf8');
		const manifest: IHackerCodeRevisionManifest = JSON.parse(contents);
		if (!isValidManifest(manifest) || manifest.id !== revisionId) {
			throw new Error(`Invalid HackerCode revision manifest: ${revisionId}`);
		}
		return manifest;
	}

	private getRevisionPath(revisionId: string): string {
		if (!REVISION_ID_PATTERN.test(revisionId)) {
			throw new Error(`Invalid stored HackerCode revision id: ${revisionId}`);
		}
		return join(this.revisionsPath, revisionId);
	}

	private updateLedger(ledger: IHackerCodeRevisionLedger): void {
		const normalizedLedger = normalizeHackerCodeRevisionLedger(ledger);
		if (JSON.stringify(this.ledger) === JSON.stringify(normalizedLedger)) {
			return;
		}

		this.ledger = normalizedLedger;
		this.persistLedger();
		this._onDidChangeState.fire(this.cloneState());
	}

	private persistLedger(): void {
		this.stateService.setItem(HACKERCODE_STORAGE_KEYS.revisionLedger, this.ledger);
	}

	override dispose(): void {
		const metadata = this.controlMetadata;
		this.controlMetadata = undefined;
		this.controlEndpoint = undefined;
		super.dispose();
		if (metadata) {
			void this.removeControlEndpointMetadata(metadata);
		}
	}
}

class HackerCodeControlConnection extends Disposable {
	private readonly protocol: JsonRpcProtocol;
	private closeNotified = false;

	rendererWindowId: number | undefined;

	constructor(
		transport: IProtocolTransport,
		handleRequest: (request: IJsonRpcRequest) => Promise<unknown>,
		private readonly onClose: () => void
	) {
		super();
		this._register(transport);
		this.protocol = this._register(new JsonRpcProtocol(
			message => sendControlMessage(transport, message),
			{ handleRequest }
		));
		this._register(transport.onMessage(message => this.handleWireMessage(transport, message)));
		this._register(transport.onClose(() => this.dispose()));
	}

	sendRequest(method: string, params: unknown, token: CancellationToken): Promise<unknown> {
		return this.protocol.sendRequest({ method, params }, token);
	}

	private handleWireMessage(transport: IProtocolTransport, value: unknown): void {
		const parsed = parseHackerCodeJsonRpcMessage(value);
		switch (parsed.kind) {
			case 'invalid':
				sendControlMessage(transport, parsed.response);
				return;
			case 'notification':
				// JSON-RPC notifications never receive responses. Ignore all
				// control notifications so mutations always require a request.
				return;
			case 'request':
			case 'response':
				void this.protocol.handleMessage(parsed.message);
				return;
		}
	}

	override dispose(): void {
		if (!this.closeNotified) {
			this.closeNotified = true;
			this.onClose();
		}
		super.dispose();
	}
}

function validateCreateRevisionRequest(request: IHackerCodeCreateRevisionRequest): void {
	if (!isPlainObject(request) || !hasOnlyKeys(request, ['baseline', 'description', 'parentId', 'patches'])) {
		throw new Error('Invalid HackerCode create revision request');
	}
	validateBoundedString(request.baseline, 'baseline', MAX_BASELINE_LENGTH);
	if (request.description !== undefined) {
		validateBoundedString(request.description, 'description', MAX_DESCRIPTION_LENGTH, true);
	}
	if (request.parentId !== undefined) {
		validateRevisionId(request.parentId);
	}
	if (!Array.isArray(request.patches) || request.patches.length > MAX_PATCH_COUNT) {
		throw new Error(`HackerCode revisions accept at most ${MAX_PATCH_COUNT} patches`);
	}

	const names = new Set<string>();
	for (const patch of request.patches) {
		if (!isPlainObject(patch) || !hasOnlyKeys(patch, ['name', 'content'])) {
			throw new Error('Invalid HackerCode patch source');
		}
		validatePatchName(patch.name);
		if (typeof patch.content !== 'string' || Buffer.byteLength(patch.content, 'utf8') > MAX_PATCH_SOURCE_SIZE) {
			throw new Error(`HackerCode patch sources must not exceed ${MAX_PATCH_SOURCE_SIZE} bytes`);
		}
		if (names.has(patch.name)) {
			throw new Error(`Duplicate HackerCode patch source name: ${patch.name}`);
		}
		names.add(patch.name);
	}
}

function validateSetRevisionRequest(request: IHackerCodeSetRevisionRequest): void {
	if (!isPlainObject(request) || !hasOnlyKeys(request, ['revisionId', 'mode', 'windowId'])) {
		throw new Error('Invalid HackerCode set revision request');
	}
	validateRevisionId(request.revisionId);
	if (request.windowId !== undefined) {
		validateWindowId(request.windowId);
	}
	if (request.mode !== undefined && request.mode !== 'normal' && request.mode !== 'recover') {
		throw new Error('Invalid HackerCode revision selection mode');
	}
}

function validateReloadRevisionRequest(request: IHackerCodeReloadRevisionRequest): void {
	if (!isPlainObject(request) || !hasOnlyKeys(request, ['revisionId', 'windowId'])) {
		throw new Error('Invalid HackerCode reload revision request');
	}
	validateRevisionId(request.revisionId);
	validateWindowId(request.windowId);
}

function validatePromoteRequest(request: IHackerCodePromoteRequest): void {
	if (!isPlainObject(request) || !hasOnlyKeys(request, ['revisionId', 'windowId', 'commitMessage'])) {
		throw new Error('Invalid HackerCode promote request');
	}
	validateRevisionId(request.revisionId);
	validateWindowId(request.windowId);
	if (request.commitMessage !== undefined) {
		validateCommitMessage(request.commitMessage);
	}
}

function validateCommitMessage(message: string): void {
	if (
		typeof message !== 'string'
		|| message.length === 0
		|| message.length > MAX_COMMIT_MESSAGE_LENGTH
		|| message.trim() !== message
		|| /[\u0000-\u001f\u007f]/.test(message)
	) {
		throw new Error(`HackerCode commit messages must be a single trimmed line no longer than ${MAX_COMMIT_MESSAGE_LENGTH} characters`);
	}
}

function validateQuarantineRevisionRequest(request: IHackerCodeQuarantineRevisionRequest): void {
	if (!isPlainObject(request) || !hasOnlyKeys(request, ['revisionId', 'reason'])) {
		throw new Error('Invalid HackerCode quarantine request');
	}
	validateRevisionId(request.revisionId);
	if (request.reason !== undefined) {
		validateBoundedString(request.reason, 'quarantine reason', MAX_QUARANTINE_REASON_LENGTH, true);
	}
}

function validateBootRequest(request: IHackerCodeBootRequest): void {
	if (!isPlainObject(request) || !hasOnlyKeys(request, ['revisionId', 'windowId'])) {
		throw new Error('Invalid HackerCode boot request');
	}
	validateRevisionId(request.revisionId);
	validateWindowId(request.windowId);
}

function validateSafeModeRequest(request: IHackerCodeSafeModeRequest): void {
	if (!isPlainObject(request) || !hasOnlyKeys(request, ['reason', 'windowId'])) {
		throw new Error('Invalid HackerCode safe mode request');
	}
	if (request.reason !== undefined) {
		validateBoundedString(request.reason, 'safe mode reason', MAX_QUARANTINE_REASON_LENGTH, true);
	}
	if (request.windowId !== undefined) {
		validateWindowId(request.windowId);
	}
}

function validateRevisionId(revisionId: string): void {
	if (typeof revisionId !== 'string' || (revisionId !== PRISTINE_REVISION_ID && !REVISION_ID_PATTERN.test(revisionId))) {
		throw new Error('Invalid HackerCode revision id');
	}
}

function validateWindowId(windowId: number): void {
	if (typeof windowId !== 'number' || !Number.isSafeInteger(windowId) || windowId <= 0) {
		throw new Error('Invalid HackerCode window id');
	}
}

function validatePatchName(name: string): void {
	validateBoundedString(name, 'patch name', MAX_PATCH_NAME_LENGTH);
	if (name === '.' || name === '..' || /[\\/\u0000-\u001f\u007f]/.test(name)) {
		throw new Error('HackerCode patch names cannot contain paths or control characters');
	}
}

function validateBoundedString(value: string, name: string, maximumLength: number, allowEmpty = false): void {
	if (
		typeof value !== 'string'
		|| value.length > maximumLength
		|| (!allowEmpty && value.length === 0)
		|| value.trim() !== value
		|| /[\u0000]/.test(value)
	) {
		throw new Error(`Invalid HackerCode ${name}`);
	}
}

function isPlainObject<T>(value: T): value is T & Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: object, allowedKeys: readonly string[]): boolean {
	return Object.keys(value).every(key => allowedKeys.includes(key));
}

function isValidLedger(ledger: IHackerCodeRevisionLedger | undefined): boolean {
	return isPlainObject(ledger)
		&& hasOnlyKeys(ledger, ['schemaVersion', 'activeRevisionId', 'lastKnownGoodRevisionId', 'revisions', 'quarantinedRevisions', 'bootAttempt', 'skipPromoted'])
		&& ledger?.schemaVersion === 1
		&& isValidRevisionId(ledger.activeRevisionId)
		&& isValidRevisionId(ledger.lastKnownGoodRevisionId)
		&& Array.isArray(ledger.revisions)
		&& ledger.revisions.every(isValidManifest)
		&& Array.isArray(ledger.quarantinedRevisions)
		&& ledger.quarantinedRevisions.every(quarantine => isPlainObject(quarantine)
			&& hasOnlyKeys(quarantine, ['revisionId', 'quarantinedAt', 'reason'])
			&& isValidRevisionId(quarantine.revisionId)
			&& isIsoTimestamp(quarantine.quarantinedAt)
			&& (quarantine.reason === undefined || isBoundedStoredString(quarantine.reason, MAX_QUARANTINE_REASON_LENGTH, true)))
		&& (ledger.bootAttempt === undefined || isValidBootAttempt(ledger.bootAttempt))
		&& (ledger.skipPromoted === undefined || typeof ledger.skipPromoted === 'boolean');
}

function isValidBootAttempt(bootAttempt: IHackerCodeBootAttempt): boolean {
	return isPlainObject(bootAttempt)
		&& hasOnlyKeys(bootAttempt, ['revisionId', 'windowId', 'startedAt'])
		&& isValidRevisionId(bootAttempt.revisionId)
		&& (bootAttempt.windowId === undefined || (typeof bootAttempt.windowId === 'number' && Number.isSafeInteger(bootAttempt.windowId) && bootAttempt.windowId > 0))
		&& isIsoTimestamp(bootAttempt.startedAt);
}

function isValidManifest(manifest: IHackerCodeRevisionManifest): boolean {
	return isPlainObject(manifest)
		&& hasOnlyKeys(manifest, ['schemaVersion', 'id', 'baseline', 'createdAt', 'description', 'parentId', 'patches'])
		&& manifest.schemaVersion === 1
		&& isValidRevisionId(manifest.id)
		&& isBoundedStoredString(manifest.baseline, MAX_BASELINE_LENGTH)
		&& isIsoTimestamp(manifest.createdAt)
		&& isValidRevisionId(manifest.parentId)
		&& (manifest.description === undefined || isBoundedStoredString(manifest.description, MAX_DESCRIPTION_LENGTH, true))
		&& Array.isArray(manifest.patches)
		&& manifest.patches.length <= MAX_PATCH_COUNT
		&& manifest.patches.every((patch, index) => isPlainObject(patch)
			&& hasOnlyKeys(patch, ['name', 'fileName', 'sha256', 'size'])
			&& isValidPatchName(patch.name)
			&& patch.fileName === `patch-${String(index).padStart(4, '0')}.txt`
			&& PATCH_FILE_NAME_PATTERN.test(patch.fileName)
			&& typeof patch.sha256 === 'string'
			&& REVISION_ID_PATTERN.test(patch.sha256)
			&& typeof patch.size === 'number'
			&& Number.isSafeInteger(patch.size)
			&& patch.size >= 0
			&& patch.size <= MAX_PATCH_SOURCE_SIZE);
}

function isValidRevisionId(revisionId: string): boolean {
	return typeof revisionId === 'string' && (revisionId === PRISTINE_REVISION_ID || REVISION_ID_PATTERN.test(revisionId));
}

function isValidPatchName(name: string): boolean {
	return isBoundedStoredString(name, MAX_PATCH_NAME_LENGTH)
		&& name !== '.'
		&& name !== '..'
		&& !/[\\/\u0000-\u001f\u007f]/.test(name);
}

function isBoundedStoredString(value: string, maximumLength: number, allowEmpty = false): boolean {
	return typeof value === 'string'
		&& value.length <= maximumLength
		&& (allowEmpty || value.length > 0)
		&& value.trim() === value
		&& !/[\u0000]/.test(value);
}

function isIsoTimestamp(value: string): boolean {
	if (typeof value !== 'string') {
		return false;
	}
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function computeRevisionId(
	request: IHackerCodeCreateRevisionRequest,
	parentId: string,
	patches: readonly IHackerCodePatchDescriptor[]
): string {
	const canonicalMetadata = JSON.stringify({
		schemaVersion: 1,
		baseline: request.baseline,
		description: request.description ?? null,
		parentId,
		patches: patches.map(patch => ({
			name: patch.name,
			fileName: patch.fileName,
			sha256: patch.sha256,
			size: patch.size
		}))
	});
	const hash = createHash('sha256').update(canonicalMetadata, 'utf8');
	for (const patch of request.patches) {
		hash.update(`\n${Buffer.byteLength(patch.content, 'utf8')}:`, 'utf8');
		hash.update(patch.content, 'utf8');
	}
	return hash.digest('hex');
}

function hashString(value: string): string {
	return createHash('sha256').update(value, 'utf8').digest('hex');
}

function manifestsHaveSameIdentity(first: IHackerCodeRevisionManifest, second: IHackerCodeRevisionManifest): boolean {
	return first.id === second.id
		&& first.baseline === second.baseline
		&& first.description === second.description
		&& first.parentId === second.parentId
		&& JSON.stringify(first.patches) === JSON.stringify(second.patches);
}

function cloneManifest(manifest: IHackerCodeRevisionManifest): IHackerCodeRevisionManifest {
	return {
		...manifest,
		patches: manifest.patches.map(patch => ({ ...patch }))
	};
}

function cloneState(ledger: IHackerCodeRevisionLedger, baseline: IHackerCodeBaselineInfo): IHackerCodeState {
	return {
		...ledger,
		revisions: ledger.revisions.map(cloneManifest),
		quarantinedRevisions: ledger.quarantinedRevisions.map(quarantine => ({ ...quarantine })),
		bootAttempt: ledger.bootAttempt ? { ...ledger.bootAttempt } : undefined,
		baseline: { ...baseline }
	};
}

function collectPromotedContent(bundle: IHackerCodePromotedBundle): Map<string, string> {
	const contentByFileName = new Map<string, string>();
	for (const layer of bundle.manifest.layers) {
		const sources = bundle.sourcesByLayer.get(layer.id);
		if (!sources || sources.length !== layer.patches.length) {
			throw new Error(`HackerCode promoted layer returned an unexpected source count: ${layer.id}`);
		}
		for (let index = 0; index < layer.patches.length; index++) {
			const descriptor = layer.patches[index];
			const source = sources[index];
			if (source.name !== descriptor.name) {
				throw new Error(`HackerCode promoted patch source does not match its descriptor: ${descriptor.name}`);
			}
			const existing = contentByFileName.get(descriptor.fileName);
			if (existing !== undefined && existing !== source.content) {
				throw new Error(`Conflicting HackerCode promoted patch content: ${descriptor.fileName}`);
			}
			contentByFileName.set(descriptor.fileName, source.content);
		}
	}
	return contentByFileName;
}

function createOrReusePromotedManifest(
	manifest: IHackerCodePromotedManifest,
	revision: IHackerCodeRevisionManifest
): IHackerCodePromotedManifest {
	const existing = manifest.layers.find(layer => layer.id === revision.id);
	if (!existing) {
		return appendHackerCodePromotedLayer(manifest, revision, new Date().toISOString());
	}
	const expectedPatches = revision.patches.map(patch => ({ ...patch, fileName: `${patch.sha256}.js` }));
	if (existing.baseline !== revision.baseline || JSON.stringify(existing.patches) !== JSON.stringify(expectedPatches)) {
		throw new Error(`Existing HackerCode promoted layer does not match revision: ${revision.id}`);
	}
	return manifest;
}

async function setRestrictiveDirectoryMode(path: string): Promise<void> {
	try {
		await chmod(path, 0o700);
	} catch {
		// Some filesystems and platforms do not support POSIX modes.
	}
}

function isFileNotFoundError(error: unknown): boolean {
	return error instanceof Error && hasOwnProperty(error, 'code') && error.code === 'ENOENT';
}

function hasOwnProperty<T extends object, K extends PropertyKey>(value: T, key: K): value is T & Record<K, unknown> {
	return Object.prototype.hasOwnProperty.call(value, key);
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch (error) {
		if (isFileNotFoundError(error)) {
			return false;
		}
		throw error;
	}
}

function isMatchingControlToken(candidate: unknown, expected: string): boolean {
	if (typeof candidate !== 'string') {
		return false;
	}
	const candidateBytes = Buffer.from(candidate, 'utf8');
	const expectedBytes = Buffer.from(expected, 'utf8');
	return candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes);
}

function sendControlMessage(transport: IProtocolTransport, message: JsonRpcMessage | IHackerCodeJsonRpcNullErrorResponse): void {
	// IProtocolTransport is typed with generated AHP message unions, while its
	// JSON-RPC base request/response wrappers deliberately allow arbitrary
	// method strings used by this separate control protocol.
	transport.send(message as JsonRpcRequest | JsonRpcResponse | JsonRpcParseErrorResponse);
}
