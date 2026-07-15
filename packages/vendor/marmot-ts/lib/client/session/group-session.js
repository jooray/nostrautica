import { bytesToHex } from "@noble/hashes/utils.js";
import { getMarmotGroupView, serializeClientState, } from "../../core/client-state.js";
import { MarmotGroupEngine } from "../../engine/group-engine.js";
import { GroupHistoryTree } from "../../engine/history-tree.js";
import { ingestResultDisposition as engineIngestResultDisposition } from "../../engine/ingest-disposition.js";
import { NostrGroupPeeler } from "../group/nostr-peeler.js";
import { proposeLeaveGroup } from "../group/proposals/leave-group.js";
export function ingestResultDisposition(result) {
    const { event, ...rest } = result;
    return engineIngestResultDisposition({
        ...rest,
        envelope: event,
    });
}
function mapEngineIngestResult(result) {
    const { envelope, disposition, ...rest } = result;
    return { ...rest, event: envelope, disposition };
}
export class GroupSession {
    ciphersuite;
    store;
    rewindStore;
    history;
    #engine;
    #peeler;
    #sentEventIds = new Set();
    #groupData = null;
    #dirty = false;
    #onStateChanged;
    #onStateSaved;
    #onApplicationMessage;
    #onHistoryError;
    constructor(options) {
        this.ciphersuite = options.ciphersuite;
        this.store = options.store;
        this.rewindStore = options.rewindStore;
        this.history = options.history;
        this.#onStateChanged = options.onStateChanged;
        this.#onStateSaved = options.onStateSaved;
        this.#onApplicationMessage = options.onApplicationMessage;
        this.#onHistoryError = options.onHistoryError;
        this.#peeler = new NostrGroupPeeler(this.ciphersuite);
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
    get unappliedProposals() {
        return this.state.unappliedProposals;
    }
    get dirty() {
        return this.#dirty;
    }
    async save(force = false) {
        // The history tree can grow without the canonical state changing — a fork
        // whose incoming branch is superseded still records the losing branch — so
        // a dirty tree must trigger a save even when `#dirty` (state-changed) is not.
        const treeDirty = !!this.rewindStore && this.#engine.history.isDirty;
        if (!force && !this.#dirty && !treeDirty)
            return;
        const idHex = bytesToHex(this.id);
        const stateBytes = serializeClientState(this.state);
        await this.store.setItem(idHex, stateBytes);
        // Persist the full-fork history tree — the single source for fork recovery
        // across restarts. Append-only flush of any new nodes (O(new nodes)). The
        // bounded convergence window is rebuilt from the tree on load.
        if (this.rewindStore)
            await this.#engine.history.flush();
        this.#dirty = false;
        this.#onStateSaved?.();
    }
    async destroyLocalState() {
        await this.history?.purgeMessages();
        const idHex = bytesToHex(this.id);
        await this.store.removeItem(idHex);
        await this.rewindStore?.removeItem(idHex);
        if (this.rewindStore)
            await GroupHistoryTree.purge(this.rewindStore, idHex);
    }
    /** Releases engine resources (the settle-check timer); call on teardown (B5). */
    dispose() {
        this.#engine.dispose();
    }
    confirmPublished(pending) {
        this.#engine.confirmPublished(pending);
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
        const selfEcho = [];
        const rest = [];
        for (const event of events) {
            if (this.#sentEventIds.delete(event.id))
                selfEcho.push(event);
            else
                rest.push(event);
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
                yield { ...skipped, disposition: ingestResultDisposition(skipped) };
            }
        }
        for await (const result of this.#engine.ingest(rest, options)) {
            const mapped = mapEngineIngestResult(result);
            if (mapped.kind === "processed" &&
                mapped.result.kind === "applicationMessage") {
                await this.#saveHistory(mapped.result.message);
                this.#onApplicationMessage?.(mapped.result.message);
            }
            yield mapped;
        }
        await this.save();
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
//# sourceMappingURL=group-session.js.map