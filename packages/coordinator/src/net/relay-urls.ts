/**
 * Validation for relay URLs taken from UNTRUSTED input (audit COORD-16): event
 * grants (`config_relays`), 31600 `relay` tags, kind-10050 inbox relays, and
 * kind-10002 `r` tags. Only `wss://` URLs are usable by this daemon (the Nostr
 * transport is websocket-only, and plaintext `ws://` would leak gift-wrap
 * traffic); malformed entries, duplicates, and anything past the per-list cap
 * are dropped so a hostile config can't fan the daemon out to arbitrary
 * endpoints.
 */

/** Default per-list cap on accepted relay URLs. */
export const MAX_RELAYS_PER_LIST = 10;

/**
 * Keep only well-formed `wss://` URLs, deduped (trailing-slash-normalized),
 * capped at `cap` entries (extras dropped in order).
 */
export function sanitizeRelayUrls(urls: string[], cap = MAX_RELAYS_PER_LIST): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of urls) {
    if (out.length >= cap) break;
    if (typeof raw !== "string") continue;
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    if (u.protocol !== "wss:") continue;
    const normalized = u.toString().replace(/\/+$/, "");
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}
