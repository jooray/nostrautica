/** @module @category Core - Extensions */
import { type CustomExtension } from "../vendor/ts-mls/index.js";
/** Checks if an extension is the last_resort extension */
export declare function isLastResortExtension(extension: CustomExtension): extension is CustomExtension;
/**
 * Modifies an {@link CustomExtension} array to ensure it includes the last_resort extension.
 * This is useful for ensuring that key packages are compliant with `foundation/key-packages.md` (`last_resort_key_package`).
 *
 * @param extensions - The extensions to modify
 * @returns The modified extensions
 */
export declare function ensureLastResortExtension(extensions: CustomExtension[]): CustomExtension[];
/** Replaces an extension in an array of extensions */
export declare function replaceExtension(extensions: Array<{
    extensionType: number;
}>, extension: {
    extensionType: number;
}): Array<{
    extensionType: number;
}>;
