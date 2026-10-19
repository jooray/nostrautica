/** @module @category Core - Welcome */
import { Rumor } from "applesauce-common/helpers/gift-wrap";
import { CiphersuiteImpl, type GroupInfo, KeyPackage, PrivateKeyPackage, type ClientState, type Welcome } from "../vendor/ts-mls/index.js";
import { type MarmotGroupView } from "./client-state.js";
/** Validates the full tentative Marmot state before any persistence or secret consumption. */
export declare function validateWelcomeGroup(state: ClientState, groupInfo: GroupInfo): string;
/**
 * Authenticates the {@link GroupInfo} through the full MLS Welcome validation,
 * without persisting or adopting the tentative joined state.
 *
 * @returns The decrypted GroupInfo
 * @throws Error if the key package does not match any secret in the welcome
 */
export declare function readWelcomeGroupInfo({ welcome, keyPackage, ciphersuiteImpl, }: {
    /** The MLS Welcome message (or a kind 444 Rumor) */
    welcome: Welcome | Rumor;
    /** The full key package (public + private) used to receive the invite */
    keyPackage: {
        publicPackage: KeyPackage;
        privatePackage: PrivateKeyPackage;
    };
    /** The ciphersuite implementation */
    ciphersuiteImpl: CiphersuiteImpl;
}): Promise<GroupInfo>;
/**
 * Reads the {@link MarmotGroupView} from a Welcome message using the provided
 * key package, without performing a full group join.
 *
 * Convenience wrapper around {@link readWelcomeGroupInfo} that projects the
 * app-component state from `groupInfo.groupContext.extensions`.
 *
 * @returns The group view, or null if no app components are present
 */
export declare function readWelcomeMarmotGroupView({ welcome, keyPackage, ciphersuiteImpl, }: {
    /** The MLS Welcome message (or a kind 444 Rumor) */
    welcome: Welcome | Rumor;
    /** The full key package (public + private) used to receive the invite */
    keyPackage: {
        publicPackage: KeyPackage;
        privatePackage: PrivateKeyPackage;
    };
    /** The ciphersuite implementation */
    ciphersuiteImpl: CiphersuiteImpl;
}): Promise<MarmotGroupView | null>;
