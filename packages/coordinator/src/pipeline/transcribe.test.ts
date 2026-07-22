/**
 * Media policy enforcement (audit H-3, spec §8): the coordinator MUST compare the
 * actual downloaded ciphertext length to the declared `size` and reject mismatches,
 * and MUST probe the real decoded duration and reject over-limit media before STT.
 * Actual bytes/duration are accounted into the usage budgets, never declared values.
 */
import { describe, it, expect } from "vitest";
import { encryptMedia } from "@nostrautica/protocol";
import { Store } from "../store/db.js";
import { transcribeMedia, MediaPolicyError } from "./transcribe.js";
import { MockStt } from "../providers/mock.js";

async function fixture(durationDeclared = 30) {
  const data = new Uint8Array(4096).map((_, i) => i % 251);
  const { ciphertext, descriptor } = await encryptMedia({
    kind: "intro",
    data,
    mime: "audio/webm",
    duration: durationDeclared,
    urls: ["https://blob.example/x"],
  });
  return { ciphertext, descriptor };
}

describe("H-3 — declared-size verification", () => {
  it("rejects media whose actual ciphertext length != declared size (no STT), accounting actual bytes", async () => {
    const store = new Store(":memory:");
    const { ciphertext, descriptor } = await fixture();
    // Attendee lied: declares a tiny size to duck the aggregate byte budget.
    const lying = { ...descriptor, size: 1 };
    const stt = new MockStt();
    const usage: { bytes: number; durationSec: number }[] = [];
    await expect(
      transcribeMedia(
        {
          store,
          stt,
          sttModel: "m",
          fetchBlob: async () => ciphertext,
          onUsage: (u) => usage.push(u),
        },
        lying as any,
      ),
    ).rejects.toThrow(MediaPolicyError);
    expect(stt.calls).toBe(0); // never transcribed
    // Actual downloaded bytes were still accounted (abuse metered on rejection).
    expect(usage[0]!.bytes).toBe(ciphertext.length);
    // An empty transcript is cached so a re-delivery of the same x doesn't re-download.
    expect(store.getTranscript(descriptor.x)).toBe("");
  });

  it("accepts media whose actual length matches the declared size", async () => {
    const store = new Store(":memory:");
    const { ciphertext, descriptor } = await fixture();
    const stt = new MockStt({ default: "hello world" });
    const r = await transcribeMedia(
      {
        store,
        stt,
        sttModel: "m",
        fetchBlob: async () => ciphertext,
        probeDuration: async () => 10, // under any limit
        extractAudio: async () => [{ data: new Uint8Array(8), mime: "audio/ogg" }],
      },
      descriptor as any,
    );
    expect(r.text).toBe("hello world");
    expect(stt.calls).toBe(1);
  });
});

describe("H-3 — real decoded-duration enforcement", () => {
  it("rejects media whose PROBED duration exceeds the event limit, before STT", async () => {
    const store = new Store(":memory:");
    // Declares 30s (under the 60s limit) but really decodes to 600s.
    const { ciphertext, descriptor } = await fixture(30);
    const stt = new MockStt();
    const usage: { bytes: number; durationSec: number }[] = [];
    await expect(
      transcribeMedia(
        {
          store,
          stt,
          sttModel: "m",
          fetchBlob: async () => ciphertext,
          maxDurationSec: 60,
          probeDuration: async () => 600, // REAL duration >> declared
          onUsage: (u) => usage.push(u),
        },
        descriptor as any,
      ),
    ).rejects.toThrow(/decoded duration 600s exceeds the 60s/);
    expect(stt.calls).toBe(0); // rejected before STT
    // Real (probed) duration + actual bytes accounted, not the declared 30s.
    expect(usage.at(-1)).toEqual({ bytes: ciphertext.length, durationSec: 600 });
  });

  it("transcribes when the probed duration is within the limit, accounting real duration", async () => {
    const store = new Store(":memory:");
    const { ciphertext, descriptor } = await fixture(30);
    const stt = new MockStt({ default: "ok" });
    const usage: { bytes: number; durationSec: number }[] = [];
    const r = await transcribeMedia(
      {
        store,
        stt,
        sttModel: "m",
        fetchBlob: async () => ciphertext,
        maxDurationSec: 60,
        probeDuration: async () => 45,
        onUsage: (u) => usage.push(u),
        extractAudio: async () => [{ data: new Uint8Array(8), mime: "audio/ogg" }],
      },
      descriptor as any,
    );
    expect(r.text).toBe("ok");
    expect(stt.calls).toBe(1);
    expect(usage.at(-1)).toEqual({ bytes: ciphertext.length, durationSec: 45 });
  });
});
