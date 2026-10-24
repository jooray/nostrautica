import type { ClientState } from "../../vendor/ts-mls/index.js";
/** Public identity of an MLS source state; contains no exporter material. */
export declare function mediaSourceStateToken(state: ClientState): string;
/** Preparation must be repeated with a fresh nonce after the source changes. */
export declare class StaleMediaPreparationError extends Error {
    constructor();
}
