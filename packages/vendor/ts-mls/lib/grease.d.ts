import { Capabilities } from "./capabilities.js";
import { CustomExtension } from "./extension.js";
/** @public */
export declare const greaseValues: readonly [2570, 6682, 10794, 14906, 19018, 23130, 27242, 31354, 35466, 39578, 43690, 47802, 51914, 56026, 60138];
/** @public */
export interface GreaseConfig {
    probabilityPerGreaseValue: number;
}
export declare const defaultGreaseConfig: {
    probabilityPerGreaseValue: number;
};
/** @public */
export declare function greaseExtensions(greaseConfig: GreaseConfig): CustomExtension[];
/** @public */
export declare function greaseCapabilities(config: GreaseConfig, capabilities: Capabilities): Capabilities;
