import { bytesToHex } from "@noble/hashes/utils.js";
import { ciphersuites, defaultCryptoProvider, } from "../vendor/ts-mls/index.js";
import { GroupHistoryTree } from "../engine/history-tree.js";
import { MarmotGroupEngine } from "../engine/group-engine.js";
import { RetainedHistoryStore } from "../engine/retained-store.js";
import { createCredential } from "../core/credential.js";
import { createSimpleGroup } from "../core/group.js";
import { generateKeyPackage } from "../core/key-package.js";
import { MarmotGroup, } from "./group/marmot-group.js";
import { createInviteIntent } from "./group/invite.js";
import { NostrGroupPeeler } from "./group/nostr-peeler.js";
import { defaultVerifyEvent } from "./verify.js";
import { isValidRelayUrl } from "../utils/relay-url.js";
/**
 * Builds new {@link MarmotGroup} instances. Isolates the identity signer and
 * the ciphersuite implementation — i.e. the native-sensitive group-creation
 * seam (darkmatter's `do_create_group`). The factory only constructs and
 * persists; caching/eventing is the registry's job.
 */
export class GroupFactory {
    #store;
    #ingestStateStore;
    #lifecycleStore;
    #rewindStore;
    #removedMarkerStore;
    #signer;
    #network;
    #audit;
    #auditContext;
    #cryptoProvider;
    #historyFactory;
    #mediaFactory;
    #convergencePolicy;
    #ingestionPool;
    #verifyEvent;
    constructor(options) {
        this.#store = options.store;
        this.#ingestStateStore = options.ingestStateStore;
        this.#lifecycleStore = options.lifecycleStore;
        this.#rewindStore = options.rewindStore;
        this.#removedMarkerStore = options.removedMarkerStore;
        this.#convergencePolicy = options.convergencePolicy;
        this.#ingestionPool = options.ingestionPool;
        this.#signer = options.signer;
        this.#network = options.network;
        this.#audit = options.audit;
        this.#auditContext = options.auditContext;
        this.#cryptoProvider = options.cryptoProvider ?? defaultCryptoProvider;
        this.#historyFactory =
            options.historyFactory;
        this.#mediaFactory = options.mediaFactory;
        this.#verifyEvent = options.verifyEvent ?? defaultVerifyEvent;
    }
    /** Resolves a ciphersuite implementation from a name (defaults to X25519/AES128). */
    async #getCiphersuiteImpl(name) {
        const ciphersuiteName = name ?? "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519";
        const id = ciphersuites[ciphersuiteName];
        return await this.#cryptoProvider.getCiphersuiteImpl(id);
    }
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
    async create(name, options) {
        assertFoundingInviteeRelays(options?.invitees, options?.relays);
        const ciphersuiteImpl = await this.#getCiphersuiteImpl(options?.ciphersuite);
        const pubkey = await this.#signer.getPublicKey();
        const credential = await createCredential(pubkey);
        const keyPackage = await generateKeyPackage({
            credential,
            ciphersuiteImpl,
            signer: this.#signer,
        });
        const { clientState } = await createSimpleGroup(keyPackage, ciphersuiteImpl, name, {
            ...options,
            adminPubkeys: [...new Set([pubkey, ...(options?.adminPubkeys || [])])],
        });
        const invitees = options?.invitees;
        const founding = invitees && invitees.length > 0
            ? await this.#createFounding(pubkey, ciphersuiteImpl, clientState, invitees)
            : undefined;
        const group = new MarmotGroup(founding?.state ?? clientState, {
            ciphersuite: ciphersuiteImpl,
            store: this.#store,
            ingestStateStore: this.#ingestStateStore,
            lifecycleStore: this.#lifecycleStore,
            rewindStore: this.#rewindStore,
            removedMarkerStore: this.#removedMarkerStore,
            convergencePolicy: this.#convergencePolicy,
            ingestionPool: this.#ingestionPool,
            signer: this.#signer,
            network: this.#network,
            audit: this.#audit,
            auditContext: this.#auditContext,
            history: this.#historyFactory,
            media: this.#mediaFactory,
            retained: founding?.retained,
            historyTree: founding?.historyTree,
        });
        // GroupSession only binds a tree it created itself (its own fresh
        // GroupHistoryTree) — a supplied tree must be bound here before saving,
        // or save()'s history.flush() would throw.
        if (founding && this.#rewindStore)
            founding.historyTree.bindStore(this.#rewindStore);
        await group.save(true);
        // D-05/D-07/D-12: fan out directly, bypassing GroupRuntime entirely — no
        // GroupPublishWork, no GroupEffects, no GroupRuntime publish call. Never
        // throws on partial or total Welcome failure: the group exists at epoch
        // 1 with all N members either way, and failures sit in
        // group.pendingWelcomes for retry.
        if (founding) {
            await group.deliverFoundingWelcomes({
                welcome: founding.welcome,
                author: pubkey,
                recipients: founding.recipients,
            });
        }
        return group;
    }
    /**
     * The founding orchestration (D-01/D-02/D-03/D-11/D-13): admits every
     * invitee through the unchanged invite trust boundary, merges one founding
     * Add commit locally with no yield before confirmation, and asserts the
     * resulting Welcome's shape before any persistence or delivery. Returns
     * the canonical epoch-1 state plus the convergence structures and Welcome
     * material `create()` needs — it performs no persistence and no delivery
     * itself.
     */
    async #createFounding(pubkey, ciphersuiteImpl, epochZeroState, invitees) {
        // D-13 (pre-burn): reject a duplicate invitee before any KeyPackage
        // material is consumed, before any commit is built. The realistic
        // trigger is the same invitee's KeyPackage passed twice.
        const seenPubkeys = new Set();
        const seenEventIds = new Set();
        for (const event of invitees) {
            if (seenPubkeys.has(event.pubkey) || seenEventIds.has(event.id)) {
                throw new Error(`GroupFactory.create: duplicate founding invitee ${event.pubkey}`);
            }
            seenPubkeys.add(event.pubkey);
            seenEventIds.add(event.id);
        }
        // D-11: admit each invitee through the unchanged invite trust boundary —
        // zero new trust-boundary code, so the founding path cannot drift from
        // SEC-01/WIRE-01/WIRE-02 and the credential-identity-equals-author gate.
        // Only the single Add proposal and single Welcome recipient of each
        // resulting commit intent are kept; the rest of the intent is discarded.
        const extraProposals = [];
        const recipients = [];
        for (const keyPackageEvent of invitees) {
            const intent = createInviteIntent({
                keyPackageEvent,
                actorPubkey: pubkey,
                verifyEvent: this.#verifyEvent,
            });
            extraProposals.push(intent.extraProposals[0]);
            recipients.push(intent.welcomeRecipients[0]);
        }
        // A short-lived engine over the epoch-0 state. Its retained store and
        // history tree are handed to the caller so they can be passed straight
        // into the constructed MarmotGroup, letting the founding commit's CR-09
        // records (retained history + fork tree) survive into the group's own
        // engine. This second engine emits its own engine-start audit context
        // for the same group id — an accepted consequence of D-05's bypass.
        const peeler = new NostrGroupPeeler(ciphersuiteImpl);
        const retained = new RetainedHistoryStore(epochZeroState, this.#convergencePolicy);
        const historyTree = new GroupHistoryTree(epochZeroState);
        const engine = new MarmotGroupEngine({
            state: epochZeroState,
            ciphersuite: ciphersuiteImpl,
            peeler,
            retained,
            historyTree,
            convergencePolicy: this.#convergencePolicy,
            ingestionPool: this.#ingestionPool,
            audit: this.#audit,
            auditContext: this.#auditContext,
        });
        // D-01/D-02: stage and merge with nothing in between — no await, no
        // logging, no persistence, no group construction. This invariant is
        // enforced by convention, not by signature (R-01); any inserted await
        // here widens a real observable PendingPublish window.
        const result = await engine.send({
            kind: "foundingAdd",
            actorPubkey: pubkey,
            extraProposals,
        });
        if (result.kind !== "foundingGroupCreated") {
            throw new Error(`GroupFactory.create: expected a founding-create send result, got ${result.kind}`);
        }
        engine.confirmPublished(result.pending);
        // D-13 (pre-delivery): assert exactly one distinct Welcome secret per
        // invitee before any persistence or delivery attempt, mirroring MDK's
        // guard. Synchronous, so it introduces no new yield point — if it
        // throws, nothing has been persisted (D-03) and no group was ever
        // constructed.
        assertOneWelcomeSecretPerInvitee(result.welcome.welcome, invitees.length);
        return {
            state: engine.state,
            retained,
            historyTree,
            welcome: result.welcome.welcome,
            recipients,
        };
    }
}
/**
 * CR-01 (10-VERIFICATION.md, supersedes D-09): the base refusal message for
 * a founding create whose invitees cannot possibly receive a Welcome.
 * `createWelcomeRumor()` (`src/core/welcome-event.ts`) throws unconditionally
 * for every recipient when the group's relay list is empty, and a group with
 * no `transport.nostr.routing` component (only pushed when `relays.length >
 * 0`, see `src/core/group.ts`) can never publish afterwards — so a relay-less
 * founding create can only ever produce a permanently unusable group with
 * phantom members. Declared once and referenced at both throw sites below so
 * the literal appears exactly once in this file.
 */
const FOUNDING_RELAYS_REQUIRED = "GroupFactory.create: founding invitees require a non-empty list of valid group relays (every Welcome rumor must carry a relays tag, and a relay-less group can never publish)";
/**
 * CR-01 (10-VERIFICATION.md, supersedes D-09): fails closed, before any key
 * material is generated, any MLS state is built, or any store is written,
 * when `invitees` is non-empty and `relays` is absent, empty, or contains an
 * invalid (non-ws/wss, empty, or unparseable) relay URL. A solo create
 * (`invitees` undefined or empty) is unaffected — this mirrors the existing
 * founding condition `invitees && invitees.length > 0` in `create()`.
 * Duplicate relays are deliberately NOT rejected here: `encodeNostrRoutingV1`
 * already dedupes them (`src/core/components/nostr-routing.ts`) and
 * `MarmotGroup.relays` is read back from that deduped component, so
 * duplicates cannot cause the Welcome failure this guard exists to prevent.
 */
function assertFoundingInviteeRelays(invitees, relays) {
    if (!invitees || invitees.length === 0)
        return;
    if (!relays || relays.length === 0) {
        throw new Error(FOUNDING_RELAYS_REQUIRED);
    }
    for (const relay of relays) {
        if (!isValidRelayUrl(relay)) {
            throw new Error(`${FOUNDING_RELAYS_REQUIRED} — invalid relay: ${JSON.stringify(relay)}`);
        }
    }
}
/**
 * D-13 (post-confirm, pre-delivery): asserts the founding Welcome carries
 * exactly one distinct secret per invitee, mirroring MDK's `do_create_group`
 * guard (refs/mdk/crates/cgka-engine/src/group_lifecycle.rs). Catches a
 * ts-mls behaviour change or a duplicate-KeyPackage invitee list at the one
 * point where it is cheap — before KeyPackage material is burned.
 */
function assertOneWelcomeSecretPerInvitee(welcome, inviteeCount) {
    if (welcome.secrets.length !== inviteeCount) {
        throw new Error(`GroupFactory.create: founding creation did not produce one distinct Welcome per invitee (expected ${inviteeCount} secrets, got ${welcome.secrets.length})`);
    }
    const distinctMembers = new Set(welcome.secrets.map((secret) => bytesToHex(secret.newMember)));
    if (distinctMembers.size !== inviteeCount) {
        throw new Error("GroupFactory.create: founding creation did not produce one distinct Welcome per invitee (duplicate newMember reference)");
    }
}
