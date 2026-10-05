/** @module @category Client - Group Manager */
import { bytesToHex } from "@noble/hashes/utils.js";
import { hexToBytes } from "applesauce-core/helpers";
import { EventEmitter } from "eventemitter3";
import { defaultCryptoProvider, } from "../vendor/ts-mls/index.js";
import { getNostrGroupIdHex, } from "../core/client-state.js";
import { GROUP_EVENT_KIND } from "../core/protocol.js";
import { assertCurrentGroupAccountIdentityProofProfile, validateGroupMemberAccountIdentityProofs, } from "../core/components/account-identity-proof.js";
import { joinWelcomeWithAuthor } from "../core/welcome-join.js";
import { validateWelcomeGroupState } from "../engine/welcome-validation.js";
import { logger } from "../utils/debug.js";
import { hasAck } from "../utils/index.js";
import { getSingletonTagValue } from "../utils/tag-cardinality.js";
import { GroupTerminalError, } from "./group/marmot-group.js";
import { createInviteIntent } from "./group/invite.js";
import { GroupFactory } from "./group-factory.js";
import { GroupRegistry } from "./group-registry.js";
import { defaultVerifyEvent, safeVerifyEvent, } from "./verify.js";
const SUBSCRIPTION_ID_CACHE_CAPACITY = 10_000;
/** Deterministic bounded LRU used by long-lived group subscriptions. */
const U64_MAX = (1n << 64n) - 1n;
/**
 * The kind-445 tag-set rule (`transports/nostr.md` "Group message delivery"):
 * besides its single `h` tag, a group event may carry only one NIP-40
 * `["expiration", <unsigned integer>]` tag, and nothing else. Receivers
 * validate the whole envelope before decrypting ("Validation before
 * peeling"). Mirrors MDK `NostrTransportEvent::kind_445_transport_group_id`,
 * which drops such events, so accepting them here would let a member show
 * marmot-ts users messages that MDK users never see.
 */
function hasOnlyGroupEventTags(event) {
    let expirations = 0;
    for (const tag of event.tags) {
        if (tag[0] === "h")
            continue; // cardinality checked by getSingletonTagValue
        if (tag[0] !== "expiration")
            return false;
        if (++expirations > 1 || tag.length !== 2)
            return false;
        if (!/^[0-9]+$/.test(tag[1]) || BigInt(tag[1]) > U64_MAX)
            return false;
    }
    return true;
}
export class BoundedIdCache {
    capacity;
    #ids = new Map();
    constructor(capacity) {
        this.capacity = capacity;
        if (!Number.isSafeInteger(capacity) || capacity < 1)
            throw new Error("BoundedIdCache capacity must be a positive integer");
    }
    get size() {
        return this.#ids.size;
    }
    has(id) {
        if (!this.#ids.delete(id))
            return false;
        this.#ids.set(id, undefined);
        return true;
    }
    add(id) {
        this.#ids.delete(id);
        this.#ids.set(id, undefined);
        if (this.#ids.size <= this.capacity)
            return;
        const oldest = this.#ids.keys().next().value;
        if (oldest !== undefined)
            this.#ids.delete(oldest);
    }
}
const log = logger.extend("GroupsManager");
/**
 * Orchestrates the lifecycle of {@link MarmotGroup} instances. Delegates
 * in-memory caching and store hydration to a {@link GroupRegistry} and group
 * construction to a {@link GroupFactory}, layering the public lifecycle events
 * (created/imported/joined/destroyed/left) and the send/ingest facade on top.
 */
export class GroupsManager extends EventEmitter {
    /** The backend storing serialized group state bytes */
    store;
    /** The signer used for the clients identity */
    signer;
    /** The nostr relay pool to use for the client */
    network;
    /** Crypto provider for cryptographic operations */
    cryptoProvider;
    ingestPersistence;
    /** Owns the in-memory cache + store hydration. */
    #registry;
    /** Builds new groups (the identity-signer/ciphersuite consumer). */
    #factory;
    /** The injectable event verifier gating the 445 drain (SEC-01). */
    #verifyEvent;
    constructor(options) {
        super();
        this.store = options.store;
        this.ingestPersistence = options.ingestPersistence;
        this.signer = options.signer;
        this.network = options.network;
        this.cryptoProvider = options.cryptoProvider ?? defaultCryptoProvider;
        this.#verifyEvent = options.verifyEvent ?? defaultVerifyEvent;
        this.#registry = new GroupRegistry({
            store: options.store,
            ingestStateStore: options.ingestStateStore,
            lifecycleStore: options.lifecycleStore,
            rewindStore: options.rewindStore,
            removedMarkerStore: options.removedMarkerStore,
            convergencePolicy: options.convergencePolicy,
            ingestionPool: options.ingestionPool,
            signer: options.signer,
            network: options.network,
            audit: options.audit,
            auditContext: options.auditContext,
            cryptoProvider: this.cryptoProvider,
            historyFactory: options.historyFactory,
            mediaFactory: options.mediaFactory,
        });
        this.#factory = new GroupFactory({
            store: options.store,
            ingestStateStore: options.ingestStateStore,
            lifecycleStore: options.lifecycleStore,
            rewindStore: options.rewindStore,
            removedMarkerStore: options.removedMarkerStore,
            convergencePolicy: options.convergencePolicy,
            ingestionPool: options.ingestionPool,
            signer: options.signer,
            network: options.network,
            audit: options.audit,
            auditContext: options.auditContext,
            cryptoProvider: this.cryptoProvider,
            historyFactory: options.historyFactory,
            mediaFactory: options.mediaFactory,
            verifyEvent: this.#verifyEvent,
        });
        // Forward the registry's cache-level events as our own.
        this.#registry.on("updated", (groups) => this.emit("updated", groups));
        this.#registry.on("loaded", (group) => this.emit("loaded", group));
        this.#registry.on("removed", (group) => this.emit("removed", group.id));
        this.#registry.on("disbanded", (group, evidence) => this.emit("disbanded", group.id, evidence));
    }
    /** Returns the list of currently loaded group instances */
    get loaded() {
        return this.#registry.loaded;
    }
    /** Lists all persisted group IDs, decoded from their hex storage keys. */
    async listIds() {
        return this.#registry.listIds();
    }
    /** Checks if a group exists in the backend */
    async has(groupId) {
        return this.#registry.has(groupId);
    }
    /** Gets a group from cache or loads it from store */
    async get(groupId) {
        return this.#registry.get(groupId);
    }
    /** Returns the protocol session for a loaded or persisted group. */
    async session(groupId) {
        return (await this.get(groupId)).session;
    }
    /** Returns the runtime publisher for a loaded or persisted group. */
    async runtime(groupId) {
        return (await this.get(groupId)).runtime;
    }
    /** Returns the complete group info/debug model for a loaded or persisted group. */
    async info(groupId) {
        return (await this.get(groupId)).info;
    }
    /**
     * Sends a session intent through the group, convergence-gated (B5): published
     * immediately when convergence is `Settled`, otherwise queued until the
     * quiescence window settles and the queue drains. Used by `commit`/`invite`
     * and direct application-message sends; `leave` bypasses the gate.
     */
    async send(groupId, intent) {
        const group = await this.get(groupId);
        return group.submitIntent(intent);
    }
    /**
     * Invites a user to a group from their KeyPackage event (kind 30443).
     *
     * Resolves the committing member from the manager's signer, builds an Add
     * commit intent via {@link createInviteIntent} (gated on the same injected
     * verifier as the 445/1059/30443 inbound boundaries — SEC-01/WIRE-01/
     * WIRE-02), and drives it through the group session/runtime. After the
     * commit acks, the runtime delivers a Welcome to the invitee via NIP-59
     * gift wrap.
     *
     * @returns Per-relay publish responses for the commit group event.
     * @throws Error if the event is not a KeyPackage kind, fails signature
     *   verification, has invalid required-tag cardinality, has an over-long
     *   or not-current Lifetime, or the credential identity does not match
     *   the event author.
     */
    async invite(groupId, keyPackageEvent) {
        const actorPubkey = await this.signer.getPublicKey();
        const [result] = await this.send(groupId, createInviteIntent({
            keyPackageEvent,
            actorPubkey,
            verifyEvent: this.#verifyEvent,
        }));
        return result.response;
    }
    /**
     * Creates a commit from proposals and publishes it to the group.
     *
     * Resolves the committing member from the manager's signer, builds a `commit`
     * intent, and drives it through the group session/runtime. See
     * {@link GroupSessionSendIntent} for how `extraProposals`, `proposalRefs`, and
     * `welcomeRecipients` are interpreted. Requires a group admin.
     *
     * @returns Per-relay publish responses for the commit group event.
     */
    async commit(groupId, options) {
        const actorPubkey = await this.signer.getPublicKey();
        const [result] = await this.send(groupId, {
            kind: "commit",
            actorPubkey,
            extraProposals: options?.extraProposals,
            proposalRefs: options?.proposalRefs,
            welcomeRecipients: options?.welcomeRecipients,
        });
        return result.response;
    }
    /** Ingests group transport events through the group's protocol session. */
    async *ingest(groupId, events, options) {
        const group = await this.get(groupId);
        // Route through the group facade (not the raw session) so an elected
        // self_remove auto-commit (B6) is published via the group's runtime.
        yield* group.ingest(events, options);
    }
    /** Loads all groups from the store and returns them */
    async loadAll() {
        return this.#registry.loadAll();
    }
    /**
     * Connects a single group to its relays: backfills its kind-445 transport
     * events (by `#h` routing tag) and drains them through {@link MarmotGroup.ingest},
     * then opens a live subscription that ingests each subsequent event. Inbound
     * events are de-duplicated, and unreadable ones surface via the `unreadable`
     * event. Call `.unsubscribe()` on the result to disconnect.
     *
     * This is the inbound counterpart to the library's outbound publishing — the
     * relay-subscription/backfill/drain loop an app would otherwise hand-write.
     */
    async connect(groupId, options) {
        return this.#connectGroup(await this.get(groupId), options);
    }
    /**
     * Connects every loaded group (see {@link connect}) and keeps the set of
     * connections in lockstep with the loaded groups: newly created/joined/
     * imported/loaded groups are connected automatically, and
     * destroyed/left/unloaded/removed groups are disconnected. Returns a handle
     * whose `.unsubscribe()` tears down every connection and stops tracking.
     */
    connectAll(options) {
        const records = new Map();
        const connect = (group) => {
            if (records.has(group.idStr))
                return;
            const record = {
                cancelled: false,
            };
            records.set(group.idStr, record);
            void this.#connectGroup(group, options)
                .then((sub) => {
                if (record.cancelled)
                    sub.unsubscribe();
                else
                    record.sub = sub;
            })
                .catch((err) => {
                log("connectAll: failed to connect %s: %o", group.idStr, err);
                records.delete(group.idStr);
            });
        };
        const disconnect = (groupId) => {
            const hex = bytesToHex(groupId);
            const record = records.get(hex);
            if (!record)
                return;
            record.cancelled = true;
            record.sub?.unsubscribe();
            records.delete(hex);
        };
        for (const group of this.loaded)
            connect(group);
        this.on("created", connect);
        this.on("joined", connect);
        this.on("imported", connect);
        this.on("loaded", connect);
        this.on("destroyed", disconnect);
        this.on("left", disconnect);
        this.on("unloaded", disconnect);
        this.on("removed", disconnect);
        this.on("disbanded", disconnect);
        return {
            unsubscribe: () => {
                this.off("created", connect);
                this.off("joined", connect);
                this.off("imported", connect);
                this.off("loaded", connect);
                this.off("destroyed", disconnect);
                this.off("left", disconnect);
                this.off("unloaded", disconnect);
                this.off("removed", disconnect);
                this.off("disbanded", disconnect);
                for (const record of records.values()) {
                    record.cancelled = true;
                    record.sub?.unsubscribe();
                }
                records.clear();
            },
        };
    }
    /** Backfill + live-subscribe a single group instance to its transport events. */
    async #connectGroup(group, options) {
        const noop = { unsubscribe: () => { } };
        if (group.status === "removed" || group.status === "disbanded") {
            log("connect: group %s is %s — skipping", group.idStr, group.status);
            return noop;
        }
        const relays = (group.relays?.length ? group.relays : options?.fallbackRelays) ?? [];
        if (!relays.length) {
            log("connect: group %s has no relays — skipping", group.idStr);
            return noop;
        }
        let h;
        try {
            h = getNostrGroupIdHex(group.state);
        }
        catch {
            log("connect: group %s has no nostr routing — skipping", group.idStr);
            return noop;
        }
        const filter = { kinds: [GROUP_EVENT_KIND], "#h": [h] };
        // Only ids of TRUSTED (verified + exact group-scoped `h`) events live here (SEC-01/
        // WR-01): an unverified or malformed event's id must never occupy this
        // dedup slot, or a corrupted same-id forgery could poison it and censor
        // the genuine, validly-signed event arriving later. `seen.add` MUST stay
        // strictly after both trust gates below — never add a rejected event's id
        // here (T-03-24). Rejected ids have a separate bounded cache, consulted
        // only after the current event fails validation, so a valid same-id event
        // can never be censored by an earlier forgery.
        const seen = new BoundedIdCache(SUBSCRIPTION_ID_CACHE_CAPACITY);
        const rejected = new BoundedIdCache(SUBSCRIPTION_ID_CACHE_CAPACITY);
        const drain = async (events) => {
            const fresh = events.filter((event) => !seen.has(event.id));
            if (!fresh.length)
                return;
            // Trust boundary (SEC-01/WIRE-02): verify signature, the kind-445 tag
            // set, and `h` tag cardinality BEFORE any event reaches group.ingest()
            // or occupies the
            // dedup `seen` slot. Not a cross-check of the `h` value against the
            // subscribed group id — that is out of scope (RESEARCH Open Question 1).
            const trusted = [];
            for (const event of fresh) {
                if (!safeVerifyEvent(this.#verifyEvent, event)) {
                    rejected.add(event.id);
                    this.emit("rejected", group.id, event, "invalid-signature");
                    continue;
                }
                if (!hasOnlyGroupEventTags(event) ||
                    getSingletonTagValue(event, "h") !== h) {
                    rejected.add(event.id);
                    this.emit("rejected", group.id, event, "tag-cardinality");
                    continue;
                }
                seen.add(event.id);
                trusted.push(event);
            }
            if (!trusted.length)
                return;
            try {
                for await (const result of group.ingest(trusted)) {
                    if (result.kind === "unreadable")
                        this.emit("unreadable", group.id, result.event);
                }
            }
            catch (err) {
                log("connect: ingest failed for group %s: %o", group.idStr, err);
            }
        };
        // Backfill before subscribing (mirrors the proven attach order): the backlog
        // ingests as one batch so out-of-order commits resolve together.
        await drain(await this.network.request(relays, filter));
        // Backfill may itself have selected terminal state. Never seed a live route
        // after the durable tombstone has won.
        if (group.session.terminalTombstone)
            return noop;
        const sub = this.network
            .subscription(relays, filter)
            .subscribe({ next: (event) => void drain([event]) });
        const disbanded = () => sub.unsubscribe();
        group.once("disbanded", disbanded);
        return {
            unsubscribe: () => {
                group.off("disbanded", disbanded, undefined, true);
                sub.unsubscribe();
            },
        };
    }
    /**
     * Persists and caches a group built from a {@link ClientState}, emitting
     * the given lifecycle event. Used by higher-level flows (e.g. joining from
     * a welcome message) that construct ClientStates themselves.
     *
     * @param state - The ClientState to adopt
     * @returns The persisted and cached MarmotGroup
     * @throws Error if a group with the same id already exists
     */
    async adoptClientState(state, options) {
        const eventName = options?.emit ?? "imported";
        const id = bytesToHex(state.groupContext.groupId);
        if (await this.#registry.has(state.groupContext.groupId)) {
            throw new Error(`Group ${id} already exists`);
        }
        const group = await this.#registry.build(state);
        // Persist initial state via the group's own save() path.
        // MarmotGroup.save() is the single writer into the group state store.
        await group.save(true);
        await this.#registry.track(group);
        this.emit(eventName, group);
        log("adopted group %s (emit=%s)", id, eventName);
        return group;
    }
    /**
     * Imports a new group from a {@link ClientState} object, persisting it to
     * the store and emitting `imported`.
     */
    async import(state) {
        return this.adoptClientState(state, { emit: "imported" });
    }
    /**
     * Joins a group from a decoded MLS {@link Welcome} using locally held key
     * package candidates (produced by `KeyPackageManager.selectForWelcome`).
     *
     * Mirrors the darkmatter engine `do_join_welcome`: the KeyPackageRef→private
     * bundle match and the MLS join happen here, in the group layer, not in the
     * composition root. Tries candidates in priority order, then requires the
     * joined GroupContext to classify as the current `0x8009` profile
     * (rejecting legacy, mixed, and neither) and every member leaf's proof to
     * validate against the group ciphersuite — both before adopting state, per
     * `refs/marmot/app-components/account-identity-proof-v2.md` "Migration from
     * v1" — then adopts the resulting state and emits `joined`.
     *
     * @returns The joined group and the KeyPackageRef that was consumed (so the
     *   caller can mark it used), or `consumedKeyPackageRef: null` if none matched.
     */
    async joinFromWelcome(options) {
        const { welcome, candidates, ciphersuiteImpl } = options;
        if (candidates.length === 0) {
            throw new Error("No matching KeyPackage found in local store. Make sure you have published a KeyPackage event.");
        }
        let clientState = null;
        let authorLeafIndex = -1;
        let lastError = null;
        let consumedKeyPackageRef = null;
        for (const candidate of candidates) {
            try {
                const joined = await joinWelcomeWithAuthor({
                    welcome,
                    keyPackage: candidate.publicPackage,
                    privateKeys: candidate.privatePackage,
                    ciphersuiteImpl,
                });
                clientState = joined.state;
                authorLeafIndex = joined.authorLeafIndex;
                consumedKeyPackageRef = candidate.keyPackageRef;
                break;
            }
            catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
            }
        }
        if (!clientState) {
            throw new Error(lastError
                ? `Failed to join group with any matching key package. Last error: ${lastError.message}`
                : "Failed to join group with any matching key package");
        }
        // The joined GroupContext must classify as the current 0x8009 profile
        // (not legacy, mixed, or neither), and every member leaf's proof must
        // validate against the group ciphersuite — both checked before
        // adoptClientState, so a rejecting group persists nothing
        // (refs/marmot/app-components/account-identity-proof-v2.md "Migration
        // from v1").
        assertCurrentGroupAccountIdentityProofProfile(clientState.groupContext.extensions);
        validateGroupMemberAccountIdentityProofs(clientState, clientState.groupContext.cipherSuite);
        // The rest of the Marmot group state, the capabilities this client needs,
        // and the Welcome author's admin authority (joining.md steps 6-8). Also
        // before adoptClientState, so a rejected Welcome persists nothing and
        // leaves the KeyPackage unconsumed.
        validateWelcomeGroupState({ state: clientState, authorLeafIndex });
        const group = await this.adoptClientState(clientState, { emit: "joined" });
        return { group, consumedKeyPackageRef };
    }
    /** Unloads a group from the client but does not remove it from the store */
    async unload(groupId) {
        const hex = typeof groupId === "string" ? hexToBytes(groupId) : groupId;
        this.#registry.untrack(hex);
        this.emit("unloaded", hex);
    }
    /** Destroys a group and purges the group history */
    async destroy(groupId) {
        const id = typeof groupId === "string" ? groupId : bytesToHex(groupId);
        log("destroying group %s", id);
        const group = this.#registry.peek(id) ?? (await this.#registry.load(id));
        // NOTE: MarmotGroup.destroy() is the single owner of removing group state
        // from storage. It emits `destroyed`, which the registry listener uses to
        // clear the in-memory cache and emit `updated`.
        await group.destroy();
        const hexId = typeof groupId === "string" ? hexToBytes(groupId) : groupId;
        this.emit("destroyed", hexId);
    }
    /**
     * Leaves a group by publishing a self-remove proposal and purging all
     * local group data from storage.
     *
     * At least one relay must acknowledge the proposals before local state is
     * destroyed. If no relay acks, an error is thrown and local state is
     * preserved so the caller can retry.
     *
     * @param groupId - The group ID as a hex string or Uint8Array.
     * @returns The relay publish responses for the leave proposal event(s).
     */
    async leave(groupId) {
        const id = typeof groupId === "string" ? groupId : bytesToHex(groupId);
        log("leaving group %s", id);
        const group = this.#registry.peek(id) ?? (await this.#registry.load(id));
        if (group.status === "disbanded")
            throw new GroupTerminalError();
        const groupIdBytes = typeof groupId === "string" ? hexToBytes(groupId) : groupId;
        // "leave is a SendIntent": the session builds the self-remove proposals
        // (RFC 9420 §12.4 — a member cannot commit a Remove targeting their own
        // leaf, so an admin applies them later) and we publish them here.
        const ownPubkey = await this.signer.getPublicKey();
        const effects = await group.session.leave(ownPubkey);
        const response = {};
        for (const result of await group.runtime.publishEffects(effects))
            Object.assign(response, result.response);
        // publishEffects already throws on no-ack, but guard local destruction
        // behind an explicit ack check so state is preserved on failure and the
        // caller can retry.
        if (!hasAck(response)) {
            throw new Error("Failed to publish leave proposals: no relay acknowledged. Local state preserved — retry leave() to try again.");
        }
        // group.destroy() purges local state and emits `destroyed`; the registry
        // listener clears the in-memory cache and emits `updated`.
        await group.destroy();
        this.emit("left", groupIdBytes);
        return response;
    }
    /** Creates a new simple group */
    async create(name, options) {
        log("creating group %o", name);
        const group = await this.#factory.create(name, options);
        await this.#registry.track(group);
        this.emit("created", group);
        log("created group %s", group.idStr);
        return group;
    }
    /**
     * Watches for changes to the groups in the store.
     * Returns an async generator that yields the current list of groups
     * whenever the store changes.
     */
    async *watch() {
        let resolveNext = null;
        const handleChange = () => {
            if (resolveNext) {
                resolveNext();
                resolveNext = null;
            }
        };
        // `updated` fires whenever the set of loaded groups changes
        // (create, import, join, load, unload, destroy, leave).
        this.on("updated", handleChange);
        try {
            // Yield initial state after listeners are installed to avoid missing updates
            // that occur between snapshot and subscription.
            yield [...(await this.loadAll())];
            while (true) {
                await new Promise((resolve) => {
                    resolveNext = resolve;
                });
                yield [...(await this.loadAll())];
            }
        }
        finally {
            this.off("updated", handleChange);
        }
    }
}
