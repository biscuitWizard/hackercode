/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IEntitlementsData } from '../../../../base/common/defaultAccount.js';
import { Event } from '../../../../base/common/event.js';
import { Lazy } from '../../../../base/common/lazy.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { constObservable, IObservable } from '../../../../base/common/observable.js';
import { Mutable } from '../../../../base/common/types.js';
import { localize } from '../../../../nls.js';
import { IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';

/**
 * Chat entitlements do not exist in HackerCode: models come from the user's own
 * OpenAI-compatible providers and API keys, so there is nothing to sign in to,
 * sign up for, or meter.
 *
 * This module keeps the shape the rest of the workbench reads — the context
 * keys, the enum, and the service interface — but reports a single fixed state:
 * setup complete, chat installed and enabled, BYOK models available, no quotas.
 * Every sign-in, sign-up, quota and upgrade branch in the chat UI is reachable
 * only from that state being false, so they are all dead code at runtime while
 * their call sites keep compiling untouched.
 */

export namespace ChatEntitlementContextKeys {

	export const Setup = {
		hidden: new RawContextKey<boolean>('chatSetupHidden', false, true), 		// True when chat setup is explicitly hidden.
		installed: new RawContextKey<boolean>('chatSetupInstalled', false, true),  	// True when the chat extension is installed and enabled.
		disabled: new RawContextKey<boolean>('chatSetupDisabled', false, true),  	// True when the chat extension is disabled due to any other reason than workspace trust.
		disabledInWorkspace: new RawContextKey<boolean>('chatSetupDisabledInWorkspace', false, true),	// True when chat is disabled at the workspace level via settings.
		untrusted: new RawContextKey<boolean>('chatSetupUntrusted', false, true),  	// True when the chat extension is disabled due to workspace trust.
		later: new RawContextKey<boolean>('chatSetupLater', false, true),  			// True when the user wants to finish setup later.
		registered: new RawContextKey<boolean>('chatSetupRegistered', false, true), // True when the user has registered as Free or Pro user.
		completed: new RawContextKey<boolean>('chatSetupCompleted', false, true)	// True when the user has completed the setup flow, regardless of the outcome.
	};

	export const Entitlement = {
		signedOut: new RawContextKey<boolean>('chatEntitlementSignedOut', false, true), 				// True when user is signed out.
		canSignUp: new RawContextKey<boolean>('chatPlanCanSignUp', false, true), 						// True when user can sign up to be a chat free user.

		planFree: new RawContextKey<boolean>('chatPlanFree', false, true),								// True when user is a chat free user.
		planPro: new RawContextKey<boolean>('chatPlanPro', false, true),								// True when user is a chat pro user.
		planEdu: new RawContextKey<boolean>('chatPlanEdu', false, true),								// True when user is a chat edu user.
		planProPlus: new RawContextKey<boolean>('chatPlanProPlus', false, true), 						// True when user is a chat pro plus user.
		planMax: new RawContextKey<boolean>('chatPlanMax', false, true), 								// True when user is a chat max user.
		planBusiness: new RawContextKey<boolean>('chatPlanBusiness', false, true), 						// True when user is a chat business user.
		planEnterprise: new RawContextKey<boolean>('chatPlanEnterprise', false, true), 					// True when user is a chat enterprise user.

		organisations: new RawContextKey<string[]>('chatEntitlementOrganisations', undefined, true), 	// The organizations the user belongs to.
		internal: new RawContextKey<boolean>('chatEntitlementInternal', false, true), 					// True when user belongs to internal organisation.
		sku: new RawContextKey<string>('chatEntitlementSku', undefined, true), 							// The SKU of the user.
	};

	export const chatQuotaExceeded = new RawContextKey<boolean>('chatQuotaExceeded', false, true);
	export const completionsQuotaExceeded = new RawContextKey<boolean>('completionsQuotaExceeded', false, true);

	export const chatAnonymous = new RawContextKey<boolean>('chatAnonymous', false, true);

	export const clientByokEnabled = new RawContextKey<boolean>('github.copilot.clientByokEnabled', true, true);

	export const hasByokModels = new RawContextKey<boolean>('github.copilot.hasByokModels', false, true);
}

export const IChatEntitlementService = createDecorator<IChatEntitlementService>('chatEntitlementService');

export enum ChatEntitlement {
	/** Signed out */
	Unknown = 1,
	/** Signed in but not yet resolved */
	Unresolved = 2,
	/** Signed in and entitled to Free */
	Available = 3,
	/** Signed in but not entitled to Free */
	Unavailable = 4,
	/** Signed-up to Free */
	Free = 5,
	/** Signed-up to EDU */
	EDU = 10,
	/** Signed-up to Pro */
	Pro = 6,
	/** Signed-up to Pro Plus */
	ProPlus = 7,
	/** Signed-up to Business */
	Business = 8,
	/** Signed-up to Enterprise */
	Enterprise = 9,
	/** Signed-up to Max */
	Max = 11,
}

export interface IChatSentiment {

	/**
	 * Whether the user has completed the setup flow or not, regardless of the outcome
	 */
	completed?: boolean;

	/**
	 * User has Chat installed.
	 */
	installed?: boolean;

	/**
	 * User signals no intent in using Chat.
	 *
	 * Note: in contrast to `disabled`, this should not only disable
	 * Chat but also hide all of its UI.
	 */
	hidden?: boolean;

	/**
	 * User signals intent to disable Chat.
	 *
	 * Note: in contrast to `hidden`, this should not hide
	 * Chat but but disable its functionality.
	 */
	disabled?: boolean;

	/**
	 * Chat is disabled at the workspace level
	 */
	disabledInWorkspace?: boolean;

	/**
	 * Chat is disabled due to missing workspace trust.
	 */
	untrusted?: boolean;

	/**
	 * User signals intent to use Chat later.
	 */
	later?: boolean;

	/**
	 * User has registered as Free or Pro user.
	 */
	registered?: boolean;
}

/**
 * The inputs needed to decide whether Chat still requires the user to run setup
 * (sign in / sign up / trust / enable) before it can service a request.
 */
export interface IChatSetupRequirement {
	/** Whether the setup flow has been completed (any outcome). */
	readonly completed: boolean;
	/** Whether the chat extension is disabled for a reason other than trust. */
	readonly disabled: boolean;
	/** Whether the chat extension is disabled because the workspace is untrusted. */
	readonly untrusted: boolean;
	/** The user's last known or resolved entitlement. */
	readonly entitlement: ChatEntitlement;
	/** Whether anonymous (signed-out) Chat access is enabled. */
	readonly anonymous: boolean;
	/** Whether BYOK models are available. */
	readonly hasByokModels: boolean;
}

/**
 * Whether Chat requires setup before it can service a request. HackerCode has
 * no setup flow: a request either has a configured provider and model or it
 * does not, and the participant reports that itself.
 */
export function chatRequiresSetup(_context: IChatSetupRequirement): boolean {
	return false;
}

export interface IChatEntitlementService {

	_serviceBrand: undefined;

	readonly onDidChangeEntitlement: Event<void>;

	readonly entitlement: ChatEntitlement;
	readonly entitlementObs: IObservable<ChatEntitlement>;

	readonly clientByokEnabled: boolean;
	readonly hasByokModels: boolean;

	readonly organisations: string[] | undefined;
	readonly isInternal: boolean;
	readonly sku: string | undefined;
	readonly copilotTrackingId: string | undefined;

	readonly onDidChangeQuotaExceeded: Event<void>;
	readonly onDidChangeQuotaRemaining: Event<void>;
	readonly onDidChangeUsageBasedBilling: Event<void>;

	readonly quotas: IQuotas;

	readonly onDidChangeSentiment: Event<void>;

	readonly sentiment: IChatSentiment;
	readonly sentimentObs: IObservable<IChatSentiment>;

	readonly onDidChangeAnonymous: Event<void>;
	readonly anonymous: boolean;
	readonly anonymousObs: IObservable<boolean>;

	acceptQuotas(quotas: IQuotas): void;

	/**
	 * Clear all quota state.
	 */
	clearQuotas(): void;

	markAnonymousRateLimited(): void;

	/**
	 * Mark the chat setup flow as completed.
	 */
	markSetupCompleted(): void;

	/**
	 * Force the hidden state on or off, overriding the normal entitlement logic.
	 */
	setForceHidden(hidden: boolean): void;

	update(token: CancellationToken): Promise<void>;
}

//#region Helper Functions

/**
 * Checks the chat entitlements to see if the user falls into the paid category
 */
export function isProUser(chatEntitlement: ChatEntitlement): boolean {
	return chatEntitlement === ChatEntitlement.EDU ||
		chatEntitlement === ChatEntitlement.Pro ||
		chatEntitlement === ChatEntitlement.ProPlus ||
		chatEntitlement === ChatEntitlement.Max ||
		chatEntitlement === ChatEntitlement.Business ||
		chatEntitlement === ChatEntitlement.Enterprise;
}

export function getChatPlanName(_chatEntitlement: ChatEntitlement): string {
	return localize('plan.hackerCode', 'HackerCode');
}

//#endregion

//#region Quotas

export interface IQuotaSnapshot {
	readonly percentRemaining: number;
	readonly unlimited: boolean;
	readonly hasQuota?: boolean;
	readonly resetAt?: number;
	readonly usageBasedBilling?: boolean;
	readonly entitlement?: number;
	readonly quotaRemaining?: number;
	readonly creditsUsed?: number;
}

export interface IRateLimitSnapshot {
	readonly percentRemaining: number;
	readonly unlimited: boolean;
	readonly resetDate?: string;
}

interface IQuotas {
	readonly resetDate?: string;
	readonly resetDateHasTime?: boolean;

	readonly usageBasedBilling?: boolean;
	readonly canUpgradePlan?: boolean;

	readonly chat?: IQuotaSnapshot;
	readonly completions?: IQuotaSnapshot;
	readonly premiumChat?: IQuotaSnapshot;
	readonly additionalUsageEnabled?: boolean;
	readonly additionalUsageCount?: number;
	readonly additionalUsageEntitlement?: number;

	readonly sessionRateLimit?: IRateLimitSnapshot;
	readonly weeklyRateLimit?: IRateLimitSnapshot;
}

/**
 * Translates a provider's entitlements payload into quota snapshots. Kept
 * because agent-host harnesses report their own upstream quotas through the
 * same shape; it does not imply a chat entitlement of our own.
 */
export function parseQuotas(entitlementsData: IEntitlementsData): IQuotas {
	const quotas: Mutable<IQuotas> = {
		resetDate: entitlementsData.quota_reset_date_utc ?? entitlementsData.quota_reset_date ?? entitlementsData.limited_user_reset_date,
		resetDateHasTime: typeof entitlementsData.quota_reset_date_utc === 'string',
		usageBasedBilling: entitlementsData.token_based_billing,
		canUpgradePlan: entitlementsData.can_upgrade_plan,
	};

	if (entitlementsData.monthly_quotas?.chat && typeof entitlementsData.limited_user_quotas?.chat === 'number') {
		quotas.chat = {
			percentRemaining: Math.min(100, Math.max(0, (entitlementsData.limited_user_quotas.chat / entitlementsData.monthly_quotas.chat) * 100)),
			unlimited: false
		};
	}

	if (entitlementsData.monthly_quotas?.completions && typeof entitlementsData.limited_user_quotas?.completions === 'number') {
		quotas.completions = {
			percentRemaining: Math.min(100, Math.max(0, (entitlementsData.limited_user_quotas.completions / entitlementsData.monthly_quotas.completions) * 100)),
			unlimited: false
		};
	}

	if (entitlementsData.quota_snapshots) {
		for (const quotaType of ['chat', 'completions', 'premium_interactions'] as const) {
			const rawQuotaSnapshot = entitlementsData.quota_snapshots[quotaType];
			if (!rawQuotaSnapshot) {
				continue;
			}
			const parsedEntitlement = rawQuotaSnapshot.entitlement !== undefined ? Number(rawQuotaSnapshot.entitlement) : undefined;
			const parsedCreditsUsed = rawQuotaSnapshot.credits_used !== undefined ? Number(rawQuotaSnapshot.credits_used) : undefined;

			// Skip snapshots where the user has no allocated entitlement for this
			// category. Under usage-based billing has_quota is always false at the
			// per-snapshot level, so the entitlement value is what to check.
			if (!rawQuotaSnapshot.unlimited && parsedEntitlement === 0) {
				continue;
			}

			const parsedQuotaRemaining = rawQuotaSnapshot.quota_remaining !== undefined ? Number(rawQuotaSnapshot.quota_remaining) : undefined;
			const quotaSnapshot: IQuotaSnapshot = {
				percentRemaining: Math.min(100, Math.max(0, rawQuotaSnapshot.percent_remaining)),
				unlimited: rawQuotaSnapshot.unlimited,
				hasQuota: rawQuotaSnapshot.has_quota,
				usageBasedBilling: entitlementsData.token_based_billing,
				resetAt: rawQuotaSnapshot.quota_reset_at || undefined,
				entitlement: parsedEntitlement !== undefined && Number.isFinite(parsedEntitlement) && parsedEntitlement >= 0 ? parsedEntitlement : undefined,
				quotaRemaining: parsedQuotaRemaining !== undefined && Number.isFinite(parsedQuotaRemaining) && parsedQuotaRemaining >= 0 ? parsedQuotaRemaining : undefined,
				creditsUsed: parsedCreditsUsed !== undefined && Number.isFinite(parsedCreditsUsed) && parsedCreditsUsed >= 0 ? parsedCreditsUsed : undefined,
			};

			switch (quotaType) {
				case 'chat':
					quotas.chat = quotaSnapshot;
					break;
				case 'completions':
					quotas.completions = quotaSnapshot;
					break;
				case 'premium_interactions':
					quotas.premiumChat = quotaSnapshot;
					break;
			}
		}

		const overageSource = entitlementsData.quota_snapshots['premium_interactions'];
		quotas.additionalUsageEnabled = overageSource?.overage_permitted ?? false;
		quotas.additionalUsageCount = overageSource?.overage_count ?? 0;
		quotas.additionalUsageEntitlement = overageSource?.overage_entitlement ?? 0;
	}
	return quotas;
}

//#endregion

//#region Service Implementation

/** The one state this service ever reports. */
const SATISFIED_SENTIMENT: IChatSentiment = Object.freeze({
	completed: true,
	installed: true,
	registered: true,
	hidden: false,
	disabled: false,
	disabledInWorkspace: false,
	untrusted: false,
	later: false
});

export interface IChatEntitlementContextState extends IChatSentiment {
	entitlement: ChatEntitlement;
}

/**
 * The persisted setup state a profile would have carried. Retained so callers
 * that read another profile's setup state still compile; it reports the same
 * satisfied state everywhere, because there is no setup to have skipped.
 */
export class ChatEntitlementContext extends Disposable {

	readonly onDidChange = Event.None;

	readonly state: IChatEntitlementContextState = { ...SATISFIED_SENTIMENT, entitlement: ChatEntitlement.Pro as ChatEntitlement };
}

export class ChatEntitlementService extends Disposable implements IChatEntitlementService {

	declare _serviceBrand: undefined;

	/**
	 * Never resolved: the chat extension whose enablement this gated does not
	 * exist, so callers of `(service as ChatEntitlementService).context` take
	 * their "nothing to migrate" path.
	 */
	readonly context: Lazy<ChatEntitlementContext> | undefined = undefined;

	readonly onDidChangeEntitlement = Event.None;
	readonly onDidChangeQuotaExceeded = Event.None;
	readonly onDidChangeQuotaRemaining = Event.None;
	readonly onDidChangeUsageBasedBilling = Event.None;
	readonly onDidChangeSentiment = Event.None;
	readonly onDidChangeAnonymous = Event.None;

	// Widened to the enum rather than the literal so the many `entitlement ===
	// <other plan>` checks across the chat UI stay type-correct while always
	// evaluating false.
	readonly entitlement: ChatEntitlement = ChatEntitlement.Pro;
	readonly entitlementObs: IObservable<ChatEntitlement> = constObservable(ChatEntitlement.Pro);

	readonly clientByokEnabled = true;
	readonly hasByokModels = true;

	readonly organisations: string[] | undefined = undefined;
	readonly isInternal = false;
	readonly sku: string | undefined = undefined;
	readonly copilotTrackingId: string | undefined = undefined;

	readonly quotas: IQuotas = {};

	readonly sentiment: IChatSentiment = SATISFIED_SENTIMENT;
	readonly sentimentObs: IObservable<IChatSentiment> = constObservable(SATISFIED_SENTIMENT);

	readonly anonymous = false;
	readonly anonymousObs: IObservable<boolean> = constObservable(false);

	constructor(
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();

		// Pin the keys every chat `when` clause reads to the satisfied state, so
		// no setup, sign-in or quota UI is ever shown.
		ChatEntitlementContextKeys.Setup.installed.bindTo(contextKeyService).set(true);
		ChatEntitlementContextKeys.Setup.completed.bindTo(contextKeyService).set(true);
		ChatEntitlementContextKeys.Setup.registered.bindTo(contextKeyService).set(true);
		ChatEntitlementContextKeys.Setup.hidden.bindTo(contextKeyService).set(false);
		ChatEntitlementContextKeys.Setup.disabled.bindTo(contextKeyService).set(false);
		ChatEntitlementContextKeys.Setup.disabledInWorkspace.bindTo(contextKeyService).set(false);
		ChatEntitlementContextKeys.Setup.untrusted.bindTo(contextKeyService).set(false);
		ChatEntitlementContextKeys.Setup.later.bindTo(contextKeyService).set(false);

		ChatEntitlementContextKeys.Entitlement.signedOut.bindTo(contextKeyService).set(false);
		ChatEntitlementContextKeys.Entitlement.canSignUp.bindTo(contextKeyService).set(false);
		ChatEntitlementContextKeys.Entitlement.planPro.bindTo(contextKeyService).set(true);

		ChatEntitlementContextKeys.chatQuotaExceeded.bindTo(contextKeyService).set(false);
		ChatEntitlementContextKeys.completionsQuotaExceeded.bindTo(contextKeyService).set(false);
		ChatEntitlementContextKeys.chatAnonymous.bindTo(contextKeyService).set(false);
		ChatEntitlementContextKeys.clientByokEnabled.bindTo(contextKeyService).set(true);
		ChatEntitlementContextKeys.hasByokModels.bindTo(contextKeyService).set(true);
	}

	acceptQuotas(_quotas: IQuotas): void { }

	clearQuotas(): void { }

	markAnonymousRateLimited(): void { }

	markSetupCompleted(): void { }

	setForceHidden(_hidden: boolean): void { }

	async update(_token: CancellationToken): Promise<void> { }
}

registerSingleton(IChatEntitlementService, ChatEntitlementService, InstantiationType.Eager);

//#endregion
