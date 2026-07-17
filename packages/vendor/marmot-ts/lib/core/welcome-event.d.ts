/** @module @category Core - Welcome */
import { Rumor } from "applesauce-common/helpers/gift-wrap";
import { type Welcome } from "ts-mls";
/**
 * Creates a welcome rumor (kind 444) for a welcome message.
 *
 * @returns Welcome rumor with precomputed ID
 */
export declare function createWelcomeRumor({ welcome, author, groupRelays, keyPackageEventId, }: {
    /** The MLS welcome message */
    welcome: Welcome;
    /** The author's public key (hex string) */
    author: string;
    /**
     * The ID of the KeyPackage event consumed for this add. Required: the spec
     * mandates a 32-byte-hex `e` tag on every welcome rumor
     * (transports/nostr.md "Welcome delivery").
     */
    keyPackageEventId: string;
    /** Array of relay URLs for the group (becomes the non-empty `relays` tag) */
    groupRelays: string[];
}): Rumor;
/** Returns the key package event ID from a welcome rumor */
export declare function getWelcomeKeyPackageEventId(event: Rumor): string | undefined;
/** Returns the group relays from a welcome rumor */
export declare function getWelcomeGroupRelays(event: Rumor): string[];
/**
 * Returns the KeyPackageRefs of the intended recipients from a Welcome message.
 *
 * Each entry in `welcome.secrets` contains a plaintext `newMember` field which
 * is the RFC 9420 KeyPackageRef (a hash of the recipient's KeyPackage). No
 * decryption is required to read these.
 *
 * @param welcome - The MLS Welcome message
 * @returns Array of KeyPackageRefs (one per recipient)
 */
export declare function getWelcomeKeyPackageRefs(welcome: Welcome | Rumor): Uint8Array[];
/**
 * Gets the Welcome message from a kind 444 event.
 *
 * @param event - The Nostr event containing the welcome message
 * @returns The decoded Welcome message
 * @throws Error if the content cannot be decoded
 */
export declare function getWelcome(event: Rumor): Welcome;
