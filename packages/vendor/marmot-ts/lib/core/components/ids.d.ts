/** @module @category Core - App Components */
/**
 * Marmot MLS app-component identifiers (darkmatter / Marmot v2).
 *
 * Group state is carried as versioned app components inside the MLS
 * `app_data_dictionary` extension. Each component owns the opaque `data` bytes
 * stored under its {@link AppComponentId}. These ids are wire-significant and
 * MUST match the darkmatter reference implementation for cross-implementation
 * interop.
 *
 * @see darkmatter `crates/traits/src/app_components.rs`
 * @see Marmot v2 spec: `app-components/README.md`, `foundation/registries.md`
 */
/** An MLS `ComponentID` (`uint16`). */
export type AppComponentId = number;
/**
 * Upstream MLS extensions-draft component (`0x0001`) that advertises the
 * supported/required application component ids in an `AppDataDictionary` entry.
 */
export declare const APP_COMPONENTS_COMPONENT_ID: AppComponentId;
/** Marmot private component ids live in the `0x8000..0xffff` range. */
export declare const GROUP_PROFILE_COMPONENT_ID: AppComponentId;
export declare const GROUP_BLOSSOM_IMAGE_COMPONENT_ID: AppComponentId;
export declare const GROUP_ADMIN_POLICY_COMPONENT_ID: AppComponentId;
export declare const NOSTR_ROUTING_COMPONENT_ID: AppComponentId;
export declare const GROUP_MESSAGE_RETENTION_COMPONENT_ID: AppComponentId;
export declare const AGENT_TEXT_STREAM_QUIC_COMPONENT_ID: AppComponentId;
export declare const GROUP_AVATAR_URL_COMPONENT_ID: AppComponentId;
export declare const GROUP_ENCRYPTED_MEDIA_COMPONENT_ID: AppComponentId;
/** Human-readable component names (the `v1` suffix is part of the name). */
export declare const GROUP_PROFILE_COMPONENT = "marmot.group.profile.v1";
export declare const GROUP_BLOSSOM_IMAGE_COMPONENT = "marmot.group.blossom.image.v1";
export declare const GROUP_ADMIN_POLICY_COMPONENT = "marmot.group.admin-policy.v1";
export declare const NOSTR_ROUTING_COMPONENT = "marmot.transport.nostr.routing.v1";
export declare const GROUP_MESSAGE_RETENTION_COMPONENT = "marmot.group.message-retention.v1";
export declare const AGENT_TEXT_STREAM_QUIC_COMPONENT = "marmot.group.agent-text-stream.quic.v1";
export declare const GROUP_AVATAR_URL_COMPONENT = "marmot.group.avatar-url.v1";
export declare const GROUP_ENCRYPTED_MEDIA_COMPONENT = "marmot.group.encrypted-media.v1";
/**
 * Default group component ids provisioned for a new Marmot group, matching the
 * darkmatter `default_group_components()` set (profile + admin-policy only;
 * nostr routing is added by the transport layer, not the default group state).
 */
export declare const DEFAULT_GROUP_COMPONENT_IDS: readonly AppComponentId[];
/**
 * Component ids this implementation can encode/decode and therefore advertises
 * support for in the `app_components` list carried on a key package's LeafNode.
 * A group may only require components every member's leaf advertises here.
 *
 * This is a superset of the darkmatter reference app's supported set
 * (`{0x8001, 0x8003, 0x8004, 0x8006, 0x8008}`); the negotiated required set for
 * any group is the intersection across members, so advertising extra supported
 * components is safe. Excludes `group.blossom.image` (`0x8002`), which has no
 * wire codec, and the `app_components` list id (`0x0001`) itself.
 */
export declare const SUPPORTED_APP_COMPONENT_IDS: readonly AppComponentId[];
