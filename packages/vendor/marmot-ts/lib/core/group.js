/** @module @category Core - Group */
import { randomBytes } from "@noble/hashes/utils.js";
import { createGroup as MLSCreateGroup, } from "ts-mls";
import { marmotAuthService } from "./auth-service.js";
import { marmotRequiredCapabilitiesExtension } from "./capabilities.js";
import { adminPolicyEntry, appComponentsEntry, groupProfileEntry, makeAppComponentsExtension, nostrRoutingEntry, } from "./components/index.js";
import { getCredentialPubkey } from "./credential.js";
export async function createGroup(params) {
    const { creatorKeyPackage, components, requiredComponentIds, extensions = [], ciphersuiteImpl, } = params;
    // The MLS group_id MUST be private and distinct from the public
    // nostr_group_id carried by the transport.nostr.routing component.
    const groupId = randomBytes(32);
    // Advertise the required component ids (defaults to whatever was provided),
    // then seed each component's state into the app_data_dictionary extension.
    const requiredIds = requiredComponentIds ?? components.map((c) => c.componentId);
    const appDataExtension = makeAppComponentsExtension([
        appComponentsEntry(requiredIds),
        ...components,
    ]);
    // Every Marmot group declares the protocol-mandatory required_capabilities so
    // MLS enforces them on every add (capability-negotiation.md §5.2). A caller
    // may override by supplying their own required_capabilities in `extensions`.
    const hasRequiredCapabilities = extensions.some((e) => e.extensionType === marmotRequiredCapabilitiesExtension().extensionType);
    const groupExtensions = [
        appDataExtension,
        ...(hasRequiredCapabilities ? [] : [marmotRequiredCapabilitiesExtension()]),
        ...extensions,
    ];
    const clientState = await MLSCreateGroup({
        context: {
            cipherSuite: ciphersuiteImpl,
            authService: marmotAuthService,
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
 * plus any extra admins), and — when relays are supplied — a
 * `transport.nostr.routing.v1` carrying a fresh nostr group id and the relays.
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
//# sourceMappingURL=group.js.map