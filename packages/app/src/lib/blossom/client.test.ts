import { describe, it, expect, vi, afterEach } from "vitest";
import {
  uploadAndMirror,
  downloadBlob,
  preflight,
  upload,
  PREFLIGHT_TIMEOUT_MS,
  UPLOAD_TIMEOUT_MS,
  UPLOAD_CONNECT_TIMEOUT_MS,
  UPLOAD_STALL_TIMEOUT_MS,
  onUploadProgress,
  MIRROR_TIMEOUT_MS,
  DOWNLOAD_TIMEOUT_MS,
  DOWNLOAD_STALL_TIMEOUT_MS,
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
        // A conforming BUD-02 descriptor: content-addressed at our sha256.
        return jsonResponse({ url: `https://good.example/${sha256Hex(new Uint8Array([1, 2, 3]))}` });
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

    expect(result.primary).toBe(`https://good.example/${sha256Hex(new Uint8Array([1, 2, 3]))}`);
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

/**
 * The server's own descriptor URL goes straight into the media descriptor other
 * people fetch from (audit MED-9). Blossom is content-addressed, so a URL that
 * does not carry the sha256 we uploaded is a broken server or one substituting a
 * different blob — and there is no reason to publish a pointer we can already
 * tell is wrong. The coordinator re-verifies the hash on download and would
 * reject the substitute, but the app's own players would have followed it.
 */
describe("upload descriptor URL is verified against our own hash", () => {
  afterEach(() => vi.unstubAllGlobals());

  const data = new Uint8Array([7, 7, 7]);

  async function uploadWithServerUrl(serverUrl: unknown): Promise<string> {
    const signer = LocalSigner.generate();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ url: serverUrl })),
    );
    const r = await uploadAndMirror(signer, ["https://s.example"], data, "application/octet-stream");
    return r.primary;
  }

  it("keeps a URL that carries our sha256", async () => {
    const good = `https://s.example/${sha256Hex(data)}.webm`;
    expect(await uploadWithServerUrl(good)).toBe(good);
  });

  it("replaces a URL pointing at some OTHER blob with the content-addressed one", async () => {
    expect(await uploadWithServerUrl("https://evil.example/someone-elses-blob")).toBe(
      `https://s.example/${sha256Hex(data)}`,
    );
  });

  it("falls back when the server answers 200 with no usable descriptor", async () => {
    expect(await uploadWithServerUrl(undefined)).toBe(`https://s.example/${sha256Hex(data)}`);
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

  it("downloadBlob keeps going past the header timeout while bytes keep arriving", async () => {
    // Regression (prod 2026-08-07): the old budget covered headers AND body, so a
    // video that simply took longer than 20s to transfer on a slow link failed
    // with "timed out after 20000ms" on every mirror.
    vi.useFakeTimers();
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4]), new Uint8Array([5, 6])];
    const whole = new Uint8Array([1, 2, 3, 4, 5, 6]);
    // Each chunk lands well inside the stall budget, but the transfer as a whole
    // runs far past DOWNLOAD_TIMEOUT_MS.
    const gap = DOWNLOAD_STALL_TIMEOUT_MS / 2;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              async pull(c) {
                const next = chunks.shift();
                if (!next) return c.close();
                await new Promise((r) => setTimeout(r, gap));
                c.enqueue(next);
              },
            }),
            { status: 200 },
          ),
      ),
    );

    const p = downloadBlob(["https://slow.example/blob"], sha256Hex(whole));
    await vi.advanceTimersByTimeAsync(gap * chunks.length + 1);
    expect(gap * 3).toBeGreaterThan(DOWNLOAD_TIMEOUT_MS); // the old budget would have fired
    await expect(p).resolves.toEqual(whole);
  });

  it("downloadBlob gives up on a mirror that goes silent mid-body", async () => {
    vi.useFakeTimers();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("stalls")) {
          return new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new Uint8Array([9])); // one chunk, then silence forever
              },
            }),
            { status: 200 },
          );
        }
        return new Response(bytes, { status: 200 });
      }),
    );

    const p = downloadBlob(
      ["https://stalls.example/blob", "https://good.example/blob"],
      sha256Hex(bytes),
    );
    await vi.advanceTimersByTimeAsync(DOWNLOAD_STALL_TIMEOUT_MS);
    await expect(p).resolves.toEqual(bytes);
  });

  it("downloadBlob reports byte progress against the descriptor's size", async () => {
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])];
    const whole = new Uint8Array([1, 2, 3, 4, 5]);
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
            { status: 200 }, // no Content-Length — the descriptor's size is the denominator
          ),
      ),
    );

    const seen: Array<{ received: number; total?: number }> = [];
    await downloadBlob(["https://x.example/blob"], sha256Hex(whole), {
      expectedSize: whole.length,
      onProgress: (p) => seen.push(p),
    });

    expect(seen).toEqual([
      { received: 0, total: 5 },
      { received: 2, total: 5 },
      { received: 5, total: 5 },
    ]);
  });

  it("uploadAndMirror starts every mirror in parallel (a hung mirror doesn't serialize)", async () => {
    vi.useFakeTimers();
    const signer = LocalSigner.generate();
    const calls: string[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      // Conforming BUD-02 descriptors, i.e. content-addressed at our own sha256 —
      // a URL that is not gets replaced by the content-addressed one (MED-9).
      const addr = sha256Hex(new Uint8Array([1, 2, 3]));
      if (url.startsWith("https://primary.example/upload")) {
        return Promise.resolve(jsonResponse({ url: `https://primary.example/${addr}` }));
      }
      if (url.startsWith("https://hung.example/mirror")) {
        return new Promise<Response>(() => {});
      }
      if (url.startsWith("https://good.example/mirror")) {
        return Promise.resolve(jsonResponse({ url: `https://good.example/${addr}` }));
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
    const addr = sha256Hex(new Uint8Array([1, 2, 3]));
    expect(result.urls).toEqual([
      `https://primary.example/${addr}`,
      `https://good.example/${addr}`,
    ]);
  });
});

/**
 * The upload path's progress-aware budget. Uploads used to race the ENTIRE PUT —
 * headers and body together — against one 60s clock, so 15 MB of ciphertext on
 * venue Wi-Fi was killed mid-body and `uploadAndMirror` then re-uploaded the whole
 * blob to the next server and blew the same budget again.
 */
describe("upload progress budgets (XHR path)", () => {
  interface ProgressEvent_ {
    loaded: number;
    total: number;
    lengthComputable: boolean;
  }

  /** A scriptable XMLHttpRequest: `script` drives the events after send(). */
  class FakeXhr {
    static script: (xhr: FakeXhr) => void = () => {};
    /** sha256 of the payload the current test uploads, so `succeed()` can answer
     *  with a CONFORMING content-addressed descriptor (MED-9). */
    static addr = "";
    static sent: Uint8Array[] = [];
    upload: {
      onprogress?: (e: ProgressEvent_) => void;
      onload?: () => void;
    } = {};
    onload?: () => void;
    onerror?: () => void;
    onabort?: () => void;
    ontimeout?: () => void;
    onprogress?: () => void;
    status = 0;
    statusText = "";
    responseText = "";
    aborted = false;
    reason: string | null = null;
    open(): void {}
    setRequestHeader(): void {}
    getResponseHeader(name: string): string | null {
      return name === "X-Reason" ? this.reason : null;
    }
    send(body: Uint8Array): void {
      FakeXhr.sent.push(body);
      queueMicrotask(() => FakeXhr.script(this));
    }
    abort(): void {
      this.aborted = true;
      this.onabort?.();
    }
    /** Answer 200 with a BUD-02 descriptor (content-addressed — see MED-9). */
    succeed(url = `https://good.example/${FakeXhr.addr}`): void {
      this.upload.onload?.();
      this.status = 200;
      this.responseText = JSON.stringify({ url });
      this.onload?.();
    }
  }

  function useFakeXhr(script: (xhr: FakeXhr) => void) {
    FakeXhr.script = script;
    FakeXhr.sent = [];
    vi.stubGlobal("XMLHttpRequest", FakeXhr as unknown as typeof XMLHttpRequest);
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("keeps going far past the old whole-request budget while bytes keep moving", async () => {
    vi.useFakeTimers();
    const signer = LocalSigner.generate();
    const gap = UPLOAD_STALL_TIMEOUT_MS / 2;
    const steps = 5;
    // 5 × 15s = 75s of transfer: past UPLOAD_CONNECT_TIMEOUT_MS and past the old
    // single UPLOAD_TIMEOUT_MS, which is exactly the failure being fixed.
    expect(gap * steps).toBeGreaterThan(UPLOAD_TIMEOUT_MS);
    useFakeXhr(async (xhr) => {
      for (let i = 1; i <= steps; i++) {
        await new Promise((r) => setTimeout(r, gap));
        xhr.upload.onprogress?.({ loaded: i * 2, total: steps * 2, lengthComputable: true });
      }
      xhr.succeed();
    });

    const body = new Uint8Array(steps * 2);
    FakeXhr.addr = sha256Hex(body);
    const p = upload(signer, "https://slow.example", body);
    await vi.advanceTimersByTimeAsync(gap * steps + 1);
    await expect(p).resolves.toMatchObject({ url: `https://good.example/${FakeXhr.addr}` });
  });

  it("gives up on a server that stops accepting bytes mid-body", async () => {
    vi.useFakeTimers();
    const signer = LocalSigner.generate();
    useFakeXhr((xhr) => {
      xhr.upload.onprogress?.({ loaded: 2, total: 10, lengthComputable: true });
      // …then silence forever.
    });

    const p = upload(signer, "https://stalls.example", new Uint8Array(10));
    const assertion = expect(p).rejects.toThrow(/stalled/);
    await vi.advanceTimersByTimeAsync(UPLOAD_STALL_TIMEOUT_MS + 1);
    await assertion;
  });

  it("skips a server that never connects, without waiting a whole transfer", async () => {
    vi.useFakeTimers();
    const signer = LocalSigner.generate();
    useFakeXhr(() => {
      /* never answers, never acknowledges a byte */
    });

    const p = upload(signer, "https://dead.example", new Uint8Array(10));
    const assertion = expect(p).rejects.toThrow(/no connection/);
    await vi.advanceTimersByTimeAsync(UPLOAD_CONNECT_TIMEOUT_MS + 1);
    await assertion;
  });

  it("waits out a long store-side silence once the body is fully sent", async () => {
    vi.useFakeTimers();
    const signer = LocalSigner.generate();
    // A big blob leaves the client quickly on a fast uplink, then the server
    // hashes and stores it — a legitimate silence far longer than a stall.
    const body = new Uint8Array(10);
    FakeXhr.addr = sha256Hex(body);
    useFakeXhr(async (xhr) => {
      xhr.upload.onprogress?.({ loaded: 10, total: 10, lengthComputable: true });
      xhr.upload.onload?.();
      await new Promise((r) => setTimeout(r, UPLOAD_STALL_TIMEOUT_MS * 2));
      xhr.status = 200;
      xhr.responseText = JSON.stringify({ url: `https://good.example/${FakeXhr.addr}` });
      xhr.onload?.();
    });

    const p = upload(signer, "https://slow-store.example", body);
    await vi.advanceTimersByTimeAsync(UPLOAD_STALL_TIMEOUT_MS * 2 + 1);
    await expect(p).resolves.toMatchObject({ url: `https://good.example/${FakeXhr.addr}` });
  });

  it("reports byte progress to the caller and to onUploadProgress subscribers", async () => {
    const signer = LocalSigner.generate();
    useFakeXhr((xhr) => {
      xhr.upload.onprogress?.({ loaded: 4, total: 10, lengthComputable: true });
      xhr.upload.onprogress?.({ loaded: 10, total: 10, lengthComputable: true });
      xhr.succeed();
    });

    const own: Array<{ sent: number; total: number }> = [];
    const subscribed: Array<{ sent: number; total: number; server: string }> = [];
    const off = onUploadProgress((p) => subscribed.push(p));
    await upload(signer, "https://good.example", new Uint8Array(10), "application/octet-stream", {
      onProgress: (p) => own.push({ sent: p.sent, total: p.total }),
    });
    off();

    // 0 before the first byte (so the bar starts at a truthful 0%), then each
    // progress event, then `total` once the body is out.
    expect(own).toEqual([
      { sent: 0, total: 10 },
      { sent: 4, total: 10 },
      { sent: 10, total: 10 },
      { sent: 10, total: 10 },
    ]);
    expect(subscribed).toEqual(own.map((p) => ({ ...p, server: "https://good.example" })));

    // Unsubscribed listeners stop hearing about later uploads.
    subscribed.length = 0;
    await upload(signer, "https://good.example", new Uint8Array(10));
    expect(subscribed).toEqual([]);
  });

  it("surfaces the server's X-Reason on a rejected upload", async () => {
    const signer = LocalSigner.generate();
    useFakeXhr((xhr) => {
      xhr.upload.onload?.();
      xhr.status = 413;
      xhr.statusText = "Payload Too Large";
      xhr.reason = "file too big";
      xhr.onload?.();
    });

    await expect(upload(signer, "https://picky.example", new Uint8Array(10))).rejects.toThrow(
      /413 file too big/,
    );
  });
});
