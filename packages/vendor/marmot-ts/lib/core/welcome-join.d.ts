/** @module @category Core - Welcome */
import { Rumor } from "applesauce-common/helpers/gift-wrap";
import { CiphersuiteImpl, type GroupInfo, KeyPackage, PrivateKeyPackage, type Welcome } from "ts-mls";
import { type MarmotGroupView } from "./client-state.js";
/**
 * Decrypts the {@link GroupInfo} from a Welcome message using the provided key package,
 * without performing a full group join.
 *
 * This is lighter than `joinGroup` — it stops after decrypting the group secrets
 * and group info, giving access to `groupContext` (group ID, epoch, extensions) and
 * `GroupInfo`-level extensions (ratchet tree, external pub).
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
