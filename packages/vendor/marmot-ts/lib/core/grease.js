/** @module @category Core - Grease */
import { greaseValues } from "../vendor/ts-mls/index.js";
export const GREASE_VALUE_SET = new Set(greaseValues);
export function isGreaseValue(value) {
    return GREASE_VALUE_SET.has(value);
}
