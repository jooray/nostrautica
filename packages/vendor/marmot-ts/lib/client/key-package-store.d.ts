import { NostrEvent } from "applesauce-core/helpers/event";
import { EventEmitter } from "eventemitter3";
import { CryptoProvider, KeyPackage, PrivateKeyPackage } from "ts-mls";
import { GenericKeyValueStore } from "../utils/key-value.js";
/**
 * A key package that has local private material.
 *
 * Created when generating or importing a key package for which the private
 * keys are held locally. Narrow from {@link StoredKeyPackage} by checking
 * `privatePackage !== undefined`.
 */
export type LocalKeyPackage = {
    /** The calculated key package reference */
    keyPackageRef: Uint8Array;
    /** The public key package */
    publicPackage: KeyPackage;
    /** The private key package — its presence is the discriminant for a local entry */
    privatePackage: PrivateKeyPackage;
    /** Nostr kind-30443 addressable slot identifier (`d` tag value) */
    identifier?: string;
    /** Nostr kind-30443 events this key package has been published under */
    published?: NostrEvent[];
    /** Whether this key package has been consumed (e.g. used to join a group). Undefined means unused. */
    used?: boolean;
};
/**
 * A key package observed on relays for which no private material is held locally.
 *
 * Created when tracking a kind-30443 event from another device.
 * Enables cross-device deletion without requiring the private keys to be
 * present. The public key package is always present — events that cannot be
 * decoded are rejected as invalid.
 *
 * Narrow from {@link StoredKeyPackage} by checking `privatePackage === undefined`.
 */
export type TrackedKeyPackage = {
    /** The calculated key package reference */
    keyPackageRef: Uint8Array;
    /** The public key package, decoded from the kind-30443 event body */
    publicPackage: KeyPackage;
    /** Always undefined — the discriminant that identifies this as a tracked entry */
    privatePackage?: undefined;
    /** Nostr kind-30443 addressable slot identifier (`d` tag value) */
    identifier?: string;
    /** Nostr kind-30443 events this key package has been published under */
    published?: NostrEvent[];
    /** Whether this key package has been consumed (e.g. used to join a group). Undefined means unused. */
    used?: boolean;
};
/**
 * A stored key package — either a locally-held one (with private material) or
 * a tracked foreign one (without private material).
 *
 * Use `privatePackage` to narrow the type:
 *
 * ```ts
 * if (pkg.privatePackage !== undefined) {
 *   // pkg is LocalKeyPackage
 * } else {
 *   // pkg is TrackedKeyPackage
 * }
 * ```
 */
export type StoredKeyPackage = LocalKeyPackage | TrackedKeyPackage;
/** A {@link LocalKeyPackage} without the private material, safe to expose in listings */
export type ListedKeyPackage = Omit<StoredKeyPackage, "privatePackage">;
/**
 * A locally-held key package selected as a candidate for joining from a
 * specific Welcome message. Produced by `KeyPackageManager.selectForWelcome`
 * and consumed by `GroupsManager.joinFromWelcome`.
 */
export type WelcomeKeyPackageCandidate = {
    /** The public key package to hand to `joinGroup`. */
    publicPackage: KeyPackage;
    /** The matching local private material. */
    privatePackage: PrivateKeyPackage;
    /** The RFC 9420 KeyPackageRef of this package. */
    keyPackageRef: Uint8Array;
    /** Whether this package's ref matches an encrypted secret in the Welcome. */
    hasMatchingSecret: boolean;
};
/** Events emitted by {@link KeyPackageStore} as its entries change. */
export type KeyPackageStoreEvents = {
    /** Emitted when a key package is stored locally */
    added: (keyPackage: StoredKeyPackage) => void;
    /** Emitted when a key package is removed from local storage */
    removed: (keyPackageRef: Uint8Array) => void;
    /** Emitted when a key package is updated */
    updated: (keyPackage: StoredKeyPackage) => void;
};
/**
 * Owns the persisted key package entries — the local private material and the
 * tracked kind-30443 events that advertise each package. Pure storage: it never
 * signs or publishes (that is {@link KeyPackagePublisher}'s job). Mirrors
 * darkmatter's `AccountSecretStore` seam.
 */
export declare class KeyPackageStore extends EventEmitter<KeyPackageStoreEvents> {
    #private;
    constructor(store: GenericKeyValueStore<StoredKeyPackage>, cryptoProvider?: CryptoProvider);
    /**
     * Adds a {@link LocalKeyPackage} to the store.
     *
     * @param keyPackage - Must include `publicPackage` and `privatePackage`.
     *   Optionally include `identifier` to persist the addressable slot identifier.
     * @returns The storage key (hex ref string)
     */
    add(keyPackage: Pick<LocalKeyPackage, "publicPackage" | "privatePackage"> & Partial<Pick<LocalKeyPackage, "published" | "identifier">>): Promise<string>;
    /**
     * Appends a kind-30443 Nostr event to the `published` list of
     * the key package identified by `ref`. If no entry exists yet, a
     * {@link TrackedKeyPackage} is created by decoding the public key package
     * from the event body.
     *
     * Throws if the event body cannot be decoded as a valid key package, or if
     * the event's `i` tag (KeyPackageRef) does not match the decoded body.
     */
    addPublished(ref: string | Uint8Array, event: NostrEvent): Promise<void>;
    /**
     * Retrieves the stored key package entry.
     * Returns any entry regardless of whether it has private material.
     */
    get(ref: Uint8Array | string): Promise<StoredKeyPackage | null>;
    /**
     * Removes a key package from the backend.
     */
    remove(ref: Uint8Array | string): Promise<void>;
    /**
     * Lists all {@link LocalKeyPackage} entries (those with private material),
     * without the private package itself.
     */
    list(): Promise<ListedKeyPackage[]>;
    /**
     * Lists all local key packages with their published events defaulted to an
     * empty array, suitable for emitting as a stable snapshot.
     */
    snapshot(): Promise<ListedKeyPackage[]>;
    /** Returns the number of locally stored key packages (those with private material). */
    count(): Promise<number>;
    /** Checks whether a key package with local private material exists. */
    has(ref: Uint8Array | string): Promise<boolean>;
    /**
     * Retrieves the private key material for a key package.
     *
     * @param ref - The key package reference
     * @returns The private key package, or null if not found
     */
    getPrivateKey(ref: Uint8Array | string): Promise<PrivateKeyPackage | null>;
    /**
     * Marks a key package as used by setting `used = true` on the stored entry.
     *
     * Does nothing if no entry is found for the given ref.
     *
     * @param ref - The key package reference
     */
    markUsed(ref: Uint8Array | string): Promise<void>;
    /** Clears all entries (local and tracked) from the store. */
    clear(): Promise<void>;
}
