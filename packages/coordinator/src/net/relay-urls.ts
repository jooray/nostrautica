/**
 * Validation for relay URLs taken from UNTRUSTED input (audit COORD-16 + C4): event
 * grants (`config_relays`), 31600 `relay` tags, kind-10050 inbox relays, kind-10002
 * `r` tags, and key-package discovery. Only `wss://` URLs are usable by this daemon
 * (the Nostr transport is websocket-only, and plaintext `ws://` would leak gift-wrap
 * traffic); malformed entries, duplicates, and anything past the per-list cap are
 * dropped so a hostile config can't fan the daemon out to arbitrary endpoints.
 *
 * SSRF hardening (audit C4): the syntactic pass here ALSO rejects URLs that embed
 * credentials, that carry a fragment, that name a loopback/private/link-local host
 * literal, or (when an operator allowlist is configured) whose host is not listed.
 * DNS-name hosts can't be resolved synchronously here — a rebinding/mixed-answer
 * host is caught at CONNECT time by the pinned lookup in {@link ./relay-guard}, the
 * websocket equivalent of net/safe-fetch's DNS pinning. Private relays are permitted
 * only behind the explicit dev-only `allowInsecure` flag (local testing).
 */
import { isIP } from "node:net";
import { isBlockedAddress } from "./safe-fetch.js";

/** Default per-list cap on accepted relay URLs. */
export const MAX_RELAYS_PER_LIST = 10;

/** Policy applied to untrusted relay URLs (audit C4). */
export interface RelayPolicy {
  /** Per-list cap (extras dropped in order). Default {@link MAX_RELAYS_PER_LIST}. */
  cap?: number;
  /** Operator allowlist of relay hosts (or full URLs); empty = any public host. */
  allowlist?: string[];
  /** DEV ONLY: permit `ws://` and loopback/private hosts (local test relays). */
  allowInsecure?: boolean;
}

/** True for a hostname literal that is loopback/private/link-local/unspecified. */
function isLocalOrPrivateHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (isIP(h) !== 0) return isBlockedAddress(h);
  return false;
}

/** Normalize an allowlist entry (host or URL) to a bare lowercase hostname. */
function allowlistHost(entry: string): string {
  try {
    return new URL(entry).hostname.toLowerCase();
  } catch {
    return entry.trim().toLowerCase().replace(/^\[|\]$/g, "");
  }
}

/**
 * Keep only well-formed, policy-passing relay URLs, deduped (trailing-slash-
 * normalized), capped. With no policy this is the historical behavior (wss-only,
 * deduped, capped) plus the always-on C4 rejections of credential/fragment URLs.
 */
export function sanitizeRelayUrls(urls: string[], policyOrCap: RelayPolicy | number = {}): string[] {
  const policy: RelayPolicy = typeof policyOrCap === "number" ? { cap: policyOrCap } : policyOrCap;
  const cap = policy.cap ?? MAX_RELAYS_PER_LIST;
  const allowInsecure = policy.allowInsecure ?? false;
  const allow = (policy.allowlist ?? []).map(allowlistHost).filter(Boolean);
  const allowSet = new Set(allow);

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
    // Scheme: wss only (ws:// only behind the dev flag).
    if (u.protocol !== "wss:" && !(u.protocol === "ws:" && allowInsecure)) continue;
    // No credentials, no fragment (audit C4).
    if (u.username || u.password || u.hash) continue;
    // Loopback/private host literals are rejected unless the dev flag is set.
    if (!allowInsecure && isLocalOrPrivateHost(u.hostname)) continue;
    // Operator allowlist (audit C4): when set, the host must be listed.
    if (allowSet.size > 0 && !allowSet.has(u.hostname.toLowerCase())) continue;
    const normalized = u.toString().replace(/\/+$/, "");
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}
