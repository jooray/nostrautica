/** @module @category Client - Group Manager */
import { EventSigner } from "applesauce-core";
import type { NostrEvent } from "applesauce-core/helpers/event";
import { CiphersuiteName, CryptoProvider } from "../vendor/ts-mls/index.js";
import type { SerializedClientState } from "../core/client-state.js";
import type { ConvergencePolicy } from "../core/convergence.js";
import type { IngestionPoolOptions } from "../engine/ingestion-pool.js";
import type { AuditContextOptions, AuditSink } from "../audit/index.js";
import { SimpleGroupOptions } from "../core/group.js";
import type { GenericKeyValueStore } from "../utils/key-value.js";
import { BaseGroupHistory, BaseGroupMedia, GroupHistoryFactory, GroupMediaFactory, MarmotGroup } from "./group/marmot-group.js";
import { type VerifyEventMethod } from "./verify.js";
import type { NostrNetworkInterface } from "./nostr-interface.js";
/** Options accepted by {@link GroupFactory}. */
export type GroupFactoryOptions<THistory extends BaseGroupHistory | undefined = undefined, TMedia extends BaseGroupMedia | undefined = undefined> = {
    store: GenericKeyValueStore<SerializedClientState>;
    ingestStateStore: GenericKeyValueStore<Uint8Array>;
    lifecycleStore: GenericKeyValueStore<Uint8Array>;
    /** Dedicated store for the per-group rewind-history blob (optional). */
    rewindStore?: GenericKeyValueStore<Uint8Array>;
    /**
     * Persisted removed-inactive marker store (D-12) inherited by new groups;
     * see {@link MarmotGroupOptions.removedMarkerStore}.
     */
    removedMarkerStore?: GenericKeyValueStore<boolean>;
    signer: EventSigner;
    network: NostrNetworkInterface;
    /** Optional forensic audit sink inherited by new groups. */
    audit?: AuditSink;
    /** Required when `audit` is set; contains stable engine/account/session metadata. */
    auditContext?: AuditContextOptions;
    cryptoProvider?: CryptoProvider;
    historyFactory?: GroupHistoryFactory<THistory>;
    mediaFactory?: GroupMediaFactory<TMedia>;
    /** Convergence policy applied to newly created/imported groups. */
    convergencePolicy?: ConvergencePolicy;
    /** Ingestion-pool tuning applied to newly created/imported groups. */
    ingestionPool?: IngestionPoolOptions;
    /**
     * Injectable event verifier for founding invitee admission (D-11), gating
     * the same 30443 trust boundary `GroupsManager.invite()` already uses.
     * Defaults to applesauce's `verifyEvent`.
     */
    verifyEvent?: VerifyEventMethod;
};
export type CreateGroupOptions = SimpleGroupOptions & {
    ciphersuite?: CiphersuiteName;
    /**
     * Founding invitees' KeyPackage events (kind 30443). Supplying this turns
     * `create()` into a *founding* creation (D-08): one Add commit carrying
     * every invitee is merged locally to epoch 1 and **no** kind-445 group
     * event is published for it (`refs/marmot/protocol-core/joining.md` lines
     * 21-30 — the founding-creation exception). Omitting `invitees` keeps
     * today's exact solo-create behaviour and code path.
     *
     * When `invitees` is non-empty, `relays` MUST be a non-empty list of valid
     * ws/wss relay URLs, otherwise `create()` throws before generating any key
     * material, building any MLS state or writing to any store (CR-01,
     * supersedes D-09 — see 10-VERIFICATION.md). The reason: every Welcome
     * rumor must carry a non-empty `relays` tag (`createWelcomeRumor()`), and a
     * group without a Nostr routing component can never publish. A solo create
     * (`invitees` omitted or empty) may still omit `relays`.
     */
    invitees?: NostrEvent[];
};
/**
 * Builds new {@link MarmotGroup} instances. Isolates the identity signer and
 * the ciphersuite implementation — i.e. the native-sensitive group-creation
 * seam (darkmatter's `do_create_group`). The factory only constructs and
 * persists; caching/eventing is the registry's job.
 */
export declare class GroupFactory<THistory extends BaseGroupHistory | undefined = any, TMedia extends BaseGroupMedia | undefined = any> {
    #private;
    constructor(options: GroupFactoryOptions<THistory, TMedia>);
    /**
     * Creates and persists a new simple group with the manager's signer as the
     * sole initial admin. The returned group is saved but not cached — the
     * caller (registry/manager) tracks it and emits the `created` event.
     *
     * When `options.invitees` is a non-empty array, this becomes a *founding*
     * creation (D-08): every invitee is admitted through the unchanged invite
     * trust boundary (D-11) into one founding Add commit that is merged
     * locally to epoch 1 with no yield between send and confirm (D-01/D-02),
     * the produced Welcome is asserted to carry exactly one distinct secret
     * per invitee (D-13), and Welcomes are fanned out directly, bypassing
     * `GroupRuntime` (D-05/D-07/D-12). Only one durable write occurs either
     * way (D-03): omitting `invitees` keeps today's exact solo-create result.
     *
     * A founding create first validates the group relays (CR-01) and refuses
     * before any state exists when `invitees` is non-empty and `relays` is
     * absent, empty, or contains an invalid relay URL.
     */
    create(name: string, options?: CreateGroupOptions): Promise<MarmotGroup<THistory, TMedia>>;
}
