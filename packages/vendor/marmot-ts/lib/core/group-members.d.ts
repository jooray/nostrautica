/** @module @category Core - Group Members */
import { ClientState, Credential, LeafNode } from "../vendor/ts-mls/index.js";
/**
 * Gets all the nostr pubkey keys in a group.
 *
 * WR-15: a leaf whose identity is not a valid 32-byte hex key is SKIPPED, not
 * thrown on. Filtering on `credentialType` alone is not enough — a basic
 * credential can still carry a malformed identity, and `getCredentialPubkey`
 * throws for one. `marmotAuthService.validateCredential` gates identities on
 * the inbound path, but a state hydrated from a Welcome or a `ratchet_tree`
 * extension is not covered by that gate. Callers here (notably
 * `deriveStateNotifications`, run per link of an applied rewind AFTER state
 * has already advanced) treat this as an enumeration, so one unparseable leaf
 * must not abort the whole enumeration — and such a leaf is not a valid
 * Marmot member in the first place.
 */
export declare function getGroupMemberPubkeys(state: ClientState): string[];
/** @deprecated Use {@link getGroupMemberPubkeys}. */
export declare const getGroupMembers: typeof getGroupMemberPubkeys;
/** Gets all leaf nodes for a given nostr pubkey in a group */
export declare function getPubkeyLeafNodes(state: ClientState, pubkey: string): LeafNode[];
/**
 * Gets all leaf node indexes for a given nostr pubkey in a group.
 *
 * @param state - The ClientState to search
 * @param pubkey - The nostr pubkey to find
 * @returns Array of leaf node indexes (numbers) for the given pubkey
 */
export declare function getPubkeyLeafNodeIndexes(state: ClientState, pubkey: string): number[];
/**
 * Gets all leaf node indexes for a given credential in a group.
 *
 * @param state - The ClientState to search
 * @param credential - The credential to find
 * @returns Array of leaf node indexes (numbers) for the given credential
 */
export declare function getCredentialLeafNodeIndexes(state: ClientState, credential: Credential): number[];
