import { CiphersuiteImpl, ClientState, ComponentData, GroupContextExtension } from "../vendor/ts-mls/index.js";
import { AppComponentId, type EncryptedMediaPolicyV2 } from "./components/index.js";
import { CompleteKeyPackage } from "./key-package.js";
export interface CreateGroupParams {
    /** Creator's complete key package (public + private) */
    creatorKeyPackage: CompleteKeyPackage;
    /**
     * Initial app components seeded into the group's `app_data_dictionary`
     * GroupContext extension. The `app_components` (`0x0001`) advertising entry is
     * added automatically from {@link requiredComponentIds}.
     */
    components: ComponentData[];
    /**
     * Component ids advertised in the `app_components` (`0x0001`) entry. Defaults
     * to the ids present in {@link components}.
     */
    requiredComponentIds?: AppComponentId[];
    /** Additional group context extensions (optional) */
    extensions?: GroupContextExtension[];
    /** Cipher suite implementation for cryptographic operations */
    ciphersuiteImpl: CiphersuiteImpl;
}
export interface CreateGroupResult {
    /** The ClientState for the created group */
    clientState: ClientState;
}
export declare function createGroup(params: CreateGroupParams): Promise<CreateGroupResult>;
export type SimpleGroupOptions = {
    description?: string;
    adminPubkeys?: string[];
    relays?: string[];
    /**
     * The group's `marmot.group.encrypted-media.v2` (`0x800b`) policy. Defaults
     * to a Blossom policy over {@link DEFAULT_ENCRYPTED_MEDIA_BLOB_ENDPOINTS},
     * which is what MDK puts in every new current-profile group. Pass `false`
     * for a non-media group (`protocol-core/group-setup.md` lets it omit the
     * component), e.g. to invite peers whose KeyPackages lack `0x800b`.
     */
    encryptedMedia?: EncryptedMediaPolicyV2 | false;
};
/**
 * Creates a Marmot v2 group seeded with the default group components: a
 * `group.profile.v1` (name + description), an `admin-policy.v1` (the creator
 * plus any extra admins), a `group.encrypted-media.v2` media policy (unless
 * `options.encryptedMedia` is `false`), and — when relays are supplied — a
 * `transport.nostr.routing.v1` carrying a fresh nostr group id and the relays.
 * Every seeded component is listed as required, so invitees must advertise
 * support for it (MDK requires `0x800b` the same way).
 */
export declare function createSimpleGroup(creatorKeyPackage: CompleteKeyPackage, ciphersuiteImpl: CiphersuiteImpl, groupName?: string, options?: SimpleGroupOptions): Promise<CreateGroupResult>;
