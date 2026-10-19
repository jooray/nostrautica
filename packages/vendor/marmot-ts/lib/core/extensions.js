/** @module @category Core - Extensions */
import { makeCustomExtension } from "../vendor/ts-mls/index.js";
import { LAST_RESORT_EXTENSION_TYPE } from "./protocol.js";
/** Checks if an extension is the last_resort extension */
export function isLastResortExtension(extension) {
    return (typeof extension.extensionType === "number" &&
        extension.extensionType === LAST_RESORT_EXTENSION_TYPE);
}
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
export function ensureLastResortExtension(extensions) {
    if (extensions.some((ext) => typeof ext.extensionType === "number" &&
        ext.extensionType === LAST_RESORT_EXTENSION_TYPE))
        return extensions;
    return [
        ...extensions,
        makeCustomExtension({
            extensionType: LAST_RESORT_EXTENSION_TYPE,
            extensionData: new Uint8Array(0),
        }),
    ];
}
/** Replaces an extension in an array of extensions */
export function replaceExtension(extensions, extension) {
    return extensions.map((ext) => ext.extensionType === extension.extensionType ? extension : ext);
}
