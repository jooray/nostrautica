/**
 * Optional stages must degrade, and a degradation must not be the end of it
 * (2026-09-04 audit).
 *
 * `processAttendee` composes one required stage (the ai_profile) with two
 * decorations: a summary of the attendee's public Nostr activity, and a
 * translation of their authored fields into the event language. Both are
 * enrichment. Neither is worth an attendee's profile, directory entry and every
 * match they would have had — which is exactly what a throw from either used to
 * cost, because it unwound the whole function before anything reached
 * `commitAiProfile`.
 *
 * The translation stage learned that in July (three attendees, 27 billed attempts
 * on a response shape that could never pass). The nostr summary sat next to it
 * with the same `z.object({summary: z.string()})` strictness and no catch at all,
 * so a `{"summary": null}` — the same malformation, from the same model family —
 * still took the attendee down.
 *
 * The other half is that "degraded" was ALL that happened: the failed artifact is
 * deliberately not cached, and nothing ever re-ran it, so the profile stayed
 * untranslated unless the attendee happened to edit it.
 */
import { describe, it, expect } from "vitest";
import type { AttendeeProfile } from "@nostrautica/protocol";
import { Store } from "../store/db.js";
import { MockLlm, MockStt } from "../providers/mock.js";
import { ProviderContractError } from "../providers/types.js";
import type { LlmProvider, RoleRoute } from "../providers/types.js";
import { processAttendee, type ProcessDeps } from "./process.js";
import { bytesToBase64, sha256Hex, aesGcmEncrypt } from "@nostrautica/protocol";

const PK = "a".repeat(64);

const profile: AttendeeProfile = {
  about: "Buduje nástroje na súkromie.", // Slovak, so the translation stage runs
  skills: ["zk"],
  looking_for: "dizajnéra",
  links: [],
};

const AI_PROFILE = {
  summary: "A cryptographer who builds privacy tools.",
  skills: ["zk"],
  interests: ["privacy"],
  offers: ["mentoring"],
  seeks: ["a designer"],
};

const TRANSLATION = {
  source_lang: "sk",
  needs_translation: true,
  about: "Builds privacy tools.",
  looking_for: "a designer",
  skills: ["zk"],
};

/** One mock LLM answering every role, with per-schema overrides/throws. */
function llmFor(handlers: Record<string, () => unknown>): MockLlm {
  return new MockLlm((req) => {
    const h = handlers[req.schemaName];
    if (h) return h();
    if (req.schemaName === "ai_profile") return AI_PROFILE;
    if (req.schemaName === "profile_translation") return TRANSLATION;
    if (req.schemaName === "nostr_summary") return { summary: "Posts about ZK." };
    throw new Error(`unexpected schema ${req.schemaName}`);
  });
}

function route(llm: LlmProvider): RoleRoute {
  return { llm, model: "mock-strong", provider: "mock", requirePrivate: false, privacy: "private" };
}

function deps(llm: MockLlm, extra: Partial<ProcessDeps> = {}): ProcessDeps {
  return {
    store: new Store(),
    stt: new MockStt(),
    sttModel: "m",
    summary: route(llm),
    match: route(llm),
    translate: route(llm),
    fetchNostrContext: async () => [{ kind: 1, content: "gm zk", created_at: 1 }],
    nostrContextN: 5,
    lang: "en",
    now: () => 1000,
    ...extra,
  };
}

describe("the nostr summary degrades instead of taking the attendee with it", () => {
  const nullSummary = () => ({ summary: null });

  it("a malformed summary still yields an ai_profile", async () => {
    const llm = llmFor({ nostr_summary: nullSummary });
    const logs: string[] = [];
    const out = await processAttendee(deps(llm, { log: (m) => logs.push(m) }), {
      pubkey: PK,
      profile,
      media: [],
      introText: "Hi, I build privacy tools.",
    });
    expect(out.aiProfile.summary).toBe(AI_PROFILE.summary);
    expect(logs.join("\n")).toMatch(/nostr summary failed/);
    expect(out.degraded).toEqual([
      { stage: "nostr_summary", reason: expect.stringContaining("nostr_summary"), retryable: false },
    ]);
  });

  it("does not cache the failure — a later run asks again rather than inheriting it", async () => {
    const store = new Store();
    const llm = llmFor({ nostr_summary: nullSummary });
    const d = deps(llm, { store, coordinate: `31923:${PK}:ev` });
    await processAttendee(d, { pubkey: PK, profile, media: [], introText: "hi" });
    const summaryCalls = llm.requests.filter((r) => r.schemaName === "nostr_summary").length;
    expect(summaryCalls).toBe(1);
    // Same inputs, same store: a cached failure would short-circuit this call.
    await processAttendee(d, { pubkey: PK, profile, media: [], introText: "hi" });
    expect(llm.requests.filter((r) => r.schemaName === "nostr_summary").length).toBe(2);
  });

  it("the summary is simply absent from the profile prompt, not a stray 'undefined'", async () => {
    const llm = llmFor({ nostr_summary: nullSummary });
    await processAttendee(deps(llm), { pubkey: PK, profile, media: [], introText: "hi" });
    const profileReq = llm.lastBySchema("ai_profile")!;
    expect(profileReq.user).not.toContain("PUBLIC NOSTR ACTIVITY");
  });

  it("a shutdown mid-summary still unwinds (abort beats degradation)", async () => {
    // Degrading past an abort would commit against a store the shutdown is about
    // to close (audit C11).
    const ac = new AbortController();
    const llm = new MockLlm((req) => {
      if (req.schemaName === "nostr_summary") {
        ac.abort();
        throw new Error("aborted");
      }
      return AI_PROFILE;
    });
    await expect(
      processAttendee(deps(llm, { signal: ac.signal }), {
        pubkey: PK,
        profile,
        media: [],
        introText: "hi",
      }),
    ).rejects.toThrow();
  });
});

describe("a degraded stage asks the job runner for another attempt", () => {
  /** A transient failure: a timeout, a 5xx, a dropped socket — not a bad shape. */
  const transient = () => {
    throw new Error("provider timeout: Venice chat/completions exceeded 120000ms");
  };
  /** Deterministic for a given (prompt, model): asking again only re-bills. */
  const deterministic = () => {
    throw new ProviderContractError("mock", "profile_translation", "m", "looking_for: invalid_type");
  };

  it("re-queues a TRANSIENT translation failure", async () => {
    const asked: unknown[] = [];
    const llm = llmFor({ profile_translation: transient });
    const out = await processAttendee(deps(llm, { retryLater: (r) => asked.push(r) }), {
      pubkey: PK,
      profile,
      media: [],
      introText: "hi",
    });
    // The attendee still gets everything that succeeded.
    expect(out.aiProfile.summary).toBe(AI_PROFILE.summary);
    expect(out.aiProfile.translations).toBeUndefined();
    // Delayed, not immediate: the one retry the dedupe key allows must not be spent
    // in the same second as the failure that asked for it.
    expect(asked).toEqual([
      {
        stage: "translation",
        pubkey: PK,
        reason: expect.stringContaining("provider timeout"),
        delayMs: 60_000,
      },
    ]);
    expect(out.degraded).toEqual([
      { stage: "translation", reason: expect.stringContaining("provider timeout"), retryable: true },
    ]);
  });

  it("does NOT re-queue a deterministic provider-contract failure", async () => {
    const asked: unknown[] = [];
    const llm = llmFor({ profile_translation: deterministic });
    const out = await processAttendee(deps(llm, { retryLater: (r) => asked.push(r) }), {
      pubkey: PK,
      profile,
      media: [],
      introText: "hi",
    });
    expect(asked).toEqual([]);
    expect(out.degraded![0]!.retryable).toBe(false);
  });

  it("re-queues a transient nostr-summary failure too", async () => {
    const asked: { stage: string }[] = [];
    const llm = llmFor({ nostr_summary: transient });
    await processAttendee(deps(llm, { retryLater: (r) => asked.push(r) }), {
      pubkey: PK,
      profile,
      media: [],
      introText: "hi",
    });
    expect(asked.map((a) => a.stage)).toEqual(["nostr_summary"]);
  });

  it("a clean run asks for nothing and reports no degradation", async () => {
    const asked: unknown[] = [];
    const out = await processAttendee(deps(llmFor({}), { retryLater: (r) => asked.push(r) }), {
      pubkey: PK,
      profile,
      media: [],
      introText: "hi",
    });
    expect(asked).toEqual([]);
    expect(out.degraded).toBeUndefined();
    expect(out.aiProfile.translations?.about).toBe(TRANSLATION.about);
  });
});

/**
 * SEC-18 / R13. `processAttendee` accepts a cancellation signal and forwards it to
 * every stage — except the one that does all the waiting. The default transcribe
 * closure took a signal parameter, named it `_sig`, and never handed it to
 * `transcribeMedia`, so an abort could only be noticed BETWEEN media files: never
 * inside the blob download, the ffprobe, or the STT call. That is the difference
 * between a coordinator that stops and one that runs each in-flight media file to
 * its provider deadline. The talk path forwarded it; the intro path did not.
 */
describe("SEC-18 — the intro path forwards cancellation into transcription", () => {
  it("does not start the STT call once the abort has landed", async () => {
    const ac = new AbortController();
    const stt = new MockStt();
    const llm = llmFor({});
    // A shutdown realistically lands while ffmpeg is running — the longest wait
    // before any money is spent. The question is whether the pipeline then goes on
    // to pay for the transcription anyway.
    // Real AES-GCM, because decryptMedia verifies `x`, `ox` and the tag before the
    // pipeline ever reaches the STT call — a fake blob fails earlier and would make
    // this test pass for the wrong reason.
    const plaintext = new Uint8Array(1024).fill(7);
    const key = new Uint8Array(32);
    const nonce = new Uint8Array(12);
    const media = (await aesGcmEncrypt(plaintext, key, nonce)).ciphertext;
    const x = sha256Hex(media);
    const ox = sha256Hex(plaintext);
    const run = processAttendee(
      deps(llm, {
        stt,
        signal: ac.signal,
        fetchBlob: async () => media,
        probeDuration: async () => 12,
        extractAudio: async () => {
          ac.abort();
          return [{ data: new Uint8Array(16), mime: "audio/ogg" }];
        },
      }),
      {
        pubkey: PK,
        profile,
        media: [
          {
            url: ["https://blossom.example/a.ogg"],
            x,
            ox,
            size: media.length,
            m: "audio/ogg",
            duration: 12,
            "encryption-algorithm": "aes-gcm",
            "decryption-key": bytesToBase64(new Uint8Array(32)),
            "decryption-nonce": bytesToBase64(new Uint8Array(12)),
          },
        ],
      },
    );
    await expect(run).rejects.toThrow();
    // Without the signal forwarded, transcribeMedia never learns about the abort
    // and bills a full STT call for a coordinator that is already shutting down.
    expect(stt.calls).toBe(0);
  });
});
