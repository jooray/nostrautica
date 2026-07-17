/** @module @category Core - App Components */
import { AppDataDictionary, ComponentData, CustomExtension, GroupContextExtension } from "ts-mls";
import { AppComponentId } from "./ids.js";
import { GroupProfileV1 } from "./group-profile.js";
import { NostrRoutingV1 } from "./nostr-routing.js";
import { GroupAvatarUrlV1 } from "./avatar-url.js";
import { EncryptedMediaPolicyV1 } from "./encrypted-media.js";
import { AgentTextStreamQuicPolicyV1 } from "./agent-text-stream.js";
/**
 * Read + build helpers over the Marmot v2 app components carried in the MLS
 * `app_data_dictionary` GroupContext extension (`0x0006`).
 *
 * The dictionary container itself — `ComponentData { componentId, data }` sorted
 * by id, wrapped in the extension — is owned by ts-mls
 * ({@link getAppDataDictionary} / {@link makeAppDataDictionaryExtension}), which
 * binds it to the MLS transcript. This module is the generic registry over the
 * opaque `data` bytes plus typed accessors that run each component's codec.
 *
 * Mutation (emitting `app_data_update` proposals) lives alongside the commit
 * path; this module only reads existing state and builds the create-time
 * dictionary.
 */
/** Returns the raw component `data` bytes for a component id, or undefined. */
export declare function getComponentData(extensions: GroupContextExtension[], componentId: AppComponentId): Uint8Array | undefined;
/** Builds a single {@link ComponentData} entry. */
export declare function componentEntry(componentId: AppComponentId, data: Uint8Array): ComponentData;
/**
 * Builds an {@link AppDataDictionary} from entries, sorted ascending by
 * componentId. Throws on a duplicate component id.
 */
export declare function buildAppDataDictionary(entries: ComponentData[]): AppDataDictionary;
/**
 * Builds the `app_data_dictionary` GroupContext extension from component
 * entries (sorting them first). Use at group creation to seed initial state.
 */
export declare function makeAppComponentsExtension(entries: ComponentData[]): CustomExtension;
/**
 * Builds the `app_data_dictionary` extension carried on a key package's LeafNode
 * to advertise the component ids this member supports. The dictionary holds a
 * single `app_components` (`0x0001`) entry listing {@link SUPPORTED_APP_COMPONENT_IDS}
 * (or the given override). Mirrors darkmatter's `leaf_app_components_extension`.
 */
export declare function makeLeafAppComponentsExtension(supportedIds?: readonly AppComponentId[]): CustomExtension;
/** The `app_components` advertising list (`0x0001`). */
export declare function getAppComponents(extensions: GroupContextExtension[]): AppComponentId[] | undefined;
/** The `group.profile.v1` component (`0x8001`). */
export declare function getGroupProfile(extensions: GroupContextExtension[]): GroupProfileV1 | undefined;
/** The `admin-policy.v1` admin pubkey set (`0x8003`). */
export declare function getAdminPolicy(extensions: GroupContextExtension[]): string[] | undefined;
/** The `transport.nostr.routing.v1` component (`0x8004`). */
export declare function getNostrRouting(extensions: GroupContextExtension[]): NostrRoutingV1 | undefined;
/** The `message-retention.v1` timer in seconds (`0x8005`). */
export declare function getMessageRetention(extensions: GroupContextExtension[]): bigint | undefined;
/** The `agent-text-stream.quic.v1` policy (`0x8006`). */
export declare function getAgentTextStreamPolicy(extensions: GroupContextExtension[]): AgentTextStreamQuicPolicyV1 | undefined;
/** The `group.avatar-url.v1` component (`0x8007`). */
export declare function getGroupAvatarUrl(extensions: GroupContextExtension[]): GroupAvatarUrlV1 | undefined;
/** The `group.encrypted-media.v1` policy (`0x8008`). */
export declare function getEncryptedMediaPolicy(extensions: GroupContextExtension[]): EncryptedMediaPolicyV1 | undefined;
/** Builds the `app_components` advertising entry from a list of ids. */
export declare function appComponentsEntry(ids: AppComponentId[]): ComponentData;
/** Builds the `group.profile.v1` entry. */
export declare function groupProfileEntry(profile: GroupProfileV1): ComponentData;
/** Builds the `admin-policy.v1` entry from hex admin pubkeys. */
export declare function adminPolicyEntry(adminPubkeys: string[]): ComponentData;
/** Builds the `transport.nostr.routing.v1` entry. */
export declare function nostrRoutingEntry(routing: NostrRoutingV1): ComponentData;
/** Builds the `message-retention.v1` entry. */
export declare function messageRetentionEntry(seconds: number | bigint): ComponentData;
/** Builds the `agent-text-stream.quic.v1` entry. */
export declare function agentTextStreamEntry(policy: AgentTextStreamQuicPolicyV1): ComponentData;
/** Builds the `group.avatar-url.v1` entry. */
export declare function groupAvatarUrlEntry(avatar: GroupAvatarUrlV1): ComponentData;
/** Builds the `group.encrypted-media.v1` entry. */
export declare function encryptedMediaEntry(policy: EncryptedMediaPolicyV1): ComponentData;
