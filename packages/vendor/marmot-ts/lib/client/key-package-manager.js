/** @module @category Client - Key Package Manager */
import { bytesToHex } from "@noble/hashes/utils.js";
import { EventEmitter } from "eventemitter3";
import { getKeyPackageReference, getKeyPackageRelays, } from "../core/key-package-event.js";
import { ADDRESSABLE_KEY_PACKAGE_KIND } from "../core/protocol.js";
import { logger } from "../utils/debug.js";
import { KeyPackageNotFoundError, KeyPackageRotatePreconditionError, MissingRelayError, MissingSlotIdentifierError, } from "./key-package-errors.js";
import { KeyPackagePublisher } from "./key-package-publisher.js";
import { KeyPackageStore, } from "./key-package-store.js";
// Re-export the storage entry types and errors from their dedicated modules so
// existing imports from this module keep working.
export { KeyPackageNotFoundError, KeyPackageRotatePreconditionError, MissingRelayError, MissingSlotIdentifierError, } from "./key-package-errors.js";
export { KeyPackageStore, } from "./key-package-store.js";
export { KeyPackagePublisher, } from "./key-package-publisher.js";
/**
 * Manages the full lifecycle of MLS key packages — local private material and
 * the Nostr kind-30443 events that advertise this client to potential inviters.
 *
 * A thin coordinator over a {@link KeyPackageStore} (persistence) and a
 * {@link KeyPackagePublisher} (the sign/publish boundary).
 */
export class KeyPackageManager extends EventEmitter {
    /**
     * Default slot identifier (`d` tag value) used by {@link create} when no
     * explicit `d` is passed in options. Set this to a stable string (e.g.
     * `"my-app-desktop"`) so all key packages from this manager share a single
     * addressable slot on relays.
     */
    clientId;
    #store;
    #publisher;
    #log = logger.extend("KeyPackageManager");
    constructor(options) {
        super();
        this.clientId = options.clientId;
        this.#store = new KeyPackageStore(options.store, options.cryptoProvider);
        this.#publisher = new KeyPackagePublisher({
            signer: options.signer,
            network: options.network,
            accountProofSigner: options.accountProofSigner,
            cryptoProvider: options.cryptoProvider,
        });
        // Re-emit storage lifecycle events so the manager's public event surface is
        // unchanged by the internal split.
        this.#store.on("added", (keyPackage) => this.emit("added", keyPackage));
        this.#store.on("removed", (ref) => this.emit("removed", ref));
        this.#store.on("updated", (keyPackage) => this.emit("updated", keyPackage));
    }
    // ---------------------------------------------------------------------------
    // Creation and publishing
    // ---------------------------------------------------------------------------
    /**
     * Adds a {@link LocalKeyPackage} to local storage. Delegates to
     * {@link KeyPackageStore.add}.
     *
     * @returns The storage key (hex ref string)
     */
    async add(keyPackage) {
        return this.#store.add(keyPackage);
    }
    /**
     * Creates a new key package, stores the private material locally, signs and
     * publishes a kind 30443 addressable event to the specified relays, and
     * records the event.
     *
     * The `d` (slot identifier) is resolved in order:
     * 1. `options.identifier` (explicit)
     * 2. `this.clientId` (manager default)
     * 3. Throws {@link MissingSlotIdentifierError}
     *
     * @param options - Creation options, including required relay URLs
     * @returns The stored key package (without private material)
     * @throws {MissingRelayError} if relays is empty
     * @throws {MissingSlotIdentifierError} if no slot identifier can be determined
     */
    async create(options) {
        if (!options.relays || options.relays.length === 0) {
            throw new MissingRelayError();
        }
        const identifier = options.identifier ?? this.clientId;
        if (!identifier) {
            throw new MissingSlotIdentifierError();
        }
        this.#log("creating key package on relays: %O", options.relays);
        const keyPackage = await this.#publisher.generate({
            ciphersuite: options.ciphersuite,
            isLastResort: options.isLastResort,
        });
        // Store private material locally, including the slot identifier
        const refHex = await this.#store.add({ ...keyPackage, identifier });
        // Build, sign and publish the kind 30443 event
        const signed = await this.#publisher.publish({
            keyPackage: keyPackage.publicPackage,
            identifier,
            relays: options.relays,
            client: options.client,
            protected: options.protected,
        });
        // Record the published event on the stored entry
        await this.#store.addPublished(refHex, signed);
        const stored = await this.#store.get(refHex);
        if (!stored)
            throw new Error("Key package not found after store operation");
        this.emit("published", refHex, signed.id, options.relays);
        this.#log("created and published key package %s with slot %s", refHex, identifier);
        return {
            keyPackageRef: stored.keyPackageRef,
            publicPackage: stored.publicPackage,
            identifier: stored.identifier,
        };
    }
    /**
     * Ensures this client has at least one unused KeyPackage published, so peers
     * can always invite it. A no-op (returning the existing unused KeyPackage)
     * when one already exists; otherwise creates and publishes a fresh one to
     * `options.relays` via {@link create}. Idempotent — safe to call on every
     * startup.
     *
     * @returns The existing unused KeyPackage, or the freshly created one.
     */
    async ensurePublished(options) {
        const existing = await this.list();
        const unused = existing.find((pkg) => !pkg.used);
        if (unused)
            return unused;
        return this.create(options);
    }
    // ---------------------------------------------------------------------------
    // Rotation
    // ---------------------------------------------------------------------------
    /**
     * Rotates a key package: publishes a new kind 30443 event (reusing the same
     * `d` slot so relays replace the old event automatically), then removes the
     * old private key material.
     *
     * Kind-30443 published events do not need explicit deletion — the new event
     * supersedes them on relays.
     *
     * @param ref - The key package reference of the key package to rotate
     * @param options - Options for the new key package
     * @returns The new stored key package (without private material)
     * @throws {KeyPackageNotFoundError} if the key package ref is not found in the local store
     * @throws {KeyPackageRotatePreconditionError} if no relay URLs can be determined for the new key package
     */
    async rotate(ref, options) {
        const refHex = typeof ref === "string" ? ref : bytesToHex(ref);
        this.#log("rotating key package %s", refHex);
        const existing = await this.#store.get(ref);
        if (!existing) {
            throw new KeyPackageNotFoundError(refHex);
        }
        // Determine relays for the new key package
        const oldEvents = existing.published ?? [];
        const relaysForNew = options?.relays ??
            (oldEvents.length > 0
                ? getKeyPackageRelays(oldEvents[oldEvents.length - 1])
                : undefined);
        if (!relaysForNew || relaysForNew.length === 0) {
            throw new KeyPackageRotatePreconditionError();
        }
        // Resolve the slot identifier for the new event:
        // prefer an explicit override, then the stored entry's d (same slot = relay auto-replaces),
        // then generate a fresh random value.
        const newD = options?.d ?? existing.identifier ?? this.#publisher.freshIdentifier();
        // Kind-30443 events are superseded automatically by the new event on the
        // relays (same `d` slot), so no explicit NIP-09 deletion is needed.
        // Create and publish the new key package under the resolved slot
        const newPkg = await this.create({
            relays: relaysForNew,
            identifier: newD,
            ciphersuite: options?.ciphersuite,
            isLastResort: options?.isLastResort,
            client: options?.client,
            protected: options?.protected,
        });
        // Remove old private key material (and its published events)
        await this.#store.remove(ref);
        return newPkg;
    }
    // ---------------------------------------------------------------------------
    // Removal
    // ---------------------------------------------------------------------------
    /**
     * Removes a key package from local private key storage only.
     *
     * Does not publish a relay deletion and does not touch publish records.
     * Use when the key package was never published, or when relay cleanup has
     * already been handled separately.
     *
     * @param ref - The key package reference to remove
     */
    async remove(ref) {
        const refHex = typeof ref === "string" ? ref : bytesToHex(ref);
        await this.#store.remove(ref);
        this.#log("removed key package %s from local store", refHex);
    }
    /**
     * Completely purges one or more key packages: publishes a NIP-09 deletion
     * for all known relay event IDs, removes local private key material, and
     * clears the publish records.
     *
     * @param refs - One or more key package references (hex string or Uint8Array)
     */
    async purge(refs) {
        const refList = Array.isArray(refs) ? refs : [refs];
        this.#log("purging %d key package(s)", refList.length);
        // Collect all published events and relays across the provided refs
        const allEvents = [];
        const allRelays = new Set();
        for (const ref of refList) {
            const stored = await this.#store.get(ref);
            const events = stored?.published ?? [];
            for (const event of events) {
                allEvents.push(event);
                for (const relay of getKeyPackageRelays(event) ?? []) {
                    allRelays.add(relay);
                }
            }
        }
        // Publish a single kind 5 deletion covering all events, if any
        if (allEvents.length > 0) {
            await this.#publisher.delete(allEvents, [...allRelays]);
        }
        // Remove local private key material for all refs
        for (const ref of refList) {
            await this.#store.remove(ref);
        }
    }
    // ---------------------------------------------------------------------------
    // Publish tracking
    // ---------------------------------------------------------------------------
    /**
     * Observes a Nostr event and, if it is a kind 30443 key package event whose
     * `i` tag (MIP-00 KeyPackageRef) matches its decoded body, records it in the
     * store. Events with no `i` tag, an undecodable body, or an `i` tag that does
     * not match the recomputed ref are rejected.
     *
     * @param event - Any Nostr event; non-key-package events are silently ignored
     * @returns `true` if the event was recorded, `false` if ignored or rejected
     */
    async track(event) {
        if (event.kind !== ADDRESSABLE_KEY_PACKAGE_KIND) {
            return false;
        }
        const refHex = getKeyPackageReference(event);
        if (!refHex)
            return false;
        try {
            await this.#store.addPublished(refHex, event);
        }
        catch {
            // Event body could not be decoded as a KeyPackage — treat as invalid
            return false;
        }
        const relays = getKeyPackageRelays(event) ?? [];
        this.emit("published", refHex, event.id, relays);
        return true;
    }
    // ---------------------------------------------------------------------------
    // Queries
    // ---------------------------------------------------------------------------
    /**
     * Lists all locally stored key packages, each enriched with their published
     * Nostr events.
     */
    async list() {
        return this.#store.snapshot();
    }
    /** Returns the number of locally stored key packages. */
    async count() {
        return this.#store.count();
    }
    /** Checks whether a key package exists in local private key storage. */
    async has(ref) {
        return this.#store.has(ref);
    }
    /** Retrieves the full key package from the store. */
    async get(ref) {
        return this.#store.get(ref);
    }
    /**
     * Retrieves the private key material for a key package.
     * Used internally by {@link MarmotClient} when processing Welcome messages.
     *
     * @param ref - The key package reference
     * @returns The private key package, or null if not found
     */
    async getPrivateKey(ref) {
        return this.#store.getPrivateKey(ref);
    }
    /**
     * Selects the locally-held key packages that could receive a given Welcome,
     * ordered with the RFC 9420 KeyPackageRef matches first.
     *
     * Filters to packages whose ciphersuite matches the Welcome and for which
     * local private material is held, computes whether each package's ref matches
     * one of the Welcome's encrypted secrets, and returns the matching packages
     * before the non-matching ones so `GroupsManager.joinFromWelcome` tries the
     * most likely candidate first. This is the TypeScript analog of the private
     * key-bundle lookup the darkmatter engine performs inside `do_join_welcome`.
     *
     * @param welcome - The decoded MLS Welcome message.
     * @returns Candidate key packages in priority order (may be empty).
     */
    async selectForWelcome(welcome) {
        const entries = await this.list();
        const candidates = [];
        for (const entry of entries) {
            if (entry.publicPackage.cipherSuite !== welcome.cipherSuite)
                continue;
            const privatePackage = await this.getPrivateKey(entry.keyPackageRef);
            if (!privatePackage)
                continue;
            // RFC 9420 KeyPackageRef matching: does this package's ref equal the
            // `newMember` ref of any encrypted secret in the Welcome?
            const hasMatchingSecret = welcome.secrets.some((secret) => secret.newMember.length === entry.keyPackageRef.length &&
                secret.newMember.every((val, idx) => val === entry.keyPackageRef[idx]));
            candidates.push({
                publicPackage: entry.publicPackage,
                privatePackage,
                keyPackageRef: entry.keyPackageRef,
                hasMatchingSecret,
            });
        }
        // Try packages whose ref matches a Welcome secret first (RFC 9420 compliance).
        return [
            ...candidates.filter((c) => c.hasMatchingSecret),
            ...candidates.filter((c) => !c.hasMatchingSecret),
        ];
    }
    /**
     * Marks a key package as used by setting `used = true` on the stored entry.
     *
     * Does nothing if no entry is found for the given ref.
     *
     * @param ref - The key package reference
     */
    async markUsed(ref) {
        return this.#store.markUsed(ref);
    }
    /** Clears all entries (local and tracked) from the store. */
    async clear() {
        return this.#store.clear();
    }
    // ---------------------------------------------------------------------------
    // Watching
    // ---------------------------------------------------------------------------
    /**
     * Watches for any change to key packages or their published events.
     *
     * Yields the current snapshot on subscription, then re-yields on every
     * subsequent change.
     */
    async *watchKeyPackages() {
        let resolveNext = null;
        let pending = false;
        const signal = () => {
            if (resolveNext) {
                resolveNext();
                resolveNext = null;
            }
            else {
                pending = true;
            }
        };
        this.on("added", signal);
        this.on("removed", signal);
        this.on("updated", signal);
        this.on("published", signal);
        try {
            yield [...(await this.#store.snapshot())];
            while (true) {
                await new Promise((resolve) => {
                    if (pending) {
                        pending = false;
                        resolve();
                    }
                    else {
                        resolveNext = resolve;
                    }
                });
                yield [...(await this.#store.snapshot())];
            }
        }
        finally {
            this.off("added", signal);
            this.off("removed", signal);
            this.off("updated", signal);
            this.off("published", signal);
        }
    }
}
//# sourceMappingURL=key-package-manager.js.map