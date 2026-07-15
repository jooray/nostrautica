/** @module @category Core - App Components */
/** Returns `true` when `hostname` resolves to a loopback IP or localhost domain. */
export declare function isLoopbackHost(hostname: string): boolean;
/**
 * Throws (with the given `label` prefix) when `hostname` points at a
 * non-routable address or at localhost. Mirrors the darkmatter host-safety
 * rejection performed inside `validate_and_normalize_*`.
 */
export declare function rejectNonRoutableHost(hostname: string, label: string): void;
