/**
 * Audit R-18: a media download that failed spent bytes nobody booked, and the
 * fetch was capped at the operator's 250 MiB ceiling rather than at the size the
 * descriptor declared (and capMedia budgeted). The real fetchBlob path is under
 * test here, so the guarded downloader is mocked at the module boundary.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { encryptMedia } from "@nostrautica/protocol";

const calls: { maxBytes: number }[] = [];
let behaviour: (opts: { maxBytes: number; onBytes?: (n: number) => void }) => Promise<Uint8Array>;

vi.mock("../net/safe-fetch.js", async (orig) => {
  const real = await orig<typeof import("../net/safe-fetch.js")>();
  return {
    ...real,
    safeFetch: async (_url: string, opts: { maxBytes: number; onBytes?: (n: number) => void }) => {
      calls.push({ maxBytes: opts.maxBytes });
      return behaviour(opts);
    },
  };
});

const { transcribeMedia, MediaPolicyError } = await import("./transcribe.js");
const { SafeFetchError } = await import("../net/safe-fetch.js");
const { Store } = await import("../store/db.js");
const { MockStt } = await import("../providers/mock.js");

async function fixture() {
  return encryptMedia({
    kind: "intro",
    data: new Uint8Array(4096).map((_, i) => i % 251),
    mime: "audio/webm",
    duration: 30,
    urls: ["https://one.example/x", "https://two.example/x"],
  });
}

function run(descriptor: unknown, usage: { bytes: number; durationSec: number }[]) {
  return transcribeMedia(
    {
      store: new Store(":memory:"),
      stt: new MockStt({ default: "x" }),
      sttModel: "m",
      maxMediaBytes: 250 * 1024 * 1024,
      probeDuration: async () => 10,
      extractAudio: async () => [{ data: new Uint8Array(8), mime: "audio/ogg" }],
      onUsage: (u) => usage.push(u),
    },
    descriptor as never,
  );
}

const total = (usage: { bytes: number }[]) => usage.reduce((n, u) => n + u.bytes, 0);

beforeEach(() => {
  calls.length = 0;
});

describe("media download accounting (R-18)", () => {
  it("caps each fetch at the descriptor's declared size, not the operator ceiling", async () => {
    const { ciphertext, descriptor } = await fixture();
    behaviour = async (opts) => {
      opts.onBytes?.(ciphertext.length);
      return ciphertext;
    };
    const usage: { bytes: number; durationSec: number }[] = [];
    await run(descriptor, usage);
    expect(calls[0]!.maxBytes).toBe(descriptor.size);
    expect(total(usage)).toBe(ciphertext.length);
  });

  it("books the bytes streamed by downloads that then failed, on every mirror", async () => {
    const { descriptor } = await fixture();
    behaviour = async (opts) => {
      opts.onBytes?.(1000);
      opts.onBytes?.(1000);
      throw new SafeFetchError("connection reset mid-body", true);
    };
    const usage: { bytes: number; durationSec: number }[] = [];
    await expect(run(descriptor, usage)).rejects.toThrow(/could not fetch blob/);
    expect(calls.length).toBe(2);
    expect(total(usage)).toBe(4000);
  });

  it("books a body that ran past the cap, and rejects it as policy", async () => {
    const { descriptor } = await fixture();
    behaviour = async (opts) => {
      opts.onBytes?.(opts.maxBytes + 1);
      throw new SafeFetchError("streamed bytes exceed cap", false);
    };
    const usage: { bytes: number; durationSec: number }[] = [];
    await expect(run(descriptor, usage)).rejects.toThrow(MediaPolicyError);
    expect(total(usage)).toBe(2 * (descriptor.size + 1));
  });

  it("books the download when the decrypt then fails", async () => {
    const { ciphertext, descriptor } = await fixture();
    behaviour = async (opts) => {
      opts.onBytes?.(ciphertext.length);
      return ciphertext;
    };
    const wrongKey = { ...descriptor, "decryption-key": btoa(String.fromCharCode(...new Uint8Array(32))) };
    const usage: { bytes: number; durationSec: number }[] = [];
    await expect(run(wrongKey, usage)).rejects.toThrow(MediaPolicyError);
    expect(total(usage)).toBe(ciphertext.length);
  });
});
