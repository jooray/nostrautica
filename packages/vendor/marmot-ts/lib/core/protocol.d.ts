/** The extension id for the last_resort extension for key packages */
export declare const LAST_RESORT_EXTENSION_TYPE = 10;
/**
 * NIP-65 relay list event kind. Marmot uses an account's NIP-65 list to
 * discover where it publishes and fetches KeyPackages; there is no dedicated
 * KeyPackage relay list (transports/nostr.md "KeyPackage publication").
 */
export declare const NIP65_RELAY_LIST_KIND = 10002;
/** The NIP-65 relay tag (`r`), optionally followed by a read/write marker. */
export declare const NIP65_RELAY_TAG = "r";
/**
 * Marmot inbox relay list event kind (kind 10050). Welcomes are gift-wrapped to
 * the recipient's inbox relay set (transports/nostr.md "Publish targets").
 */
export declare const INBOX_RELAY_LIST_KIND = 10050;
/** The inbox relay-list tag (`relay`) carrying a single relay URL. */
export declare const INBOX_RELAY_TAG = "relay";
/** Event kind for addressable key package events */
export declare const ADDRESSABLE_KEY_PACKAGE_KIND = 30443;
/** The name of the tag that contains the MLS protocol version */
export declare const KEY_PACKAGE_MLS_VERSION_TAG = "mls_protocol_version";
/** The name of the tag that contains the MLS cipher suite */
export declare const KEY_PACKAGE_CIPHER_SUITE_TAG = "mls_ciphersuite";
/** The name of the tag that contains the MLS extensions */
export declare const KEY_PACKAGE_EXTENSIONS_TAG = "mls_extensions";
/** The name of the tag that contains the supported MLS proposal ids */
export declare const KEY_PACKAGE_PROPOSALS_TAG = "mls_proposals";
/** The name of the tag that contains the supported Marmot app-component ids */
export declare const KEY_PACKAGE_APP_COMPONENTS_TAG = "app_components";
/** The name of the tag that contains the relays */
export declare const KEY_PACKAGE_RELAYS_TAG = "relays";
/** The name of the tag that contains the client */
export declare const KEY_PACKAGE_CLIENT_TAG = "client";
/** The possible MLS protocol versions */
export type MLS_VERSIONS = "1.0";
/** Parsed client tag from a kind 30443 event */
export type KeyPackageClient = {
    name: string;
};
/** Extended extension types that include Marmot-specific extensions */
export declare const extendedExtensionTypes: {
    readonly last_resort: 10;
    readonly application_id: 1;
    readonly ratchet_tree: 2;
    readonly required_capabilities: 3;
    readonly external_pub: 4;
    readonly external_senders: 5;
};
export type ExtendedExtensionTypeName = keyof typeof extendedExtensionTypes;
export type ExtendedExtensionTypeValue = (typeof extendedExtensionTypes)[ExtendedExtensionTypeName];
/** Event kind for group events (commits, proposals, application messages) */
export declare const GROUP_EVENT_KIND = 445;
/** Event kind for welcome events */
export declare const WELCOME_EVENT_KIND = 444;
