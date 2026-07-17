/** @module @category Core - Client State */
import { bytesToHex } from "@noble/hashes/utils.js";
import { clientStateDecoder, clientStateEncoder, ciphersuites, decode, defaultAppDataUpdateCallback, defaultKeyPackageEqualityConfig, defaultKeyRetentionConfig, defaultLifetimeConfig, defaultPaddingConfig, getAppDataDictionary, nodeTypes, encode, } from "ts-mls";
import { AGENT_TEXT_STREAM_QUIC_COMPONENT, AGENT_TEXT_STREAM_QUIC_COMPONENT_ID, APP_COMPONENTS_COMPONENT_ID, GROUP_ADMIN_POLICY_COMPONENT, GROUP_ADMIN_POLICY_COMPONENT_ID, GROUP_AVATAR_URL_COMPONENT, GROUP_AVATAR_URL_COMPONENT_ID, GROUP_BLOSSOM_IMAGE_COMPONENT, GROUP_BLOSSOM_IMAGE_COMPONENT_ID, GROUP_ENCRYPTED_MEDIA_COMPONENT, GROUP_ENCRYPTED_MEDIA_COMPONENT_ID, GROUP_MESSAGE_RETENTION_COMPONENT, GROUP_MESSAGE_RETENTION_COMPONENT_ID, GROUP_PROFILE_COMPONENT, GROUP_PROFILE_COMPONENT_ID, NOSTR_ROUTING_COMPONENT, NOSTR_ROUTING_COMPONENT_ID, decodeAdminPolicyV1, decodeAgentTextStreamQuicPolicyV1, decodeComponentsList, decodeEncryptedMediaPolicyV1, decodeGroupAvatarUrlV1, decodeGroupProfileV1, decodeMessageRetentionV1, decodeNostrRoutingV1, getAdminPolicy, getEncryptedMediaPolicy, getGroupAvatarUrl, getGroupProfile, getMessageRetention, getNostrRouting, } from "./components/index.js";
import { getGroupMembers } from "./group-members.js";
/** Default ClientConfig for Marmot. */
export const defaultMarmotClientConfig = {
    keyRetentionConfig: defaultKeyRetentionConfig,
    lifetimeConfig: defaultLifetimeConfig,
    keyPackageEqualityConfig: defaultKeyPackageEqualityConfig,
    paddingConfig: defaultPaddingConfig,
    // Marmot v2 app components use full-replacement update payloads, so the
    // default last-update-wins callback is the correct merge policy.
    appDataUpdateCallback: defaultAppDataUpdateCallback,
};
const COMPONENT_NAMES = new Map([
    [APP_COMPONENTS_COMPONENT_ID, "app_components"],
    [GROUP_PROFILE_COMPONENT_ID, GROUP_PROFILE_COMPONENT],
    [GROUP_BLOSSOM_IMAGE_COMPONENT_ID, GROUP_BLOSSOM_IMAGE_COMPONENT],
    [GROUP_ADMIN_POLICY_COMPONENT_ID, GROUP_ADMIN_POLICY_COMPONENT],
    [NOSTR_ROUTING_COMPONENT_ID, NOSTR_ROUTING_COMPONENT],
    [GROUP_MESSAGE_RETENTION_COMPONENT_ID, GROUP_MESSAGE_RETENTION_COMPONENT],
    [AGENT_TEXT_STREAM_QUIC_COMPONENT_ID, AGENT_TEXT_STREAM_QUIC_COMPONENT],
    [GROUP_AVATAR_URL_COMPONENT_ID, GROUP_AVATAR_URL_COMPONENT],
    [GROUP_ENCRYPTED_MEDIA_COMPONENT_ID, GROUP_ENCRYPTED_MEDIA_COMPONENT],
]);
const CIPHERSUITE_NAMES = new Map(Object.entries(ciphersuites).map(([name, id]) => [id, name]));
function componentIdHex(id) {
    return `0x${id.toString(16).padStart(4, "0")}`;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function decodeGroupComponent(componentId, data) {
    switch (componentId) {
        case APP_COMPONENTS_COMPONENT_ID:
            return decodeComponentsList(data);
        case GROUP_PROFILE_COMPONENT_ID:
            return decodeGroupProfileV1(data);
        case GROUP_ADMIN_POLICY_COMPONENT_ID:
            return decodeAdminPolicyV1(data);
        case NOSTR_ROUTING_COMPONENT_ID: {
            const routing = decodeNostrRoutingV1(data);
            return {
                nostrGroupId: routing.nostrGroupId,
                nostrGroupIdHex: bytesToHex(routing.nostrGroupId),
                relays: routing.relays,
            };
        }
        case GROUP_MESSAGE_RETENTION_COMPONENT_ID:
            return decodeMessageRetentionV1(data);
        case AGENT_TEXT_STREAM_QUIC_COMPONENT_ID:
            return decodeAgentTextStreamQuicPolicyV1(data);
        case GROUP_AVATAR_URL_COMPONENT_ID:
            return decodeGroupAvatarUrlV1(data);
        case GROUP_ENCRYPTED_MEDIA_COMPONENT_ID:
            return decodeEncryptedMediaPolicyV1(data);
        default:
            return undefined;
    }
}
function getGroupComponentInfos(clientState) {
    let dictionary;
    try {
        dictionary = getAppDataDictionary(clientState.groupContext.extensions);
    }
    catch (error) {
        return { components: [], decodeError: errorMessage(error) };
    }
    const components = (dictionary ?? []).map((entry) => {
        const info = {
            id: entry.componentId,
            idHex: componentIdHex(entry.componentId),
            name: COMPONENT_NAMES.get(entry.componentId) ?? "unknown",
            dataLength: entry.data.length,
            dataHex: bytesToHex(entry.data),
        };
        try {
            const decoded = decodeGroupComponent(entry.componentId, entry.data);
            if (decoded !== undefined)
                info.decoded = decoded;
        }
        catch (error) {
            info.decodeError = errorMessage(error);
        }
        return info;
    });
    return { components };
}
/**
 * Reads the Marmot group view from a ClientState or GroupInfo. Returns null when
 * the group carries no recognizable app components.
 */
export function getMarmotGroupView(clientState) {
    const extensions = clientState.groupContext.extensions;
    try {
        const profile = getGroupProfile(extensions);
        const adminPubkeys = getAdminPolicy(extensions);
        const routing = getNostrRouting(extensions);
        const avatar = getGroupAvatarUrl(extensions);
        const encryptedMedia = getEncryptedMediaPolicy(extensions);
        const messageRetention = getMessageRetention(extensions);
        if (!profile && !adminPubkeys && !routing)
            return null;
        return {
            nostrGroupId: routing?.nostrGroupId,
            name: profile?.name ?? "",
            description: profile?.description ?? "",
            adminPubkeys: adminPubkeys ?? [],
            relays: routing?.relays ?? [],
            avatarUrl: avatar?.url,
            encryptedMedia,
            messageRetention,
        };
    }
    catch {
        return null;
    }
}
function hasLocalClientState(state) {
    return "ratchetTree" in state;
}
/**
 * Builds a complete group information/debug projection from MLS state.
 *
 * This includes the private MLS group id and epoch details, decoded Marmot app
 * components, public Nostr routing details, and member identity summary.
 */
export function getMarmotGroupInfo(clientState) {
    const groupContext = clientState.groupContext;
    const view = getMarmotGroupView(clientState);
    const { components, decodeError } = getGroupComponentInfos(clientState);
    const appComponents = components.find((component) => component.id === APP_COMPONENTS_COMPONENT_ID);
    const requiredComponentIds = Array.isArray(appComponents?.decoded)
        ? appComponents.decoded.filter((id) => typeof id === "number")
        : [];
    const members = hasLocalClientState(clientState)
        ? getGroupMembers(clientState)
        : [];
    return {
        mls: {
            groupId: groupContext.groupId,
            groupIdHex: bytesToHex(groupContext.groupId),
            epoch: groupContext.epoch,
            epochNumber: Number(groupContext.epoch),
            epochString: groupContext.epoch.toString(),
            cipherSuite: groupContext.cipherSuite,
            cipherSuiteName: CIPHERSUITE_NAMES.get(groupContext.cipherSuite),
            treeHashHex: bytesToHex(groupContext.treeHash),
            confirmedTranscriptHashHex: bytesToHex(groupContext.confirmedTranscriptHash),
            confirmationTagHex: hasLocalClientState(clientState)
                ? bytesToHex(clientState.confirmationTag)
                : undefined,
            historicalEpochs: hasLocalClientState(clientState)
                ? Array.from(clientState.historicalReceiverData.keys()).map((epoch) => epoch.toString())
                : [],
            memberCount: hasLocalClientState(clientState)
                ? getMemberCount(clientState)
                : 0,
            proposalCount: hasLocalClientState(clientState)
                ? Object.keys(clientState.unappliedProposals).length
                : 0,
        },
        app: {
            view,
            components,
            componentCount: components.length,
            requiredComponentIds,
            decodeError,
        },
        nostr: {
            groupId: view?.nostrGroupId,
            groupIdHex: view?.nostrGroupId
                ? bytesToHex(view.nostrGroupId)
                : undefined,
            relays: view?.relays ?? [],
            relayCount: view?.relays.length ?? 0,
            hasRouting: !!view?.nostrGroupId,
        },
        members: {
            pubkeys: members,
            count: members.length,
        },
    };
}
/** Reads the hex id of the group from a ClientState or GroupInfo object */
export function getGroupIdHex(clientState) {
    return bytesToHex(clientState.groupContext.groupId);
}
export function getNostrGroupIdHex(clientState) {
    const routing = getNostrRouting(clientState.groupContext.extensions);
    if (!routing)
        throw new Error("nostr routing component not found in ClientState");
    return bytesToHex(routing.nostrGroupId);
}
/** Reads the epoch number from a ClientState or GroupInfo object */
export function getEpoch(clientState) {
    return Number(clientState.groupContext.epoch);
}
/** Reads the number of members in the group from a ClientState ratchet tree */
export function getMemberCount(clientState) {
    return clientState.ratchetTree.filter((node) => node && node.nodeType === nodeTypes.leaf).length;
}
/** Serializes a ClientState object to a bytes array */
export function serializeClientState(state) {
    return encode(clientStateEncoder, state);
}
/** Deserializes stored ClientState bytes (ts-mls TLS decoding). */
export function deserializeClientState(stored) {
    try {
        const decoded = decode(clientStateDecoder, stored);
        if (!decoded)
            throw new Error("Failed to deserialize ClientState: clientStateDecoder returned null");
        return decoded;
    }
    catch (error) {
        if (error instanceof Error)
            throw new Error(`Failed to deserialize ClientState: ${error.message}`);
        throw new Error("Failed to deserialize ClientState: Unknown error");
    }
}
//# sourceMappingURL=client-state.js.map