/** @module @category Client - Marmot Client */
import { isRumor } from "applesauce-common/helpers/gift-wrap";
import { defaultCryptoProvider, } from "ts-mls";
import { getMarmotGroupView, } from "../core/client-state.js";
import { defaultCapabilities } from "../core/default-capabilities.js";
import { getWelcome, getWelcomeGroupRelays, getWelcomeKeyPackageEventId, getWelcomeKeyPackageRefs, readWelcomeGroupInfo, } from "../core/welcome.js";
import { logger } from "../utils/debug.js";
import { GroupsManager } from "./groups-manager.js";
import { InviteManager, } from "./invite-manager.js";
import { KeyPackageManager } from "./key-package-manager.js";
import { InMemoryKeyValueStore } from "../extra/in-memory-key-value-store.js";
const log = logger.extend("client");
export class MarmotClient {
    /** The signer used for the clients identity */
    signer;
    /** The capabilities to use for the client */
    capabilities;
    /** The nostr relay pool to use for the client */
    network;
    /** Manages key package lifecycle: local storage, publishing, and rotation */
    keyPackages;
    /** Manages group lifecycle: persistence, caching, creation, loading, leaving */
    groups;
    /** Manages invite lifecycle: ingestion, decryption, and storage */
    invites;
    /** Crypto provider for cryptographic operations */
    cryptoProvider;
    constructor(options) {
        this.signer = options.signer;
        this.capabilities = options.capabilities ?? defaultCapabilities();
        this.network = options.network;
        this.cryptoProvider = options.cryptoProvider ?? defaultCryptoProvider;
        this.keyPackages = new KeyPackageManager({
            store: options.keyPackageStore,
            signer: options.signer,
            accountProofSigner: options.accountProofSigner,
            network: options.network,
            clientId: options.clientId,
        });
        const historyFactory = ("historyFactory" in options ? options.historyFactory : undefined);
        const mediaFactory = ("mediaFactory" in options ? options.mediaFactory : undefined);
        this.groups = new GroupsManager({
            store: options.groupStateStore,
            rewindStore: options.rewindStore,
            convergencePolicy: options.convergencePolicy,
            ingestionPool: options.ingestionPool,
            signer: this.signer,
            accountProofSigner: options.accountProofSigner,
            network: this.network,
            audit: options.audit,
            auditContext: options.auditContext,
            cryptoProvider: this.cryptoProvider,
            historyFactory,
            mediaFactory,
        });
        this.invites = new InviteManager({
            signer: this.signer,
            store: options.inviteStore || new InMemoryKeyValueStore(),
            network: this.network,
        });
    }
    // ---------------------------------------------------------------------------
    // Welcome / invite flows
    //
    // These are higher-level methods that combine key package lookup with
    // MLS join logic. They delegate group persistence/caching to `this.groups`.
    // ---------------------------------------------------------------------------
    /**
     * Reads the {@link GroupInfo} from a Welcome rumor without joining the group.
     *
     * Finds the local key package that matches one of the welcome's recipient slots,
     * then decrypts the group info using that key package. Useful for previewing
     * group metadata (name, relays, admins) before deciding to join.
     *
     * @param welcomeRumor - The decrypted kind 444 welcome rumor
     * @returns The decrypted GroupInfo, or null if no matching key package is found or decryption fails
     */
    async readInviteGroupInfo(welcomeRumor) {
        const welcome = isRumor(welcomeRumor)
            ? getWelcome(welcomeRumor)
            : welcomeRumor;
        // Reuse the same candidate selection as joinGroupFromWelcome (ref matches
        // first), then try decrypting the group info with each until one succeeds.
        const candidates = await this.keyPackages.selectForWelcome(welcome);
        for (const candidate of candidates) {
            try {
                const ciphersuiteImpl = await this.cryptoProvider.getCiphersuiteImpl(candidate.publicPackage.cipherSuite);
                return await readWelcomeGroupInfo({
                    welcome,
                    keyPackage: candidate,
                    ciphersuiteImpl,
                });
            }
            catch {
                // Ignore error, try other key packages
            }
        }
        return null;
    }
    /**
     * Whether we still hold the private KeyPackage a Welcome is addressed to —
     * i.e. whether {@link joinGroupFromWelcome} can succeed for this invite.
     * Accepting an invite whose KeyPackage we no longer hold (e.g. it rotated
     * away) would fail with "No matching KeyPackage found". Never throws: an
     * unparseable Welcome yields `false`.
     */
    async canJoinInvite(invite) {
        try {
            for (const ref of getWelcomeKeyPackageRefs(invite)) {
                if (await this.keyPackages.has(ref))
                    return true;
            }
            return false;
        }
        catch {
            return false;
        }
    }
    /**
     * Decodes everything showable about an invite *before* committing to join.
     * Rumor-level fields (relays, KeyPackage event id, cipher suite, recipient
     * count) decode without key material; the `group` block requires decrypting
     * the Welcome with a held KeyPackage via {@link readInviteGroupInfo} and is
     * null when we don't hold it. Never throws — a malformed Welcome or failed
     * preview just yields the fields it could read.
     */
    async previewWelcome(invite) {
        const preview = {
            relays: getWelcomeGroupRelays(invite),
            keyPackageEventId: getWelcomeKeyPackageEventId(invite),
            group: null,
        };
        try {
            const welcome = getWelcome(invite);
            preview.cipherSuite = welcome.cipherSuite;
            preview.recipientCount = welcome.secrets.length;
        }
        catch {
            // Unparseable Welcome — leave the MLS-struct fields undefined.
        }
        try {
            const groupInfo = await this.readInviteGroupInfo(invite);
            if (groupInfo) {
                preview.epoch = groupInfo.groupContext.epoch;
                const view = getMarmotGroupView(groupInfo);
                if (view) {
                    preview.group = {
                        name: view.name,
                        description: view.description,
                        adminPubkeys: view.adminPubkeys,
                        relays: view.relays,
                    };
                }
            }
        }
        catch {
            // Best-effort preview; keep the rumor-level fields already decoded.
        }
        return preview;
    }
    /**
     * Like {@link InviteManager.watchUnread}, but annotates each invite with
     * whether it's {@link canJoinInvite | joinable}. Lets an app default to showing
     * only acceptable invites while still being able to reveal the rest.
     */
    async *watchInvites() {
        for await (const invites of this.invites.watchUnread()) {
            const joinable = await Promise.all(invites.map((invite) => this.canJoinInvite(invite)));
            yield invites.map((invite, index) => ({
                invite,
                joinable: joinable[index],
            }));
        }
    }
    /**
     * Joins a group from a Welcome message received via NIP-59 gift wrap.
     *
     * This method:
     * 1. Decodes the Welcome message from the kind 444 event
     * 2. Finds the matching local KeyPackage private material from the store
     * 3. Calls ts-mls joinGroup() to create a new ClientState
     * 4. Persists the resulting ClientState via `this.groups.adoptClientState()`
     * 5. Marks the consumed key package as used via `this.keyPackages.markUsed()`
     * 6. Returns a MarmotGroup instance
     *
     * After joining, callers can list used key packages with
     * `(await client.keyPackages.list()).filter(p => p.used)` and rotate them
     * via `client.keyPackages.rotate(ref)` to publish fresh ones to relays.
     *
     * @returns Promise resolving to the joined group
     * @throws Error if no matching KeyPackage is found or if joining fails
     */
    async joinGroupFromWelcome(options) {
        const { welcomeRumor } = options;
        log("joining group from welcome rumor %s", welcomeRumor.id);
        const welcome = getWelcome(welcomeRumor);
        // ts-mls v2: welcome.cipherSuite is a numeric CiphersuiteId
        const ciphersuiteImpl = await this.cryptoProvider.getCiphersuiteImpl(welcome.cipherSuite);
        // Candidate selection (KeyPackageRef matching) lives in the key-package
        // layer; the MLS join + leaf-proof validation + persistence live in the
        // group layer — mirroring darkmatter's engine `do_join_welcome` rather than
        // doing protocol matching here in the composition root.
        const candidates = await this.keyPackages.selectForWelcome(welcome);
        const { group, consumedKeyPackageRef } = await this.groups.joinFromWelcome({
            welcome,
            candidates,
            ciphersuiteImpl,
        });
        // Mark the consumed key package as used. Callers can later list used packages
        // with (await client.keyPackages.list()).filter(p => p.used) and rotate them
        // via client.keyPackages.rotate(ref) to publish fresh ones to relays.
        if (consumedKeyPackageRef) {
            await this.keyPackages.markUsed(consumedKeyPackageRef);
        }
        log("joined group %s", group.idStr);
        // MIP-02 SHOULD: callers are responsible for calling group.selfUpdate() after
        // joining to rotate leaf key material for forward secrecy. Doing it automatically
        // here caused the joining member to fork off to a new epoch before other members
        // could ingest the commit.
        return { group };
    }
}
//# sourceMappingURL=marmot-client.js.map