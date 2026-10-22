/**
 * Media policy enforcement (audit H-3, spec §8): the coordinator MUST compare the
 * actual downloaded ciphertext length to the declared `size` and reject mismatches,
 * and MUST probe the real decoded duration and reject over-limit media before STT.
 * Actual bytes/duration are accounted into the usage budgets, never declared values.
 */
import { describe, it, expect, vi } from "vitest";
import { encryptMedia } from "@nostrautica/protocol";
import { Store } from "../store/db.js";
import {
  transcribeMedia,
  MediaPolicyError,
  EmptyTranscriptError,
  MAX_EMPTY_STT_ATTEMPTS,
  MIN_AUDIO_BYTES_TO_EXPECT_SPEECH,
} from "./transcribe.js";
import { ProbeUnavailableError, SubprocessError } from "./audio.js";
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
    // Nothing is cached (audit R-16): the verdict is this descriptor's, not the blob's.
    expect(store.getTranscriptRow(descriptor.x)).toBeUndefined();
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

  it("leaves the cache empty and fails retryably, so the job tries again (DS41-040)", async () => {
    const store = new Store();
    const { ciphertext, descriptor } = await fixture(30);
    const stt = new MockStt({ default: "" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Pre-fix this RESOLVED with "", and the job committed as done: a content-free
    // profile, no status, and a terminal dedupe key nothing re-opened.
    const err = await transcribeMedia(
      {
        store,
        stt,
        sttModel: "m",
        fetchBlob: async () => ciphertext,
        probeDuration: async () => 30,
        extractAudio: async () => [bigSegment],
      },
      descriptor as any,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(EmptyTranscriptError);
    expect(err).not.toBeInstanceOf(MediaPolicyError);
    expect(store.getTranscript(descriptor.x)).toBeUndefined(); // NOT cached
    expect(store.emptySttAttempts(descriptor.x)).toBe(1);
    expect(warn.mock.calls.map((c) => c.join(" ")).join("\n")).toMatch(/empty transcript/);
    warn.mockRestore();
  });

  it("gives up after MAX_EMPTY_STT_ATTEMPTS as a media-policy reject, then stops paying (DS41-040)", async () => {
    const store = new Store();
    const { ciphertext, descriptor } = await fixture(30);
    const stt = new MockStt({ default: "" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps = {
      store,
      stt,
      sttModel: "m",
      fetchBlob: async () => ciphertext,
      probeDuration: async () => 30,
      extractAudio: async () => [bigSegment],
    };
    const errors: unknown[] = [];
    for (let i = 0; i < MAX_EMPTY_STT_ATTEMPTS; i++) errors.push(await transcribeMedia(deps, descriptor as any).catch((e) => e));
    expect(errors.slice(0, -1).every((e) => e instanceof EmptyTranscriptError)).toBe(true);
    expect(errors.at(-1)).toBeInstanceOf(MediaPolicyError);
    expect(stt.calls).toBe(MAX_EMPTY_STT_ATTEMPTS);
    // Once given up on, a further attempt rejects before downloading or calling STT.
    let downloaded = false;
    await expect(
      transcribeMedia({ ...deps, fetchBlob: async () => ((downloaded = true), ciphertext) }, descriptor as any),
    ).rejects.toBeInstanceOf(MediaPolicyError);
    expect(downloaded).toBe(false);
    expect(stt.calls).toBe(MAX_EMPTY_STT_ATTEMPTS);
    warn.mockRestore();
  });

  it("a later real transcript clears the count", async () => {
    const store = new Store();
    const { ciphertext, descriptor } = await fixture(30);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const base = { store, sttModel: "m", fetchBlob: async () => ciphertext, probeDuration: async () => 30, extractAudio: async () => [bigSegment] };
    await transcribeMedia({ ...base, stt: new MockStt({ default: "" }) }, descriptor as any).catch(() => {});
    expect(store.emptySttAttempts(descriptor.x)).toBe(1);
    await transcribeMedia({ ...base, stt: new MockStt({ default: "hello" }) }, descriptor as any);
    expect(store.emptySttAttempts(descriptor.x)).toBe(0);
    warn.mockRestore();
  });

  it("an organizer reprocess resets the attendee's counters", async () => {
    const store = new Store();
    const x = "a".repeat(64);
    for (let i = 0; i < MAX_EMPTY_STT_ATTEMPTS; i++) store.recordEmptyStt(x, i);
    store.recordTranscriptRef(x, "31923:pk:d", "b".repeat(64), 0);
    expect(store.clearEmptySttForSubject("31923:pk:d", "b".repeat(64))).toBe(1);
    expect(store.emptySttAttempts(x)).toBe(0);
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

/** Audit DS41-037: deterministic decrypt/decode failures rode the 3-day retry tail. */
describe("deterministic media failures reject the media, not the attendee", () => {
  const deps = (store: Store, ciphertext: Uint8Array, extractAudio?: any) => ({
    store, stt: new MockStt({ default: "x" }), sttModel: "m",
    fetchBlob: async () => ciphertext, probeDuration: async () => 10,
    ...(extractAudio ? { extractAudio } : {}),
  });
  it("a descriptor whose key does not decrypt the blob is a MediaPolicyError", async () => {
    const { ciphertext, descriptor } = await fixture();
    const wrongKey = { ...descriptor, "decryption-key": btoa(String.fromCharCode(...new Uint8Array(32))) };
    await expect(transcribeMedia(deps(new Store(":memory:"), ciphertext) as any, wrongKey as any)).rejects.toThrow(MediaPolicyError);
  });
  it("an ffmpeg exit is a MediaPolicyError; a timeout stays retryable", async () => {
    const { ciphertext, descriptor } = await fixture();
    const exit = async () => { throw new SubprocessError("ffmpeg exited 1", "exit"); };
    await expect(transcribeMedia(deps(new Store(":memory:"), ciphertext, exit) as any, descriptor as any)).rejects.toThrow(MediaPolicyError);
    const timeout = async () => { throw new SubprocessError("ffmpeg timed out", "timeout"); };
    const err = await transcribeMedia(deps(new Store(":memory:"), ciphertext, timeout) as any, descriptor as any).catch((e) => e);
    expect(err).toBeInstanceOf(SubprocessError);
    expect(err).not.toBeInstanceOf(MediaPolicyError);
  });
});

/**
 * Audit R-16 — the transcript cache is keyed by the PUBLIC ciphertext hash, so a
 * hit has to be tied to possession of the key, or anyone who knows `x` reads the
 * owner's transcript, pins it with a ref, or silences it with a lying `size`.
 */
describe("a transcript cache hit requires the blob's key (R-16)", () => {
  const owner = { coordinate: "31923:pk:d", pubkey: "a".repeat(64) };
  const thief = { coordinate: "31923:pk:other", pubkey: "c".repeat(64) };
  const seg = { data: new Uint8Array(MIN_AUDIO_BYTES_TO_EXPECT_SPEECH), mime: "audio/ogg" };
  const refs = (store: Store, x: string) =>
    (store as any).db.prepare("SELECT coordinate, pubkey FROM transcript_refs WHERE blob_sha256 = ?").all(x);

  async function seeded() {
    const store = new Store(":memory:");
    const { ciphertext, descriptor } = await fixture(30);
    await transcribeMedia(
      {
        store,
        stt: new MockStt({ default: "the owner's private intro" }),
        sttModel: "m",
        fetchBlob: async () => ciphertext,
        probeDuration: async () => 30,
        extractAudio: async () => [seg],
        owner,
      },
      descriptor as any,
    );
    return { store, ciphertext, descriptor };
  }

  it("the owner's own descriptor still hits the cache without a download", async () => {
    const { store, descriptor } = await seeded();
    const fetchBlob = vi.fn(async () => new Uint8Array());
    const stt = new MockStt({ default: "x" });
    const r = await transcribeMedia({ store, stt, sttModel: "m", fetchBlob, owner }, descriptor as any);
    expect(r.text).toBe("the owner's private intro");
    expect(fetchBlob).not.toHaveBeenCalled();
    expect(stt.calls).toBe(0);
  });

  it("a descriptor with the right x but a wrong key gets no transcript and records no ref", async () => {
    const { store, ciphertext, descriptor } = await seeded();
    const forged = { ...descriptor, "decryption-key": btoa(String.fromCharCode(...new Uint8Array(32).fill(7))) };
    const stt = new MockStt({ default: "x" });
    await expect(
      transcribeMedia({ store, stt, sttModel: "m", fetchBlob: async () => ciphertext, owner: thief }, forged as any),
    ).rejects.toThrow(MediaPolicyError);
    expect(stt.calls).toBe(0);
    expect(refs(store, descriptor.x)).toEqual([owner]);
  });

  it("a wrong declared size cannot plant an empty transcript under the victim's x", async () => {
    const store = new Store(":memory:");
    const { ciphertext, descriptor } = await fixture(30);
    await expect(
      transcribeMedia(
        { store, stt: new MockStt(), sttModel: "m", fetchBlob: async () => ciphertext },
        { ...descriptor, size: 1 } as any,
      ),
    ).rejects.toThrow(MediaPolicyError);
    const r = await transcribeMedia(
      {
        store,
        stt: new MockStt({ default: "the victim speaks" }),
        sttModel: "m",
        fetchBlob: async () => ciphertext,
        probeDuration: async () => 30,
        extractAudio: async () => [seg],
      },
      descriptor as any,
    );
    expect(r.text).toBe("the victim speaks");
  });

  it("a legacy row is served only after a decrypt proves the key, then bound to it", async () => {
    const store = new Store(":memory:");
    const { ciphertext, descriptor } = await fixture(30);
    store.putTranscript(descriptor.x, "legacy text", 0); // older binary: no key_fp
    const stt = new MockStt({ default: "fresh" });
    const fetchBlob = vi.fn(async () => ciphertext);
    const r = await transcribeMedia({ store, stt, sttModel: "m", fetchBlob, owner }, descriptor as any);
    expect(r.text).toBe("legacy text");
    expect(fetchBlob).toHaveBeenCalledTimes(1);
    expect(stt.calls).toBe(0);
    expect(store.getTranscriptRow(descriptor.x)!.key_fp).toBeTruthy();
    expect(refs(store, descriptor.x)).toEqual([owner]);
  });

  it("a legacy EMPTY row (what the old size-mismatch branch planted) is re-transcribed", async () => {
    const store = new Store(":memory:");
    const { ciphertext, descriptor } = await fixture(30);
    store.putTranscript(descriptor.x, "", 0);
    const r = await transcribeMedia(
      {
        store,
        stt: new MockStt({ default: "real words" }),
        sttModel: "m",
        fetchBlob: async () => ciphertext,
        probeDuration: async () => 30,
        extractAudio: async () => [seg],
      },
      descriptor as any,
    );
    expect(r.text).toBe("real words");
  });
});
