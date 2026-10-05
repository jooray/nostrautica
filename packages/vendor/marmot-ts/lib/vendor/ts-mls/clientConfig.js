import { defaultAppDataUpdateCallback } from "./appDataUpdate.js";
import { defaultKeyPackageEqualityConfig } from "./keyPackageEqualityConfig.js";
import { defaultKeyRetentionConfig } from "./keyRetentionConfig.js";
import { defaultLifetimeConfig } from "./lifetimeConfig.js";
import { defaultPaddingConfig } from "./paddingConfig.js";
export const defaultClientConfig = {
    keyRetentionConfig: defaultKeyRetentionConfig,
    lifetimeConfig: defaultLifetimeConfig,
    keyPackageEqualityConfig: defaultKeyPackageEqualityConfig,
    paddingConfig: defaultPaddingConfig,
    appDataUpdateCallback: defaultAppDataUpdateCallback,
};
/**
 * Fills in defaults for any missing ClientConfig fields, so callers that
 * constructed a config before a field existed keep working at runtime.
 */
export function resolveClientConfig(clientConfig) {
    return clientConfig === undefined ? defaultClientConfig : { ...defaultClientConfig, ...clientConfig };
}
