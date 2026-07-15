import { Decoder } from "./codec/tlsDecoder.js";
import { Encoder } from "./codec/tlsEncoder.js";
import { GroupContextExtension } from "./extension.js";
/**
 * The `app_data_update` proposal type defined in draft-ietf-mls-extensions-09.
 *
 * @public
 */
export declare const appDataUpdateProposalType = 8;
/**
 * The AppDataUpdateOperation values defined in draft-ietf-mls-extensions-09.
 *
 * @public
 */
export declare const appDataUpdateOperations: {
    readonly update: 1;
    readonly remove: 2;
};
/** @public */
export type AppDataUpdateOperationName = keyof typeof appDataUpdateOperations;
/**
 * The content of an `app_data_update` proposal (draft-ietf-mls-extensions-09):
 * either replaces the application data for a component or removes the component's
 * entry from the `app_data_dictionary` GroupContext extension.
 *
 * @public
 */
export type AppDataUpdate = {
    componentId: number;
    operation: "update";
    update: Uint8Array;
} | {
    componentId: number;
    operation: "remove";
};
export declare const appDataUpdateEncoder: Encoder<AppDataUpdate>;
export declare const appDataUpdateDecoder: Decoder<AppDataUpdate>;
/**
 * The application logic that interprets the update payloads of `app_data_update`
 * proposals for a component (draft-ietf-mls-extensions-09 Section 4.7).
 *
 * Receives the componentId, the current data stored for the component (or undefined
 * if no entry exists) and the update payloads for the component in commit order.
 * Returns the new data to store for the component, or undefined if the application
 * considers the updates invalid, which invalidates the whole proposal list.
 *
 * @public
 */
export type AppDataUpdateCallback = (componentId: number, currentData: Uint8Array | undefined, updates: Uint8Array[]) => Uint8Array | undefined;
/**
 * The default {@link AppDataUpdateCallback}: each update payload fully replaces the
 * component's data, so the last update for a component wins.
 *
 * @public
 */
export declare const defaultAppDataUpdateCallback: AppDataUpdateCallback;
/**
 * Applies a list of AppDataUpdates (in commit order) to the `app_data_dictionary`
 * extension contained in the given GroupContext extension list, per
 * draft-ietf-mls-extensions-09 Section 4.7. Returns the new extension list.
 */
export declare function applyAppDataUpdates(extensions: GroupContextExtension[], updates: AppDataUpdate[], callback: AppDataUpdateCallback): GroupContextExtension[];
