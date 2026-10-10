/** @module @category Core - App Components */
/**
 * Upstream MLS extensions-draft component (`0x0001`) that advertises the
 * supported/required application component ids in an `AppDataDictionary` entry.
 */
export const APP_COMPONENTS_COMPONENT_ID = 0x0001;
/**
 * Upstream MLS extensions-draft component that advertises SafeAAD support on
 * LeafNodes. Marmot does not yet admit SafeAAD-framed group-component state.
 */
export const SAFE_AAD_COMPONENT_ID = 0x0002;
/**
 * Upstream MLS extensions-draft `last_resort_key_package` component. A
 * last-resort KeyPackage carries an empty-data entry for it in the
 * `app_data_dictionary` of its KeyPackage extensions (not its LeafNode).
 * @see refs/marmot/foundation/key-packages.md "Capability advertising"
 * @see refs/marmot/foundation/registries.md
 */
export const LAST_RESORT_KEY_PACKAGE_COMPONENT_ID = 0x0004;
/** Marmot private component ids live in the `0x8000..0xffff` range. */
export const GROUP_PROFILE_COMPONENT_ID = 0x8001;
export const GROUP_BLOSSOM_IMAGE_COMPONENT_ID = 0x8002;
export const GROUP_ADMIN_POLICY_COMPONENT_ID = 0x8003;
export const NOSTR_ROUTING_COMPONENT_ID = 0x8004;
export const GROUP_MESSAGE_RETENTION_COMPONENT_ID = 0x8005;
export const AGENT_TEXT_STREAM_QUIC_COMPONENT_ID = 0x8006;
export const GROUP_AVATAR_URL_COMPONENT_ID = 0x8007;
/**
 * `marmot.group.encrypted-media.v1` — the frozen legacy media policy. Kept for
 * decoding and legacy groups only; the current profile uses
 * {@link GROUP_ENCRYPTED_MEDIA_V2_COMPONENT_ID}.
 * @see refs/marmot/app-components/group-encrypted-media-v1.md
 */
export const GROUP_ENCRYPTED_MEDIA_COMPONENT_ID = 0x8008;
/** Explicit alias of {@link GROUP_ENCRYPTED_MEDIA_COMPONENT_ID} (MDK `GROUP_ENCRYPTED_MEDIA_V1_COMPONENT_ID`). */
export const GROUP_ENCRYPTED_MEDIA_V1_COMPONENT_ID = GROUP_ENCRYPTED_MEDIA_COMPONENT_ID;
/**
 * `marmot.member.account-identity-proof.v2` — LeafNode-only proof binding the
 * MLS signature key to the credential's Nostr account identity.
 * @see refs/marmot/app-components/account-identity-proof-v2.md
 */
export const ACCOUNT_IDENTITY_PROOF_COMPONENT_ID = 0x8009;
/**
 * `marmot.group.encrypted-media.v2` — the current group media policy. It
 * supersedes `0x8008`; the two ids never reinterpret each other's bytes.
 * @see refs/marmot/app-components/group-encrypted-media-v2.md
 */
export const GROUP_ENCRYPTED_MEDIA_V2_COMPONENT_ID = 0x800b;
export const GROUP_LIFECYCLE_COMPONENT_ID = 0x800c;
/** Human-readable component names (the `v1` suffix is part of the name). */
export const GROUP_PROFILE_COMPONENT = "marmot.group.profile.v1";
export const GROUP_BLOSSOM_IMAGE_COMPONENT = "marmot.group.blossom.image.v1";
export const GROUP_ADMIN_POLICY_COMPONENT = "marmot.group.admin-policy.v1";
export const NOSTR_ROUTING_COMPONENT = "marmot.transport.nostr.routing.v1";
export const GROUP_MESSAGE_RETENTION_COMPONENT = "marmot.group.message-retention.v1";
export const AGENT_TEXT_STREAM_QUIC_COMPONENT = "marmot.group.agent-text-stream.quic.v1";
export const GROUP_AVATAR_URL_COMPONENT = "marmot.group.avatar-url.v1";
export const GROUP_ENCRYPTED_MEDIA_COMPONENT = "marmot.group.encrypted-media.v1";
export const GROUP_ENCRYPTED_MEDIA_V1_COMPONENT = GROUP_ENCRYPTED_MEDIA_COMPONENT;
export const GROUP_ENCRYPTED_MEDIA_V2_COMPONENT = "marmot.group.encrypted-media.v2";
export const ACCOUNT_IDENTITY_PROOF_COMPONENT = "marmot.member.account-identity-proof.v2";
export const GROUP_LIFECYCLE_COMPONENT = "marmot.group.lifecycle.v1";
/**
 * Default group component ids provisioned for a new Marmot group, matching the
 * darkmatter `default_group_components()` set (profile + admin-policy only;
 * nostr routing is added by the transport layer, not the default group state),
 * plus `0x8009`: every Marmot GroupContext must require the account identity
 * proof component in its `app_components` required list — there is no
 * GroupContext *state* for `0x8009` itself (it is LeafNode-only data), only a
 * requirement entry (`refs/marmot/app-components/account-identity-proof-v2.md`
 * "Negotiation and presence"; MDK `CURRENT_PROFILE_REQUIRED_APP_COMPONENTS`).
 */
export const DEFAULT_GROUP_COMPONENT_IDS = [
    GROUP_PROFILE_COMPONENT_ID,
    GROUP_ADMIN_POLICY_COMPONENT_ID,
    ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
    GROUP_LIFECYCLE_COMPONENT_ID,
];
/**
 * Component ids this implementation can encode/decode and therefore advertises
 * support for in the `app_components` list carried on a key package's LeafNode.
 * A group may only require components every member's leaf advertises here.
 *
 * This is a superset of the darkmatter reference app's supported set
 * (`{0x8001, 0x8003, 0x8004, 0x8006, 0x8008}`); the negotiated required set for
 * any group is the intersection across members, so advertising extra supported
 * components is safe. Excludes the `app_components` list id (`0x0001`) itself.
 *
 * Includes `group.blossom.image` (`0x8002`): MDK/White Noise only puts an
 * encrypted group image into a group when every founding member's leaf
 * advertises `0x8002`, and otherwise silently drops it.
 *
 * Includes `0x8009`: every KeyPackage leaf advertises and carries the account
 * identity proof, and the kind-30443 `app_components` tag must include it
 * (`refs/marmot/transports/nostr.md`).
 *
 * Advertises both encrypted-media versions, like MDK's
 * `supported_app_component_ids`: `0x8008` for existing legacy groups and
 * `0x800b` for current-profile groups. MDK-created groups require `0x800b`, so
 * a leaf without it cannot be added to them.
 */
export const SUPPORTED_APP_COMPONENT_IDS = [
    GROUP_PROFILE_COMPONENT_ID,
    GROUP_BLOSSOM_IMAGE_COMPONENT_ID,
    GROUP_ADMIN_POLICY_COMPONENT_ID,
    NOSTR_ROUTING_COMPONENT_ID,
    GROUP_MESSAGE_RETENTION_COMPONENT_ID,
    AGENT_TEXT_STREAM_QUIC_COMPONENT_ID,
    GROUP_AVATAR_URL_COMPONENT_ID,
    GROUP_ENCRYPTED_MEDIA_COMPONENT_ID,
    ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
    GROUP_ENCRYPTED_MEDIA_V2_COMPONENT_ID,
    GROUP_LIFECYCLE_COMPONENT_ID,
];
