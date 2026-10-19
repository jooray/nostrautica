/** @module @category Core - Group */
import { randomBytes } from "@noble/hashes/utils.js";
import { appDataDictionaryExtensionType, createGroup as MLSCreateGroup, } from "../vendor/ts-mls/index.js";
import { marmotAuthService } from "./auth-service.js";
import { defaultMarmotClientConfig } from "./client-config.js";
import { marmotRequiredCapabilitiesExtension } from "./capabilities.js";
import { adminPolicyEntry, appComponentsEntry, DEFAULT_ENCRYPTED_MEDIA_BLOB_ENDPOINTS, DEFAULT_GROUP_COMPONENT_IDS, encryptedMediaV2BlossomDefault, encryptedMediaV2Entry, GROUP_LIFECYCLE_COMPONENT_ID, groupLifecycleEntry, groupProtocolLifecycleValues, groupProfileEntry, makeAppComponentsExtension, nostrRoutingEntry, } from "./components/index.js";
import { getCredentialPubkey } from "./credential.js";
/** Thrown when caller-supplied GroupContext extensions are invalid. */
export class InvalidGroupContextExtensionError extends Error {
    constructor(message) {
        super(message);
        this.name = "InvalidGroupContextExtensionError";
    }
}
export async function createGroup(params) {
    const { creatorKeyPackage, components, requiredComponentIds, extensions = [], ciphersuiteImpl, } = params;
    const extensionTypes = new Set();
    for (const extension of extensions) {
        if (extension.extensionType === appDataDictionaryExtensionType) {
            throw new InvalidGroupContextExtensionError("app_data_dictionary must not be supplied in extensions; put dictionary data in components");
        }
        if (extensionTypes.has(extension.extensionType)) {
            throw new InvalidGroupContextExtensionError(`Duplicate group context extension type: ${extension.extensionType}`);
        }
        extensionTypes.add(extension.extensionType);
    }
    // The MLS group_id MUST be private and distinct from the public
    // nostr_group_id carried by the transport.nostr.routing component.
    const groupId = randomBytes(32);
    // Advertise the required component ids (defaults to whatever was provided),
    // then seed each component's state into the app_data_dictionary extension.
    const requiredIds = [
        ...new Set([
            ...DEFAULT_GROUP_COMPONENT_IDS,
            ...(requiredComponentIds ?? components.map((c) => c.componentId)),
        ]),
    ];
    const initialComponents = components.some((component) => component.componentId === GROUP_LIFECYCLE_COMPONENT_ID)
        ? components
        : [...components, groupLifecycleEntry(groupProtocolLifecycleValues.active)];
    const appDataExtension = makeAppComponentsExtension([
        appComponentsEntry(requiredIds),
        ...initialComponents,
    ]);
    // Every Marmot group declares the protocol-mandatory required_capabilities so
    // MLS enforces them on every add (capability-negotiation.md §5.2). A caller
    // may override by supplying their own required_capabilities in `extensions`.
    const hasRequiredCapabilities = extensions.some((e) => e.extensionType === marmotRequiredCapabilitiesExtension().extensionType);
    // Keep the dictionary last, matching MDK: app_data_update replaces it in
    // place in ts-mls, while OpenMLS removes it and appends it to the end.
    const groupExtensions = [
        ...(hasRequiredCapabilities ? [] : [marmotRequiredCapabilitiesExtension()]),
        ...extensions,
        appDataExtension,
    ];
    const clientState = await MLSCreateGroup({
        context: {
            cipherSuite: ciphersuiteImpl,
            authService: marmotAuthService,
            clientConfig: defaultMarmotClientConfig,
        },
        groupId,
        keyPackage: creatorKeyPackage.publicPackage,
        privateKeyPackage: creatorKeyPackage.privatePackage,
        extensions: groupExtensions,
    });
    return { clientState };
}
/**
 * Creates a Marmot v2 group seeded with the default group components: a
 * `group.profile.v1` (name + description), an `admin-policy.v1` (the creator
 * plus any extra admins), a `group.encrypted-media.v2` media policy (unless
 * `options.encryptedMedia` is `false`), and — when relays are supplied — a
 * `transport.nostr.routing.v1` carrying a fresh nostr group id and the relays.
 * Every seeded component is listed as required, so invitees must advertise
 * support for it (MDK requires `0x800b` the same way).
 */
export async function createSimpleGroup(creatorKeyPackage, ciphersuiteImpl, groupName = "New Group", options) {
    // The creator is always an admin (matches darkmatter's create flow).
    const creatorPubkey = getCredentialPubkey(creatorKeyPackage.publicPackage.leafNode.credential);
    const adminPubkeys = [
        ...new Set([creatorPubkey, ...(options?.adminPubkeys ?? [])]),
    ];
    const components = [
        groupProfileEntry({
            name: groupName,
            description: options?.description ?? "",
        }),
        adminPolicyEntry(adminPubkeys),
    ];
    // Media-capable profile: new groups carry and require 0x800b, like MDK
    // (`protocol-core/group-setup.md` "Creation flow"; MDK
    // `encrypted_media_component_for_new_group`).
    if (options?.encryptedMedia !== false) {
        components.push(encryptedMediaV2Entry(options?.encryptedMedia ??
            encryptedMediaV2BlossomDefault([
                ...DEFAULT_ENCRYPTED_MEDIA_BLOB_ENDPOINTS,
            ])));
    }
    const relays = options?.relays ?? [];
    if (relays.length > 0) {
        components.push(nostrRoutingEntry({ nostrGroupId: randomBytes(32), relays }));
    }
    return createGroup({
        creatorKeyPackage,
        components,
        ciphersuiteImpl,
    });
}
