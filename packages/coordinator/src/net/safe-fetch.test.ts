/**
 * SSRF/DoS hardening of the blob downloader (audit C3). The guard must reject
 * loopback/private/reserved targets, non-https schemes, off-allowlist origins,
 * and over-cap bodies — BEFORE and DURING the fetch, never relying on post-download
 * hash checks.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  safeFetch,
  isBlockedAddress,
  SafeFetchError,
  pinnedLookup,
  guardedProviderFetch,
} from "./safe-fetch.js";

const ALLOW = "https://blossom.example";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Build a Response whose streamed body is `bytes` long. */
function streamResponse(bytes: number, headers: Record<string, string> = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers });
}

describe("isBlockedAddress", () => {
  it("blocks loopback, private, link-local, CGNAT, multicast, and mapped v4", () => {
    for (const ip of [
      "127.0.0.1", "10.0.0.5", "172.16.9.9", "192.168.1.1", "169.254.1.1",
      "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
      "::1", "::", "fc00::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1",
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });
  it("allows ordinary public addresses", () => {
    for (const ip of ["1.1.1.1", "8.8.8.8", "203.0.115.7", "2606:4700:4700::1111"]) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });

  it("blocks v4-smuggling transition mechanisms (COORD-6): NAT64, 6to4, Teredo", () => {
    for (const ip of [
      "64:ff9b::7f00:1", // NAT64 (64:ff9b::/96) of 127.0.0.1
      "64:ff9b::ffff:a00:1", // NAT64 shape within the /96
      "2002:0a00:0001::1", // 6to4 of 10.0.0.1
      "2002:7f00:0001::", // 6to4 of 127.0.0.1
      "2001:0000:4136:e378:8000:63bf:3fff:fdd2", // Teredo
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
    // Non-transition 2001 space (e.g. documentation 2001:db8::) is not blocked.
    expect(isBlockedAddress("2001:db8::1")).toBe(false);
  });
});

describe("pinnedLookup (audit COORD-6)", () => {
  it("returns ONLY the pre-validated addresses, ignoring the queried hostname", () => {
    const lookup = pinnedLookup([{ address: "93.184.216.34", family: 4 }]);
    const cb = vi.fn();
    lookup("rebinding.attacker.example", { all: true }, cb);
    expect(cb).toHaveBeenCalledWith(null, [{ address: "93.184.216.34", family: 4 }]);
    const cbSingle = vi.fn();
    lookup("rebinding.attacker.example", {}, cbSingle);
    expect(cbSingle).toHaveBeenCalledWith(null, "93.184.216.34", 4);
  });

  it("safeFetch passes a pinned dispatcher to fetch (no re-resolution)", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(streamResponse(10));
    await safeFetch("https://1.1.1.1/ok", { maxBytes: 100 });
    const init = spy.mock.calls[0]![1] as any;
    expect(init.dispatcher).toBeDefined(); // connection pinned to the validated IP
  });

  it("a hostname re-resolving to a private IP is rejected (lookupFn injection)", async () => {
    // First resolution is public… then the attacker flips DNS to loopback.
    const lookupFn = vi.fn(async () => [{ address: "10.0.0.9", family: 4 }]) as any;
    await expect(
      safeFetch("https://rebind.example/x", { maxBytes: 100, lookupFn }),
    ).rejects.toMatchObject({ retryable: false });
    const spy = vi.spyOn(globalThis, "fetch");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("guardedProviderFetch (audit R22)", () => {
  it("pins a public provider host and passes a dispatcher to fetch", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const lookupFn = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) as any;
    const out = await guardedProviderFetch(
      "https://api.venice.ai/api/v1/models",
      { headers: { authorization: "Bearer secret" } },
      { lookupFn },
      async (res) => (await res.json()) as unknown,
    );
    expect(out).toEqual({});
    const init = spy.mock.calls[0]![1] as any;
    expect(init.dispatcher).toBeDefined(); // pinned to the resolved public IP
    expect(init.headers.authorization).toBe("Bearer secret");
  });

  it("rejects a provider host that resolves to a private address (no request, no leaked bearer)", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const lookupFn = vi.fn(async () => [{ address: "169.254.169.254", family: 4 }]) as any;
    await expect(
      guardedProviderFetch(
        "https://metadata.attacker.example/v1/chat",
        { headers: { authorization: "Bearer secret" } },
        { lookupFn },
        async (res) => res.text(),
      ),
    ).rejects.toBeInstanceOf(SafeFetchError);
    expect(spy).not.toHaveBeenCalled();
  });

  it("under allowInsecure (dev) skips pinning and fetches directly", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    const out = await guardedProviderFetch(
      "http://localhost:8080/v1/models",
      {},
      { allowInsecure: true },
      async (res) => res.text(),
    );
    expect(out).toBe("ok");
    const init = spy.mock.calls[0]![1] as any;
    expect(init?.dispatcher).toBeUndefined(); // no pinning in dev
  });
});

describe("safeFetch", () => {
  it("rejects a non-https URL without making a request", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    await expect(safeFetch("http://blossom.example/x", { maxBytes: 1000 })).rejects.toBeInstanceOf(SafeFetchError);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects a loopback IP-literal host before fetching (SSRF)", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    await expect(safeFetch("https://127.0.0.1/x", { maxBytes: 1000 })).rejects.toMatchObject({ retryable: false });
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects an origin outside the Blossom allowlist", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    await expect(
      safeFetch("https://evil.example/x", { allowedOrigins: [ALLOW], maxBytes: 1000 }),
    ).rejects.toMatchObject({ retryable: false });
    expect(spy).not.toHaveBeenCalled();
  });

  it("aborts a body that exceeds the streamed byte cap", async () => {
    // Use an IP-literal allowlisted origin so DNS is skipped and fetch is stubbed.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(streamResponse(5000));
    await expect(
      safeFetch("https://1.1.1.1/big", { allowedOrigins: ["https://1.1.1.1"], maxBytes: 1000 }),
    ).rejects.toMatchObject({ retryable: false });
  });

  it("rejects an over-cap declared Content-Length up front", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      streamResponse(10, { "content-length": "999999999" }),
    );
    await expect(
      safeFetch("https://1.1.1.1/big", { allowedOrigins: ["https://1.1.1.1"], maxBytes: 1000 }),
    ).rejects.toMatchObject({ retryable: false });
  });

  it("returns the body when the target and size are within policy", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(streamResponse(500));
    const out = await safeFetch("https://1.1.1.1/ok", { allowedOrigins: ["https://1.1.1.1"], maxBytes: 1000 });
    expect(out.length).toBe(500);
  });

  it("re-validates a redirect target and blocks a redirect to loopback", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 302, headers: { location: "https://127.0.0.1/inner" } }),
    );
    await expect(
      safeFetch("https://1.1.1.1/start", { allowedOrigins: [], maxBytes: 1000 }),
    ).rejects.toMatchObject({ retryable: false });
  });
});

/**
 * IPv4 smuggled inside an IPv6 literal (2026-09-04 audit).
 *
 * The guard decoded ONLY the dotted mapped form, `::ffff:a.b.c.d`. That check is
 * dead for anything URL-derived, because WHATWG `URL` normalizes the dotted form
 * to hex on parse — so every mapped literal that reached the guard was in the one
 * shape it could not match, fell through the hextet rules (whose high bits are all
 * zero), and was ALLOWED. An attendee could point a media descriptor at
 * `https://[::ffff:a9fe:a9fe]/…` and have the coordinator connect to cloud
 * metadata.
 */
describe("isBlockedAddress — embedded IPv4 in IPv6 (audit 2026-09-04)", () => {
  it("blocks the HEX mapped forms a URL actually produces", () => {
    expect(new URL("https://[::ffff:127.0.0.1]/").hostname).toBe("[::ffff:7f00:1]"); // the premise
    expect(isBlockedAddress("::ffff:7f00:1")).toBe(true); // loopback
    expect(isBlockedAddress("::ffff:a9fe:a9fe")).toBe(true); // 169.254.169.254 metadata
    expect(isBlockedAddress("::ffff:a00:1")).toBe(true); // 10.0.0.1 private
    expect(isBlockedAddress("::ffff:c0a8:1")).toBe(true); // 192.168.0.1 private
  });

  it("still blocks the dotted forms", () => {
    expect(isBlockedAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedAddress("::ffff:169.254.169.254")).toBe(true);
  });

  it("blocks IPv4-compatible and IPv4-translated constructions too", () => {
    expect(isBlockedAddress("::7f00:1")).toBe(true); // ::127.0.0.1
    expect(isBlockedAddress("::ffff:0:7f00:1")).toBe(true); // ::ffff:0:127.0.0.1
  });

  it("fails closed on an unrecognised shape in the same space", () => {
    expect(isBlockedAddress("::dead:7f00:1")).toBe(true);
  });

  it("still allows a genuinely public mapped address and ordinary global IPv6", () => {
    expect(isBlockedAddress("::ffff:808:808")).toBe(false); // 8.8.8.8
    expect(isBlockedAddress("2606:4700:4700::1111")).toBe(false);
  });
});
