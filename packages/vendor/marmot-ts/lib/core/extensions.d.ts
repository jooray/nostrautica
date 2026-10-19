/** @module @category Core - Extensions */
import { type CustomExtension } from "../vendor/ts-mls/index.js";
/** Checks if an extension is the last_resort extension */
export declare function isLastResortExtension(extension: CustomExtension): extension is CustomExtension;
/**
 * Public compatibility helper for the legacy MLS last_resort extension (0x000a).
 * Returns the supplied array if present, or a new array with that extension added.
 * Current Marmot KeyPackage generation uses the canonical empty app-data component
 * 0x0004 for `foundation/key-packages.md` (`last_resort_key_package`) instead;
 * see the canonical last_resort generation tests in `__tests__/key-package.test.ts`.
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
