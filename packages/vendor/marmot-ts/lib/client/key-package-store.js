/** @module @category Client - Key Package Manager */
import { bytesToHex } from "@noble/hashes/utils.js";
import { EventEmitter } from "eventemitter3";
import { defaultCryptoProvider, } from "ts-mls";
import { getKeyPackage, getKeyPackageIdentifier, } from "../core/key-package-event.js";
import { calculateKeyPackageRef } from "../core/key-package.js";
import { logger } from "../utils/debug.js";
import { deduplicatePublishedEvents } from "./key-package-events.js";
/**
 * Owns the persisted key package entries — the local private material and the
 * tracked kind-30443 events that advertise each package. Pure storage: it never
 * signs or publishes (that is {@link KeyPackagePublisher}'s job). Mirrors
 * darkmatter's `AccountSecretStore` seam.
 */
export class KeyPackageStore extends EventEmitter {
    #store;
    #cryptoProvider;
    #log = logger.extend("KeyPackageStore");
    constructor(store, cryptoProvider = defaultCryptoProvider) {
        super();
        this.#store = store;
        this.#cryptoProvider = cryptoProvider;
    }
    /** Resolves a ref argument to a hex storage key */
    #resolveKey(ref) {
        if (typeof ref === "string")
            return ref;
        return bytesToHex(ref);
    }
    /**
     * Adds a {@link LocalKeyPackage} to the store.
     *
     * @param keyPackage - Must include `publicPackage` and `privatePackage`.
     *   Optionally include `identifier` to persist the addressable slot identifier.
     * @returns The storage key (hex ref string)
     */
    async add(keyPackage) {
        const keyPackageRef = await calculateKeyPackageRef(keyPackage.publicPackage, this.#cryptoProvider);
        const key = bytesToHex(keyPackageRef);
        const entry = {
            keyPackageRef,
            publicPackage: keyPackage.publicPackage,
            privatePackage: keyPackage.privatePackage,
            ...(keyPackage.identifier !== undefined
                ? { identifier: keyPackage.identifier }
                : {}),
            ...(keyPackage.published !== undefined
                ? { published: deduplicatePublishedEvents(keyPackage.published) }
                : {}),
        };
        await this.#store.setItem(key, entry);
        this.emit("added", entry);
        this.#log("added %s" + (entry.privatePackage ? " with private key" : ""), key);
        return key;
    }
    /**
     * Appends a kind-30443 Nostr event to the `published` list of
     * the key package identified by `ref`. If no entry exists yet, a
     * {@link TrackedKeyPackage} is created by decoding the public key package
     * from the event body.
     *
     * Throws if the event body cannot be decoded as a valid key package, or if
     * the event's `i` tag (KeyPackageRef) does not match the decoded body.
     */
    async addPublished(ref, event) {
        const key = this.#resolveKey(ref);
        // MIP-00: the `i` tag IS the KeyPackageRef of the event body. Receivers MUST
        // verify it against the decoded KeyPackage and reject on mismatch
        // (transports/nostr.md §KeyPackage publication) so a forged `i` tag cannot
        // make us index a package under a ref that is not its own. Decoding here
        // also throws if the body is not a valid KeyPackage. This is the single
        // chokepoint for both tracked (untrusted) and self-published events.
        const publicPackage = getKeyPackage(event);
        const computedRefBytes = await calculateKeyPackageRef(publicPackage, this.#cryptoProvider);
        const computedRef = bytesToHex(computedRefBytes);
        if (computedRef !== key.toLowerCase()) {
            throw new Error(`KeyPackage event ${event.id} carries i tag ${key} but its body's KeyPackageRef is ${computedRef}`);
        }
        const existing = await this.#store.getItem(key);
        // Extract the addressable slot identifier if this is a kind 30443 event
        const identifier = getKeyPackageIdentifier(event);
        if (existing) {
            const published = deduplicatePublishedEvents([
                ...(existing.published ?? []),
                event,
            ]);
            const shouldPersistIdentifier = identifier !== undefined && existing.identifier === undefined;
            const publishedChanged = existing.published === undefined ||
                published.length !== existing.published.length ||
                !published.every((e, index) => e.id === existing.published?.[index]?.id);
            if (!publishedChanged && !shouldPersistIdentifier) {
                return;
            }
            const updated = {
                ...existing,
                // Persist identifier if discovered for the first time on this entry
                ...(shouldPersistIdentifier ? { identifier } : {}),
                published,
            };
            await this.#store.setItem(key, updated);
            this.emit("updated", updated);
            this.#log("stored published event %s for %s", event.id, ref);
        }
        else {
            // No local entry — record the package decoded and ref-verified above.
            const entry = {
                keyPackageRef: computedRefBytes,
                publicPackage,
                ...(identifier !== undefined ? { identifier } : {}),
                published: [event],
            };
            await this.#store.setItem(key, entry);
            this.emit("added", entry);
            this.#log("added key package from event %s", event.id);
        }
    }
    /**
     * Retrieves the stored key package entry.
     * Returns any entry regardless of whether it has private material.
     */
    async get(ref) {
        const key = this.#resolveKey(ref);
        return this.#store.getItem(key);
    }
    /**
     * Removes a key package from the backend.
     */
    async remove(ref) {
        const key = this.#resolveKey(ref);
        const stored = await this.#store.getItem(key);
        await this.#store.removeItem(key);
        if (stored) {
            this.emit("removed", stored.keyPackageRef);
            this.#log("removed key package %s", key);
        }
    }
    /**
     * Lists all {@link LocalKeyPackage} entries (those with private material),
     * without the private package itself.
     */
    async list() {
        const allKeys = await this.#store.keys();
        const packages = await Promise.all(allKeys.map((key) => this.#store.getItem(key)));
        return packages
            .filter((pkg) => pkg !== null && pkg.privatePackage !== undefined)
            .map(({ keyPackageRef, publicPackage, identifier, published, used }) => ({
            keyPackageRef,
            publicPackage,
            ...(identifier !== undefined ? { identifier } : {}),
            ...(published !== undefined ? { published } : {}),
            ...(used !== undefined ? { used } : {}),
        }));
    }
    /**
     * Lists all local key packages with their published events defaulted to an
     * empty array, suitable for emitting as a stable snapshot.
     */
    async snapshot() {
        const local = await this.list();
        return local.map((pkg) => ({
            ...pkg,
            published: pkg.published ?? [],
        }));
    }
    /** Returns the number of locally stored key packages (those with private material). */
    async count() {
        return (await this.list()).length;
    }
    /** Checks whether a key package with local private material exists. */
    async has(ref) {
        const key = this.#resolveKey(ref);
        const item = await this.#store.getItem(key);
        return item !== null && item.privatePackage !== undefined;
    }
    /**
     * Retrieves the private key material for a key package.
     *
     * @param ref - The key package reference
     * @returns The private key package, or null if not found
     */
    async getPrivateKey(ref) {
        const key = this.#resolveKey(ref);
        const stored = await this.#store.getItem(key);
        return stored?.privatePackage ?? null;
    }
    /**
     * Marks a key package as used by setting `used = true` on the stored entry.
     *
     * Does nothing if no entry is found for the given ref.
     *
     * @param ref - The key package reference
     */
    async markUsed(ref) {
        const key = this.#resolveKey(ref);
        const existing = await this.#store.getItem(key);
        if (!existing)
            return;
        const updated = { ...existing, used: true };
        await this.#store.setItem(key, updated);
        this.emit("updated", updated);
        this.#log("marked key package %s as used", key);
    }
    /** Clears all entries (local and tracked) from the store. */
    async clear() {
        const allKeys = await this.#store.keys();
        for (const key of allKeys) {
            const stored = await this.#store.getItem(key);
            await this.#store.removeItem(key);
            if (stored) {
                this.emit("removed", stored.keyPackageRef);
            }
        }
    }
}
//# sourceMappingURL=key-package-store.js.map