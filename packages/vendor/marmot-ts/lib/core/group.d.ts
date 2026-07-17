import { CiphersuiteImpl, ClientState, ComponentData, GroupContextExtension } from "ts-mls";
import { AppComponentId } from "./components/index.js";
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
};
/**
 * Creates a Marmot v2 group seeded with the default group components: a
 * `group.profile.v1` (name + description), an `admin-policy.v1` (the creator
 * plus any extra admins), and — when relays are supplied — a
 * `transport.nostr.routing.v1` carrying a fresh nostr group id and the relays.
 */
export declare function createSimpleGroup(creatorKeyPackage: CompleteKeyPackage, ciphersuiteImpl: CiphersuiteImpl, groupName?: string, options?: SimpleGroupOptions): Promise<CreateGroupResult>;
