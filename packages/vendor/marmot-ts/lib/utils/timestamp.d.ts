/** @module @category Utilities */
import { Lifetime } from "ts-mls";
/**
 * Formats a bigint timestamp to a readable date string, handling special MLS timestamp values.
 *
 * @param timestamp - The timestamp as a bigint (typically from MLS lifetime fields)
 * @returns A formatted date string or descriptive text for special values
 */
export declare function formatMlsTimestamp(timestamp: bigint): string;
/**
 * Checks if a lifetime is currently valid, handling the "no expiration" case.
 *
 * @param lifetime - The lifetime object with notBefore and notAfter fields
 * @returns True if the lifetime is currently valid, false otherwise
 */
export declare function isLifetimeValid(lifetime: Lifetime): boolean;
/**
 * Creates a lifetime with a 3-month expiration from the current time.
 *
 * @returns A lifetime object with notBefore set to current time and notAfter set to 3 months from now
 */
export declare function createThreeMonthLifetime(): Lifetime;
