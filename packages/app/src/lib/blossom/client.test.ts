import { describe, it, expect, vi, afterEach } from "vitest";
import {
  uploadAndMirror,
  downloadBlob,
  preflight,
  upload,
  PREFLIGHT_TIMEOUT_MS,
  UPLOAD_TIMEOUT_MS,
  MIRROR_TIMEOUT_MS,
  DOWNLOAD_TIMEOUT_MS,
} from "./client.js";
import { sha256Hex } from "@nostrautica/protocol";
import { LocalSigner } from "$lib/signer/local.js";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("uploadAndMirror", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls through to the next server when the first upload fails", async () => {
    const signer = LocalSigner.generate();
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.startsWith("https://bad.example/upload")) {
        return new Response("nope", { status: 415 });
      }
      if (url.startsWith("https://good.example/upload")) {
        return jsonResponse({ url: "https://good.example/deadbeef" });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await uploadAndMirror(
      signer,
      ["https://bad.example", "https://good.example"],
      new Uint8Array([1, 2, 3]),
      "application/octet-stream",
    );

    expect(result.primary).toBe("https://good.example/deadbeef");
    expect(calls[0]).toBe("PUT https://bad.example/upload");
    expect(calls[1]).toBe("PUT https://good.example/upload");
  });

  it("throws with every server's error when all uploads fail", async () => {
    const signer = LocalSigner.generate();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 415 })),
    );

    await expect(
      uploadAndMirror(
        signer,
        ["https://bad-one.example", "https://bad-two.example"],
        new Uint8Array([1, 2, 3]),
        "application/octet-stream",
      ),
    ).rejects.toThrow(/bad-one\.example.*bad-two\.example/s);
  });
});

describe("downloadBlob size cap (audit APPR-4)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const CAP = 16; // tiny cap so the tests don't allocate real buffers

  it("rejects up front when the descriptor claims more than the cap — no fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      downloadBlob(["https://x.example/blob"], "0".repeat(64), {
        maxBytes: CAP,
        expectedSize: CAP + 1,
      }),
    ).rejects.toThrow(/claims/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects on a Content-Length over the cap without reading the body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("x", {
            status: 200,
            headers: { "Content-Length": String(CAP + 1) },
          }),
      ),
    );

    await expect(
      downloadBlob(["https://x.example/blob"], "0".repeat(64), { maxBytes: CAP }),
    ).rejects.toThrow(/over the 16-byte cap/);
  });

  it("aborts mid-stream when the bytes pass the cap (lying/missing Content-Length)", async () => {
    const chunks = [new Uint8Array(10), new Uint8Array(10), new Uint8Array(10)];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(c) {
                for (const chunk of chunks) c.enqueue(chunk);
                c.close();
              },
            }),
            { status: 200 },
          ),
      ),
    );

    await expect(
      downloadBlob(["https://x.example/blob"], "0".repeat(64), { maxBytes: CAP }),
    ).rejects.toThrow(/download cap/);
  });

  it("still downloads a small blob and verifies its hash", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes, { status: 200 })));

    const out = await downloadBlob(["https://x.example/blob"], sha256Hex(bytes), {
      maxBytes: CAP,
    });
    expect(out).toEqual(bytes);
  });
});

describe("Blossom timeouts (UX-7)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** A fetch that never answers and ignores the abort signal (worst case). */
  const hungFetch = () => vi.fn(() => new Promise<Response>(() => {}));

  it("preflight resolves !ok after its timeout on a hung server", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", hungFetch());
    const signer = LocalSigner.generate();
    const p = preflight(signer, "https://hung.example", {
      sha256: "0".repeat(64),
      size: 3,
      type: "application/octet-stream",
    });
    await vi.advanceTimersByTimeAsync(PREFLIGHT_TIMEOUT_MS);
    const res = await p;
    expect(res.ok).toBe(false);
    expect(res.status).toBe(0);
    expect(res.message).toMatch(/timed out/);
  });

  it("upload rejects with a normal Error after its timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", hungFetch());
    const signer = LocalSigner.generate();
    const p = upload(signer, "https://hung.example", new Uint8Array([1, 2, 3]));
    const assertion = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(UPLOAD_TIMEOUT_MS);
    await assertion;
  });

  it("downloadBlob skips a hung mirror and falls back to a healthy one", async () => {
    vi.useFakeTimers();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("hung")) return new Promise<Response>(() => {});
      return Promise.resolve(new Response(bytes, { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const p = downloadBlob(
      ["https://hung.example/blob", "https://good.example/blob"],
      sha256Hex(bytes),
    );
    // The hung mirror burns exactly its timeout, then the healthy one answers.
    await vi.advanceTimersByTimeAsync(DOWNLOAD_TIMEOUT_MS);
    await expect(p).resolves.toEqual(bytes);
  });

  it("uploadAndMirror starts every mirror in parallel (a hung mirror doesn't serialize)", async () => {
    vi.useFakeTimers();
    const signer = LocalSigner.generate();
    const calls: string[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.startsWith("https://primary.example/upload")) {
        return Promise.resolve(jsonResponse({ url: "https://primary.example/deadbeef" }));
      }
      if (url.startsWith("https://hung.example/mirror")) {
        return new Promise<Response>(() => {});
      }
      if (url.startsWith("https://good.example/mirror")) {
        return Promise.resolve(jsonResponse({ url: "https://good.example/deadbeef" }));
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const p = uploadAndMirror(
      signer,
      ["https://primary.example", "https://hung.example", "https://good.example"],
      new Uint8Array([1, 2, 3]),
      "application/octet-stream",
    );
    // Let the primary upload settle, then BOTH mirrors must already be in
    // flight — before any timer advances (i.e. not serial).
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toContain("PUT https://hung.example/mirror");
    expect(calls).toContain("PUT https://good.example/mirror");

    await vi.advanceTimersByTimeAsync(MIRROR_TIMEOUT_MS);
    const result = await p;
    expect(result.urls).toEqual([
      "https://primary.example/deadbeef",
      "https://good.example/deadbeef",
    ]);
  });
});
