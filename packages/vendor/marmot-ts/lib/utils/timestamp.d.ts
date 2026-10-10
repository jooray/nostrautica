/** @module @category Utilities */
import { Lifetime } from "../vendor/ts-mls/index.js";
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
 * Creates the default produced KeyPackage lifetime: an 84-day range
 * (7,257,600 s — deliberately ~1h under the 7,261,200 s cap for headroom),
 * with `notBefore` backdated ~1h so a peer's minor clock skew does not
 * reject a just-published KeyPackage as not-yet-valid (D-07).
 *
 * @returns A lifetime object with notBefore backdated ~1h and notAfter 84 days after notBefore
 */
export declare function createDefaultKeyPackageLifetime(): Lifetime;
/**
 * Creates a lifetime with a 3-month expiration from the current time.
 *
 * @deprecated Use {@link createDefaultKeyPackageLifetime} instead.
 * @returns A lifetime object with notBefore set to current time and notAfter set to 3 months from now
 */
export declare function createThreeMonthLifetime(): Lifetime;
/**
 * Checks whether a lifetime's range is within the ≤7,261,200 s (84 days + 1h)
 * cap (D-08). This is a strict check — no grace is applied to the range
 * itself (only to the current-check, see {@link isLifetimeCurrentWithGrace}).
 *
 * @param lifetime - The lifetime object with notBefore and notAfter fields
 * @returns True if `notAfter - notBefore` is within the cap, false otherwise
 */
export declare function isLifetimeWithinCap(lifetime: Lifetime): boolean;
/**
 * Checks whether a lifetime is current, applying a symmetric ~1h grace
 * window to tolerate minor clock skew (D-08): rejects only if `now` is
 * before `notBefore - 3600` or after `notAfter + 3600`.
 *
 * @param lifetime - The lifetime object with notBefore and notAfter fields
 * @returns True if `now` is within the lifetime's range plus grace, false otherwise
 */
export declare function isLifetimeCurrentWithGrace(lifetime: Lifetime): boolean;
