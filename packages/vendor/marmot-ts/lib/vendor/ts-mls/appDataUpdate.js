import { uint16Decoder, uint16Encoder, uint8Decoder, uint8Encoder } from "./codec/number.js";
import { failDecoder, flatMapDecoder, mapDecoder, mapDecoders, succeedDecoder } from "./codec/tlsDecoder.js";
import { contramapBufferEncoders } from "./codec/tlsEncoder.js";
import { varLenDataDecoder, varLenDataEncoder } from "./codec/variableLength.js";
import { appDataDictionaryExtensionType, getAppDataDictionary, makeAppDataDictionaryExtension, } from "./appDataDictionary.js";
import { ValidationError } from "./mlsError.js";
/**
 * The `app_data_update` proposal type defined in draft-ietf-mls-extensions-09.
 *
 * @public
 */
export const appDataUpdateProposalType = 8;
/**
 * The AppDataUpdateOperation values defined in draft-ietf-mls-extensions-09.
 *
 * @public
 */
export const appDataUpdateOperations = {
    update: 1,
    remove: 2,
};
const appDataUpdateUpdateEncoder = contramapBufferEncoders([uint16Encoder, uint8Encoder, varLenDataEncoder], (u) => [u.componentId, appDataUpdateOperations.update, u.update]);
const appDataUpdateRemoveEncoder = contramapBufferEncoders([uint16Encoder, uint8Encoder], (u) => [u.componentId, appDataUpdateOperations.remove]);
export const appDataUpdateEncoder = (u) => u.operation === "update" ? appDataUpdateUpdateEncoder(u) : appDataUpdateRemoveEncoder(u);
export const appDataUpdateDecoder = flatMapDecoder(mapDecoders([uint16Decoder, uint8Decoder], (componentId, operation) => ({ componentId, operation })), ({ componentId, operation }) => {
    switch (operation) {
        case appDataUpdateOperations.update:
            return mapDecoder(varLenDataDecoder, (update) => ({ componentId, operation: "update", update }));
        case appDataUpdateOperations.remove:
            return succeedDecoder({ componentId, operation: "remove" });
        default:
            return failDecoder();
    }
});
/**
 * The default {@link AppDataUpdateCallback}: each update payload fully replaces the
 * component's data, so the last update for a component wins.
 *
 * @public
 */
export const defaultAppDataUpdateCallback = (_componentId, _currentData, updates) => updates.at(-1);
/**
 * Applies a list of AppDataUpdates (in commit order) to the `app_data_dictionary`
 * extension contained in the given GroupContext extension list, per
 * draft-ietf-mls-extensions-09 Section 4.7. Returns the new extension list.
 */
export function applyAppDataUpdates(extensions, updates, callback) {
    const dictionary = [...(getAppDataDictionary(extensions) ?? [])];
    const updatesByComponent = new Map();
    for (const update of updates) {
        const componentUpdates = updatesByComponent.get(update.componentId) ?? [];
        componentUpdates.push(update);
        updatesByComponent.set(update.componentId, componentUpdates);
    }
    for (const [componentId, componentUpdates] of updatesByComponent) {
        const entryIndex = dictionary.findIndex((e) => e.componentId === componentId);
        const containsRemove = componentUpdates.some((u) => u.operation === "remove");
        if (containsRemove) {
            if (componentUpdates.length > 1)
                throw new ValidationError("Commit cannot contain multiple AppDataUpdate proposals that remove state for the same component or both update and remove state for the same component");
            if (entryIndex === -1)
                throw new ValidationError("AppDataUpdate cannot remove state for a component that has no state present");
            dictionary.splice(entryIndex, 1);
        }
        else {
            const newData = callback(componentId, entryIndex === -1 ? undefined : dictionary[entryIndex].data, componentUpdates.flatMap((u) => (u.operation === "update" ? [u.update] : [])));
            if (newData === undefined)
                throw new ValidationError("Application logic considered the AppDataUpdate proposals for a component invalid");
            if (entryIndex === -1) {
                const insertAt = dictionary.findIndex((e) => e.componentId > componentId);
                dictionary.splice(insertAt === -1 ? dictionary.length : insertAt, 0, { componentId, data: newData });
            }
            else {
                dictionary[entryIndex] = { componentId, data: newData };
            }
        }
    }
    const newExtension = makeAppDataDictionaryExtension(dictionary);
    const extensionIndex = extensions.findIndex((e) => e.extensionType === appDataDictionaryExtensionType);
    return extensionIndex === -1
        ? [...extensions, newExtension]
        : extensions.map((e, i) => (i === extensionIndex ? newExtension : e));
}
