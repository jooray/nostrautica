import { EventSigner } from "applesauce-core";
import { NostrEvent } from "applesauce-core/helpers/event";
import { EventEmitter } from "eventemitter3";
import { CiphersuiteName, CryptoProvider, PrivateKeyPackage, Welcome } from "ts-mls";
import type { AccountIdentityProofSigner } from "../core/account-identity-proof.js";
import { GenericKeyValueStore } from "../utils/key-value.js";
import { ListedKeyPackage, LocalKeyPackage, StoredKeyPackage, WelcomeKeyPackageCandidate } from "./key-package-store.js";
import { NostrNetworkInterface } from "./nostr-interface.js";
export { KeyPackageNotFoundError, KeyPackageRotatePreconditionError, MissingRelayError, MissingSlotIdentifierError, } from "./key-package-errors.js";
export { KeyPackageStore, type KeyPackageStoreEvents, type ListedKeyPackage, type LocalKeyPackage, type StoredKeyPackage, type TrackedKeyPackage, type WelcomeKeyPackageCandidate, } from "./key-package-store.js";
export { KeyPackagePublisher, type KeyPackagePublisherOptions, } from "./key-package-publisher.js";
/** Options for creating a new key package */
export type CreateKeyPackageOptions = {
    /** Relay URLs where the key package event will be published (required) */
    relays: string[];
    /**
     * Addressable slot identifier (`d` tag value) for the kind 30443 event.
     * If omitted, falls back to the manager's `clientId`. Throws
     * {@link MissingSlotIdentifierError} if neither is available.
     */
    identifier?: string;
    /** Ciphersuite to use (default: MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519) */
    ciphersuite?: CiphersuiteName;
    /** Whether to mark the key package with the MLS last_resort extension (default: true) */
    isLastResort?: boolean;
    /** Client identifier string to include in the key package event */
    client?: string;
    /** Whether to include the NIP-70 protected tag on the event */
    protected?: boolean;
};
/** Options for rotating a key package */
export type RotateKeyPackageOptions = {
    /**
     * Relay URLs for the new key package event.
     * If omitted, the relays from the most recent publish of the old key package are reused.
     */
    relays?: string[];
    /**
     * Addressable slot identifier (`d` tag value) for the replacement event.
     * If omitted, the `d` from the stored entry is reused (preferred). If the
     * stored entry has no `d`, a fresh random value is generated.
     */
    d?: string;
    /** Ciphersuite to use for the new key package */
    ciphersuite?: CiphersuiteName;
    /** Whether to mark the new key package with the MLS last_resort extension (default: true) */
    isLastResort?: boolean;
    /** Client identifier string to include in the new key package event */
    client?: string;
    /** Whether to include the NIP-70 protected tag on the new event */
    protected?: boolean;
};
export type KeyPackageManagerEvents = {
    /** Emitted when a key package is stored locally */
    added: (keyPackage: StoredKeyPackage) => void;
    /** Emitted when a key package is removed from local storage */
    removed: (keyPackageRef: Uint8Array) => void;
    /** Emitted when a key package is updated */
    updated: (keyPackage: StoredKeyPackage) => void;
    /** Emitted when a key package publish is recorded (own publish or observed relay event) */
    published: (refHex: string, eventId: string, relays: string[]) => void;
};
/** Options for creating a new KeyPackageManager */
export type KeyPackageManagerOptions = {
    /** The backend to store and load the key packages from */
    store: GenericKeyValueStore<StoredKeyPackage>;
    /** Default `d` tag value for {@link KeyPackageManager.create} and {@link KeyPackageManager.rotate}. Falls back to this when no explicit `d` is passed. */
    clientId?: string;
    /** The signer used for the clients identity */
    signer: EventSigner;
    /**
     * Optional Nostr-account proof signer. When provided, generated key packages
     * carry a `marmot.account-identity-proof.v1` LeafNode extension binding the
     * account to the leaf signature key (required for darkmatter wire interop).
     * Supply this from a signer with raw BIP-340 access (e.g. a PrivateKeyAccount
     * secret key via `signAccountIdentityProof`); the applesauce `EventSigner`
     * alone cannot sign the proof digest.
     */
    accountProofSigner?: AccountIdentityProofSigner;
    /** The nostr relay pool to use for the client. Should implement GroupNostrInterface for group operations. */
    network: NostrNetworkInterface;
    /** The crypto provider to use for cryptographic operations */
    cryptoProvider?: CryptoProvider;
};
/**
 * Manages the full lifecycle of MLS key packages — local private material and
 * the Nostr kind-30443 events that advertise this client to potential inviters.
 *
 * A thin coordinator over a {@link KeyPackageStore} (persistence) and a
 * {@link KeyPackagePublisher} (the sign/publish boundary).
 */
export declare class KeyPackageManager extends EventEmitter<KeyPackageManagerEvents> {
    #private;
    /**
     * Default slot identifier (`d` tag value) used by {@link create} when no
     * explicit `d` is passed in options. Set this to a stable string (e.g.
     * `"my-app-desktop"`) so all key packages from this manager share a single
     * addressable slot on relays.
     */
    readonly clientId: string | undefined;
    constructor(options: KeyPackageManagerOptions);
    /**
     * Adds a {@link LocalKeyPackage} to local storage. Delegates to
     * {@link KeyPackageStore.add}.
     *
     * @returns The storage key (hex ref string)
     */
    add(keyPackage: Pick<LocalKeyPackage, "publicPackage" | "privatePackage"> & Partial<Pick<LocalKeyPackage, "published" | "identifier">>): Promise<string>;
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
    create(options: CreateKeyPackageOptions): Promise<ListedKeyPackage>;
    /**
     * Ensures this client has at least one unused KeyPackage published, so peers
     * can always invite it. A no-op (returning the existing unused KeyPackage)
     * when one already exists; otherwise creates and publishes a fresh one to
     * `options.relays` via {@link create}. Idempotent — safe to call on every
     * startup.
     *
     * @returns The existing unused KeyPackage, or the freshly created one.
     */
    ensurePublished(options: CreateKeyPackageOptions): Promise<ListedKeyPackage>;
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
    rotate(ref: Uint8Array | string, options?: RotateKeyPackageOptions): Promise<ListedKeyPackage>;
    /**
     * Removes a key package from local private key storage only.
     *
     * Does not publish a relay deletion and does not touch publish records.
     * Use when the key package was never published, or when relay cleanup has
     * already been handled separately.
     *
     * @param ref - The key package reference to remove
     */
    remove(ref: Uint8Array | string): Promise<void>;
    /**
     * Completely purges one or more key packages: publishes a NIP-09 deletion
     * for all known relay event IDs, removes local private key material, and
     * clears the publish records.
     *
     * @param refs - One or more key package references (hex string or Uint8Array)
     */
    purge(refs: Uint8Array | string | Array<Uint8Array | string>): Promise<void>;
    /**
     * Observes a Nostr event and, if it is a kind 30443 key package event whose
     * `i` tag (MIP-00 KeyPackageRef) matches its decoded body, records it in the
     * store. Events with no `i` tag, an undecodable body, or an `i` tag that does
     * not match the recomputed ref are rejected.
     *
     * @param event - Any Nostr event; non-key-package events are silently ignored
     * @returns `true` if the event was recorded, `false` if ignored or rejected
     */
    track(event: NostrEvent): Promise<boolean>;
    /**
     * Lists all locally stored key packages, each enriched with their published
     * Nostr events.
     */
    list(): Promise<ListedKeyPackage[]>;
    /** Returns the number of locally stored key packages. */
    count(): Promise<number>;
    /** Checks whether a key package exists in local private key storage. */
    has(ref: Uint8Array | string): Promise<boolean>;
    /** Retrieves the full key package from the store. */
    get(ref: Uint8Array | string): Promise<StoredKeyPackage | null>;
    /**
     * Retrieves the private key material for a key package.
     * Used internally by {@link MarmotClient} when processing Welcome messages.
     *
     * @param ref - The key package reference
     * @returns The private key package, or null if not found
     */
    getPrivateKey(ref: Uint8Array | string): Promise<PrivateKeyPackage | null>;
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
    selectForWelcome(welcome: Welcome): Promise<WelcomeKeyPackageCandidate[]>;
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
    /**
     * Watches for any change to key packages or their published events.
     *
     * Yields the current snapshot on subscription, then re-yields on every
     * subsequent change.
     */
    watchKeyPackages(): AsyncGenerator<ListedKeyPackage[]>;
}
