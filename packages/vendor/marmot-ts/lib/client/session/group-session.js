import { getCredentialFromLeafIndex, } from "../../vendor/ts-mls/index.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { getMarmotGroupView, serializeClientState, } from "../../core/client-state.js";
import { getCredentialPubkey } from "../../core/credential.js";
import { MarmotGroupEngine } from "../../engine/group-engine.js";
import { GroupHistoryTree } from "../../engine/history-tree.js";
import { disbandConvergenceKey, disbandRequestKey, } from "../../engine/disband-request.js";
import { decodeDisbandTombstone, disbandRegistryStateKey, disbandTombstoneKey, encodeDisbandTombstone, } from "../../engine/disband-tombstone.js";
import { ingestResultDisposition as engineIngestResultDisposition } from "../../engine/ingest-disposition.js";
import { NostrGroupPeeler } from "../group/nostr-peeler.js";
import { ConvergenceEffectLedger, TerminalWrapperLedger, } from "../group/wrapper-ledger.js";
import { proposeLeaveGroup } from "../group/proposals/leave-group.js";
export function ingestResultDisposition(result) {
    if (result.kind === "stateInvalidated" ||
        result.kind === "appliedNotifications" ||
        result.kind === "stateRevalidated")
        return engineIngestResultDisposition(result);
    const { event, ...rest } = result;
    return engineIngestResultDisposition({
        ...rest,
        envelope: event,
    });
}
function mapEngineIngestResult(result) {
    // A withdrawal has no `envelope` to rename to `event` — pass it through
    // unchanged (D-11).
    if (result.kind === "stateInvalidated" ||
        result.kind === "appliedNotifications" ||
        result.kind === "stateRevalidated")
        return result;
    const { envelope, disposition, ...rest } = result;
    return { ...rest, event: envelope, disposition };
}
export class GroupSession {
    ciphersuite;
    store;
    rewindStore;
    ingestStateStore;
    lifecycleStore;
    #removedMarkerStore;
    history;
    #engine;
    #peeler;
    #sentEventIds = new Set();
    #wrapperLedger;
    #effectLedger;
    #groupData = null;
    #dirty = false;
    #terminalTombstone;
    #terminalHydrated;
    #onStateChanged;
    #onStateSaved;
    #onApplicationMessage;
    #onHistoryError;
    #onHistoryChanged;
    constructor(options) {
        this.ciphersuite = options.ciphersuite;
        this.store = options.store;
        this.rewindStore = options.rewindStore;
        this.ingestStateStore = options.ingestStateStore;
        this.lifecycleStore = options.lifecycleStore ?? options.ingestStateStore;
        this.#removedMarkerStore = options.removedMarkerStore;
        this.history = options.history;
        this.#onStateChanged = options.onStateChanged;
        this.#onStateSaved = options.onStateSaved;
        this.#onApplicationMessage = options.onApplicationMessage;
        this.#onHistoryError = options.onHistoryError;
        this.#onHistoryChanged = options.onHistoryChanged;
        this.#peeler = new NostrGroupPeeler(this.ciphersuite);
        if (this.ingestStateStore) {
            const groupId = bytesToHex(options.state.groupContext.groupId);
            this.#wrapperLedger = new TerminalWrapperLedger(this.ingestStateStore, groupId);
            this.#effectLedger = new ConvergenceEffectLedger(this.ingestStateStore, groupId);
        }
        this.#engine = new MarmotGroupEngine({
            state: options.state,
            ciphersuite: this.ciphersuite,
            peeler: this.#peeler,
            retained: options.retained,
            historyTree: options.historyTree,
            convergencePolicy: options.convergencePolicy,
            ingestionPool: options.ingestionPool,
            now: options.now,
            settlementQuiescenceMs: options.settlementQuiescenceMs,
            scheduler: options.scheduler,
            onSettleCheck: options.onSettleCheck,
            audit: options.audit,
            auditContext: options.auditContext,
            lifecycleStore: this.lifecycleStore,
            onStateChanged: (newState) => {
                this.#dirty = true;
                this.#groupData = null;
                this.#onStateChanged?.(newState);
            },
        });
        // Persist the full-fork history tree to the rewind store. A rehydrated tree
        // (loaded form) is already bound; a fresh one is bound here so its nodes
        // flush on the next save.
        if (this.rewindStore && !options.historyTree)
            this.#engine.history.bindStore(this.rewindStore);
        this.#terminalHydrated = this.#hydrateDisbandTombstone();
    }
    get id() {
        return this.state.groupContext.groupId;
    }
    get state() {
        return this.#engine.state;
    }
    set state(newState) {
        this.#engine.state = newState;
    }
    get lifecycle() {
        return this.#engine.lifecycle;
    }
    /**
     * Whether this group's canonical GroupContext still classifies as the
     * current account identity proof profile (D-11). Orthogonal to `lifecycle`:
     * an unsupported group can still be `Stable` — it stays listable and
     * `destroy()`-able, but every outbound `send` and every inbound envelope is
     * refused. Delegates to the engine, which recomputes this on every access.
     */
    get profileSupport() {
        return this.#engine.profileSupport;
    }
    /** The derived convergence status (`group-state.md` §Convergence status, B5). */
    get convergenceStatus() {
        return this.#engine.convergenceStatus;
    }
    get groupData() {
        if (!this.#groupData)
            this.#groupData = getMarmotGroupView(this.state);
        return this.#groupData;
    }
    get relays() {
        return this.groupData?.relays;
    }
    /** The full-fork history tree (every observed state, canonical + forks). */
    get historyTree() {
        return this.#engine.history;
    }
    /**
     * The retained canonical states within the rollback horizon, newest epoch
     * first — the candidate epochs for cross-epoch encrypted-media decryption
     * (see {@link MarmotGroupEngine.retainedStates}).
     */
    retainedStates() {
        return this.#engine.retainedStates();
    }
    /**
     * Transport events received but not yet decrypted/processed into the history
     * tree — the engine's ingestion pool (undecryptable-so-far events held for
     * retry as the tree grows).
     */
    pendingEvents() {
        return this.#engine.pendingEnvelopes();
    }
    get unappliedProposals() {
        return this.state.unappliedProposals;
    }
    get dirty() {
        return this.#dirty;
    }
    async save(force = false) {
        await this.#terminalHydrated;
        if (this.#terminalTombstone)
            return;
        // The history tree can grow without the canonical state changing — a fork
        // whose incoming branch is superseded still records the losing branch — so
        // a dirty tree must trigger a save even when `#dirty` (state-changed) is not.
        const treeDirty = !!this.rewindStore && this.#engine.history.isDirty;
        if (!force && !this.#dirty && !treeDirty)
            return;
        const idHex = bytesToHex(this.id);
        // Persist the full-fork history tree — the single source for fork recovery
        // across restarts. Append-only flush of any new nodes (O(new nodes)). The
        // bounded convergence window is rebuilt from the tree on load.
        await this.#engine.persistDisbandConvergence();
        if (this.rewindStore)
            await this.#engine.history.flush();
        const stateBytes = serializeClientState(this.state);
        await this.store.setItem(idHex, stateBytes);
        this.#dirty = false;
        this.#onStateSaved?.();
    }
    /**
     * Re-scores the persisted fork history against the current tip and switches to
     * the canonical branch if a competing fork now wins (`convergence.md`), then
     * persists a resulting switch. Sources candidates from the history tree, so a
     * client that diverged onto a losing fork converges from disk without waiting
     * for the network to re-deliver the winning branch. Called on load.
     *
     * Returns the pass's results in the same shape {@link ingest} yields, so the
     * caller can route them through the identical handler — in particular the
     * `stateInvalidated` withdrawal that clears the removed-inactive marker
     * (CONV-03, D-12). This layer used to swallow them (CR-06).
     */
    async reconverge() {
        const results = [];
        for (const result of await this.#engine.reconvergeFromHistory())
            results.push(...(await this.#reconcile(mapEngineIngestResult(result))));
        await this.save();
        return results;
    }
    /** Runs one retained-input scheduler edge through the normal reconciliation seam. */
    async driveConvergence() {
        const results = [];
        for (const result of await this.#engine.driveConvergence())
            results.push(...(await this.#reconcile(mapEngineIngestResult(result))));
        await this.#persistSelectedDisbandIfPossible(this.#engine.selectedDisbandEvidence);
        await this.save();
        return results;
    }
    async destroyLocalState() {
        await this.history?.purgeMessages();
        const idHex = bytesToHex(this.id);
        await this.#removedMarkerStore?.removeItem(`${idHex}/removed`);
        await this.store.removeItem(idHex);
        if (this.rewindStore)
            await GroupHistoryTree.purge(this.rewindStore, idHex);
    }
    /** Returns authoritative terminal evidence, failing closed on corrupt bytes. */
    async disbandTombstone() {
        await this.#terminalHydrated;
        return this.#terminalTombstone;
    }
    /** Synchronous terminal authority after lifecycle hydration has completed. */
    get terminalTombstone() {
        return this.#terminalTombstone;
    }
    /** Durably records public notification delivery before application callbacks run. */
    async markDisbandNotificationDelivered() {
        await this.#terminalHydrated;
        const current = this.#terminalTombstone;
        if (!current || current.notificationState === "delivered")
            return undefined;
        if (!this.lifecycleStore)
            throw new Error("Disband notification requires a lifecycle store");
        const delivered = {
            ...current,
            notificationState: "delivered",
        };
        await this.lifecycleStore.setItem(disbandTombstoneKey(bytesToHex(current.groupId)), encodeDisbandTombstone(delivered));
        this.#terminalTombstone = delivered;
        return delivered;
    }
    /** Waits until both durable lifecycle namespaces have been decoded. */
    async hydrateLifecycleEvidence() {
        await this.#terminalHydrated;
        await this.#engine.disbandRequest();
    }
    /**
     * WR-02: the guarded, best-effort form of {@link persistSelectedDisband}
     * that every internal caller uses.
     *
     * `persistSelectedDisband` THROWS without a `lifecycleStore`, and that store
     * is optional in both `GroupSessionOptions` and `MarmotGroupOptions` — while
     * `#selectedDisbandEvidence` is set by the engine for any inbound disband
     * commit that wins selection, store or no store. Calling it unguarded at the
     * end of `ingest` therefore threw for every store-less session, after
     * results had been yielded and BEFORE `save()`, so the batch persisted
     * nothing and the next ingest repeated it.
     *
     * The engine getter is never cleared, so this is re-entered on every
     * subsequent ingest for the life of the group; the `#terminalTombstone`
     * check makes that an explicit early return rather than relying on the one
     * buried inside `persistSelectedDisband`.
     */
    async #persistSelectedDisbandIfPossible(evidence) {
        if (!evidence)
            return;
        await this.#terminalHydrated;
        if (this.#terminalTombstone || !this.lifecycleStore)
            return;
        try {
            await this.persistSelectedDisband(evidence);
        }
        catch (error) {
            // Terminal evidence stays in engine state, so the next pass retries.
            this.#onHistoryError?.(error);
        }
    }
    /**
     * Commits selected terminal evidence before repeatable cleanup. The first
     * durable write is authoritative even if any later store operation fails.
     */
    async persistSelectedDisband(evidence) {
        await this.#terminalHydrated;
        if (this.#terminalTombstone)
            return this.#terminalTombstone;
        if (!this.lifecycleStore)
            throw new Error("Selected disband requires a lifecycle store");
        const idHex = bytesToHex(this.id);
        const tombstone = {
            groupId: this.id.slice(),
            selectedEpoch: Number(this.state.groupContext.epoch),
            commitDigest: evidence.commitDigest.slice(),
            actorPubkey: evidence.actorPubkey,
            notificationState: "pending",
        };
        // The terminal write is the commit point. Everything below is idempotent
        // cleanup and is resumed by hydration after an interrupted attempt.
        await this.lifecycleStore.setItem(disbandTombstoneKey(idHex), encodeDisbandTombstone(tombstone));
        await this.lifecycleStore.setItem(disbandRegistryStateKey(idHex), serializeClientState(scrubTerminalRegistryState(this.state)));
        this.#terminalTombstone = tombstone;
        await this.#cleanupAfterDisband(idHex);
        return tombstone;
    }
    async #hydrateDisbandTombstone() {
        if (!this.lifecycleStore)
            return;
        const idHex = bytesToHex(this.id);
        const bytes = await this.lifecycleStore.getItem(disbandTombstoneKey(idHex));
        if (!bytes)
            return;
        const tombstone = decodeDisbandTombstone(bytes);
        if (bytesToHex(tombstone.groupId) !== idHex)
            throw new Error("Invalid disband tombstone group id");
        this.#terminalTombstone = tombstone;
        if (!(await this.lifecycleStore.getItem(disbandRegistryStateKey(idHex))))
            await this.lifecycleStore.setItem(disbandRegistryStateKey(idHex), serializeClientState(scrubTerminalRegistryState(this.state)));
        await this.#cleanupAfterDisband(idHex);
    }
    async #cleanupAfterDisband(idHex) {
        this.#engine.dispose();
        await this.history?.purgeMessages();
        await this.lifecycleStore?.removeItem(disbandRequestKey(idHex));
        await this.lifecycleStore?.removeItem(disbandConvergenceKey(idHex));
        await this.#removedMarkerStore?.removeItem(`${idHex}/removed`);
        await this.store.removeItem(idHex);
        if (this.rewindStore)
            await GroupHistoryTree.purge(this.rewindStore, idHex);
        if (this.ingestStateStore) {
            for (const key of await this.ingestStateStore.keys())
                if (key.startsWith(`${idHex}/`))
                    await this.ingestStateStore.removeItem(key);
        }
        this.#dirty = false;
    }
    /** Releases engine resources (the settle-check timer); call on teardown (B5). */
    dispose() {
        this.#engine.dispose();
    }
    confirmPublished(pending) {
        const historySizeBefore = this.#engine.history.size;
        const notifications = this.#engine.confirmPublished(pending);
        if (this.#engine.history.size !== historySizeBefore)
            this.#onHistoryChanged?.();
        return notifications;
    }
    publishFailed(pending) {
        this.#engine.publishFailed(pending);
    }
    proposalContext() {
        const groupData = this.groupData;
        if (!groupData)
            throw new Error("MarmotGroupData not found in ClientState.");
        return { state: this.state, ciphersuite: this.ciphersuite, groupData };
    }
    async send(intent) {
        switch (intent.kind) {
            case "applicationMessage": {
                const sendResult = await this.#engine.send({
                    kind: "applicationMessage",
                    payload: intent.payload,
                });
                if (sendResult.kind !== "applicationMessage") {
                    throw new Error("Expected applicationMessage result from applicationMessage send");
                }
                this.#sentEventIds.add(sendResult.envelope.id);
                await this.#saveHistory(intent.payload);
                return {
                    publish: [
                        { kind: "applicationMessage", envelope: sendResult.envelope },
                    ],
                };
            }
            case "proposal": {
                const sendResult = await this.#engine.send({
                    kind: "proposal",
                    proposal: intent.proposal,
                });
                if (sendResult.kind !== "proposal") {
                    throw new Error("Expected proposal result from proposal send");
                }
                return {
                    publish: [
                        {
                            kind: "proposal",
                            envelope: sendResult.envelope,
                            pending: sendResult.pending,
                        },
                    ],
                };
            }
            case "selfUpdate": {
                const sendResult = await this.#engine.send({ kind: "selfUpdate" });
                if (sendResult.kind !== "selfUpdate") {
                    throw new Error("Expected selfUpdate result from selfUpdate send");
                }
                return {
                    publish: [
                        {
                            kind: "selfUpdate",
                            envelope: sendResult.envelope,
                            pending: sendResult.pending,
                        },
                    ],
                };
            }
            case "commit": {
                const sendResult = await this.#engine.send({
                    kind: "commit",
                    actorPubkey: intent.actorPubkey,
                    extraProposals: intent.extraProposals,
                    proposalRefs: intent.proposalRefs,
                });
                if (sendResult.kind !== "groupEvolution") {
                    throw new Error("Expected groupEvolution result from commit send");
                }
                return {
                    publish: [
                        {
                            kind: "groupEvolution",
                            envelope: sendResult.envelope,
                            pending: sendResult.pending,
                            actorPubkey: intent.actorPubkey,
                            welcome: sendResult.welcome,
                            welcomeRecipients: intent.welcomeRecipients,
                        },
                    ],
                };
            }
        }
    }
    /** Persists irreversible terminal intent before returning publish work. */
    async requestDisband() {
        const sendResult = await this.#engine.requestDisband();
        if (!sendResult)
            return { publish: [] };
        if (sendResult.kind !== "groupEvolution")
            throw new Error("Expected groupEvolution result from disband request");
        return {
            publish: [
                {
                    kind: "groupEvolution",
                    envelope: sendResult.envelope,
                    pending: sendResult.pending,
                    welcome: sendResult.welcome,
                    actorPubkey: this.#ownPubkey(),
                },
            ],
        };
    }
    /** Returns the hydrated durable disband request, if one exists. */
    async disbandRequest() {
        return this.#engine.disbandRequest();
    }
    /** Builds the atomic active+required lifecycle enablement commit. */
    async enableGroupDisbanding() {
        const sendResult = await this.#engine.enableGroupDisbanding();
        if (!sendResult)
            return { publish: [] };
        if (sendResult.kind !== "groupEvolution")
            throw new Error("Expected groupEvolution result from lifecycle enablement");
        return {
            publish: [
                {
                    kind: "groupEvolution",
                    envelope: sendResult.envelope,
                    pending: sendResult.pending,
                    welcome: sendResult.welcome,
                    actorPubkey: this.#ownPubkey(),
                },
            ],
        };
    }
    #ownPubkey() {
        return getCredentialPubkey(getCredentialFromLeafIndex(this.state.ratchetTree, this.state.privatePath.leafIndex));
    }
    /**
     * Builds the self-remove proposal effects for leaving the group.
     *
     * Per RFC 9420 §12.4 a member cannot *commit* a Remove targeting their own
     * leaf, so this emits self-remove proposal(s) for the next committer (e.g.
     * an admin) to apply. Modelled as a send-intent — the darkmatter engine
     * exposes the same operation as `do_send_leave` rather than letting callers
     * hand-build the proposals.
     *
     * @param ownPubkey - The leaving member's Nostr public key (hex string).
     * @returns Publishable proposal effects (one per owned leaf node).
     */
    async leave(ownPubkey) {
        const removeProposals = await proposeLeaveGroup(ownPubkey)(this.proposalContext());
        const publish = [];
        for (const proposal of removeProposals) {
            const sendResult = await this.#engine.send({
                kind: "proposal",
                proposal,
            });
            if (sendResult.kind !== "proposal") {
                throw new Error("Expected proposal result from leave send");
            }
            publish.push({
                kind: "proposal",
                envelope: sendResult.envelope,
                pending: sendResult.pending,
            });
        }
        return { publish };
    }
    async *ingest(events, options) {
        await this.#terminalHydrated;
        if (this.#terminalTombstone) {
            for (const event of events) {
                const skipped = {
                    kind: "skipped",
                    event,
                    reason: "group-disbanded",
                };
                yield { ...skipped, disposition: ingestResultDisposition(skipped) };
            }
            return;
        }
        // D-11 mirror: refuse every event for a group outside the current
        // account identity proof profile before any effect-ledger replay or
        // wrapper-ledger bookkeeping, so refused input writes nothing to either
        // ledger and persists no state. The engine gate (`ingestEnvelopes`)
        // remains authoritative for direct engine callers; this repeats the
        // terminal-tombstone precedent of gating at both session and engine.
        if (this.#engine.profileSupport.kind === "unsupported") {
            for (const event of events) {
                const skipped = {
                    kind: "skipped",
                    event,
                    reason: "unsupported-profile",
                };
                yield { ...skipped, disposition: ingestResultDisposition(skipped) };
            }
            return;
        }
        for (const pending of (await this.#effectLedger?.pending()) ?? [])
            yield { ...pending, disposition: ingestResultDisposition(pending) };
        const selfEcho = [];
        const rest = [];
        const stateHash = bytesToHex(sha256(serializeClientState(this.state)));
        for (const event of events) {
            if (await this.#wrapperLedger?.get(event.id, stateHash))
                continue;
            if (this.#sentEventIds.delete(event.id))
                selfEcho.push(event);
            else {
                await this.#wrapperLedger?.begin(event.id, stateHash);
                rest.push(event);
            }
        }
        for (const event of selfEcho) {
            const peeled = await this.#peeler.peelGroupMessages([event], this.state);
            const message = peeled.read[0]?.message;
            if (message) {
                const skipped = {
                    kind: "skipped",
                    event,
                    message,
                    reason: "self-echo",
                };
                const disposition = ingestResultDisposition(skipped);
                await this.#wrapperLedger?.record(event.id, "stale");
                yield { ...skipped, disposition };
            }
        }
        for await (const result of this.#engine.ingest(rest, options)) {
            const mapped = mapEngineIngestResult(result);
            if (mapped.kind === "processed")
                await this.#persistSelectedDisbandIfPossible(mapped.selectedTerminal);
            if (mapped.kind === "processed" &&
                mapped.result.kind === "applicationMessage") {
                await this.#saveHistory(mapped.result.message);
            }
            const retryableUnreadable = mapped.kind === "unreadable" && mapped.decryptFailure === true;
            const terminal = "event" in mapped &&
                mapped.disposition.kind !== "deferred" &&
                !retryableUnreadable;
            if (terminal) {
                const outcome = mapped.disposition.kind === "accepted"
                    ? "accepted"
                    : mapped.disposition.kind === "invalidated"
                        ? "invalidated"
                        : "stale";
                await this.#wrapperLedger?.stageApplied(mapped.event.id, stateHash, bytesToHex(sha256(serializeClientState(this.state))), outcome);
                // Canonical state and fork material must be durable before terminal
                // wrapper evidence can suppress replay after a crash.
                await this.save(true);
                await this.#wrapperLedger?.record(mapped.event.id, outcome);
            }
            if (mapped.kind === "processed" &&
                mapped.result.kind === "applicationMessage")
                this.#onApplicationMessage?.(mapped.result.message);
            for (const reconciled of await this.#reconcile(mapped))
                yield reconciled;
        }
        // WR-01: a pool-replay rewind can select disband evidence with no
        // `processed` result to carry it (every triggering envelope was refused).
        // The engine still records the selection, so persist it from engine state
        // exactly as `driveConvergence` does. Idempotent once the tombstone exists.
        await this.#persistSelectedDisbandIfPossible(this.#engine.selectedDisbandEvidence);
        await this.save();
    }
    async #reconcile(result) {
        if (!this.#effectLedger)
            return [result];
        if (result.kind === "stateInvalidated") {
            return (await this.#effectLedger.prepareWithdrawal(result.commitDigest, result.forkEpoch, result.withdrawn))
                ? [result]
                : [];
        }
        const notifications = "notifications" in result ? result.notifications : undefined;
        if (!notifications?.length)
            return [result];
        const groups = new Map();
        for (const notification of notifications) {
            const key = bytesToHex(notification.commitDigest);
            const group = groups.get(key) ?? [];
            group.push(notification);
            groups.set(key, group);
        }
        const output = [result];
        for (const group of groups.values()) {
            const digest = group[0].commitDigest;
            if (await this.#effectLedger.prepareAdoption(digest, group))
                output.push({
                    kind: "stateRevalidated",
                    commitDigest: digest,
                    effectId: digest,
                    notifications: group,
                    disposition: { kind: "accepted" },
                });
        }
        return output;
    }
    /** Establishes the durable application-observation boundary for an effect. */
    async acknowledgeConvergenceEffect(result) {
        await this.#effectLedger?.acknowledge(result.commitDigest, result.kind === "stateInvalidated" ? "withdrawal" : "adoption");
    }
    async #saveHistory(message) {
        if (!this.history)
            return;
        try {
            await this.history.saveMessage(message);
        }
        catch (err) {
            this.#onHistoryError?.(err);
        }
    }
}
function scrubTerminalRegistryState(state) {
    const copy = structuredClone(state);
    scrubSecrets(copy.keySchedule);
    scrubSecrets(copy.secretTree);
    scrubSecrets(copy.privatePath);
    copy.signaturePrivateKey.fill(0);
    copy.historicalReceiverData.clear();
    copy.unappliedProposals = {};
    return copy;
}
function scrubSecrets(value) {
    if (value instanceof Uint8Array) {
        value.fill(0);
        return;
    }
    if (value instanceof Map) {
        for (const entry of value.values())
            scrubSecrets(entry);
        return;
    }
    if (!value || typeof value !== "object")
        return;
    for (const entry of Object.values(value))
        scrubSecrets(entry);
}
