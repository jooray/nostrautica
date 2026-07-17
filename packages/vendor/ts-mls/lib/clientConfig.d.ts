import { AppDataUpdateCallback } from "./appDataUpdate.js";
import { KeyPackageEqualityConfig } from "./keyPackageEqualityConfig.js";
import { KeyRetentionConfig } from "./keyRetentionConfig.js";
import { LifetimeConfig } from "./lifetimeConfig.js";
import { PaddingConfig } from "./paddingConfig.js";
/** @public */
export interface ClientConfig {
    keyRetentionConfig: KeyRetentionConfig;
    lifetimeConfig: LifetimeConfig;
    keyPackageEqualityConfig: KeyPackageEqualityConfig;
    paddingConfig: PaddingConfig;
    appDataUpdateCallback: AppDataUpdateCallback;
}
export declare const defaultClientConfig: ClientConfig;
/**
 * Fills in defaults for any missing ClientConfig fields, so callers that
 * constructed a config before a field existed keep working at runtime.
 */
export declare function resolveClientConfig(clientConfig: ClientConfig | undefined): ClientConfig;
