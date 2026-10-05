/** @module @category Core - Extensions */
import { type CustomExtension, type KeyPackage } from "../vendor/ts-mls/index.js";
/**
 * Checks if an extension is the legacy `last_resort` KeyPackage extension
 * (`0x000a`).
 *
 * @deprecated Marmot marks last-resort KeyPackages with the
 * `last_resort_key_package` component (`0x0004`) in the KeyPackage
 * `app_data_dictionary`, not with this extension. Use
 * {@link isLastResortKeyPackage}, which recognizes both.
 */
export declare function isLastResortExtension(extension: CustomExtension): extension is CustomExtension;
/**
 * Whether a KeyPackage is marked last-resort: its KeyPackage extensions carry
 * an `app_data_dictionary` with an empty-data `last_resort_key_package`
 * (`0x0004`) entry (`foundation/key-packages.md`). The legacy `last_resort`
 * extension (`0x000a`) is also recognized so KeyPackages published by older
 * releases still read as last-resort, matching OpenMLS `KeyPackage::last_resort`.
 */
export declare function isLastResortKeyPackage(keyPackage: KeyPackage): boolean;
/**
 * Returns KeyPackage extensions that mark the KeyPackage as last-resort.
 *
 * Marmot marks a last-resort KeyPackage with an empty-data
 * `last_resort_key_package` component (`0x0004`) in an `app_data_dictionary`
 * KeyPackage extension (`foundation/key-packages.md`, `foundation/registries.md`):
 * "Last-resort status is not an MLS capability or extension type." This is the
 * same encoding OpenMLS (and so MDK / White Noise) emits from
 * `KeyPackageBuilder::mark_as_last_resort` with the `extensions-draft` feature.
 *
 * An existing `app_data_dictionary` extension gets the entry merged in; a legacy
 * `last_resort` extension (`0x000a`) is dropped. Returns the input array
 * unchanged when it already carries the component entry and no legacy extension.
 *
 * @param extensions - The KeyPackage extensions to modify
 * @returns The extensions with the last-resort marker
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
