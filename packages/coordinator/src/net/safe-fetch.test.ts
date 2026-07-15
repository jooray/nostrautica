/**
 * SSRF/DoS hardening of the blob downloader (audit C3). The guard must reject
 * loopback/private/reserved targets, non-https schemes, off-allowlist origins,
 * and over-cap bodies — BEFORE and DURING the fetch, never relying on post-download
 * hash checks.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { safeFetch, isBlockedAddress, SafeFetchError } from "./safe-fetch.js";

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
