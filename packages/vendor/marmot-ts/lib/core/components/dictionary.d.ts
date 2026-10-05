/** @module @category Core - App Components */
import { AppDataDictionary, ComponentData, CustomExtension, GroupContextExtension } from "../../vendor/ts-mls/index.js";
import { AppComponentId } from "./ids.js";
import { GroupProfileV1 } from "./group-profile.js";
import { NostrRoutingV1 } from "./nostr-routing.js";
import { GroupAvatarUrlV1 } from "./avatar-url.js";
import { GroupBlossomImageV1 } from "./blossom-image.js";
import { EncryptedMediaPolicyV1 } from "./encrypted-media.js";
import { EncryptedMediaPolicyV2 } from "./encrypted-media-v2.js";
import { AgentTextStreamQuicPolicyV1 } from "./agent-text-stream.js";
import { GroupProtocolLifecycleValue } from "./group-lifecycle.js";
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
 *
 * Also refuses a `0x8009` data entry (`ACCOUNT_IDENTITY_PROOF_COMPONENT_ID`):
 * the account identity proof is LeafNode-only data and MUST NOT be created as
 * GroupContext state (PROOF-06, D-08). A `0x0001` required-component-id list
 * that merely names `0x8009` is unaffected by this guard — only a keyed data
 * entry is rejected.
 */
export declare function makeAppComponentsExtension(entries: ComponentData[]): CustomExtension;
/**
 * Builds the `app_data_dictionary` extension carried on a key package's LeafNode
 * to advertise the component ids this member supports and carry its `0x8009`
 * account identity proof. Mirrors MDK's `leaf_app_components_extension`
 * (`refs/mdk/crates/cgka-engine/src/app_components.rs`): the dictionary holds
 * exactly three entries — the `app_components` (`0x0001`) advertising list
 * (sorted, de-duplicated, always including `0x8009` regardless of whether
 * `supportedIds` names it), an empty SafeAAD (`0x0002`) list, and the `0x8009`
 * proof data itself. This structure is correct by construction: one advertising
 * list, an empty SafeAAD, and exactly one proof entry.
 *
 * @param proof The 104-byte encoded `0x8009` account identity proof
 *   (see `produceAccountIdentityProof`). Throws `UsageError` if not exactly
 *   {@link AUTHORIZATION_PROOF_LENGTH} bytes.
 * @param supportedIds Component ids advertised in the `app_components` list,
 *   defaulting to {@link SUPPORTED_APP_COMPONENT_IDS}.
 */
export declare function makeLeafAppComponentsExtension(proof: Uint8Array, supportedIds?: readonly AppComponentId[]): CustomExtension;
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
/** The `group.blossom.image.v1` encrypted group image (`0x8002`). */
export declare function getGroupBlossomImage(extensions: GroupContextExtension[]): GroupBlossomImageV1 | undefined;
/** The `group.encrypted-media.v1` policy (`0x8008`). */
export declare function getEncryptedMediaPolicy(extensions: GroupContextExtension[]): EncryptedMediaPolicyV1 | undefined;
/** The `group.encrypted-media.v2` policy (`0x800b`). */
export declare function getEncryptedMediaPolicyV2(extensions: GroupContextExtension[]): EncryptedMediaPolicyV2 | undefined;
/** The `group.lifecycle.v1` protocol state (`0x800c`). */
export declare function getGroupLifecycle(extensions: GroupContextExtension[]): GroupProtocolLifecycleValue | undefined;
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
/** Builds the `group.blossom.image.v1` entry (an empty state clears the image). */
export declare function groupBlossomImageEntry(image: GroupBlossomImageV1): ComponentData;
/** Builds the `group.encrypted-media.v1` entry. */
export declare function encryptedMediaEntry(policy: EncryptedMediaPolicyV1): ComponentData;
/** Builds the `group.encrypted-media.v2` entry. */
export declare function encryptedMediaV2Entry(policy: EncryptedMediaPolicyV2): ComponentData;
/** Builds the `group.lifecycle.v1` entry. */
export declare function groupLifecycleEntry(value: GroupProtocolLifecycleValue): ComponentData;
