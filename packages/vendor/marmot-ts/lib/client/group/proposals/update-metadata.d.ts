/** @module @category Client - Proposals */
import { type Proposal } from "ts-mls";
import { type EncryptedMediaPolicyV1 } from "../../../core/components/index.js";
import type { ProposalAction } from "../marmot-group.js";
/** A partial update to a group's app-component metadata. */
export interface UpdateGroupMetadata {
    /** New group display name (group.profile.v1). */
    name?: string;
    /** New group description (group.profile.v1). */
    description?: string;
    /** New admin pubkey set (admin-policy.v1). */
    adminPubkeys?: string[];
    /** New relay set (transport.nostr.routing.v1). */
    relays?: string[];
    /** New nostr group id (transport.nostr.routing.v1). */
    nostrGroupId?: Uint8Array;
    /** New group avatar URL (group.avatar-url.v1). */
    avatarUrl?: string;
    /** New encrypted-media policy (group.encrypted-media.v1). */
    encryptedMedia?: EncryptedMediaPolicyV1;
    /**
     * New message-retention window in seconds (message-retention.v1); `0` retains
     * indefinitely.
     */
    messageRetention?: number | bigint;
}
/**
 * Builds `app_data_update` proposals that update a group's app-component
 * metadata. Each changed component is re-encoded in full (matching the default
 * last-update-wins merge), so unchanged fields are read from the current group
 * view. Touches only the components whose fields are present in `metadata`.
 */
export declare function proposeUpdateMetadata(metadata: UpdateGroupMetadata): ProposalAction<Proposal[]>;
