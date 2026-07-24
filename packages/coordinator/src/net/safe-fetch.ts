/**
 * SSRF- and DoS-hardened blob downloader (audit C3). Media descriptors carry
 * attacker-controlled URLs; a bare `fetch()` would let an attendee make the
 * coordinator request loopback/metadata/private-network endpoints or stream an
 * endless/oversized body. This module:
 *
 *   - allows only `https:` URLs (and, when configured, only Blossom origins);
 *   - resolves every hostname and rejects loopback / private / link-local /
 *     multicast / reserved addresses — re-checked on each manual redirect;
 *   - pins the connection to the ALREADY-VALIDATED addresses via a custom
 *     dispatcher lookup (audit COORD-6): fetch() never re-resolves the name,
 *     so a DNS-rebinding race between the policy check and the connect can't
 *     swap in a private address (SNI/Host stay correct — only the lookup is
 *     overridden);
 *   - disables automatic redirects and follows at most `maxRedirects` manually;
 *   - enforces a wall-clock timeout and a hard streamed-byte cap.
 *
 * Hash verification alone does not prevent blind SSRF (the request already left),
 * so the guard runs BEFORE and DURING the fetch, not only after.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, type Dispatcher } from "undici";

export interface SafeFetchOptions {
  /** Exact allowed origins (e.g. "https://blossom.example"). Empty = any public https host. */
  allowedOrigins?: string[];
  /** Hard cap on streamed bytes. */
  maxBytes: number;
  timeoutMs?: number;
  maxRedirects?: number;
  /** Injectable DNS resolver (tests); defaults to node:dns lookup. */
  lookupFn?: typeof lookup;
  /** Caller cancellation (audit R13): shutdown / per-event teardown, combined with
   *  the per-hop wall-clock timeout so a blocked blob download unwinds promptly. */
  signal?: AbortSignal;
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

/** Expand an IPv6 address (with `::` compression) to its 8 hextets; null if unparseable. */
function expandV6(ip: string): number[] | null {
  if (ip.includes(".")) return null; // embedded v4 handled by the caller
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = (halves[0] ?? "").split(":").filter((s) => s !== "");
  const tail = halves.length === 2 ? (halves[1] ?? "").split(":").filter((s) => s !== "") : [];
  if (head.length + tail.length > 8) return null;
  const parts =
    halves.length === 2
      ? [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail]
      : head;
  if (parts.length !== 8) return null;
  const out = parts.map((h) => parseInt(h, 16));
  return out.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? out : null;
}

function isBlockedV6(ip: string): boolean {
  if (ip === "::" || ip === "::1") return true; // unspecified + loopback
  // IPv4-mapped (::ffff:a.b.c.d) — evaluate the embedded v4.
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedV4(mapped[1]!);
  const h = expandV6(ip);
  if (!h) return true; // unparseable → block
  if ((h[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((h[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((h[0]! & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  // Transition/translation mechanisms that can smuggle a blocked v4 (COORD-6):
  if (h[0] === 0x0064 && h[1] === 0xff9b && h[2] === 0x0000) return true; // 64:ff9b::/96 NAT64
  if (h[0] === 0x2002) return true; // 2002::/16 6to4
  if (h[0] === 0x2001 && h[1] === 0x0000) return true; // 2001::/32 Teredo
  return false;
}

interface ValidatedTarget {
  url: URL;
  /** The already policy-validated addresses the connection is pinned to (COORD-6). */
  addresses: { address: string; family: 4 | 6 }[];
}

/** Validate a single URL against scheme, origin allowlist, and resolved-IP policy. */
async function validateTarget(raw: string, opts: SafeFetchOptions): Promise<ValidatedTarget> {
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
  let addresses: { address: string; family: 4 | 6 }[];
  if (isIP(host)) {
    addresses = [{ address: host, family: isIP(host) as 4 | 6 }];
  } else {
    const resolve = opts.lookupFn ?? lookup;
    let resolved: { address: string; family: number }[];
    try {
      resolved = await resolve(host, { all: true });
    } catch {
      throw new SafeFetchError(`DNS resolution failed`, true);
    }
    addresses = resolved
      .filter((a) => isIP(a.address) !== 0)
      .map((a) => ({ address: a.address, family: isIP(a.address) as 4 | 6 }));
  }
  if (addresses.length === 0) throw new SafeFetchError(`no addresses resolved`, true);
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new SafeFetchError(`resolved to a blocked (private/loopback/reserved) address`, false);
    }
  }
  return { url, addresses };
}

/**
 * A dns.lookup-compatible callback that returns ONLY the given (already
 * policy-validated) addresses (audit COORD-6). Used as the dispatcher's lookup
 * so the actual connection can never resolve the hostname to anything else —
 * DNS rebinding between the policy check and the connect is impossible by
 * construction. SNI and the Host header still use the real hostname.
 */
export function pinnedLookup(addresses: { address: string; family: 4 | 6 }[]) {
  return (
    _hostname: string,
    options: { all?: boolean },
    callback: (...args: any[]) => void,
  ): void => {
    if (options.all) {
      callback(null, addresses);
    } else {
      const first = addresses[0]!;
      callback(null, first.address, first.family);
    }
  };
}

/** A dispatcher that connects only to the validated addresses (COORD-6). */
export function pinnedDispatcher(addresses: { address: string; family: 4 | 6 }[]): Dispatcher {
  return new Agent({ connect: { lookup: pinnedLookup(addresses) } });
}

/**
 * Resolve a URL's host to public addresses and return a dispatcher pinned to them
 * (audit R22): the same DNS-resolution + public-address check + pin the blob
 * downloader applies, so a configured provider hostname that resolves to (or rebinds
 * to) a private/loopback/reserved address can't receive bearer credentials or
 * attendee prompts. IP literals short-circuit DNS. Throws {@link SafeFetchError} on
 * any non-public answer.
 */
export async function pinnedDispatcherFor(
  rawUrl: string,
  opts: { lookupFn?: typeof lookup } = {},
): Promise<Dispatcher> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SafeFetchError(`invalid URL`, false);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: { address: string; family: 4 | 6 }[];
  if (isIP(host)) {
    addresses = [{ address: host, family: isIP(host) as 4 | 6 }];
  } else {
    const resolve = opts.lookupFn ?? lookup;
    let resolved: { address: string; family: number }[];
    try {
      resolved = await resolve(host, { all: true });
    } catch {
      throw new SafeFetchError(`DNS resolution failed`, true);
    }
    addresses = resolved
      .filter((a) => isIP(a.address) !== 0)
      .map((a) => ({ address: a.address, family: isIP(a.address) as 4 | 6 }));
  }
  if (addresses.length === 0) throw new SafeFetchError(`no addresses resolved`, true);
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new SafeFetchError(`resolved to a blocked (private/loopback/reserved) address`, false);
    }
  }
  return pinnedDispatcher(addresses);
}

/** DNS-pinning policy for operator-configured provider requests (audit R22). */
export interface ProviderNetPolicy {
  /**
   * DEV ONLY: skip DNS pinning and allow the provider host to resolve to a
   * loopback/private address (a local test provider). Mirrors the coordinator's
   * `security.allow_insecure_urls` knob. Default false = pin + public-only.
   */
  allowInsecure?: boolean;
  /** Injectable DNS resolver (tests); defaults to node:dns lookup. */
  lookupFn?: typeof lookup;
}

/**
 * Run a provider HTTP request under the same DNS pinning as {@link safeFetch}
 * (audit R22). Resolves + validates the host, pins the connection to the validated
 * public addresses for the life of the request, invokes `handle` to read the body
 * (while the caller's `signal` deadline is still armed), then closes the pinned
 * dispatcher. Under `allowInsecure` (dev) it skips pinning and fetches directly so a
 * local test provider still works. The caller keeps ownership of timeouts/signals
 * via the `init.signal` it passes.
 */
export async function guardedProviderFetch<T>(
  rawUrl: string,
  init: RequestInit,
  policy: ProviderNetPolicy,
  handle: (res: Response) => Promise<T>,
): Promise<T> {
  if (policy.allowInsecure) {
    return handle(await fetch(rawUrl, init));
  }
  const dispatcher = await pinnedDispatcherFor(rawUrl, { lookupFn: policy.lookupFn });
  try {
    const res = await fetch(rawUrl, {
      ...init,
      // Same undici@7 Dispatcher shape as safeFetch — cast through unknown.
      dispatcher: dispatcher as unknown as NonNullable<RequestInit["dispatcher"]>,
    });
    return await handle(res);
  } finally {
    await dispatcher.close().catch(() => {});
  }
}

/**
 * Download a URL under the SSRF/DoS guard. Follows manual redirects (each
 * re-validated) up to the cap and returns the body bytes, aborting if the stream
 * exceeds `maxBytes` or the wall-clock timeout.
 */
export async function safeFetch(raw: string, opts: SafeFetchOptions): Promise<Uint8Array> {
  const maxRedirects = opts.maxRedirects ?? 3;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  // Fail fast if the caller was already cancelled (audit R13).
  if (opts.signal?.aborted) throw new SafeFetchError(`download cancelled`, true);
  let current = raw;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const { url, addresses } = await validateTarget(current, opts);
    // Pin this hop's connection to the validated addresses (COORD-6): fetch()
    // would otherwise re-resolve the hostname and lose the race against a
    // rebinding attacker.
    const dispatcher = pinnedDispatcher(addresses);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Combine the per-hop deadline with the caller's cancellation (audit R13): a
    // shutdown/teardown aborts the in-flight body read, not just the timeout.
    const hopSignal = opts.signal
      ? AbortSignal.any([opts.signal, controller.signal])
      : controller.signal;
    let res: Response;
    try {
      res = await fetch(url, {
        redirect: "manual",
        signal: hopSignal,
        // The installed undici@7 Dispatcher is structurally compatible with the
        // global fetch's dispatcher option but typed against a different
        // undici-types version — cast through unknown.
        dispatcher: dispatcher as unknown as NonNullable<RequestInit["dispatcher"]>,
      });
    } catch (e) {
      clearTimeout(timer);
      await dispatcher.close().catch(() => {});
      throw new SafeFetchError(`network error: ${e instanceof Error ? e.message : String(e)}`, true);
    }

    // Manual redirect handling: re-validate the next hop.
    if (res.status >= 300 && res.status < 400) {
      clearTimeout(timer);
      await dispatcher.close().catch(() => {});
      const loc = res.headers.get("location");
      if (!loc) throw new SafeFetchError(`redirect without Location`, false);
      if (hop === maxRedirects) throw new SafeFetchError(`too many redirects`, false);
      current = new URL(loc, url).toString();
      continue;
    }
    if (!res.ok) {
      clearTimeout(timer);
      await dispatcher.close().catch(() => {});
      throw new SafeFetchError(`HTTP ${res.status}`, res.status >= 500 || res.status === 429);
    }

    // Reject an over-limit declared Content-Length up front.
    const declared = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > opts.maxBytes) {
      clearTimeout(timer);
      await dispatcher.close().catch(() => {});
      throw new SafeFetchError(`declared size ${declared} exceeds cap ${opts.maxBytes}`, false);
    }

    try {
      return await readCapped(res, opts.maxBytes);
    } finally {
      clearTimeout(timer);
      await dispatcher.close().catch(() => {});
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
