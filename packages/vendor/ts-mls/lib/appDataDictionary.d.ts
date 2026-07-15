import { Decoder } from "./codec/tlsDecoder.js";
import { Encoder } from "./codec/tlsEncoder.js";
import { CustomExtension, GroupContextExtension } from "./extension.js";
/**
 * The `app_data_dictionary` extension type defined in draft-ietf-mls-extensions-09.
 *
 * @public
 */
export declare const appDataDictionaryExtensionType = 6;
/**
 * A single entry in an {@link AppDataDictionary}, associating opaque application
 * data with a component id.
 *
 * @public
 */
export interface ComponentData {
    componentId: number;
    data: Uint8Array;
}
export declare const componentDataEncoder: Encoder<ComponentData>;
export declare const componentDataDecoder: Decoder<ComponentData>;
/**
 * The content of the `app_data_dictionary` extension. Entries MUST be sorted by
 * componentId and there MUST be at most one entry per componentId.
 *
 * @public
 */
export type AppDataDictionary = ComponentData[];
export declare const appDataDictionaryEncoder: Encoder<AppDataDictionary>;
export declare const appDataDictionaryDecoder: Decoder<AppDataDictionary>;
/**
 * Creates an `app_data_dictionary` GroupContext extension carrying the given dictionary.
 * The dictionary entries must be sorted by componentId with at most one entry per componentId.
 *
 * @public
 */
export declare function makeAppDataDictionaryExtension(dictionary: AppDataDictionary): CustomExtension;
/**
 * Reads the {@link AppDataDictionary} carried in an extension list. Returns undefined
 * if no `app_data_dictionary` extension is present.
 *
 * @public
 */
export declare function getAppDataDictionary(extensions: GroupContextExtension[]): AppDataDictionary | undefined;
