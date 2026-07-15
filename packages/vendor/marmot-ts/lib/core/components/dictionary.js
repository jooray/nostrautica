/** @module @category Core - App Components */
import { getAppDataDictionary, makeAppDataDictionaryExtension, } from "ts-mls";
import { UsageError } from "ts-mls";
import { APP_COMPONENTS_COMPONENT_ID, GROUP_ADMIN_POLICY_COMPONENT_ID, GROUP_AVATAR_URL_COMPONENT_ID, GROUP_ENCRYPTED_MEDIA_COMPONENT_ID, GROUP_MESSAGE_RETENTION_COMPONENT_ID, GROUP_PROFILE_COMPONENT_ID, AGENT_TEXT_STREAM_QUIC_COMPONENT_ID, NOSTR_ROUTING_COMPONENT_ID, SUPPORTED_APP_COMPONENT_IDS, } from "./ids.js";
import { decodeComponentsList, encodeComponentsList, } from "./app-components-list.js";
import { decodeGroupProfileV1, encodeGroupProfileV1, } from "./group-profile.js";
import { decodeAdminPolicyV1, encodeAdminPolicyV1 } from "./admin-policy.js";
import { decodeNostrRoutingV1, encodeNostrRoutingV1, } from "./nostr-routing.js";
import { decodeMessageRetentionV1, encodeMessageRetentionV1, } from "./message-retention.js";
import { decodeGroupAvatarUrlV1, encodeGroupAvatarUrlV1, } from "./avatar-url.js";
import { decodeEncryptedMediaPolicyV1, encodeEncryptedMediaPolicyV1, } from "./encrypted-media.js";
import { decodeAgentTextStreamQuicPolicyV1, encodeAgentTextStreamQuicPolicyV1, } from "./agent-text-stream.js";
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
// ---------------------------------------------------------------------------
// Generic core
// ---------------------------------------------------------------------------
/** Returns the raw component `data` bytes for a component id, or undefined. */
export function getComponentData(extensions, componentId) {
    const dictionary = getAppDataDictionary(extensions);
    return dictionary?.find((c) => c.componentId === componentId)?.data;
}
/** Builds a single {@link ComponentData} entry. */
export function componentEntry(componentId, data) {
    return { componentId, data };
}
/**
 * Builds an {@link AppDataDictionary} from entries, sorted ascending by
 * componentId. Throws on a duplicate component id.
 */
export function buildAppDataDictionary(entries) {
    const sorted = [...entries].sort((a, b) => a.componentId - b.componentId);
    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i - 1].componentId === sorted[i].componentId) {
            throw new UsageError(`Duplicate app component id 0x${sorted[i].componentId.toString(16)}`);
        }
    }
    return sorted;
}
/**
 * Builds the `app_data_dictionary` GroupContext extension from component
 * entries (sorting them first). Use at group creation to seed initial state.
 */
export function makeAppComponentsExtension(entries) {
    return makeAppDataDictionaryExtension(buildAppDataDictionary(entries));
}
/**
 * Builds the `app_data_dictionary` extension carried on a key package's LeafNode
 * to advertise the component ids this member supports. The dictionary holds a
 * single `app_components` (`0x0001`) entry listing {@link SUPPORTED_APP_COMPONENT_IDS}
 * (or the given override). Mirrors darkmatter's `leaf_app_components_extension`.
 */
export function makeLeafAppComponentsExtension(supportedIds = SUPPORTED_APP_COMPONENT_IDS) {
    return makeAppComponentsExtension([appComponentsEntry([...supportedIds])]);
}
function defineCodec(id, decode, encode) {
    return { id, decode, encode };
}
const APP_COMPONENTS_CODEC = defineCodec(APP_COMPONENTS_COMPONENT_ID, decodeComponentsList, encodeComponentsList);
const GROUP_PROFILE_CODEC = defineCodec(GROUP_PROFILE_COMPONENT_ID, decodeGroupProfileV1, encodeGroupProfileV1);
const ADMIN_POLICY_CODEC = defineCodec(GROUP_ADMIN_POLICY_COMPONENT_ID, decodeAdminPolicyV1, encodeAdminPolicyV1);
const NOSTR_ROUTING_CODEC = defineCodec(NOSTR_ROUTING_COMPONENT_ID, decodeNostrRoutingV1, encodeNostrRoutingV1);
const MESSAGE_RETENTION_CODEC = defineCodec(GROUP_MESSAGE_RETENTION_COMPONENT_ID, decodeMessageRetentionV1, 
// The builder accepts number | bigint; the decoder yields bigint.
(seconds) => encodeMessageRetentionV1(seconds));
const AGENT_TEXT_STREAM_CODEC = defineCodec(AGENT_TEXT_STREAM_QUIC_COMPONENT_ID, decodeAgentTextStreamQuicPolicyV1, encodeAgentTextStreamQuicPolicyV1);
const GROUP_AVATAR_URL_CODEC = defineCodec(GROUP_AVATAR_URL_COMPONENT_ID, decodeGroupAvatarUrlV1, encodeGroupAvatarUrlV1);
const ENCRYPTED_MEDIA_CODEC = defineCodec(GROUP_ENCRYPTED_MEDIA_COMPONENT_ID, decodeEncryptedMediaPolicyV1, encodeEncryptedMediaPolicyV1);
/** Reads + decodes a component from the dictionary, or `undefined` if absent. */
function getComponent(extensions, codec) {
    const data = getComponentData(extensions, codec.id);
    return data === undefined ? undefined : codec.decode(data);
}
/** Builds a {@link ComponentData} entry by encoding `value` with `codec`. */
function entryFor(codec, value) {
    return componentEntry(codec.id, codec.encode(value));
}
// ---------------------------------------------------------------------------
// Typed accessors
// ---------------------------------------------------------------------------
/** The `app_components` advertising list (`0x0001`). */
export function getAppComponents(extensions) {
    return getComponent(extensions, APP_COMPONENTS_CODEC);
}
/** The `group.profile.v1` component (`0x8001`). */
export function getGroupProfile(extensions) {
    return getComponent(extensions, GROUP_PROFILE_CODEC);
}
/** The `admin-policy.v1` admin pubkey set (`0x8003`). */
export function getAdminPolicy(extensions) {
    return getComponent(extensions, ADMIN_POLICY_CODEC);
}
/** The `transport.nostr.routing.v1` component (`0x8004`). */
export function getNostrRouting(extensions) {
    return getComponent(extensions, NOSTR_ROUTING_CODEC);
}
/** The `message-retention.v1` timer in seconds (`0x8005`). */
export function getMessageRetention(extensions) {
    return getComponent(extensions, MESSAGE_RETENTION_CODEC);
}
/** The `agent-text-stream.quic.v1` policy (`0x8006`). */
export function getAgentTextStreamPolicy(extensions) {
    return getComponent(extensions, AGENT_TEXT_STREAM_CODEC);
}
/** The `group.avatar-url.v1` component (`0x8007`). */
export function getGroupAvatarUrl(extensions) {
    return getComponent(extensions, GROUP_AVATAR_URL_CODEC);
}
/** The `group.encrypted-media.v1` policy (`0x8008`). */
export function getEncryptedMediaPolicy(extensions) {
    return getComponent(extensions, ENCRYPTED_MEDIA_CODEC);
}
// ---------------------------------------------------------------------------
// Typed entry builders (for create-time dictionaries and updates)
// ---------------------------------------------------------------------------
/** Builds the `app_components` advertising entry from a list of ids. */
export function appComponentsEntry(ids) {
    return entryFor(APP_COMPONENTS_CODEC, ids);
}
/** Builds the `group.profile.v1` entry. */
export function groupProfileEntry(profile) {
    return entryFor(GROUP_PROFILE_CODEC, profile);
}
/** Builds the `admin-policy.v1` entry from hex admin pubkeys. */
export function adminPolicyEntry(adminPubkeys) {
    return entryFor(ADMIN_POLICY_CODEC, adminPubkeys);
}
/** Builds the `transport.nostr.routing.v1` entry. */
export function nostrRoutingEntry(routing) {
    return entryFor(NOSTR_ROUTING_CODEC, routing);
}
/** Builds the `message-retention.v1` entry. */
export function messageRetentionEntry(seconds) {
    return entryFor(MESSAGE_RETENTION_CODEC, seconds);
}
/** Builds the `agent-text-stream.quic.v1` entry. */
export function agentTextStreamEntry(policy) {
    return entryFor(AGENT_TEXT_STREAM_CODEC, policy);
}
/** Builds the `group.avatar-url.v1` entry. */
export function groupAvatarUrlEntry(avatar) {
    return entryFor(GROUP_AVATAR_URL_CODEC, avatar);
}
/** Builds the `group.encrypted-media.v1` entry. */
export function encryptedMediaEntry(policy) {
    return entryFor(ENCRYPTED_MEDIA_CODEC, policy);
}
//# sourceMappingURL=dictionary.js.map