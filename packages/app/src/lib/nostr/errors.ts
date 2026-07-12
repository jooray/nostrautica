/**
 * Relay-error resilience (user feedback): publishing to some relays failing is
 * EXPECTED — a relay may rate-limit, be slow, require PoW/auth, or reject a
 * duplicate. Success = the event reached at least one relay (NDK enforces this
 * with requiredRelayCount=1), so per-relay failures must never surface as
 * uncaught exceptions.
 *
 * NDK has an orphan-rejection bug: when a relay is slower than the publish
 * timeout, the timeout wins the Promise.race and the relay's later OK=false
 * response rejects a promise nobody is awaiting → an unhandled rejection. We
 * install a global guard that swallows these benign relay rejections (and logs
 * them quietly) while letting genuine app errors surface.
 */

// NIP-01 OK=false message prefixes + the transport errors NDK emits per relay.
const BENIGN_RELAY_PATTERNS = [
  /rate-?limit/i,
  /noting too much/i,
  /\btimeout\b/i,
  /\bblocked\b/i,
  /\bpow\b/i,
  /\bduplicate\b/i,
  /\brestricted\b/i,
  /\bmute[d]?\b/i,
  /auth-?required/i,
  /not enough relays received/i, // NDKPublishError when every relay declined
  /\bshunned\b/i,
];

/** True if an error reads like an expected, non-fatal relay publish rejection. */
export function isBenignRelayError(reason: unknown): boolean {
  const msg =
    reason instanceof Error
      ? reason.message
      : typeof reason === "string"
        ? reason
        : (reason as any)?.message ?? "";
  if (typeof msg !== "string" || !msg) return false;
  return BENIGN_RELAY_PATTERNS.some((re) => re.test(msg));
}

/**
 * Install a global handler that prevents benign relay rejections from becoming
 * uncaught exceptions. Call once at app boot. Non-relay errors are left alone so
 * real bugs still surface.
 */
export function installRelayErrorGuard(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("unhandledrejection", (event) => {
    if (isBenignRelayError(event.reason)) {
      event.preventDefault();
      const msg = event.reason instanceof Error ? event.reason.message : String(event.reason);
      console.debug("[relay] ignored non-fatal publish error:", msg);
    }
  });
}
