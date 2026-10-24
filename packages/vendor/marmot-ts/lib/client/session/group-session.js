/** @module @category Client - Session */
import { pendingPublicationKey } from "../runtime/pending-publication.js";
import { mediaSourceStateToken, StaleMediaPreparationError, } from "../../core/media/source-state.js";
import { deserializeApplicationData } from "../../core/application-rumor.js";
import { encodeDeliveredEvidence, decodeDeliveredEvidence, } from "./delivered-payload-store.js";
import { getCredentialFromLeafIndex, appDataUpdateProposalType, } from "../../vendor/ts-mls/index.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { getAdminPolicy } from "../../core/components/dictionary.js";
import { getGroupMemberPubkeys } from "../../core/group-members.js";
import { GROUP_BLOSSOM_IMAGE_COMPONENT_ID } from "../../core/components/ids.js";
import { getMarmotGroupView, deserializeClientState, serializeClientState, } from "../../core/client-state.js";
import { getCredentialPubkey } from "../../core/credential.js";
import { MarmotGroupEngine } from "../../engine/group-engine.js";
import { GroupHistoryTree } from "../../engine/history-tree.js";
import { framedEpoch } from "../../engine/wire-format.js";
import { contentDedupId } from "../../engine/message-dedup.js";
import { registerSettledRetentionOwner, unregisterSettledRetentionOwner, } from "../../engine/settled-retention-owner.js";
import { registerPublicationPreparationOwner, unregisterPublicationPreparationOwner, } from "../../engine/publication-preparation.js";
import { registerPublicationRetention, unregisterPublicationRetention, } from "../runtime/publication-retention.js";
import { projectHistoricalReceivers, } from "../../engine/retention.js";
import { disbandConvergenceKey, disbandRequestKey, } from "../../engine/disband-request.js";
import { decodeDisbandTombstone, decodeDisbandTerminalIntent, encodeDisbandTerminalIntent, disbandTerminalIntentKey, disbandRegistryStateKey, disbandTombstoneKey, encodeDisbandTombstone, } from "../../engine/disband-tombstone.js";
import { ingestResultDisposition as engineIngestResultDisposition } from "../../engine/ingest-disposition.js";
import { NostrGroupPeeler } from "../group/nostr-peeler.js";
import { ConvergenceEffectLedger, TerminalWrapperLedger, } from "../group/wrapper-ledger.js";
import { proposeLeaveGroup } from "../group/proposals/leave-group.js";
export function removalEvidenceKey(groupId) {
    return `${groupId}/removal-attribution/v1`;
}
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
    #sentEventIds = new Map();
    #pendingPublications = new Map();
    #wrapperLedger;
    #effectLedger;
    #groupData = null;
    #dirty = false;
    #stateVersion = 0;
    #retentionVersion = 0;
    #destroyed = false;
    #disposed = false;
    #localWrites = new Set();
    /** Adapter history mutations only: terminal operations never wait on themselves. */
    #historyWrites = new Set();
    #saveInFlight;
    #retentionInFlight;
    #retentionPending = false;
    #terminalTombstone;
    #terminalIntent;
    #terminalProjectionComplete = false;
    #terminalProjectionInFlight;
    #removalEvidence;
    #removalFenced = false;
    #removalRecoveryInFlight;
    #removalHydrated;
    #terminalHydrated;
    #disbandNotificationInFlight;
    #deliveredHydrated;
    #pendingRetractions = new Map();
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
        this.#peeler.wrapGroupMessage = async (message, state, metadata) => {
            const sourceEpoch = framedEpoch(message);
            if (sourceEpoch === undefined ||
                sourceEpoch < 0n ||
                !Number.isSafeInteger(Number(sourceEpoch)))
                throw new Error("Unsafe local publication source epoch");
            // Capture authenticated inner identity and source before wrapping awaits.
            const record = {
                sourceEpoch: Number(sourceEpoch),
                contentId: contentDedupId(message),
                stateTag: bytesToHex(state.confirmationTag),
            };
            const envelope = await NostrGroupPeeler.prototype.wrapGroupMessage.call(this.#peeler, message, state, metadata);
            if (!this.#destroyed &&
                !this.#disposed &&
                !this.#terminalTombstone &&
                !this.removalBlocked) {
                this.#sentEventIds.set(envelope.id, record);
                this.#pendingPublications.set(envelope.id, record);
            }
            return envelope;
        };
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
            onSettleCheck: async () => {
                await this.#deliveredHydrated;
                if (this.#destroyed || this.#disposed)
                    return;
                try {
                    await options.onSettleCheck?.();
                }
                catch (error) {
                    if (!this.#destroyed && !this.#disposed)
                        throw error;
                }
            },
            audit: options.audit,
            auditContext: options.auditContext,
            // Engine lifecycle writes also occur outside awaited session calls (for
            // example when a confirmed epoch refreshes a pending request). Route
            // every such write through the same destruction barrier.
            lifecycleStore: this.lifecycleStore && {
                getItem: (key) => this.lifecycleStore.getItem(key),
                keys: () => this.lifecycleStore.keys(),
                setItem: async (key, value) => {
                    await this.#write(() => this.lifecycleStore.setItem(key, value));
                    return value;
                },
                removeItem: async (key) => {
                    await this.#write(() => this.lifecycleStore.removeItem(key));
                },
                clear: async () => {
                    await this.#write(() => this.lifecycleStore.clear());
                },
            },
            onStateChanged: (newState) => {
                if (this.#destroyed || this.#disposed)
                    return;
                this.#dirty = true;
                this.#stateVersion++;
                this.#groupData = null;
                this.#onStateChanged?.(newState);
            },
            onSelectedDisband: (evidence, state) => this.#fenceDisband(evidence, state),
        });
        this.#registerRetentionOwners();
        // Persist the full-fork history tree to the rewind store. A rehydrated tree
        // (loaded form) is already bound; a fresh one is bound here so its nodes
        // flush on the next save.
        if (this.rewindStore && !options.historyTree)
            this.#engine.history.bindStore(this.rewindStore);
        this.#terminalHydrated = this.#hydrateDisbandTombstone();
        this.#deliveredHydrated = this.#hydrateDelivered();
        this.#removalHydrated = this.#hydrateRemovalEvidence();
    }
    get removalEvidence() {
        const evidence = this.#removalEvidence;
        return (evidence && {
            ...evidence,
            recoveryPending: evidence.recoveryPending && {
                ...evidence.recoveryPending,
            },
        });
    }
    /** Side-effect-free hydration used before a loaded facade becomes observable. */
    async hydrateRemovalEvidence() {
        await this.#removalHydrated;
    }
    /** Public membership remains removed until every recovery write completes. */
    get removalBlocked() {
        return (this.#removalFenced ||
            this.state.groupActiveState.kind === "removedFromGroup");
    }
    async #assertOutboundMembership() {
        await this.#removalHydrated;
        if (this.removalBlocked)
            throw new Error("Group removed or removal recovery pending");
    }
    async #hydrateRemovalEvidence() {
        const bytes = await this.lifecycleStore?.getItem(removalEvidenceKey(bytesToHex(this.id)));
        const marker = this.state.groupActiveState.kind === "removedFromGroup"
            ? undefined
            : await this.#removedMarkerStore?.getItem(`${bytesToHex(this.id)}/removed`);
        this.#removalFenced = !!bytes || marker === true;
        if (!bytes)
            return;
        try {
            const record = JSON.parse(new TextDecoder().decode(bytes));
            if (![1, 2].includes(record.version) ||
                (record.version === 2 &&
                    (typeof record.removingCommitter !== "string" ||
                        !/^([0-9a-f]{64})?$/.test(record.removingCommitter))) ||
                (record.removingPriority !== undefined &&
                    record.removingPriority !== "privileged" &&
                    record.removingPriority !== "ordinary") ||
                record.groupId !== bytesToHex(this.id) ||
                !/^[0-9a-f]{64}$/.test(record.removalDigest) ||
                !/^[0-9a-f]+$/.test(record.parentTag) ||
                !/^[0-9a-f]{64}$/.test(record.localIdentity) ||
                !Number.isSafeInteger(record.parentEpoch) ||
                record.parentEpoch < 0 ||
                !Number.isSafeInteger(record.localLeaf) ||
                record.localLeaf < 0 ||
                !["pending", "delivered"].includes(record.notificationState))
                return;
            if (record.recoveryPending !== undefined &&
                (!record.recoveryPending ||
                    typeof record.recoveryPending !== "object" ||
                    record.recoveryPending.removalDigest !== record.removalDigest ||
                    record.recoveryPending.parentTag !== record.parentTag ||
                    typeof record.recoveryPending.selectedTip !== "string" ||
                    !/^[0-9a-f]+$/.test(record.recoveryPending.selectedTip)))
                return;
            this.#removalEvidence = record;
            this.#clearPublications();
        }
        catch {
            /* Legacy or malformed authority cannot restore membership. */
        }
    }
    async #persistRemovalEvidence(evidence) {
        if (!this.#removalFenced)
            this.#clearPublications();
        this.#removalFenced = true;
        if (this.lifecycleStore)
            await this.#write(() => this.lifecycleStore.setItem(removalEvidenceKey(bytesToHex(this.id)), new TextEncoder().encode(JSON.stringify(evidence))));
        this.#removalEvidence = evidence;
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
    /**
     * Transport events retained but not yet processed because a commit
     * publication or merge is in progress (or a convergence pass reached its
     * cutoff). Like {@link pendingEvents}, they exist only in memory until a
     * later convergence pass processes them.
     */
    retainedEvents() {
        return this.#engine.retainedConvergenceInput();
    }
    get unappliedProposals() {
        return this.state.unappliedProposals;
    }
    get dirty() {
        return this.#dirty;
    }
    /** Refuses stale preparation, publication and confirmation after teardown. */
    get destroyed() {
        return this.#destroyed;
    }
    assertOpen() {
        if (this.#destroyed)
            throw new Error("Group destroyed");
        if (this.#disposed)
            throw new Error("Group unloaded");
    }
    /** Synchronous publication/preparation fence after admitted lifecycle hydration. */
    assertOutboundOpen() {
        this.assertOpen();
        if (this.#terminalTombstone)
            throw new Error("Group disbanded");
        if (this.removalBlocked)
            throw new Error("Group removed or removal recovery pending");
    }
    /** Serializable identity of the canonical parent, including same-epoch forks. */
    get parentToken() {
        return mediaSourceStateToken(this.state);
    }
    /** Resolve persisted authenticated delivery evidence, never an imeta epoch. */
    async mediaSourceForRumor(rumorId) {
        await this.#deliveredHydrated;
        if (this.#destroyed ||
            this.#disposed ||
            this.removalBlocked ||
            this.#terminalTombstone)
            return undefined;
        const states = [this.state, ...this.retainedStates()];
        for (const entry of this.#engine.exportDeliveredPayloads()) {
            if (entry.rumorId !== rumorId)
                continue;
            const epoch = framedEpoch(entry.message);
            const state = states.find((candidate) => candidate.groupContext.epoch === epoch &&
                epoch === BigInt(entry.epoch) &&
                bytesToHex(candidate.confirmationTag) === entry.stateTag);
            if (state)
                return mediaSourceStateToken(state);
        }
        return undefined;
    }
    /** Track a whole admitted operation, including engine I/O between awaits. */
    async #whileOpen(operation) {
        this.assertOpen();
        const result = await this.#write(async () => {
            let value;
            try {
                value = await operation();
            }
            catch (error) {
                this.assertOpen();
                throw error;
            }
            this.assertOpen();
            return { value };
        });
        this.assertOpen();
        if (!result)
            throw new Error("Group destroyed");
        return result.value;
    }
    async save(force = false) {
        while (this.#saveInFlight) {
            await this.#saveInFlight;
            if (!force &&
                !this.#dirty &&
                !this.#retentionPending &&
                !this.historyTree.isDirty)
                return;
        }
        const saving = this.#save(force);
        this.#saveInFlight = saving;
        try {
            await saving;
        }
        finally {
            if (this.#saveInFlight === saving)
                this.#saveInFlight = undefined;
        }
    }
    async #save(force) {
        await this.#terminalHydrated;
        await this.#deliveredHydrated;
        await this.#removalHydrated;
        if (this.#destroyed || this.#disposed || this.#terminalTombstone)
            return;
        const treeDirty = !!this.rewindStore && this.#engine.history.isDirty;
        this.#retentionPending ||= force || this.#dirty || treeDirty;
        if (!this.#retentionPending) {
            await this.#persistDelivered();
            return;
        }
        await this.#write(() => this.#engine.persistDisbandConvergence());
        const retentionVersion = this.#retentionVersion;
        const stateVersion = this.#stateVersion;
        if (await this.#pruneSettledRetention()) {
            this.#retentionPending = retentionVersion !== this.#retentionVersion;
            if (stateVersion === this.#stateVersion)
                this.#dirty = false;
            this.#onStateSaved?.();
            return;
        }
        // The history tree can grow without the canonical state changing — a fork
        // whose incoming branch is superseded still records the losing branch — so
        // a dirty tree must trigger a save even when `#dirty` (state-changed) is not.
        if (!force && !this.#dirty && !treeDirty) {
            await this.#persistDelivered();
            return;
        }
        const idHex = bytesToHex(this.id);
        // Persist the full-fork history tree — the single source for fork recovery
        // across restarts. Append-only flush of any new nodes (O(new nodes)). The
        // bounded convergence window is rebuilt from the tree on load.
        await this.#write(() => this.#engine.persistDisbandConvergence());
        if (this.rewindStore)
            await this.#write(() => this.#engine.history.flush());
        // Restored delivered evidence must reference durable branch nodes, while
        // terminal convergence evidence must precede any fallible history write.
        await this.#persistDelivered();
        const stateBytes = serializeClientState(this.state);
        const writtenVersion = this.#stateVersion;
        await this.#write(() => this.store.setItem(idHex, stateBytes));
        if (this.#destroyed || this.#disposed)
            return;
        if (writtenVersion === this.#stateVersion)
            this.#dirty = false;
        this.#onStateSaved?.();
    }
    async #pruneSettledRetention() {
        if (this.#retentionInFlight)
            return this.#retentionInFlight;
        const pruning = this.#retainSettled();
        this.#retentionInFlight = pruning;
        try {
            return await pruning;
        }
        finally {
            if (this.#retentionInFlight === pruning)
                this.#retentionInFlight = undefined;
        }
    }
    async #retainSettled() {
        // Await only adapter history writes, never the enclosing local operation:
        // a send/recovery can itself be waiting for this save.
        await Promise.all([...this.#historyWrites]);
        if (this.#destroyed || this.#disposed)
            return false;
        const pins = [];
        // Removal authority owns the exact pristine parent and every selected
        // replay snapshot until durable validation, marker clearing and attribution
        // deletion finish. A malformed/unresolved authority still postpones cleanup.
        const removal = this.#removalEvidence;
        let unresolvedRemoval = this.#removalFenced && !removal;
        if (removal) {
            const path = removal.recoveryPending
                ? this.historyTree.path(removal.recoveryPending.selectedTip)
                : [removal.parentTag];
            const parentIndex = path?.indexOf(removal.parentTag) ?? -1;
            if (parentIndex < 0 ||
                this.historyTree.epochOf(removal.parentTag) !== removal.parentEpoch ||
                (removal.recoveryPending &&
                    (removal.recoveryPending.parentTag !== removal.parentTag ||
                        removal.recoveryPending.removalDigest !== removal.removalDigest)))
                unresolvedRemoval = true;
            else
                for (const stateTag of path.slice(parentIndex))
                    pins.push({ stateTag, reason: "recovery" });
        }
        const publications = [...this.#pendingPublications.values()];
        for (const publication of publications)
            pins.push({ stateTag: publication.stateTag, reason: "publication" });
        const invalidated = this.#engine.exportInvalidatedPayloads();
        for (const entry of invalidated)
            if (entry.rumorId && entry.transportId)
                this.#pendingRetractions.set(entry.transportId, entry);
        const deliveries = this.#engine.exportDeliveredPayloads();
        for (const entry of this.#pendingRetractions.values()) {
            pins.push({ stateTag: entry.stateTag, reason: "retraction" });
            for (const support of deliveries)
                if (support.rumorId === entry.rumorId)
                    pins.push({ stateTag: support.stateTag, reason: "retraction" });
        }
        const effects = (await this.#effectLedger?.pending()) ?? [];
        let unresolvedEffect = (await this.#effectLedger?.hasOpaqueDependency()) ?? false;
        for (const effect of effects) {
            const notifications = effect.kind === "stateInvalidated"
                ? effect.withdrawn
                : effect.notifications;
            for (const digest of [
                effect.commitDigest,
                ...notifications.map((notification) => notification.commitDigest),
            ]) {
                const matching = this.historyTree
                    .tags()
                    .filter((tag) => bytesToHex(this.historyTree.node(tag)?.edge?.commitDigest ??
                    new Uint8Array()) === bytesToHex(digest));
                if (!matching.length)
                    unresolvedEffect = true;
                for (const stateTag of matching)
                    pins.push({ stateTag, reason: "recovery" });
            }
        }
        const unfinishedWrappers = (await this.#wrapperLedger?.hasUnfinished()) ?? false;
        const result = await this.#engine.retainSettled(async (capture, publish) => {
            // Capture the live ratchet projection once while the engine lease owns revision.
            const stateBytes = projectHistoricalReceivers(serializeClientState(this.state), capture.appPayloadPastEpochLimit === Infinity
                ? 0
                : Math.max(0, Number(this.state.groupContext.epoch) -
                    capture.appPayloadPastEpochLimit), capture.pins.filter((pin) => pin.stateTag === capture.canonicalTipTag)).snapshot;
            const plan = await this.historyTree.prepareRetention(capture);
            const keep = new Set(plan.retainedTags);
            const evidence = encodeDeliveredEvidence({
                entries: deliveries.filter((entry) => !!entry.rumorId && keep.has(entry.stateTag)),
                pending: [...this.#pendingRetractions.values()],
            });
            if (this.rewindStore)
                await this.#write(() => this.historyTree.flush());
            await this.#write(() => this.store.setItem(bytesToHex(this.id), stateBytes));
            await this.#write(() => this.ingestStateStore?.setItem(this.#deliveredKey(), evidence));
            const digests = new Set(plan.retainedTags.flatMap((tag) => {
                const digest = this.historyTree.node(tag)?.edge?.commitDigest;
                return digest ? [bytesToHex(digest)] : [];
            }));
            await this.#write(() => this.#wrapperLedger?.compactRetained(plan.floorEpoch, plan.tipEpoch, new Set([
                ...this.#pendingRetractions.keys(),
                ...this.#pendingPublications.keys(),
            ])));
            await this.#write(() => this.#effectLedger?.compactRetained(digests));
            if (this.#destroyed || this.#disposed)
                throw new Error("Group closed during retention");
            await publish(plan);
            return plan;
        }, {
            pins,
            contentIds: publications.map((publication) => publication.contentId),
            unresolvedDependency: unresolvedRemoval ||
                !!this.#terminalIntent ||
                unfinishedWrappers ||
                unresolvedEffect,
        });
        if (result.kind === "committed") {
            this.#engine.acknowledgeInvalidatedPayloads(invalidated);
            for (const [id, record] of this.#sentEventIds)
                if (record.sourceEpoch < result.floorEpoch &&
                    !this.#pendingPublications.has(id) &&
                    !this.#pendingRetractions.has(id))
                    this.#sentEventIds.delete(id);
        }
        return result.kind === "committed";
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
        await this.#terminalHydrated;
        await this.#removalHydrated;
        await this.#deliveredHydrated;
        if (this.#destroyed)
            return [];
        if (this.#terminalTombstone)
            return this.#resumeTerminalWork();
        if (this.removalBlocked || this.#removalEvidence) {
            await this.finishRemovalRecovery();
            return [];
        }
        await this.#retryRetractions();
        const results = [];
        for (const result of await this.#engine.reconvergeFromHistory())
            results.push(...(await this.#reconcile(mapEngineIngestResult(result))));
        await this.save();
        return results;
    }
    /** Recoverable ordering over existing adapters; each interrupted prefix is restartable. */
    async #finishRemovalRecovery() {
        let evidence = this.#removalEvidence;
        if (!evidence ||
            !this.lifecycleStore ||
            !this.#removedMarkerStore ||
            !this.rewindStore)
            return;
        this.#removalFenced = true;
        if (this.state.groupActiveState.kind === "removedFromGroup") {
            const removedState = this.state;
            const recovered = await this.#engine.recoverRemovedFromAnchor(evidence, evidence.recoveryPending?.selectedTip);
            if (!recovered)
                return;
            try {
                evidence = { ...evidence, recoveryPending: recovered };
                // Authority precedes the fallible active projection write.
                await this.#persistRemovalEvidence(evidence);
                await this.save(true);
            }
            catch (error) {
                this.state = removedState;
                throw error;
            }
        }
        const authority = evidence.recoveryPending;
        if (!authority ||
            !(await this.#engine.validateRemovalRecovery(evidence, authority)))
            return;
        const bytes = await this.store.getItem(bytesToHex(this.id));
        if (!bytes)
            return;
        let durable;
        try {
            durable = deserializeClientState(bytes);
        }
        catch {
            return;
        }
        if (!(await this.#engine.validateRemovalRecovery(evidence, authority, durable)))
            return;
        // Keep notification identity and selection authority until the marker write settles.
        await this.#write(() => this.#removedMarkerStore.removeItem(`${bytesToHex(this.id)}/removed`));
        await this.#write(() => this.lifecycleStore.removeItem(removalEvidenceKey(bytesToHex(this.id))));
        this.#removalEvidence = undefined;
        this.#removalFenced = false;
        this.#registerRetentionOwners();
    }
    async finishRemovalRecovery() {
        await this.#removalHydrated;
        if (this.#removalRecoveryInFlight)
            return this.#removalRecoveryInFlight;
        const recovery = this.#whileOpen(() => this.#finishRemovalRecovery());
        this.#removalRecoveryInFlight = recovery;
        try {
            await recovery;
        }
        finally {
            if (this.#removalRecoveryInFlight === recovery)
                this.#removalRecoveryInFlight = undefined;
        }
    }
    /** Record removal delivery before callbacks; the stable identity is the removal digest. */
    async markRemovalNotificationDelivered() {
        await this.#removalHydrated;
        if (this.#removalEvidence &&
            this.#removalEvidence.notificationState !== "delivered") {
            await this.#persistRemovalEvidence({
                ...this.#removalEvidence,
                notificationState: "delivered",
            });
        }
    }
    /** Runs one retained-input scheduler edge through the normal reconciliation seam. */
    async driveConvergence() {
        await this.#terminalHydrated;
        await this.#removalHydrated;
        if (this.removalBlocked || this.#removalEvidence)
            return this.reconverge();
        await this.#deliveredHydrated;
        if (this.#destroyed)
            return [];
        if (this.#terminalTombstone)
            return this.#resumeTerminalWork();
        await this.#retryRetractions();
        const results = [];
        for (const result of await this.#engine.driveConvergence())
            results.push(...(await this.#reconcile(mapEngineIngestResult(result))));
        await this.#persistSelectedDisbandIfPossible(this.#engine.selectedDisbandEvidence);
        await this.save();
        return results;
    }
    /** Close admission synchronously, before asynchronous media/store cleanup. */
    beginDestroy() {
        this.#destroyed = true;
        this.#clearPublications();
        this.#engine.dispose();
        // A captured retention revision owns engine mutation until its adapter
        // finishes. Destruction fences admission now and wipes after that barrier.
        if (!this.#retentionInFlight)
            this.#engine.destroyDeliveredPayloads();
        this.#pendingRetractions.clear();
    }
    /** Track local writes so destruction waits for any already admitted I/O. */
    async #write(operation) {
        if (this.#destroyed || this.#disposed)
            return undefined;
        const write = Promise.resolve().then(() => {
            if (!this.#destroyed && !this.#disposed)
                return operation();
            return undefined;
        });
        this.#localWrites.add(write);
        try {
            return await write;
        }
        finally {
            this.#localWrites.delete(write);
        }
    }
    async #writeHistory(operation, ordinary = true) {
        await this.#retentionInFlight;
        // The tombstone is installed synchronously by selection/hydration. Check
        // again inside the queued write so admitted work that has not started
        // cannot open an adapter save after terminal selection.
        if (ordinary && this.#terminalTombstone)
            return undefined;
        const write = this.#write(() => {
            if (ordinary && this.#terminalTombstone)
                return undefined;
            return operation();
        });
        this.#historyWrites.add(write);
        try {
            return await write;
        }
        finally {
            this.#historyWrites.delete(write);
        }
    }
    async destroyLocalState() {
        this.beginDestroy();
        // Hydration may already be reading the plaintext ledger. Let reads finish
        // before purge, and settle writes admitted before the destruction fence.
        await Promise.allSettled([this.#terminalHydrated, this.#deliveredHydrated]);
        await Promise.allSettled([this.#retentionInFlight, this.#saveInFlight]);
        await Promise.allSettled([...this.#localWrites]);
        this.#engine.destroyDeliveredPayloads();
        this.#pendingRetractions.clear();
        await this.history?.purgeMessages();
        const idHex = bytesToHex(this.id);
        await this.#removedMarkerStore?.removeItem(`${idHex}/removed`);
        await this.store.removeItem(idHex);
        if (this.rewindStore) {
            await GroupHistoryTree.purge(this.rewindStore, idHex);
            await this.rewindStore.removeItem(pendingPublicationKey(idHex));
        }
        if (this.ingestStateStore)
            for (const key of await this.ingestStateStore.keys())
                if (key.startsWith(`${idHex}/`))
                    await this.ingestStateStore.removeItem(key);
        if (this.lifecycleStore && this.lifecycleStore !== this.ingestStateStore)
            for (const key of await this.lifecycleStore.keys())
                if (key.startsWith(`${idHex}/`))
                    await this.lifecycleStore.removeItem(key);
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
    /** Consumes the callback attempt before external code runs; it can be lost on crash. */
    async markDisbandNotificationDelivered() {
        if (this.#destroyed)
            return undefined;
        if (this.#disbandNotificationInFlight) {
            await this.#disbandNotificationInFlight;
            return undefined;
        }
        const notification = this.#whileOpen(() => this.#markDisbandNotificationDelivered());
        this.#disbandNotificationInFlight = notification;
        try {
            return await notification;
        }
        finally {
            if (this.#disbandNotificationInFlight === notification)
                this.#disbandNotificationInFlight = undefined;
        }
    }
    async #markDisbandNotificationDelivered() {
        await this.#terminalHydrated;
        this.assertOpen();
        const current = this.#terminalTombstone;
        if (!current || current.notificationState === "delivered")
            return undefined;
        if (this.lifecycleStore && !this.#terminalProjectionComplete)
            await this.#finishDisbandProjection();
        const delivered = {
            ...current,
            notificationState: "delivered",
        };
        await this.lifecycleStore?.setItem(disbandTombstoneKey(bytesToHex(current.groupId)), encodeDisbandTombstone(delivered));
        this.assertOpen();
        this.#terminalTombstone = delivered;
        return delivered;
    }
    /** Waits until both durable lifecycle namespaces have been decoded. */
    async hydrateLifecycleEvidence() {
        await this.#write(async () => {
            await this.#terminalHydrated;
            await this.#removalHydrated;
            await this.#deliveredHydrated;
            if (this.#destroyed)
                return;
            await this.#retryRetractions();
            if (this.#destroyed)
                return;
            await this.#engine.disbandRequest();
        });
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
     * Selected evidence fences immediately even without optional storage. A
     * failed projection remains retryable until every cleanup step completes.
     */
    async #persistSelectedDisbandIfPossible(evidence) {
        if (!evidence)
            return;
        await this.#terminalHydrated;
        if (this.#destroyed)
            return;
        this.#fenceDisband(evidence, this.state);
        if (this.#terminalProjectionComplete || !this.lifecycleStore)
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
        return this.#whileOpen(() => this.#persistSelectedDisband(evidence));
    }
    async #persistSelectedDisband(evidence) {
        await this.#terminalHydrated;
        this.assertOpen();
        if (!this.lifecycleStore)
            throw new Error("Selected disband requires a lifecycle store");
        this.#fenceDisband(evidence, this.state);
        if (!this.#terminalProjectionComplete)
            await this.#finishDisbandProjection();
        return this.#terminalTombstone;
    }
    #fenceDisband(evidence, state) {
        if (this.#terminalTombstone)
            return;
        this.#clearPublications();
        const tombstone = {
            groupId: this.id.slice(),
            selectedEpoch: Math.max(Number(state.groupContext.epoch), evidence.sourceEpoch + 1),
            commitDigest: evidence.commitDigest.slice(),
            actorPubkey: evidence.actorPubkey,
            notificationState: "pending",
        };
        this.#terminalTombstone = tombstone;
        this.#terminalIntent = {
            tombstone,
            registryState: serializeClientState(scrubTerminalRegistryState(state)),
        };
    }
    async #finishDisbandProjection() {
        if (this.#terminalProjectionComplete)
            return;
        if (this.#terminalProjectionInFlight)
            return this.#terminalProjectionInFlight;
        const projection = this.#writeDisbandProjection();
        this.#terminalProjectionInFlight = projection;
        try {
            await projection;
        }
        finally {
            if (this.#terminalProjectionInFlight === projection)
                this.#terminalProjectionInFlight = undefined;
        }
    }
    async #writeDisbandProjection() {
        if (!this.lifecycleStore || !this.#terminalIntent)
            return;
        const idHex = bytesToHex(this.id);
        const intent = this.#terminalIntent;
        // Every adapter may throw after forwarding; repeat all writes on retry.
        await this.lifecycleStore.setItem(disbandTerminalIntentKey(idHex), encodeDisbandTerminalIntent(intent));
        this.assertOpen();
        await this.lifecycleStore.setItem(disbandTombstoneKey(idHex), encodeDisbandTombstone(this.#terminalTombstone));
        this.assertOpen();
        await this.lifecycleStore.setItem(disbandRegistryStateKey(idHex), intent.registryState);
        this.assertOpen();
        await this.#cleanupAfterDisband(idHex);
        this.#terminalProjectionComplete = true;
    }
    async #hydrateDisbandTombstone() {
        if (!this.lifecycleStore)
            return;
        const idHex = bytesToHex(this.id);
        const intentBytes = await this.lifecycleStore.getItem(disbandTerminalIntentKey(idHex));
        const bytes = await this.lifecycleStore.getItem(disbandTombstoneKey(idHex));
        if ((!bytes && !intentBytes) || this.#destroyed || this.#disposed)
            return;
        const intent = intentBytes
            ? decodeDisbandTerminalIntent(intentBytes)
            : undefined;
        const tombstone = bytes ? decodeDisbandTombstone(bytes) : intent.tombstone;
        if (intent &&
            (bytesToHex(intent.tombstone.groupId) !== idHex ||
                bytesToHex(intent.tombstone.commitDigest) !==
                    bytesToHex(tombstone.commitDigest)))
            throw new Error("Invalid disband terminal intent identity");
        if (bytesToHex(tombstone.groupId) !== idHex)
            throw new Error("Invalid disband tombstone group id");
        if (intent &&
            bytesToHex(deserializeClientState(intent.registryState).groupContext.groupId) !== idHex)
            throw new Error("Invalid disband terminal intent shell group id");
        this.#terminalTombstone = tombstone;
        this.#terminalIntent = intent ?? {
            tombstone,
            registryState: serializeClientState(scrubTerminalRegistryState(this.state)),
        };
        await this.#write(() => this.#finishDisbandProjection());
    }
    async #cleanupAfterDisband(idHex) {
        this.#engine.dispose();
        await this.#deliveredHydrated;
        // Retraction decoding still depends on the abandoned branch's nodes.
        if (this.rewindStore)
            await this.#engine.history.flush();
        await this.#persistDelivered();
        await this.lifecycleStore?.removeItem(disbandRequestKey(idHex));
        await this.lifecycleStore?.removeItem(disbandConvergenceKey(idHex));
        await this.#removedMarkerStore?.removeItem(`${idHex}/removed`);
        await this.store.removeItem(idHex);
        await this.#wrapperLedger?.cleanupCompleted();
        await this.#cleanupCompletedRetractions(idHex);
        this.#dirty = false;
    }
    async #cleanupCompletedRetractions(idHex) {
        // Ordinary admission is already closed. An adapter save may have started
        // before selection and still forward after its await; purge only after it
        // settles. Waiting on #localWrites would include this terminal projection
        // (and a send waiting on lifecycle hydration), causing a deadlock.
        await Promise.allSettled([...this.#historyWrites]);
        if (this.#pendingRetractions.size)
            return;
        await this.history?.purgeMessages();
        // The decoder requires the tree; retire evidence before its provenance.
        await this.ingestStateStore?.removeItem(this.#deliveredKey());
        if (this.rewindStore) {
            await GroupHistoryTree.purge(this.rewindStore, idHex);
            await this.rewindStore.removeItem(pendingPublicationKey(idHex));
        }
    }
    async #resumeTerminalWork() {
        if (this.lifecycleStore && !this.#terminalProjectionComplete) {
            try {
                await this.#write(() => this.#finishDisbandProjection());
            }
            catch (error) {
                this.#onHistoryError?.(error);
            }
        }
        await this.#retryRetractions();
        if (this.#terminalProjectionComplete)
            await this.#write(() => this.#cleanupCompletedRetractions(bytesToHex(this.id)));
        return ((await this.#effectLedger?.pending()) ?? []).map((pending) => ({
            ...pending,
            disposition: ingestResultDisposition(pending),
        }));
    }
    /** Releases engine resources (the settle-check timer); call on teardown (B5). */
    dispose() {
        this.#disposed = true;
        this.#clearPublications();
        this.#engine.dispose();
    }
    /** @internal Keep recovery writes inside the owner's destruction and retention barriers. */
    async persistPublication(operation) {
        await this.#write(operation);
        this.assertOutboundOpen();
    }
    /** Restore the gate without making the retained pending state canonical. */
    restorePendingPublication(pending) {
        this.assertOutboundOpen();
        this.#engine.restorePendingPublication(pending);
    }
    confirmPublished(pending) {
        this.assertOpen();
        const historySizeBefore = this.#engine.history.size;
        const notifications = this.#engine.confirmPublished(pending);
        this.#finishPublication(pending);
        if (this.#engine.history.size !== historySizeBefore)
            this.#onHistoryChanged?.();
        return notifications;
    }
    publishFailed(pending) {
        if (this.#destroyed || this.#disposed)
            return;
        this.#engine.publishFailed(pending);
        this.#finishPublication(pending);
    }
    #associatePublication(result) {
        if (!result || !("pending" in result) || !("envelope" in result))
            return;
        const record = this.#pendingPublications.get(result.envelope.id);
        if (record)
            record.pendingState = result.pending;
    }
    #releasePublications(ids) {
        let released = false;
        for (const id of ids)
            released = this.#pendingPublications.delete(id) || released;
        if (released)
            this.#markRetentionPending();
    }
    /** Ownership transfers only after every session preparation step succeeds. */
    async #prepareOutbound(operation, beforeHandoff) {
        const owned = new Map();
        const associate = (result) => {
            if (!result || !("envelope" in result))
                return;
            owned.set(result.envelope.id, "pending" in result ? result.pending : undefined);
            this.#associatePublication(result);
        };
        try {
            const effects = await this.#whileOpen(() => operation(associate));
            this.assertOutboundOpen();
            beforeHandoff?.();
            return effects;
        }
        catch (error) {
            // These exact results were never handed to any publisher. Other sends,
            // returned application retries and sent-content evidence keep ownership.
            try {
                if (!this.#destroyed && !this.#disposed)
                    for (const pending of owned.values())
                        if (pending)
                            this.#engine.publishFailed(pending);
            }
            finally {
                this.#releasePublications(owned.keys());
            }
            throw error;
        }
    }
    #finishPublication(pending) {
        const contentId = pending.commitMessage && contentDedupId(pending.commitMessage);
        for (const [id, record] of this.#pendingPublications)
            if (record.pendingState === pending ||
                (contentId && record.contentId === contentId))
                this.#pendingPublications.delete(id);
        this.#markRetentionPending();
    }
    #registerRetentionOwners() {
        if (this.#destroyed || this.#disposed || this.#terminalTombstone)
            return;
        registerPublicationRetention(this, (eventId) => {
            if (this.#pendingPublications.delete(eventId))
                this.#markRetentionPending();
        });
        registerPublicationPreparationOwner(this.#engine, (ids) => this.#releasePublications(ids));
        registerSettledRetentionOwner(this.#engine, async () => {
            if (this.#destroyed || this.#disposed || this.#terminalTombstone)
                return;
            try {
                await this.save();
            }
            catch (error) {
                this.#onHistoryError?.(error);
            }
        });
    }
    #clearPublications() {
        unregisterPublicationPreparationOwner(this.#engine);
        unregisterSettledRetentionOwner(this.#engine);
        unregisterPublicationRetention(this);
        this.#pendingPublications.clear();
        this.#sentEventIds.clear();
    }
    #markRetentionPending() {
        this.#retentionVersion++;
        this.#retentionPending = true;
    }
    proposalContext() {
        const groupData = this.groupData;
        if (!groupData)
            throw new Error("MarmotGroupData not found in ClientState.");
        return { state: this.state, ciphersuite: this.ciphersuite, groupData };
    }
    async send(intent) {
        await this.#retentionInFlight;
        await this.#assertOutboundMembership();
        const admitted = { ...intent };
        return this.#prepareOutbound((associate) => this.#send(admitted, associate), () => {
            if (admitted.kind === "commit" ||
                admitted.kind === "applicationMessage")
                admitted.signal?.throwIfAborted();
        });
    }
    async #send(intent, associate) {
        await this.#deliveredHydrated;
        this.assertOpen();
        switch (intent.kind) {
            case "applicationMessage": {
                intent.signal?.throwIfAborted();
                if (intent.expectedParent !== undefined &&
                    intent.expectedParent !== this.parentToken)
                    throw new StaleMediaPreparationError();
                const sendResult = await this.#engine.send({
                    kind: "applicationMessage",
                    payload: intent.payload,
                    expectedParent: intent.expectedParent,
                });
                associate(sendResult);
                this.assertOpen();
                if (sendResult.kind !== "applicationMessage") {
                    throw new Error("Expected applicationMessage result from applicationMessage send");
                }
                await this.#saveHistory(intent.payload);
                await this.save(true);
                this.assertOpen();
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
                associate(sendResult);
                this.assertOpen();
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
                associate(sendResult);
                this.assertOpen();
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
                const expectedParent = intent.expectedParent;
                const assertPreparation = (proposals) => {
                    this.assertOpen();
                    intent.signal?.throwIfAborted();
                    if (expectedParent !== undefined &&
                        expectedParent !== this.parentToken)
                        throw new Error("Group canonical parent changed before preparation");
                    const changesImage = proposals.some((proposal) => proposal.proposalType === appDataUpdateProposalType &&
                        "appDataUpdate" in proposal &&
                        proposal.appDataUpdate.componentId ===
                            GROUP_BLOSSOM_IMAGE_COMPONENT_ID);
                    if (expectedParent === undefined && changesImage)
                        throw new Error("Group image commits require expectedParent from session.parentToken");
                    if (changesImage) {
                        if (this.state.groupActiveState.kind === "removedFromGroup" ||
                            !getAdminPolicy(this.state.groupContext.extensions)?.includes(intent.actorPubkey) ||
                            !getGroupMemberPubkeys(this.state).includes(intent.actorPubkey))
                            throw new Error("Only an active group admin can change the Blossom image");
                        if (this.profileSupport.kind !== "supported")
                            throw new Error("Group image mutation requires a supported group profile");
                        if (this.#terminalTombstone || this.lifecycle !== "Stable")
                            throw new Error("Group image mutation requires a stable active lifecycle");
                    }
                };
                assertPreparation([]);
                const sendResult = await this.#engine.send({
                    kind: "commit",
                    actorPubkey: intent.actorPubkey,
                    extraProposals: intent.extraProposals,
                    proposalRefs: intent.proposalRefs,
                }, assertPreparation);
                associate(sendResult);
                if (intent.signal?.aborted) {
                    intent.signal.throwIfAborted();
                }
                this.assertOpen();
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
                            signal: intent.signal,
                        },
                    ],
                };
            }
        }
    }
    /** Persists irreversible terminal intent before returning publish work. */
    async requestDisband() {
        await this.#assertOutboundMembership();
        return this.#prepareOutbound((associate) => this.#requestDisband(associate));
    }
    async #requestDisband(associate) {
        const sendResult = await this.#engine.requestDisband();
        associate(sendResult);
        this.assertOpen();
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
        return this.#whileOpen(() => this.#engine.disbandRequest());
    }
    /** Builds the atomic active+required lifecycle enablement commit. */
    async enableGroupDisbanding() {
        await this.#assertOutboundMembership();
        return this.#prepareOutbound((associate) => this.#enableGroupDisbanding(associate));
    }
    async #enableGroupDisbanding(associate) {
        const sendResult = await this.#engine.enableGroupDisbanding();
        associate(sendResult);
        this.assertOpen();
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
        await this.#assertOutboundMembership();
        return this.#prepareOutbound((associate) => this.#leave(ownPubkey, associate));
    }
    async #leave(ownPubkey, associate) {
        const removeProposals = await proposeLeaveGroup(ownPubkey)(this.proposalContext());
        this.assertOpen();
        const publish = [];
        for (const proposal of removeProposals) {
            const sendResult = await this.#engine.send({
                kind: "proposal",
                proposal,
            });
            associate(sendResult);
            this.assertOpen();
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
        await this.#removalHydrated;
        await this.#deliveredHydrated;
        if (this.#destroyed)
            return;
        if (this.#removalFenced &&
            this.state.groupActiveState.kind !== "removedFromGroup") {
            for (const event of events) {
                const skipped = {
                    kind: "skipped",
                    event,
                    reason: "self-evicted",
                };
                yield { ...skipped, disposition: ingestResultDisposition(skipped) };
            }
            return;
        }
        if (this.#terminalTombstone) {
            for (const pending of await this.#resumeTerminalWork())
                yield pending;
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
        await this.#retryRetractions();
        for (const pending of (await this.#effectLedger?.pending()) ?? [])
            yield { ...pending, disposition: ingestResultDisposition(pending) };
        const selfEcho = [];
        const rest = [];
        const stateHash = bytesToHex(sha256(serializeClientState(this.state)));
        for (const event of events) {
            if (this.#destroyed)
                return;
            if (await this.#wrapperLedger?.get(event.id, stateHash))
                continue;
            const sent = this.#sentEventIds.get(event.id);
            if (sent) {
                this.#sentEventIds.delete(event.id);
                selfEcho.push({ event, stateTag: sent.stateTag });
            }
            else {
                await this.#write(() => this.#wrapperLedger?.begin(event.id, stateHash));
                rest.push(event);
            }
        }
        for (const { event, stateTag } of selfEcho) {
            if (this.#destroyed)
                return;
            const source = await this.historyTree.stateAt(stateTag);
            const peeled = await this.#peeler.peelGroupMessages([event], source ?? this.state);
            const message = peeled.read[0]?.message;
            if (message) {
                const skipped = {
                    kind: "skipped",
                    event,
                    message,
                    reason: "self-echo",
                };
                const disposition = ingestResultDisposition(skipped);
                await this.#write(() => this.#wrapperLedger?.record(event.id, "stale", this.#wrapperCoordinate(message)));
                if (this.#destroyed)
                    return;
                yield { ...skipped, disposition };
            }
        }
        for await (const result of this.#engine.ingest(rest, options)) {
            if (this.#destroyed)
                return;
            const mapped = mapEngineIngestResult(result);
            if (mapped.kind === "removed" && mapped.removalAttribution) {
                await this.#persistRemovalEvidence({
                    ...mapped.removalAttribution,
                    notificationState: "pending",
                });
            }
            if (mapped.kind === "processed")
                await this.#persistSelectedDisbandIfPossible(mapped.selectedTerminal);
            if (mapped.kind === "processed" &&
                mapped.result.kind === "applicationMessage") {
                await this.#saveHistory(mapped.result.message);
            }
            if (this.#destroyed)
                return;
            const reconciledResults = await this.#reconcile(mapped);
            const retryableUnreadable = mapped.kind === "unreadable" && mapped.decryptFailure === true;
            const terminal = "event" in mapped &&
                mapped.disposition.kind !== "deferred" &&
                !retryableUnreadable;
            // A live terminal fence is not a durable projection. Do not let wrapper
            // dedup suppress replay if the first recoverable terminal write failed.
            if (terminal &&
                (!this.#terminalTombstone || this.#terminalProjectionComplete)) {
                const outcome = mapped.disposition.kind === "accepted"
                    ? "accepted"
                    : mapped.disposition.kind === "invalidated"
                        ? "invalidated"
                        : "stale";
                await this.#write(() => this.#wrapperLedger?.stageApplied(mapped.event.id, stateHash, bytesToHex(sha256(serializeClientState(this.state))), outcome));
                // Canonical state and fork material must be durable before terminal
                // wrapper evidence can suppress replay after a crash.
                await this.save(true);
                await this.#write(() => this.#wrapperLedger?.record(mapped.event.id, outcome, this.#wrapperCoordinate("message" in mapped ? mapped.message : undefined)));
            }
            if (this.#destroyed)
                return;
            if (mapped.kind === "processed" &&
                mapped.result.kind === "applicationMessage")
                this.#onApplicationMessage?.(mapped.result.message);
            for (const reconciled of reconciledResults)
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
        if (this.#destroyed)
            return [];
        if (result.kind === "invalidated") {
            try {
                if (!result.payload || result.epoch === undefined || !result.tag)
                    throw new Error("Invalidation lacks delivered payload evidence");
                const rumorId = deserializeApplicationData(result.payload).id.toLowerCase();
                if (result.rumorId !== undefined && result.rumorId !== rumorId)
                    throw new Error("Invalidation rumor identity mismatch");
                const entry = {
                    epoch: result.epoch,
                    stateTag: result.tag,
                    envelope: result.event,
                    message: result.message,
                    payload: result.payload,
                    rumorId,
                    transportId: result.event.id,
                    commitDigest: result.commitDigest,
                };
                this.#pendingRetractions.set(result.event.id, entry);
                await this.#persistDelivered();
                await this.#retryRetractions();
            }
            catch (error) {
                this.#onHistoryError?.(error);
            }
        }
        if (!this.#effectLedger)
            return [result];
        if (result.kind === "stateInvalidated") {
            return (await this.#write(() => this.#effectLedger.prepareWithdrawal(result.commitDigest, result.forkEpoch, result.withdrawn)))
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
            if (await this.#write(() => this.#effectLedger.prepareAdoption(digest, group)))
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
        await this.#retentionInFlight;
        await this.#write(() => this.#effectLedger?.acknowledge(result.commitDigest, result.kind === "stateInvalidated" ? "withdrawal" : "adoption"));
        this.#markRetentionPending();
    }
    #deliveredKey() {
        return `${bytesToHex(this.id)}/delivered-payloads/v1`;
    }
    #wrapperCoordinate(message) {
        const epoch = message && framedEpoch(message);
        if (epoch !== undefined &&
            Number.isSafeInteger(Number(epoch)) &&
            epoch >= 0n)
            return { sourceEpoch: Number(epoch) };
        return { completedAtEpoch: Number(this.state.groupContext.epoch) };
    }
    async #hydrateDelivered() {
        // Without persisted fork nodes there is no restart rewind authority to
        // validate historical branch provenance against. Keep session-only evidence.
        if (!this.rewindStore)
            return;
        const bytes = await this.ingestStateStore?.getItem(this.#deliveredKey());
        if (this.#destroyed || this.#disposed)
            return;
        if (!bytes)
            return; // Older clients have no attributable pre-migration deliveries.
        const evidence = decodeDeliveredEvidence(bytes, this.#engine.history);
        this.#engine.importDeliveredPayloads(evidence.entries);
        for (const entry of evidence.pending)
            this.#pendingRetractions.set(entry.transportId, entry);
    }
    async #retryRetractions() {
        await this.#retentionInFlight;
        if (this.#destroyed)
            return;
        // Restoring a failed acknowledgement must wait for the next retry pass;
        // a live Map iterator would revisit reinserted entries indefinitely.
        for (const [id, entry] of [...this.#pendingRetractions]) {
            try {
                // Transport deliveries can share one inner rumor. A losing envelope
                // withdraws only its own support; retain (or restore) the history row
                // while any surviving delivery still supports that canonical identity.
                const surviving = this.#engine
                    .exportDeliveredPayloads()
                    .find((delivery) => delivery.rumorId === entry.rumorId);
                if (surviving)
                    await this.#writeHistory(() => this.history?.saveMessage(surviving.payload), false);
                else
                    await this.#writeHistory(() => this.history?.removeMessage(entry.rumorId), false);
                if (this.#destroyed)
                    return;
                this.#pendingRetractions.delete(id);
                this.#markRetentionPending();
                try {
                    await this.#persistDelivered();
                }
                catch (error) {
                    if (!this.#destroyed)
                        this.#pendingRetractions.set(id, entry);
                    throw error;
                }
                this.#onHistoryChanged?.();
            }
            catch (error) {
                this.#onHistoryError?.(error);
            }
        }
    }
    async #persistDelivered() {
        await this.#retentionInFlight;
        if (this.#destroyed)
            return;
        // Rewinds remove the entire batch before yielding individual results. Move
        // every obligation to the durable outbox before any canonical state save
        // or history removal can discard the abandoned delivery evidence.
        const invalidated = this.#engine.exportInvalidatedPayloads();
        for (const entry of invalidated)
            if (entry.rumorId && entry.transportId)
                this.#pendingRetractions.set(entry.transportId, entry);
        await this.#write(() => this.ingestStateStore?.setItem(this.#deliveredKey(), encodeDeliveredEvidence({
            entries: this.#engine
                .exportDeliveredPayloads()
                .filter((entry) => !!entry.rumorId),
            pending: [...this.#pendingRetractions.values()],
        })));
        this.#engine.acknowledgeInvalidatedPayloads(invalidated);
    }
    async #saveHistory(message) {
        if (!this.history || this.#destroyed)
            return;
        try {
            await this.#writeHistory(() => this.history.saveMessage(message));
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
