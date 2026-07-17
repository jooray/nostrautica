/**
 * SSRF- and DoS-hardened blob downloader (audit C3). Media descriptors carry
 * attacker-controlled URLs; a bare `fetch()` would let an attendee make the
 * coordinator request loopback/metadata/private-network endpoints or stream an
 * endless/oversized body. This module:
 *
 *   - allows only `https:` URLs (and, when configured, only Blossom origins);
 *   - resolves every hostname and rejects loopback / private / link-local /
 *     multicast / reserved addresses — re-checked on each manual redirect;
 *   - disables automatic redirects and follows at most `maxRedirects` manually;
 *   - enforces a wall-clock timeout and a hard streamed-byte cap.
 *
 * Hash verification alone does not prevent blind SSRF (the request already left),
 * so the guard runs BEFORE and DURING the fetch, not only after.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface SafeFetchOptions {
  /** Exact allowed origins (e.g. "https://blossom.example"). Empty = any public https host. */
  allowedOrigins?: string[];
  /** Hard cap on streamed bytes. */
  maxBytes: number;
  timeoutMs?: number;
  maxRedirects?: number;
}

export class SafeFetchError extends Error {
  constructor(
    message: string,
    /** Whether the failure is transient (DNS/network) vs a permanent policy rejection. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "SafeFetchError";
  }
}

/** Normalize an origin string for comparison (protocol + host + explicit port). */
function normalizeOrigin(u: URL): string {
  return u.origin.toLowerCase();
}

/** True if an IPv4/IPv6 literal is NOT globally routable (must be rejected). */
export function isBlockedAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isBlockedV4(ip);
  if (v === 6) return isBlockedV6(ip.toLowerCase());
  return true; // not a parseable IP → block
}

function isBlockedV4(ip: string): boolean {
  const p = ip.split(".").map((x) => Number(x));
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 192 && b === 0 && p[2] === 0) return true; // IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast (224/4) + reserved (240/4) + 255.255.255.255
  return false;
}

function isBlockedV6(ip: string): boolean {
  if (ip === "::" || ip === "::1") return true; // unspecified + loopback
  // IPv4-mapped (::ffff:a.b.c.d) — evaluate the embedded v4.
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedV4(mapped[1]!);
  const first = ip.split(":")[0] ?? "";
  const head = parseInt(first || "0", 16);
  if ((head & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((head & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((head & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/** Validate a single URL against scheme, origin allowlist, and resolved-IP policy. */
async function validateTarget(raw: string, opts: SafeFetchOptions): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SafeFetchError(`invalid URL`, false);
  }
  if (url.protocol !== "https:") throw new SafeFetchError(`non-https URL rejected`, false);
  const allow = opts.allowedOrigins ?? [];
  if (allow.length > 0) {
    const set = new Set(allow.map((o) => o.toLowerCase().replace(/\/$/, "")));
    if (!set.has(normalizeOrigin(url))) {
      throw new SafeFetchError(`origin not in Blossom allowlist`, false);
    }
  }
  // Resolve the hostname; reject if ANY resolved address is non-public. If the host
  // is already an IP literal, isIP short-circuits DNS.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: { address: string }[];
  if (isIP(host)) {
    addresses = [{ address: host }];
  } else {
    try {
      addresses = await lookup(host, { all: true });
    } catch {
      throw new SafeFetchError(`DNS resolution failed`, true);
    }
  }
  if (addresses.length === 0) throw new SafeFetchError(`no addresses resolved`, true);
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new SafeFetchError(`resolved to a blocked (private/loopback/reserved) address`, false);
    }
  }
  return url;
}

/**
 * Download a URL under the SSRF/DoS guard. Follows manual redirects (each
 * re-validated) up to the cap and returns the body bytes, aborting if the stream
 * exceeds `maxBytes` or the wall-clock timeout.
 */
export async function safeFetch(raw: string, opts: SafeFetchOptions): Promise<Uint8Array> {
  const maxRedirects = opts.maxRedirects ?? 3;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  let current = raw;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const url = await validateTarget(current, opts);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, { redirect: "manual", signal: controller.signal });
    } catch (e) {
      clearTimeout(timer);
      throw new SafeFetchError(`network error: ${e instanceof Error ? e.message : String(e)}`, true);
    }

    // Manual redirect handling: re-validate the next hop.
    if (res.status >= 300 && res.status < 400) {
      clearTimeout(timer);
      const loc = res.headers.get("location");
      if (!loc) throw new SafeFetchError(`redirect without Location`, false);
      if (hop === maxRedirects) throw new SafeFetchError(`too many redirects`, false);
      current = new URL(loc, url).toString();
      continue;
    }
    if (!res.ok) {
      clearTimeout(timer);
      throw new SafeFetchError(`HTTP ${res.status}`, res.status >= 500 || res.status === 429);
    }

    // Reject an over-limit declared Content-Length up front.
    const declared = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > opts.maxBytes) {
      clearTimeout(timer);
      throw new SafeFetchError(`declared size ${declared} exceeds cap ${opts.maxBytes}`, false);
    }

    try {
      return await readCapped(res, opts.maxBytes);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new SafeFetchError(`too many redirects`, false);
}

/** Read a response body, aborting if it exceeds `maxBytes` (streamed cap). */
async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new SafeFetchError(`body exceeds cap ${maxBytes}`, false);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new SafeFetchError(`streamed bytes exceed cap ${maxBytes}`, false);
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
