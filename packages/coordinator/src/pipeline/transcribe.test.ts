/**
 * Media policy enforcement (audit H-3, spec §8): the coordinator MUST compare the
 * actual downloaded ciphertext length to the declared `size` and reject mismatches,
 * and MUST probe the real decoded duration and reject over-limit media before STT.
 * Actual bytes/duration are accounted into the usage budgets, never declared values.
 */
import { describe, it, expect, vi } from "vitest";
import { encryptMedia } from "@nostrautica/protocol";
import { Store } from "../store/db.js";
import { transcribeMedia, MediaPolicyError, MIN_AUDIO_BYTES_TO_EXPECT_SPEECH } from "./transcribe.js";
import { ProbeUnavailableError } from "./audio.js";
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

/**
 * "Could not probe" is not "zero seconds" (2026-09-04 audit).
 *
 * `probeDurationSec` returned 0 on ANY ffprobe failure — a timeout, a killed
 * process, an unparseable container, an "N/A" duration — and audio.ts's own
 * comment claimed the caller treated that as "unknown". The caller did not. So a
 * media file whose header ffprobe cannot parse but ffmpeg CAN decode passed the
 * `realDurationSec > maxDurationSec` guard AND booked 0 seconds against the usage
 * budget, while the STT bill for the full-length audio was entirely real. Both
 * halves of H-3's enforcement, defeated by one unparseable header.
 */
describe("H-3 — an UNPROBEABLE duration is a rejection, not a pass", () => {
  it("rejects unprobeable media before STT when a duration limit is configured", async () => {
    const store = new Store();
    const { ciphertext, descriptor } = await fixture(30);
    const stt = new MockStt({ default: "should never run" });
    const usage: { bytes: number; durationSec: number }[] = [];
    await expect(
      transcribeMedia(
        {
          store,
          stt,
          sttModel: "m",
          fetchBlob: async () => ciphertext,
          maxDurationSec: 60,
          probeDuration: async () => undefined, // ffprobe gave no usable answer
          onUsage: (u) => usage.push(u),
          extractAudio: async () => [{ data: new Uint8Array(8), mime: "audio/ogg" }],
        },
        descriptor as any,
      ),
    ).rejects.toThrow(/could not determine the decoded duration/);
    expect(stt.calls).toBe(0); // never paid for
    // Still a MediaPolicyError, so processAttendee skips THIS media and carries on
    // with the attendee rather than poisoning their whole pipeline.
    await expect(
      transcribeMedia(
        {
          store: new Store(),
          stt: new MockStt(),
          sttModel: "m",
          fetchBlob: async () => ciphertext,
          maxDurationSec: 60,
          probeDuration: async () => undefined,
        },
        descriptor as any,
      ),
    ).rejects.toBeInstanceOf(MediaPolicyError);
    // Bytes actually downloaded are still metered on rejection.
    expect(usage.at(-1)!.bytes).toBe(ciphertext.length);
  });

  it("a probe that never ANSWERED is retryable and is NOT cached (PIPE-N-1)", async () => {
    // The 09-04 fix collapsed two different things into `undefined`: "ffprobe ran
    // and could not parse this" (a fact about the media — rejected, cached) and
    // "ffprobe never answered" (a timeout, a kill, a failed spawn — a fact about
    // the HOST). The second was cached as a permanent policy rejection, so one slow
    // probe during a deploy meant the attendee's recording was never transcribed
    // and re-submitting the identical blob hit the same cached verdict forever.
    const store = new Store();
    const { ciphertext, descriptor } = await fixture(30);
    const stt = new MockStt({ default: "ok" });
    const usage: { bytes: number; durationSec: number }[] = [];
    let probes = 0;
    const deps = (probe: () => Promise<number | undefined>) => ({
      store,
      stt,
      sttModel: "m",
      fetchBlob: async () => ciphertext,
      maxDurationSec: 60,
      probeDuration: probe,
      onUsage: (u: { bytes: number; durationSec: number }) => usage.push(u),
      extractAudio: async () => [{ data: new Uint8Array(8), mime: "audio/ogg" }],
    });

    await expect(
      transcribeMedia(
        deps(async () => {
          probes++;
          throw new ProbeUnavailableError("ffprobe timed out after 120000ms");
        }),
        descriptor as any,
      ),
    ).rejects.toBeInstanceOf(ProbeUnavailableError);
    // NOT a MediaPolicyError: processAttendee rethrows this, so the job runner
    // retries with backoff instead of skipping the media for good.
    expect(stt.calls).toBe(0);
    expect(usage.at(-1)!.bytes).toBe(ciphertext.length); // bytes really spent, metered
    expect(store.getTranscriptRow(descriptor.x)).toBeUndefined(); // nothing cached

    // The retry, on a host that is no longer wedged, transcribes normally.
    const r = await transcribeMedia(deps(async () => 30), descriptor as any);
    expect(r.text).toBe("ok");
    expect(probes).toBe(1);
  });

  it("still transcribes unprobeable media when NO duration limit is configured", async () => {
    // With no limit there is nothing to enforce, so an unknown duration is just an
    // unknown duration — rejecting here would break every event that sets no cap.
    const store = new Store();
    const { ciphertext, descriptor } = await fixture(30);
    const stt = new MockStt({ default: "ok" });
    const usage: { bytes: number; durationSec: number }[] = [];
    const r = await transcribeMedia(
      {
        store,
        stt,
        sttModel: "m",
        fetchBlob: async () => ciphertext,
        probeDuration: async () => undefined,
        onUsage: (u) => usage.push(u),
        extractAudio: async () => [{ data: new Uint8Array(8), mime: "audio/ogg" }],
      },
      descriptor as any,
    );
    expect(r.text).toBe("ok");
    expect(usage.at(-1)).toEqual({ bytes: ciphertext.length, durationSec: 0 });
  });

  it("a probed 0 is still a real measurement and passes", async () => {
    const store = new Store();
    const { ciphertext, descriptor } = await fixture(30);
    const stt = new MockStt({ default: "ok" });
    const r = await transcribeMedia(
      {
        store,
        stt,
        sttModel: "m",
        fetchBlob: async () => ciphertext,
        maxDurationSec: 60,
        probeDuration: async () => 0,
        extractAudio: async () => [{ data: new Uint8Array(8), mime: "audio/ogg" }],
      },
      descriptor as any,
    );
    expect(r.text).toBe("ok");
  });
});

/**
 * An empty transcript over real audio is not cached (2026-09-04 audit).
 *
 * The transcript cache is keyed by blob sha256 and is permanent, and the cache hit
 * short-circuits before the download — so caching "" spends one provider hiccup to
 * discard an intro the attendee recorded, forever, indistinguishably from silence.
 */
describe("an empty transcript over non-trivial audio is not cached", () => {
  const bigSegment = { data: new Uint8Array(MIN_AUDIO_BYTES_TO_EXPECT_SPEECH), mime: "audio/ogg" };

  it("leaves the cache empty so a reprocess can try again", async () => {
    const store = new Store();
    const { ciphertext, descriptor } = await fixture(30);
    const stt = new MockStt({ default: "" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await transcribeMedia(
      {
        store,
        stt,
        sttModel: "m",
        fetchBlob: async () => ciphertext,
        probeDuration: async () => 30,
        extractAudio: async () => [bigSegment],
      },
      descriptor as any,
    );
    expect(r.text).toBe("");
    expect(store.getTranscript(descriptor.x)).toBeUndefined(); // NOT cached
    expect(warn.mock.calls.map((c) => c.join(" ")).join("\n")).toMatch(/empty transcript/);
    warn.mockRestore();
  });

  it("still caches an empty transcript for a genuinely tiny clip (real silence costs one call)", async () => {
    const store = new Store();
    const { ciphertext, descriptor } = await fixture(30);
    const r = await transcribeMedia(
      {
        store,
        stt: new MockStt({ default: "" }),
        sttModel: "m",
        fetchBlob: async () => ciphertext,
        probeDuration: async () => 1,
        extractAudio: async () => [{ data: new Uint8Array(64), mime: "audio/ogg" }],
      },
      descriptor as any,
    );
    expect(r.text).toBe("");
    expect(store.getTranscript(descriptor.x)).toBe("");
  });

  it("a real transcript is cached as before", async () => {
    const store = new Store();
    const { ciphertext, descriptor } = await fixture(30);
    await transcribeMedia(
      {
        store,
        stt: new MockStt({ default: "hello" }),
        sttModel: "m",
        fetchBlob: async () => ciphertext,
        probeDuration: async () => 30,
        extractAudio: async () => [bigSegment],
      },
      descriptor as any,
    );
    expect(store.getTranscript(descriptor.x)).toBe("hello");
  });
});

/**
 * Audit B-7 — a duration verdict belongs to the (blob, limit) pair, not the blob.
 *
 * The transcript cache is keyed by blob sha256 alone and shared across every event
 * a coordinator serves, so caching an over-duration/unprobeable rejection as an
 * empty transcript let a STRICT event's limit silence the same recording at a
 * LENIENT one — the reuse flow the product advertises, failing in a way that looks
 * exactly like a silent recording.
 */
describe("a limit-dependent media rejection is not cached across events", () => {
  const bigSegment = { data: new Uint8Array(MIN_AUDIO_BYTES_TO_EXPECT_SPEECH), mime: "audio/ogg" };

  it("an over-duration rejection at a STRICT event does not silence a LENIENT one", async () => {
    const store = new Store();
    const { ciphertext, descriptor } = await fixture(100);
    const stt = new MockStt({ default: "the reused intro" });
    const deps = {
      store,
      stt,
      sttModel: "m",
      fetchBlob: async () => ciphertext,
      probeDuration: async () => 100,
      extractAudio: async () => [bigSegment],
    };

    // Event A caps intros at 90s: this 100s blob is rejected, nothing transcribed.
    await expect(transcribeMedia({ ...deps, maxDurationSec: 90 }, descriptor as any)).rejects.toBeInstanceOf(
      MediaPolicyError,
    );
    expect(stt.calls).toBe(0);
    expect(store.getTranscript(descriptor.x)).toBeUndefined(); // NOT cached as ""

    // Event B allows 900s: the same blob must actually transcribe.
    const r = await transcribeMedia({ ...deps, maxDurationSec: 900 }, descriptor as any);
    expect(r.text).toBe("the reused intro");
    expect(stt.calls).toBe(1);
  });

  it("unprobeable media is likewise not cached as a permanent rejection", async () => {
    // Same reasoning: "unprobeable" is only a rejection BECAUSE a limit is
    // enforced. An event with no duration limit waves the identical blob through,
    // so the verdict cannot be cached against the blob alone.
    const store = new Store();
    const { ciphertext, descriptor } = await fixture(30);
    const stt = new MockStt({ default: "spoken words" });
    const deps = {
      store,
      stt,
      sttModel: "m",
      fetchBlob: async () => ciphertext,
      probeDuration: async () => undefined, // ffprobe answered, with nothing usable
      extractAudio: async () => [bigSegment],
    };
    await expect(transcribeMedia({ ...deps, maxDurationSec: 60 }, descriptor as any)).rejects.toBeInstanceOf(
      MediaPolicyError,
    );
    expect(store.getTranscript(descriptor.x)).toBeUndefined();
    // No limit configured for this event ⇒ the same media is transcribed.
    expect((await transcribeMedia(deps, descriptor as any)).text).toBe("spoken words");
  });

});
