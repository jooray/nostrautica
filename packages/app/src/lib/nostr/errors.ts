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
 * Typed error categories for the shared ErrorState UI (audit finding Q3). Mapping
 * happens at the boundary so pages never parse raw `Error.message` for display —
 * users get a plain-language headline + a safe next action, and the raw text is
 * hidden behind a "technical details" disclosure.
 */
export type ErrorCategory = "offline" | "timeout" | "notFound" | "access" | "decrypt" | "generic";

const CATEGORY_PATTERNS: [ErrorCategory, RegExp][] = [
  ["timeout", /\btimed?\s?out\b|\btimeout\b/i],
  ["notFound", /\bnot found\b|\b404\b|\bmissing\b|\bno such\b|\bdoesn'?t exist\b/i],
  ["access", /\bunauthor/i], // unauthorized / unauthorised / unauthenticated
  ["access", /\bforbidden\b|\baccess denied\b|\bpermission\b|\bauth-?required\b|\brestricted\b/i],
  ["decrypt", /\bdecrypt|\bnip-?44\b|\bmac\b|\bciphertext\b|\bpadding\b/i],
];

/**
 * Classify an unknown thrown value into a display category. When the browser is
 * offline everything collapses to `offline` (a transient, retryable state) so a
 * dropped connection never looks like a terminal error.
 */
export function categorizeError(reason: unknown, opts?: { online?: boolean }): ErrorCategory {
  const online = opts?.online ?? (typeof navigator === "undefined" ? true : navigator.onLine);
  if (!online) return "offline";
  const msg =
    reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "";
  for (const [cat, re] of CATEGORY_PATTERNS) {
    if (re.test(msg)) return cat;
  }
  return "generic";
}

/** Sanitized technical detail for the collapsed disclosure (no keys/ciphertext). */
export function errorDetail(reason: unknown): string {
  const msg =
    reason instanceof Error ? reason.message : typeof reason === "string" ? reason : String(reason);
  // Redact anything that looks like a 64-hex key/id or a bech32 secret.
  return msg.replace(/\b[0-9a-f]{64}\b/gi, "…").replace(/\bnsec1[0-9a-z]+/gi, "nsec…").slice(0, 300);
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
