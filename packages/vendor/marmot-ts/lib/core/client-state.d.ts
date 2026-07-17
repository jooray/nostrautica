import { ClientConfig, ClientState, GroupInfo } from "ts-mls";
import { type EncryptedMediaPolicyV1 } from "./components/index.js";
/** Default ClientConfig for Marmot. */
export declare const defaultMarmotClientConfig: ClientConfig;
/**
 * A read projection of a Marmot group's app-component state, assembled from the
 * group-scoped components in the MLS `app_data_dictionary` extension. This is
 * the v2 replacement for the legacy `MarmotGroupData` monolith.
 */
export interface MarmotGroupView {
    /** Public 32-byte nostr group id (from nostr routing), if routing is set. */
    nostrGroupId?: Uint8Array;
    /** Group display name (from the profile component). */
    name: string;
    /** Group description (from the profile component). */
    description: string;
    /** Admin nostr pubkeys (hex), from the admin-policy component. */
    adminPubkeys: string[];
    /** Nostr relay URLs (from nostr routing). */
    relays: string[];
    /** Group avatar URL (`group.avatar-url.v1`, `0x8007`), if set. */
    avatarUrl?: string;
    /**
     * Group encrypted-media policy (`group.encrypted-media.v1`, `0x8008`): the
     * group-scoped blob-store endpoints and format, if set.
     */
    encryptedMedia?: EncryptedMediaPolicyV1;
    /**
     * Message-retention window in seconds (`message-retention.v1`, `0x8005`), if
     * set; `0n` means retain indefinitely.
     */
    messageRetention?: bigint;
}
export type MarmotGroupDecodedComponent = number[] | string[] | string | bigint | object;
/** Raw and decoded details for one app component in the MLS app_data_dictionary. */
export interface MarmotGroupComponentInfo {
    /** Numeric MLS ComponentID. */
    id: number;
    /** Hex ComponentID, padded to uint16 width for display. */
    idHex: string;
    /** Known Marmot component name, or `unknown` for unrecognized ids. */
    name: string;
    /** Raw component data byte length. */
    dataLength: number;
    /** Raw component data as hex for protocol debugging. */
    dataHex: string;
    /** Decoded known component payload. Omitted when the component is unknown or invalid. */
    decoded?: MarmotGroupDecodedComponent;
    /** Decode failure for a known component. */
    decodeError?: string;
}
/** Debug-oriented projection suitable for a chat/group info panel. */
export interface MarmotGroupInfo {
    /** MLS protocol identifiers and epoch state. */
    mls: {
        groupId: Uint8Array;
        groupIdHex: string;
        epoch: bigint;
        epochNumber: number;
        epochString: string;
        cipherSuite: number;
        cipherSuiteName?: string;
        treeHashHex: string;
        confirmedTranscriptHashHex: string;
        confirmationTagHex?: string;
        historicalEpochs: string[];
        memberCount: number;
        proposalCount: number;
    };
    /** Marmot app-component state carried by the MLS group context. */
    app: {
        view: MarmotGroupView | null;
        components: MarmotGroupComponentInfo[];
        componentCount: number;
        requiredComponentIds: number[];
        decodeError?: string;
    };
    /** Public Nostr transport routing identity and relay set. */
    nostr: {
        groupId?: Uint8Array;
        groupIdHex?: string;
        relays: string[];
        relayCount: number;
        hasRouting: boolean;
    };
    /** Member identity summary decoded from the ratchet tree. */
    members: {
        pubkeys: string[];
        count: number;
    };
}
/**
 * Reads the Marmot group view from a ClientState or GroupInfo. Returns null when
 * the group carries no recognizable app components.
 */
export declare function getMarmotGroupView(clientState: ClientState | GroupInfo): MarmotGroupView | null;
/**
 * Builds a complete group information/debug projection from MLS state.
 *
 * This includes the private MLS group id and epoch details, decoded Marmot app
 * components, public Nostr routing details, and member identity summary.
 */
export declare function getMarmotGroupInfo(clientState: ClientState | GroupInfo): MarmotGroupInfo;
/** Reads the hex id of the group from a ClientState or GroupInfo object */
export declare function getGroupIdHex(clientState: ClientState | GroupInfo): string;
export declare function getNostrGroupIdHex(clientState: ClientState): string;
/** Reads the epoch number from a ClientState or GroupInfo object */
export declare function getEpoch(clientState: ClientState | GroupInfo): number;
/** Reads the number of members in the group from a ClientState ratchet tree */
export declare function getMemberCount(clientState: ClientState): number;
/** The serialized form of ClientState for storage (ts-mls TLS encoding). */
export type SerializedClientState = Uint8Array;
/** Serializes a ClientState object to a bytes array */
export declare function serializeClientState(state: ClientState): SerializedClientState;
/** Deserializes stored ClientState bytes (ts-mls TLS decoding). */
export declare function deserializeClientState(stored: SerializedClientState): ClientState;
