/**
 * Relay-error resilience (user feedback): publishing to some relays failing is
 * EXPECTED — a relay may rate-limit, be slow, require PoW/auth, or reject a
 * duplicate. Success = the event reached at least one relay (NDK enforces this
 * with requiredRelayCount=1), so per-relay failures must never surface as
 * uncaught exceptions.
 *
 * Handling happens AT THE PUBLISH SITE (nostr/ndk.ts `publishToRelay`): every
 * per-relay promise is created with its handlers already attached, and none of
 * them re-throws. That is what actually keeps a refusal off the debugger — an
 * `unhandledrejection` listener cannot, because by the time it fires the browser
 * has already classified the rejection as uncaught and paused.
 *
 * `installRelayErrorGuard` stays as a BACKSTOP for relay rejections raised
 * somewhere we don't own (a dependency's internal fire-and-forget), so one of
 * those degrades to a console.debug line instead of a red console error.
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

/**
 * Relay refusals that re-sending the same event can never turn into an accept.
 *
 * Distinct from BENIGN above, which asks "should this alarm anyone?" — both a
 * rate-limit and a kind-allowlist rejection are unalarming, but only one of them
 * is worth trying again. This asks the different question the outbox needs:
 * would another attempt at this relay plausibly change the answer?
 *
 * `duplicate` counts as permanent because the relay is telling us it already has
 * the event — the convergence goal is met, and re-sending would only ask again.
 * `pow` and `auth-required` are permanent for THIS app rather than in principle:
 * we mine no proof of work and perform no NIP-42 handshake, so the outcome is
 * fixed until that changes.
 */
const PERMANENT_RELAY_REFUSALS = [
  /\bblocked\b/i, // kind not on the allowlist, author not permitted
  /\binvalid\b/i,
  /\brestricted\b/i,
  /\bpow\b/i,
  /auth-?required/i,
  /\bmute[d]?\b/i,
  /\bshunned\b/i,
  /\bduplicate\b/i, // the relay already has it
];

/**
 * True when re-sending this event to the relay that gave `reason` could still
 * succeed — a timeout, a rate limit, a dropped socket, or anything unrecognised.
 * Unknown reasons are treated as retryable on purpose: the cost of one wasted
 * re-send is a round trip, while wrongly giving up leaves a relay permanently
 * missing an event nobody will notice is absent.
 */
export function isRetryableRelayFailure(reason: string | undefined): boolean {
  if (!reason) return true;
  return !PERMANENT_RELAY_REFUSALS.some((re) => re.test(reason));
}

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
 * Report that ONE relay didn't take an event. Called from the publish fan-out
 * (nostr/ndk.ts) for every per-relay failure, so a refusal is always visible to
 * someone debugging without ever being an error the user or the debugger sees.
 *
 * Concretely: a chat-enabled event's relay set includes the whitenoise relays,
 * which accept only kinds 0/3/445/1059/10000/10002/10050/30443 and answer
 * everything else with "blocked: kind N is not accepted by this relay". Every
 * 31600/31601/kind-5 publish therefore fails at two relays by design — that is
 * console.debug material, not a warning. Anything that does NOT read like an
 * expected relay rejection is still worth a warning: it usually means the relay
 * is broken in a new way.
 */
export function noteRelayPublishFailure(url: string, reason: unknown): void {
  const msg = reason instanceof Error ? reason.message : String(reason ?? "declined");
  if (isBenignRelayError(msg)) console.debug(`[relay] ${url} declined the event: ${msg}`);
  else console.warn(`[relay] ${url} publish failed: ${msg}`);
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
 * True when a dynamic `import()` failed because the browser is still running a
 * pre-deploy module graph whose content-hashed chunks were deleted by the new
 * build ("Failed to fetch dynamically imported module: …/W3Bonw05.js"). Not a
 * real app bug — a normal reload picks up the new shell. Match Chrome/Firefox/
 * Safari phrasings so LazyRoute / vite:preloadError can auto-recover.
 */
const STALE_CHUNK_PATTERNS = [
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
  /loading chunk [\w.-]+ failed/i,
];

export function isStaleChunkError(reason: unknown): boolean {
  const msg =
    reason instanceof Error
      ? reason.message
      : typeof reason === "string"
        ? reason
        : ((reason as { message?: unknown })?.message ?? "");
  if (typeof msg !== "string" || !msg) return false;
  return STALE_CHUNK_PATTERNS.some((re) => re.test(msg));
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
