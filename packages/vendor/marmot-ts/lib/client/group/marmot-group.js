import { bytesToHex } from "applesauce-core/helpers/event";
import { EventEmitter } from "eventemitter3";
import { defaultCryptoProvider, encode, mlsMessageEncoder, } from "../../vendor/ts-mls/index.js";
import { mayReleaseOutbound } from "../../core/convergence-status.js";
import { groupLifecycleStates } from "../../core/group-lifecycle.js";
import { commitDigest } from "../../core/convergence.js";
import { buildForkTreeView } from "./fork-tree-view.js";
import { logger } from "../../utils/debug.js";
import { getMarmotGroupInfo, } from "../../core/client-state.js";
import { evaluateKeyPackageForGroup, } from "../../core/key-package-eligibility.js";
import { GroupRuntime } from "../runtime/group-runtime.js";
import { GroupSession, ingestResultDisposition, } from "../session/group-session.js";
import { NostrWelcomeDelivery } from "../transport/nostr/welcome-delivery.js";
import { GroupMediaService, } from "./group-media-service.js";
export { createAdminCommitPolicyCallback } from "../../engine/admin-policy.js";
/** An error that is thrown when a group has no relays available to send messages. */
export class NoGroupRelaysError extends Error {
    constructor() {
        super("Group has no relays available to send messages.");
    }
}
/** An error that is thrown the client is unable to find the MarmotGroupData in the ClientState of a group. */
export class NoMarmotGroupDataError extends Error {
    constructor() {
        super("MarmotGroupData not found in ClientState.");
    }
}
/** Stable typed refusal for every operation attempted after canonical disband. */
export class GroupTerminalError extends Error {
    reason = "group_disbanded";
    constructor() {
        super("Group is disbanded");
        this.name = "GroupTerminalError";
    }
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
export { ingestResultDisposition } from "../session/group-session.js";
/**
 * Finds the first group-state commit that existed at settlement. The caller
 * still executes it through the engine's exact authorization gate; this helper
 * only assigns the bounded scheduling opportunity.
 */
export function selectFairQueuedStateIntent(queue, settledQueueLength) {
    const limit = Math.min(queue.length, Math.max(0, settledQueueLength));
    for (let index = 0; index < limit; index++)
        if (queue[index].intent.kind === "commit")
            return index;
    return undefined;
}
/**
 * The main class for interacting with a MLS group
 * @template THistory - The type of the history store to use for the group, must implement the {@link BaseGroupHistory} interface. (Default is no history store)
 */
export class MarmotGroup extends EventEmitter {
    /** The key-value backend where serialized group state bytes are persisted */
    store;
    /** The signer used for the clients identity */
    signer;
    /** The ciphersuite implementation to use for the group */
    ciphersuite;
    /** The nostr relay pool to use for the group */
    network;
    /** The storage interface for the groups application message history */
    history;
    /** The storage interface for the groups media */
    media;
    /** Protocol state owner for this group. Prefer this over convenience methods. */
    session;
    /** Runtime publisher for driving session effects through transport. */
    runtime;
    /** Optional media helper for group encrypted attachments. */
    mediaService;
    /**
     * Outbound intents held while convergence is not `Settled` (B5). Each entry
     * keeps the caller's promise open until the intent is built, encrypted, and
     * published at drain time — so a commit is regenerated against the canonical
     * post-settle state and never reuses a pre-selection staged commit.
     */
    #outboundQueue = [];
    /** Persisted removed-inactive marker store (D-12); see {@link MarmotGroupOptions.removedMarkerStore}. */
    #removedMarkerStore;
    /**
     * In-memory realization fallback used only when {@link #removedMarkerStore}
     * is not configured — keeps `#realizeRemovalIfNeeded` idempotent within a
     * single process even without persistence (documented degradation).
     */
    #removalRealizedInMemory = false;
    /** Same-instance serialization for the marker transaction and public event. */
    #removalRealizationInFlight;
    /** Project-owned metadata for safe `removed` dispatch; never reads emitter internals. */
    #removedListeners = [];
    #disbandedListeners = [];
    /**
     * FOUND-04 per-invitee Welcome delivery report, in the order recipients were
     * supplied to {@link deliverFoundingWelcomes}. In-memory only (D-04): not
     * serialized into `ClientState`, not persisted, not read on load. See
     * {@link welcomeDeliveries} / {@link pendingWelcomes} for the accepted R-04
     * consequence.
     */
    #welcomeDeliveries = [];
    /**
     * The founding Welcome retained solely to support {@link retryWelcome}.
     * In-memory only (D-04) — lost on restart, at which point `retryWelcome`
     * throws rather than silently no-opping.
     */
    #foundingWelcome;
    /** The author pubkey the retained founding Welcome was addressed from. */
    #foundingWelcomeAuthor;
    log;
    on(event, fn, context) {
        if (event === "removed") {
            this.#removedListeners.push({
                fn: fn,
                context: context || this,
                once: false,
            });
        }
        if (event === "disbanded")
            this.#disbandedListeners.push({
                fn: fn,
                context: context || this,
                once: false,
            });
        return super.on(event, fn, context);
    }
    once(event, fn, context) {
        if (event === "removed") {
            this.#removedListeners.push({
                fn: fn,
                context: context || this,
                once: true,
            });
        }
        if (event === "disbanded")
            this.#disbandedListeners.push({
                fn: fn,
                context: context || this,
                once: true,
            });
        return super.once(event, fn, context);
    }
    removeListener(event, fn, context, once) {
        if (event === "removed") {
            if (!fn) {
                this.#removedListeners.length = 0;
            }
            else {
                const removedFn = fn;
                for (let i = this.#removedListeners.length - 1; i >= 0; i--) {
                    const listener = this.#removedListeners[i];
                    if (listener.fn === removedFn &&
                        (!once || listener.once) &&
                        (!context || listener.context === context)) {
                        this.#removedListeners.splice(i, 1);
                    }
                }
            }
        }
        if (event === "disbanded") {
            if (!fn)
                this.#disbandedListeners.length = 0;
            else {
                const disbandedFn = fn;
                for (let i = this.#disbandedListeners.length - 1; i >= 0; i--) {
                    const listener = this.#disbandedListeners[i];
                    if (listener.fn === disbandedFn &&
                        (!once || listener.once) &&
                        (!context || listener.context === context))
                        this.#disbandedListeners.splice(i, 1);
                }
            }
        }
        return super.removeListener(event, fn, context, once);
    }
    off(event, fn, context, once) {
        return this.removeListener(event, fn, context, once);
    }
    removeAllListeners(event) {
        if (event === undefined || event === "removed")
            this.#removedListeners.length = 0;
        if (event === undefined || event === "disbanded")
            this.#disbandedListeners.length = 0;
        return super.removeAllListeners(event);
    }
    get id() {
        return this.session.id;
    }
    /** The group id as a hex string */
    idStr;
    /** Read the current group state */
    get state() {
        return this.session.state;
    }
    /** Public absorbing status; Unrecoverable deliberately remains active/repairable. */
    get status() {
        if (this.session.terminalTombstone)
            return "disbanded";
        return this.state.groupActiveState.kind === "removedFromGroup"
            ? "removed"
            : "active";
    }
    /**
     * Account-identity-proof profile support is orthogonal to membership
     * `status` (D-11): a stored group whose GroupContext does not classify as
     * the current profile (legacy, mixed, or missing the `0x8009` requirement)
     * stays listable and `destroy()`-able, but every outbound send and every
     * inbound event is refused. Delegates to `session.profileSupport`, which
     * recomputes from the engine on every access.
     */
    get profileSupport() {
        return this.session.profileSupport;
    }
    /** Group-scoped durable key for removal realization state. */
    get #removedMarkerKey() {
        return `${this.idStr}/removed`;
    }
    /**
     * The group's lifecycle state (`group-state.md`). A new local commit may only
     * be prepared while `Stable`; the commit flow moves through `PendingPublish`
     * (commit prepared, publish unconfirmed) and `Merging` (publish acked, staged
     * commit applying) and back to `Stable`.
     */
    get lifecycle() {
        return this.session.lifecycle;
    }
    /**
     * The group's derived convergence status (`group-state.md` §Convergence
     * status, B5): `Syncing` / `Resolving` / `Settled` / `Blocked`. Recomputed on
     * read against the clock, so it advances to `Settled` once the quiescence
     * window elapses with no further convergence-relevant input.
     */
    get convergenceStatus() {
        return this.session.convergenceStatus;
    }
    get groupData() {
        return this.status === "disbanded" ? null : this.session.groupData;
    }
    /** Complete group info/debug model for chat panels and diagnostics. */
    get info() {
        const info = getMarmotGroupInfo(this.state);
        if (this.status !== "disbanded")
            return info;
        return {
            ...info,
            mls: { ...info.mls, memberCount: 0, proposalCount: 0 },
            app: {
                view: null,
                components: [],
                componentCount: 0,
                requiredComponentIds: [],
            },
            nostr: { relays: [], relayCount: 0, hasRouting: false },
            members: { pubkeys: [], count: 0 },
        };
    }
    /**
     * The live full-fork history tree: every group state observed (the canonical
     * branch and every fork), keyed by MLS confirmation tag. Exposes synchronous
     * structural queries (`node`, `childrenOf`, `tips`, `path`, `ancestors`,
     * `lowestCommonAncestor`) and async snapshot access (`stateAt`,
     * `commitMessageOf`). For a serializable rendering snapshot use
     * {@link forkTreeView}.
     */
    get forkTree() {
        return this.session.historyTree;
    }
    /**
     * A plain, serializable snapshot of the fork-history tree for debugging UIs —
     * every node with its epoch, parent/children, tip flag, and whether it lies on
     * the canonical path to the live tip (the branch convergence settled on, i.e.
     * the node matching {@link state}). Computed on demand.
     */
    forkTreeView() {
        return buildForkTreeView(this.session.historyTree, bytesToHex(this.state.confirmationTag));
    }
    /**
     * Group transport events received but not yet decrypted/processed into the
     * fork-history tree — the engine's ingestion pool (oldest-first). Normally
     * transient (a message awaiting its commit, a fork message awaiting its
     * branch); they are retried as the tree grows. An entry that lingers is a
     * received event the client could never read — a gap a full-history debugger
     * surfaces, since the unlocking state never arrived.
     */
    pendingEvents() {
        return this.session.pendingEvents();
    }
    /**
     * Evaluates whether a candidate's KeyPackage event (kind 30443) can be added
     * to this group — cipher-suite match, `required_capabilities`,
     * agent-text-stream-QUIC `required_member_roles`, and already-a-member. Use
     * this before {@link GroupsManager.invite} to surface why a KeyPackage can't be
     * added; an `eligible: true` result is safe to invite. Never throws.
     */
    evaluateKeyPackage(keyPackageEvent) {
        if (this.status === "disbanded")
            throw new GroupTerminalError();
        return evaluateKeyPackageForGroup(this.state, keyPackageEvent);
    }
    get unappliedProposals() {
        return this.session.unappliedProposals;
    }
    get dirty() {
        return this.session.dirty;
    }
    /**
     * Overrides the current group state
     * @warning It is not recommended to use this
     */
    set state(newState) {
        this.session.state = newState;
    }
    get relays() {
        return this.groupData?.relays;
    }
    /**
     * The FOUND-04 per-invitee Welcome delivery report: one entry per recipient
     * a founding create attempted to deliver to, in delivery order.
     *
     * **This is in-memory only and is lost on restart or crash (D-04).** It is
     * discoverable state, not a returned value or a thrown error — a caller
     * that never reads it silently loses an invitee who is already a member at
     * epoch 1. The only recovery is the spec's re-invite path: the founding
     * creator MAY re-invite the unreachable member with a fresh KeyPackage
     * against the now-canonical group
     * (refs/marmot/protocol-core/publish-lifecycle.md lines 66-78). This is an
     * accepted consequence of D-04 + D-10 + D-12, not an oversight (R-04).
     */
    get welcomeDeliveries() {
        return this.#welcomeDeliveries.slice();
    }
    /**
     * The failed subset of {@link welcomeDeliveries} — the invitees a founding
     * create has not yet reached. Retry with {@link retryWelcome}.
     *
     * Carries the same R-04 warning as {@link welcomeDeliveries}: this is
     * in-memory only, lost on restart, and ignorable by a caller that never
     * reads it. The only recovery beyond {@link retryWelcome} is the spec's
     * re-invite-with-a-fresh-KeyPackage path
     * (refs/marmot/protocol-core/publish-lifecycle.md lines 66-78).
     */
    get pendingWelcomes() {
        return this.#welcomeDeliveries.filter((outcome) => outcome.kind === "failed");
    }
    /**
     * Fans out a founding Welcome to every invitee, one {@link
     * NostrWelcomeDelivery.deliverMany} call reached directly through
     * `runtime.welcomeDelivery` (D-05/D-07) — this bypasses `GroupRuntime`'s
     * publish path entirely, since a founding Add has no `GroupPublishWork` to
     * drive. Retains the Welcome and author so a failed recipient can be
     * retried later via {@link retryWelcome}.
     *
     * Never throws and never saves: partial or total Welcome failure is a
     * normal outcome (D-12), reported through {@link pendingWelcomes} rather
     * than raised. `GroupFactory.create` refuses a founding create without
     * valid group relays (CR-01), so on the factory path this group always
     * carries relays; the group-relay list is forwarded both as each Welcome
     * rumor's required relays tag and as `deliver`'s inbox-lookup fallback, and
     * a recipient whose own inbox lookup resolves empty still fails
     * independently of the others.
     */
    async deliverFoundingWelcomes(options) {
        this.#foundingWelcome = options.welcome;
        this.#foundingWelcomeAuthor = options.author;
        const outcomes = await this.runtime.welcomeDelivery.deliverMany({
            welcome: options.welcome,
            author: options.author,
            groupRelays: this.relays ?? [],
            recipients: options.recipients,
        });
        this.#welcomeDeliveries = outcomes;
        return outcomes;
    }
    /**
     * Re-delivers one invitee's founding Welcome. Throws naming `pubkey` when
     * there is no matching delivery outcome, or when no founding Welcome is
     * retained (for instance after a restart) — this fails loudly rather than
     * silently no-opping, since a silent no-op is exactly R-04's failure mode.
     * When the matching entry already succeeded, returns it unchanged without
     * performing another delivery.
     *
     * Deliberately has **no epoch guard**: RESEARCH Priority Finding #1
     * establishes that a late epoch-1 Welcome is safe because the joiner's
     * backfill (`GroupsManager#connectGroup`) has no `since` bound, **provided
     * the group has relays**. `GroupFactory.create` no longer produces
     * relay-less founding groups (CR-01), so on the factory path the relays
     * precondition always holds.
     */
    async retryWelcome(pubkey) {
        const index = this.#welcomeDeliveries.findIndex((outcome) => outcome.recipient.pubkey === pubkey);
        if (index === -1 ||
            !this.#foundingWelcome ||
            !this.#foundingWelcomeAuthor) {
            throw new Error(`retryWelcome: no retained founding Welcome delivery outcome for recipient ${pubkey}`);
        }
        const existing = this.#welcomeDeliveries[index];
        if (existing.kind === "succeeded")
            return existing;
        const [outcome] = await this.runtime.welcomeDelivery.deliverMany({
            welcome: this.#foundingWelcome,
            author: this.#foundingWelcomeAuthor,
            groupRelays: this.relays ?? [],
            recipients: [existing.recipient],
        });
        this.#welcomeDeliveries[index] = outcome;
        return outcome;
    }
    constructor(state, options) {
        super();
        this.store = options.store;
        this.signer = options.signer;
        this.ciphersuite = options.ciphersuite;
        this.network = options.network;
        this.#removedMarkerStore = options.removedMarkerStore;
        if (options.history) {
            if (typeof options.history === "function") {
                this.history = options.history(state.groupContext.groupId);
            }
            else {
                this.history = options.history;
            }
        }
        else {
            this.history = undefined;
        }
        this.session = new GroupSession({
            state,
            ciphersuite: this.ciphersuite,
            store: this.store,
            ingestStateStore: options.ingestStateStore,
            lifecycleStore: options.lifecycleStore,
            rewindStore: options.rewindStore,
            removedMarkerStore: options.removedMarkerStore,
            retained: options.retained,
            historyTree: options.historyTree,
            convergencePolicy: options.convergencePolicy,
            ingestionPool: options.ingestionPool,
            history: this.history,
            now: options.now,
            settlementQuiescenceMs: options.settlementQuiescenceMs,
            scheduler: options.scheduler,
            audit: options.audit,
            auditContext: options.auditContext,
            // When the quiescence window elapses, release any queued outbound (B5).
            onSettleCheck: () => this.#settleAndDrive(),
            onStateChanged: (newState) => this.emit("stateChanged", newState),
            onStateSaved: () => this.emit("stateSaved", this),
            onApplicationMessage: (message) => this.emit("applicationMessage", message),
            onHistoryError: (error) => this.emit("historyError", error),
            onHistoryChanged: () => this.emit("historyChanged", this),
        });
        if (options.media) {
            if (typeof options.media === "function") {
                this.media = options.media(this.id);
            }
            else {
                this.media = options.media;
            }
        }
        else {
            this.media = undefined;
        }
        this.idStr = bytesToHex(this.id);
        this.log = logger.extend(`group:${this.idStr.slice(0, 8)}`);
        this.runtime = new GroupRuntime({
            welcomeDelivery: new NostrWelcomeDelivery({
                signer: this.signer,
                network: this.network,
            }),
            getNetwork: () => this.network,
            getRelays: () => this.relays,
            getGroupRef: () => this.idStr,
            getGroupData: () => this.groupData,
            confirmPublished: (pending) => this.session.confirmPublished(pending),
            publishFailed: (pending) => this.session.publishFailed(pending),
            save: () => this.save(),
            log: this.log,
            audit: options.audit,
            auditContext: options.auditContext,
        });
        this.mediaService = new GroupMediaService({
            media: this.media,
            getState: () => this.state,
            getCiphersuite: () => this.ciphersuite,
            getRetainedStates: () => this.session.retainedStates(),
            getSigner: () => this.signer,
        });
    }
    /** Creates a new {@link MarmotGroup} instance from a {@link ClientState} object */
    static async fromClientState(state, options) {
        const cryptoProvider = options.cryptoProvider ?? defaultCryptoProvider;
        const cipherSuite = await cryptoProvider.getCiphersuiteImpl(state.groupContext.cipherSuite);
        const group = new MarmotGroup(state, {
            ...options,
            ciphersuite: cipherSuite,
        });
        return group;
    }
    /**
     * Realizes a persisted removal after the owning registry has attached its
     * forwarding listeners. This is idempotent across concurrent loads and
     * process restarts when a removal marker store is configured.
     */
    async realizeRemovalIfNeeded() {
        await this.#realizeRemovalIfNeeded();
    }
    /** Realizes durable terminal notification exactly once across restarts. */
    async realizeDisbandIfNeeded() {
        const tombstone = await this.session.markDisbandNotificationDelivered();
        if (!tombstone)
            return;
        this.session.dispose();
        this.#rejectQueuedOutbound(new GroupTerminalError());
        this.#emitDisbandedSafely(tombstone);
    }
    #emitDisbandedSafely(tombstone) {
        const evidence = {
            actorPubkey: tombstone.actorPubkey,
            commitDigest: tombstone.commitDigest,
        };
        for (const listener of [...this.#disbandedListeners]) {
            if (listener.once)
                this.off("disbanded", listener.fn, undefined, true);
            try {
                listener.fn.call(listener.context, this, evidence);
            }
            catch (error) {
                this.log("disbanded listener failed: %o", error);
            }
        }
    }
    #assertNotDisbanded() {
        if (this.session.terminalTombstone)
            throw new GroupTerminalError();
    }
    /**
     * Persists any pending changes to the group state in the store.
     *
     * @param force - When `true`, writes the current state even if `dirty` is
     *   `false`. Useful for persisting the initial state of a freshly constructed
     *   group (e.g. after `createGroup` / `joinGroupFromWelcome` / import) without
     *   having to mutate `dirty` externally.
     */
    async save(force = false) {
        await this.session.save(force);
    }
    /**
     * Re-scores the persisted fork history against the current tip and switches to
     * the canonical branch if a competing fork now wins (`convergence.md`),
     * persisting a resulting switch. Candidates come from the {@link forkTree}, so a
     * client that diverged onto a losing fork converges from disk without waiting
     * for the network to re-deliver the winning branch. Called automatically on
     * load; safe to call explicitly to force a re-evaluation.
     *
     * CR-06: the pass's results are routed through the SAME marker-clearing
     * branch {@link ingest} uses, so a load-time rewind that supersedes the
     * commit which removed us clears the persisted removed-inactive marker.
     * Previously every result here was discarded, so the documented "called
     * automatically on load" path could never clear it and a client restored to
     * membership kept a stale marker that silently suppressed its next genuine
     * removal.
     */
    async reconverge() {
        this.#assertNotDisbanded();
        const results = await this.session.reconverge();
        for (const result of results)
            await this.#applyRemovalWithdrawal(result);
        // A tree-fed switch can also land us ON a branch that removes us. The
        // realization obligation is state-derived (D-12), so re-assert it here;
        // idempotent, and a no-op unless canonical state is now the tombstone.
        // WR-16: `ingest()` runs this identical trailing step, so neither rewind
        // path can drift from the other.
        await this.#realizeRemovalIfNeeded();
    }
    /**
     * Performs a self-update commit (no proposals) to rotate this member's leaf key material.
     *
     * This is required by `refs/marmot/protocol-core/joining.md` for forward
     * secrecy after joining from a Welcome.
     *
     * Unlike admin commits (see {@link GroupsManager.commit}), this operation is
     * allowed for non-admin members.
     */
    async selfUpdate() {
        this.#assertNotDisbanded();
        this.log("self-update commit");
        const groupData = this.groupData;
        if (!groupData)
            throw new NoMarmotGroupDataError();
        const [result] = await this.submitIntent({ kind: "selfUpdate" });
        return result.response;
    }
    async propose(...args) {
        this.#assertNotDisbanded();
        const groupData = this.groupData;
        if (!groupData)
            throw new NoMarmotGroupDataError();
        const context = this.session.proposalContext();
        let proposals;
        if (args.length === 1) {
            proposals = await args[0](context);
        }
        else {
            proposals = await args[0](...args)(context);
        }
        if (!proposals) {
            throw new Error("Proposal is undefined. This should not happen.");
        }
        const proposalArray = Array.isArray(proposals) ? proposals : [proposals];
        const responses = {};
        for (const proposal of proposalArray) {
            const response = await this.sendProposal(proposal);
            Object.assign(responses, response);
        }
        return responses;
    }
    /** Sends a proposal to the group relays */
    async sendProposal(proposal) {
        this.#assertNotDisbanded();
        const [result] = await this.submitIntent({ kind: "proposal", proposal });
        return result.response;
    }
    /**
     * Convergence-gated outbound entry point (B5). While convergence is `Settled`
     * and the lifecycle allows outbound, the intent is built, encrypted, and
     * published immediately. Otherwise it is queued and the returned promise stays
     * pending until the quiescence window settles and the queue drains — so app
     * payloads are held, and group-state commits are (re)generated only against the
     * canonical post-settle state. `leave()` and the self_remove auto-committer
     * bypass this gate by design (departures and convergence progress, not fresh
     * local intents).
     */
    async submitIntent(intent) {
        this.#assertNotDisbanded();
        if (mayReleaseOutbound(this.session.convergenceStatus, this.lifecycle)) {
            return this.#sendNow(intent);
        }
        this.log("queueing %s — convergence %s, lifecycle %s", intent.kind, this.session.convergenceStatus, this.lifecycle);
        return new Promise((resolve, reject) => {
            this.#outboundQueue.push({ intent, resolve, reject });
        });
    }
    /** Atomically enables lifecycle-v1 for a legacy group and publishes it once. */
    async enableDisbanding() {
        this.#assertNotDisbanded();
        let effects;
        try {
            effects = await this.session.enableGroupDisbanding();
        }
        catch (error) {
            const message = errorMessage(error);
            const reason = /not all members support|required capabilities|does not advertise lifecycle support/i.test(message)
                ? "unsupportedMembers"
                : /only an active group admin/i.test(message)
                    ? "notAdmin"
                    : "legality";
            return { kind: "rejected", reason, error: message };
        }
        if (effects.publish.length === 0)
            return { kind: "alreadyEnabled" };
        try {
            const [publication] = await this.runtime.publishEffects(effects);
            if (!publication)
                return {
                    kind: "rejected",
                    reason: "legality",
                    error: "Lifecycle enablement produced no publication result",
                };
            return { kind: "enabled", publication };
        }
        catch (error) {
            return { kind: "publishFailed", error: errorMessage(error) };
        }
    }
    /** Persists irreversible intent, publishes one candidate, and retains it until selection. */
    async disband() {
        this.#assertNotDisbanded();
        const existing = await this.session.disbandRequest();
        if (existing?.status === "failed")
            return { kind: "failed", reason: existing.reason };
        let effects;
        try {
            effects = await this.session.requestDisband();
        }
        catch (error) {
            const message = errorMessage(error);
            return {
                kind: "rejected",
                reason: /not enabled/i.test(message) ? "notEnabled" : "legality",
                error: message,
            };
        }
        const request = await this.session.disbandRequest();
        if (request?.status === "failed")
            return { kind: "failed", reason: request.reason };
        if (!request)
            return {
                kind: "rejected",
                reason: "legality",
                error: "Disband request was not persisted",
            };
        if (effects.publish.length === 0)
            return { kind: "pending", request };
        try {
            const [publication] = await this.runtime.publishEffects(effects);
            if (!publication)
                return { kind: "pending", request };
            return { kind: "acknowledged", request, publication };
        }
        catch (error) {
            return { kind: "publishFailed", request, error: errorMessage(error) };
        }
    }
    /** Builds + publishes an intent's effects immediately (no gating). */
    async #sendNow(intent) {
        const effects = await this.session.send(intent);
        return this.runtime.publishEffects(effects);
    }
    /**
     * Releases queued outbound while convergence is `Settled` and the lifecycle
     * allows outbound (B5). Drains FIFO so send order is preserved; re-checks the
     * gate each iteration so a fork arriving mid-drain re-queues the remainder.
     */
    async #drainOutbound() {
        while (this.#outboundQueue.length > 0 &&
            mayReleaseOutbound(this.session.convergenceStatus, this.lifecycle)) {
            const item = this.#outboundQueue.shift();
            try {
                item.resolve(await this.#sendNow(item.intent));
            }
            catch (error) {
                item.reject(error);
            }
        }
    }
    /** Gives one pre-existing state intent a preparation attempt, then resumes inbound. */
    async #settleAndDrive() {
        const settledQueueLength = this.#outboundQueue.length;
        const fairIndex = selectFairQueuedStateIntent(this.#outboundQueue, settledQueueLength);
        if (fairIndex !== undefined &&
            mayReleaseOutbound(this.session.convergenceStatus, this.lifecycle)) {
            const [item] = this.#outboundQueue.splice(fairIndex, 1);
            try {
                item.resolve(await this.#sendNow(item.intent));
            }
            catch (error) {
                // The attempt is consumed even when authorization/signing/preparation
                // fails; reject its caller and continue rather than pinning liveness.
                item.reject(error);
            }
        }
        const resumed = await this.session.driveConvergence();
        for (const result of resumed) {
            await this.#applyRemovalWithdrawal(result);
            if (result.kind === "removed")
                await this.#realizeRemovalIfNeeded();
        }
        await this.realizeDisbandIfNeeded();
        // CR-04: routed through the single resume seam rather than repeating its
        // predicate, so the profile gate (D-12) and the already-disbanded check
        // cannot be present on one resume path and missing on the other.
        await this.resumePendingDisband();
        if (resumed.length === 0)
            await this.#drainOutbound();
    }
    /**
     * Resumes a durable terminal intent after hydration when preparation is
     * eligible. Also the single seam `#settleAndDrive` uses to resume a pending
     * request mid-session, so both resume paths share one predicate.
     */
    async resumePendingDisband() {
        // D-12: nothing is published automatically for a group outside the current
        // account identity proof profile. `MarmotGroupEngine.requestDisband` now
        // refuses such a group itself (CR-04), before it persists or prepares
        // anything; this early return keeps the refusal from surfacing to callers
        // as a `rejected` DisbandResult for work they never asked for.
        if (this.profileSupport.kind === "unsupported")
            return;
        if (this.status !== "disbanded" &&
            this.lifecycle === groupLifecycleStates.stable &&
            (await this.session.disbandRequest())?.status === "pending")
            await this.disband();
    }
    /** Rejects and clears every queued outbound intent (teardown / removal). */
    #rejectQueuedOutbound(reason) {
        if (this.#outboundQueue.length === 0)
            return;
        const error = typeof reason === "string" ? new Error(reason) : reason;
        for (const item of this.#outboundQueue.splice(0))
            item.reject(error);
    }
    /**
     * Realizes involuntary removal as a state-derived obligation, not a
     * one-shot side effect of applying one commit (D-12,
     * `protocol-core/member-departure.md` "Realizing removal"): whenever
     * canonical state is the `removedFromGroup` tombstone AND realization has
     * not already happened (the marker is unset), sets the marker, fails any
     * queued outbound, and emits `removed` — exactly once. A no-op when state
     * is not the tombstone, and a no-op (no re-emit) when the marker is
     * already set.
     *
     * Called through {@link realizeRemovalIfNeeded} after registry listeners are
     * attached on load, and by the `ingest` handler's `result.kind === "removed"`
     * branch (the commit that produces the tombstone in a live process). Both
     * funnel through this single idempotent implementation.
     */
    async #realizeRemovalIfNeeded() {
        if (this.#removalRealizationInFlight)
            return this.#removalRealizationInFlight;
        const realization = this.#performRemovalRealization();
        this.#removalRealizationInFlight = realization;
        try {
            await realization;
        }
        finally {
            if (this.#removalRealizationInFlight === realization)
                this.#removalRealizationInFlight = undefined;
        }
    }
    async #performRemovalRealization() {
        if (this.state.groupActiveState.kind !== "removedFromGroup")
            return;
        if (this.#removedMarkerStore) {
            const alreadyRealized = await this.#removedMarkerStore.getItem(this.#removedMarkerKey);
            if (alreadyRealized)
                return;
            await this.#removedMarkerStore.setItem(this.#removedMarkerKey, true);
        }
        else {
            // No persisted marker configured: realization degrades to in-memory
            // only — still idempotent within this process, but not restart-durable
            // (documented on `MarmotGroupOptions.removedMarkerStore`).
            if (this.#removalRealizedInMemory)
                return;
            this.#removalRealizedInMemory = true;
        }
        this.#rejectQueuedOutbound("Removed from group; outbound cancelled.");
        this.#emitRemovedSafely();
    }
    /** Delivers the public removal signal without making callbacks transactional. */
    #emitRemovedSafely() {
        for (const listener of [...this.#removedListeners]) {
            // EventEmitter3 removes one-shot listeners before invoking them.
            if (listener.once)
                this.off("removed", listener.fn, undefined, true);
            try {
                listener.fn.call(listener.context, this);
            }
            catch (error) {
                this.log("removed listener failed: %o", error);
            }
        }
    }
    /**
     * Clears the persisted removed-inactive marker (D-12). Called from
     * {@link destroy} so a fully-purged group never leaves a stale marker
     * entry behind. Plan 03-07 (CONV-03) adds a second call site: when a later
     * rewind supersedes the removing commit and re-establishes canonical
     * membership, so a subsequent removal can realize again instead of being
     * permanently suppressed by a stale marker.
     */
    async #clearRemovalMarker() {
        if (!this.#removedMarkerStore) {
            this.#removalRealizedInMemory = false;
            return;
        }
        await this.#removedMarkerStore.removeItem(this.#removedMarkerKey);
    }
    /**
     * ingests an array of group messages and applies commits to the group state.
     *
     * Processing happens in two stages:
     * 1. Process all non-commit messages (proposals, application messages)
     *    - If a message fails to process, it's added to unreadable for retry
     * 2. Process commits according to `refs/marmot/protocol-core/group-messaging.md`
     *    (sorted by epoch, timestamp, event id)
     *    - Commits advance the epoch and update the group state
     *
     * After both stages, recursively retry unreadable messages until no more can be read.
     * Events that can never be processed are yielded as {@link UnreadableIngestResult}.
     *
     * @param events - Array of Nostr events containing encrypted MLS messages
     * @yields DispositionedIngestResult - The processing result plus its
     *   inbound-processing {@link Disposition}.
     */
    async *ingest(events, options) {
        // The fork-history tree can grow during ingest (new commits / forks) without
        // the canonical state changing — track its size to emit `historyChanged`.
        const historySizeBefore = this.session.historyTree.size;
        for await (const result of this.session.ingest(events, options)) {
            // The engine elected us to commit a peer's departure (B6): publish the
            // staged self_remove-only commit (publish-before-apply). On publish
            // failure the staged commit is rolled back and the self_remove stays
            // pending, so a later ingest re-elects and retries — swallow the throw so
            // it does not abort delivery of the rest of the batch.
            if (result.kind === "autoCommit") {
                let applied;
                try {
                    const [confirmed] = await this.runtime.publishEffects({
                        publish: [
                            {
                                kind: "groupEvolution",
                                envelope: result.event,
                                pending: result.pending,
                                actorPubkey: result.actorPubkey,
                            },
                        ],
                    });
                    if (!result.pending.commitMessage)
                        throw new Error("Auto-commit pending state has no commit message");
                    applied = {
                        kind: "appliedNotifications",
                        commitDigest: commitDigest(encode(mlsMessageEncoder, result.pending.commitMessage)),
                        notifications: confirmed.notifications,
                    };
                }
                catch {
                    /* rolled back; retried on a later ingest */
                }
                yield result;
                if (applied)
                    yield {
                        ...applied,
                        disposition: ingestResultDisposition(applied),
                    };
                continue;
            }
            // An inbound commit removed us (involuntary Remove, or a peer committing
            // our own self_remove). The session has already applied + persisted the
            // `removedFromGroup` tombstone; surface it so the app can react. Per the
            // chosen policy we keep the tombstone rather than auto-destroying — the
            // app calls destroy() when it wants to purge. Realization (marker +
            // reject-queued-outbound + `removed` emit) is the single idempotent
            // `#realizeRemovalIfNeeded` (D-12), shared with the `fromClientState`
            // load-time path so the two can never diverge.
            if (result.kind === "removed") {
                this.log("removed from group by inbound commit");
                // CR-05: persist the tombstone BEFORE the marker is written. The
                // session only reaches its own trailing `save()` after this generator
                // is fully drained, so writing the marker first leaves a window —
                // a throwing `removed` listener, a consumer that `break`s out of the
                // `for await`, a process exit, or a rejected `save()` — in which the
                // marker says "already realized" while the persisted `ClientState` is
                // NOT the tombstone. On the next load `#realizeRemovalIfNeeded`
                // returns early (state is not the tombstone), and when the removing
                // commit is re-ingested it returns early again (marker set), so the
                // `removed` event is never emitted and queued outbound is never
                // rejected — the permanent silent suppression the marker exists to
                // prevent.
                //
                // Forced, because the removal may have arrived on a path that left
                // `#dirty` false. If it rejects, the marker is never written and the
                // removal simply realizes on the next load — the safe direction.
                await this.save(true);
                await this.#realizeRemovalIfNeeded();
            }
            if (result.kind === "processed" && result.selectedTerminal)
                await this.realizeDisbandIfNeeded();
            await this.#applyRemovalWithdrawal(result);
            yield result;
        }
        // WR-16: same trailing re-assert as `reconverge()`, so the live and
        // load-time rewind paths run an identical sequence (per-result
        // withdrawal handling, then a state-derived realization check). A rewind
        // during ingest can land us ON a branch that removes us without producing
        // a `removed` result, and the realization obligation is state-derived
        // (D-12). Idempotent: a no-op unless canonical state is the tombstone and
        // realization has not happened yet.
        await this.#realizeRemovalIfNeeded();
        // WR-01: the same state-derived re-assert for a selected disband that
        // reached no `processed` result (the session persisted it from engine
        // state). Idempotent: a no-op unless a tombstone awaits notification.
        await this.realizeDisbandIfNeeded();
        if (this.session.historyTree.size !== historySizeBefore)
            this.emit("historyChanged", this);
    }
    /**
     * CONV-03 (D-12): a rewind superseded the commit that removed us — canonical
     * membership is live again, so the persisted removed-inactive marker must be
     * cleared, or a later genuine removal would be silently suppressed by the
     * stale marker. This rides the same `stateInvalidated` result stream as the
     * withdrawal itself; no separate event is emitted (re-emission of state
     * notifications is deferred).
     *
     * Shared by {@link ingest} and {@link reconverge} so the live and load-time
     * rewind paths can never diverge (CR-06).
     */
    async #applyRemovalWithdrawal(result) {
        if (result.kind !== "stateInvalidated" ||
            !result.withdrawn.some((n) => n.kind === "selfRemoved"))
            return;
        // WR-16: a withdrawn `selfRemoved` means the commit that removed us was
        // superseded — NOT necessarily that we are a member again. A rewind can
        // supersede removal-commit A and land on branch B which ALSO removes us.
        // Clearing unconditionally left `marker = false` while
        // `groupActiveState.kind === "removedFromGroup"`, with no re-emitted
        // `removed` — so the next load realized the removal all over again and
        // emitted a duplicate, violating the exactly-once contract from the other
        // side. Only clear once canonical state has actually left the tombstone.
        if (this.state.groupActiveState.kind === "removedFromGroup") {
            this.log("rewind superseded one removal but canonical state is still removed — keeping the marker");
            return;
        }
        this.log("rewind superseded our removal — clearing removal marker");
        await this.#clearRemovalMarker();
    }
    /**
     * Encrypts a media file for sharing in a group message, in the group's
     * media format (`encrypted-media-v2` unless the group only carries the
     * frozen v1 policy — see {@link GroupMediaService.mediaVersion}).
     *
     * Derives the per-file key from the current MLS epoch, encrypts with
     * ChaCha20-Poly1305, and returns the ciphertext alongside a populated
     * {@link MediaAttachment} (hashes, nonce, media type, filename) with no
     * locators yet.
     *
     * **Caller responsibilities:**
     * 1. Upload `encrypted` to a blob store (`ciphertextSha256` is the content id).
     * 2. Push a locator (`{ kind, value }`) onto `attachment.locators`.
     * 3. Serialize with `encodeMediaImetaTag` and include the tag on the rumor.
     */
    async encryptMedia(blob, metadata) {
        return this.mediaService.encryptMedia(blob, metadata);
    }
    /**
     * Encrypts a media file and uploads the ciphertext to the group's Blossom
     * endpoints (or `opts.servers`), returning an attachment with a
     * `blossom-v1` locator ready for `encodeMediaImetaTag`. See
     * {@link GroupMediaService.uploadMedia}.
     */
    async uploadMedia(blob, metadata, opts) {
        return this.mediaService.uploadMedia(blob, metadata, opts);
    }
    /**
     * Fetches, verifies and decrypts an attachment from its locators or the
     * group's fallback endpoints. See {@link GroupMediaService.downloadMedia}.
     */
    async downloadMedia(attachment, opts) {
        return this.mediaService.downloadMedia(attachment, opts);
    }
    /**
     * Decrypts an encrypted-media attachment (v1 or v2) downloaded from a blob store.
     *
     * On the first call for a given file the plaintext bytes are derived via
     * key-derivation + ChaCha20-Poly1305 decryption (after verifying the
     * ciphertext and plaintext hashes) and stored in {`@link` media}. Subsequent
     * calls for the same `attachment.ciphertextSha256` are served directly from
     * the cache, skipping key-derivation entirely.
     */
    async decryptMedia(encrypted, attachment) {
        return this.mediaService.decryptMedia(encrypted, attachment);
    }
    /**
     * Releases in-memory resources without touching persisted state (B5): cancels
     * the settle-check timer and fails any queued outbound. Call on unload so a
     * timer/promise does not outlive the cached instance.
     */
    dispose() {
        this.session.dispose();
        this.#rejectQueuedOutbound("Group unloaded; outbound cancelled.");
    }
    /** Destroys the group and purges the group history */
    async destroy() {
        this.log("destroying group");
        // Stop the settle timer and fail queued outbound before tearing down (B5).
        this.dispose();
        this.log("clearing group media");
        if (this.media)
            await this.media.clearMedia();
        this.log("removing group from store");
        await this.session.destroyLocalState();
        this.emit("destroyed", this);
    }
}
