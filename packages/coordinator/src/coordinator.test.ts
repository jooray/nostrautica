import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { Event as NostrEvent } from "nostr-tools/core";
import {
  makeCoordinate,
  makeInviteProof,
  inviteHash,
  generateEck,
  bytesToBase64,
  base64ToBytes,
  bytesToHex,
  eckDecrypt,
  nip44Decrypt,
  blindedD,
  wrapRumor,
  KIND_JOIN_REQUEST,
  KIND_PROFILE_SUBMISSION,
  KIND_MATCH_LIST,
  KIND_MATCH_MATRIX,
  KIND_DIRECTORY_ENTRY,
  KIND_ADMIN_COMMAND,
  KIND_COORDINATOR_GRANT,
  KIND_COORDINATOR_STATUS,
  KIND_PROFILE_CORRECTION,
  KIND_TALK,
  KIND_TALK_SUBMISSION,
  KIND_DELETION,
  talkContentSchema,
  directoryEntryContentSchema,
  matchListContentSchema,
  matchMatrixContentSchema,
  rosterContentSchema,
  keyGrantContentSchema,
  coordinatorStatusContentSchema,
  unwrapRumor,
  type EckVersion,
} from "@nostrautica/protocol";
import { Store } from "./store/db.js";
import { Coordinator, type Transport } from "./coordinator.js";
import { MockStt, MockLlm } from "./providers/mock.js";

class FakeTransport implements Transport {
  published: NostrEvent[] = [];
  seed: NostrEvent[] = [];
  async publish(event: NostrEvent): Promise<void> {
    this.published.push(event);
  }
  async fetch(filter: any): Promise<NostrEvent[]> {
    return [...this.seed, ...this.published].filter((e) => {
      if (filter.kinds && !filter.kinds.includes(e.kind)) return false;
      if (filter.authors && !filter.authors.includes(e.pubkey)) return false;
      if (filter["#d"]) {
        const d = e.tags.find((t) => t[0] === "d")?.[1];
        if (!d || !filter["#d"].includes(d)) return false;
      }
      return true;
    });
  }
  subscribe(): () => void {
    return () => {};
  }
}

const FIXTURES = {
  crypto: { about: "cryptographer", skills: ["zk", "cryptography"], transcript: "I build zk proofs", role: "cryptographer" },
  design: { about: "designer", skills: ["ui", "ux"], transcript: "I design interfaces", role: "designer" },
  code: { about: "programmer", skills: ["rust"], transcript: "I write systems code", role: "programmer" },
  music: { about: "musician", skills: ["drums"], transcript: "I play drums", role: "musician" },
};
type FixtureKey = keyof typeof FIXTURES;
const ORDER: FixtureKey[] = ["crypto", "design", "code", "music"];
const blobSize = (f: FixtureKey) => 100 + ORDER.indexOf(f);

interface Counters {
  nostrSummary: number;
  /** One entry per FORWARD batched match-scoring call: target role + candidate roles. */
  batchCalls: { targetRole?: string; candidateRoles: (string | undefined)[] }[];
  /** One entry per REVERSE batched call: shared-candidate role + target roles. */
  reverseCalls: { sharedRole?: string; targetRoles: (string | undefined)[] }[];
  /** When set, the NEXT batch containing a candidate of this role omits that entry once. */
  dropRoleOnce?: string;
  /** How many profile-translation calls the pipeline made. */
  translateCalls: number;
}

const ROLES = ["cryptographer", "designer", "programmer", "musician"] as const;
const roleOf = (text: string) => ROLES.find((r) => text.includes(r));

/** Shared match-scoring: complementary (different roles) → high, else low. An
 *  "(updated)" profile in EITHER block nudges the score so a re-recorded intro
 *  produces a visibly different match list. */
function scoreEntry(index: number, aRole?: string, bRole?: string, updated = false) {
  const complementary = !!aRole && !!bRole && aRole !== bRole;
  const base = complementary ? 0.9 : 0.4;
  return {
    index,
    score: updated ? Math.min(1, base + 0.05) : base,
    similarity: complementary ? 0.4 : 0.85,
    complementarity: complementary ? 0.95 : 0.2,
    reasoning_for_target: complementary
      ? `You should meet them — complementary skills (${aRole} + ${bRole}) fit this event.${updated ? " (updated)" : ""}`
      : "Similar backgrounds.",
  };
}

function makeLlm(counters: Counters): MockLlm {
  return new MockLlm((req) => {
    if (req.schemaName === "ai_profile") {
      // A re-recorded intro (marker "CHANGED-INTRO") yields a DIFFERENT ai_profile
      // so its profile_hash changes — exercises recompute-on-change.
      if (req.user.includes("CHANGED-INTRO")) {
        return {
          summary: "cryptographer profile (updated)",
          skills: ["zk", "cryptography", "halo2"],
          interests: ["cryptographer", "recursion"],
          offers: ["zk", "halo2"],
          seeks: ["designer", "programmer"],
        };
      }
      const which = ORDER.find((k) => req.user.includes(FIXTURES[k].transcript)) ?? "code";
      const f = FIXTURES[which];
      const usedNostr = req.user.includes("PUBLIC NOSTR ACTIVITY");
      return {
        summary: `${f.role} profile`,
        skills: f.skills,
        interests: [f.role, ...(usedNostr ? ["from-nostr"] : [])],
        offers: f.skills,
        seeks: which === "crypto" ? ["designer", "programmer"] : ["collaborators"],
      };
    }
    if (req.schemaName === "batch_score") {
      // Forward batched scoring: ONE target + numbered candidates (spec §16.2).
      const [, afterTarget = ""] = req.user.split("TARGET ATTENDEE:");
      const [targetBlock = "", candsBlock = ""] = afterTarget.split("CANDIDATES:");
      const targetRole = roleOf(targetBlock);
      const chunks = candsBlock.split(/--- CANDIDATE (\d+) ---/).slice(1);
      const targetUpdated = targetBlock.includes("(updated)");
      const call: Counters["batchCalls"][number] = { targetRole, candidateRoles: [] };
      counters.batchCalls.push(call);
      const matches = [];
      for (let i = 0; i + 1 < chunks.length; i += 2) {
        const index = Number(chunks[i]);
        const chunk = chunks[i + 1]!;
        const role = roleOf(chunk);
        call.candidateRoles.push(role);
        if (role && counters.dropRoleOnce === role) {
          // Simulate the model skipping this candidate (partial batch failure).
          counters.dropRoleOnce = undefined;
          continue;
        }
        matches.push(scoreEntry(index, targetRole, role, targetUpdated || chunk.includes("(updated)")));
      }
      return { matches };
    }
    if (req.schemaName === "reverse_batch_score") {
      // Reverse batched scoring: ONE shared candidate + numbered targets (§16.2).
      const [, afterShared = ""] = req.user.split("SHARED PERSON (the one each target below would meet):");
      const [sharedBlock = "", targetsBlock = ""] = afterShared.split("TARGET ATTENDEES:");
      const sharedRole = roleOf(sharedBlock);
      const chunks = targetsBlock.split(/--- TARGET (\d+) ---/).slice(1);
      const sharedUpdated = sharedBlock.includes("(updated)");
      const call: Counters["reverseCalls"][number] = { sharedRole, targetRoles: [] };
      counters.reverseCalls.push(call);
      const matches = [];
      for (let i = 0; i + 1 < chunks.length; i += 2) {
        const index = Number(chunks[i]);
        const chunk = chunks[i + 1]!;
        const role = roleOf(chunk);
        call.targetRoles.push(role);
        // reasoning addressed to the TARGET about meeting the shared person.
        matches.push(scoreEntry(index, role, sharedRole, sharedUpdated || chunk.includes("(updated)")));
      }
      return { matches };
    }
    if (req.schemaName === "profile_translation") {
      counters.translateCalls++;
      // Fixtures are English. If the target (event) language is English too, nothing
      // to translate; otherwise return a marked translation of each supplied field.
      const targetIsEn = /TARGET LANGUAGE: English \(en\)/.test(req.user);
      if (targetIsEn) return { source_lang: "en", needs_translation: false };
      const grab = (label: string) =>
        req.user.match(new RegExp(`${label}: (.*)`))?.[1]?.trim() ?? "";
      const about = grab("About");
      const looking = grab("Looking for");
      const skills = grab("Skills");
      return {
        source_lang: "en",
        needs_translation: true,
        ...(about ? { about: `[sk] ${about}` } : {}),
        ...(looking ? { looking_for: `[sk] ${looking}` } : {}),
        ...(skills ? { skills: skills.split(", ").filter(Boolean).map((s) => `[sk] ${s}`) } : {}),
      };
    }
    if (req.schemaName === "nostr_summary") {
      counters.nostrSummary++;
      return { summary: "active in cryptography circles" };
    }
    return {};
  });
}

interface Harness {
  coordinator: Coordinator;
  transport: FakeTransport;
  store: Store;
  llm: MockLlm;
  stt: MockStt;
  counters: Counters;
  coordSk: Uint8Array;
  eidSk: Uint8Array;
  einboxSk: Uint8Array;
  coordinate: string;
  eck: Uint8Array;
  invites: Uint8Array[];
  nextInvite: number;
  /** Mutable test clock — advance to let retry backoffs elapse. */
  clock: { t: number };
}

async function setup(
  nostrContextN = 0,
  opts: {
    batchSize?: number;
    lang?: string;
    matchVisibility?: "pair" | "event";
    matching?: "on" | "off";
    talks?: "off" | "on" | "prerecord-first";
    failTranscribe?: boolean;
  } = {},
): Promise<Harness> {
  const coordSk = generateSecretKey();
  const eidSk = generateSecretKey();
  const eidPubkey = getPublicKey(eidSk);
  const einboxSk = generateSecretKey();
  const d = "cypherpunk";
  const coordinate = makeCoordinate(eidPubkey, d);
  const eck = generateEck();
  const eckVersions: EckVersion[] = [{ id: 1, key: bytesToBase64(eck) }];
  const invites = Array.from({ length: 6 }, () => generateSecretKey());

  // Pass the identity key so the whole pipeline runs against at-rest-encrypted
  // event-key columns (F1) — exactly like production.
  const store = new Store(":memory:", coordSk);
  const transport = new FakeTransport();
  transport.seed.push(
    { kind: 31923, pubkey: eidPubkey, created_at: 1, tags: [["d", d], ["title", "Cypherpunk Assembly"], ["t", "cypherpunk"]], content: "", id: "e1", sig: "" } as any,
    { kind: 31600, pubkey: eidPubkey, created_at: 1, tags: [["d", d], ["inbox", getPublicKey(einboxSk)], ["matching", opts.matching ?? "on"], ["nostr_context", String(nostrContextN)], ["match_visibility", opts.matchVisibility ?? "pair"], ...(opts.lang ? [["lang", opts.lang]] : []), ...(opts.talks ? [["talks", opts.talks]] : [])], content: "", id: "e2", sig: "" } as any,
    { kind: 31601, pubkey: eidPubkey, created_at: 1, tags: [["d", d]], content: JSON.stringify({ v: 1, invites: invites.map((sk) => ({ h: inviteHash(getPublicKey(sk)) })) }), id: "e3", sig: "" } as any,
  );

  const counters: Counters = { nostrSummary: 0, batchCalls: [], reverseCalls: [], translateCalls: 0 };
  const llm = makeLlm(counters);
  const stt = new MockStt({
    [String(blobSize("crypto"))]: FIXTURES.crypto.transcript,
    [String(blobSize("design"))]: FIXTURES.design.transcript,
    [String(blobSize("code"))]: FIXTURES.code.transcript,
    [String(blobSize("music"))]: FIXTURES.music.transcript,
    default: "generic",
  });

  const clock = { t: 1_700_000_000_000 };
  const coordinator = new Coordinator({
    store, transport, coordSk, llm, stt,
    sttModel: "mock",
    summaryModel: { provider: "mock", model: "mock-cheap" },
    matchModel: { provider: "mock", model: "mock-strong" },
    embedModel: { provider: "mock", model: "mock-embed" },
    translateModel: { provider: "mock", model: "mock-cheap" },
    defaultRelays: ["wss://test"],
    batchSize: opts.batchSize,
    now: () => clock.t,
    // Inject transcription: skip real Blossom/ffmpeg, still exercise the STT mock
    // + the blob-sha256 transcript cache (so idempotency is genuinely tested).
    transcribe: async (descriptor) => {
      if (opts.failTranscribe) throw new Error("could not fetch blob (simulated)");
      const cached = store.getTranscript(descriptor.x);
      if (cached !== undefined) return cached;
      const { text } = await stt.transcribe({ data: new Uint8Array(descriptor.size), mime: "audio/ogg" });
      store.putTranscript(descriptor.x, text, 1);
      return text;
    },
  });

  await coordinator.installEvent({
    coordinate, inboxSkHex: bytesToHex(einboxSk), eck: eckVersions, configRelays: ["wss://test"],
  });

  return { coordinator, transport, store, llm, stt, counters, coordSk, eidSk, einboxSk, coordinate, eck, invites, nextInvite: 0, clock };
}

async function join(h: Harness, attendeeSk: Uint8Array, fixture: FixtureKey): Promise<string> {
  const attendeePubkey = getPublicKey(attendeeSk);
  const f = FIXTURES[fixture];
  const inboxPk = getPublicKey(h.einboxSk);
  const inviteSk = h.invites[h.nextInvite++]!; // a distinct single-use invite per attendee
  const proof = makeInviteProof(inviteSk, h.coordinate, attendeePubkey);

  const joinWrap = wrapRumor(attendeeSk, inboxPk, {
    kind: KIND_JOIN_REQUEST,
    content: { v: 1, name: f.about, message: "", rsvp_public: false },
    tags: [["a", h.coordinate], ["invite", getPublicKey(inviteSk), proof.sig]],
  });
  const subWrap = wrapRumor(attendeeSk, inboxPk, {
    kind: KIND_PROFILE_SUBMISSION,
    content: {
      v: 1,
      profile: { about: f.about, skills: f.skills, looking_for: "", links: [] },
      media: [{
        kind: "intro", url: ["https://blob/x"],
        x: String(ORDER.indexOf(fixture)).repeat(64).slice(0, 64),
        ox: "b".repeat(64),
        size: blobSize(fixture), m: "video/webm",
        "encryption-algorithm": "aes-gcm",
        "decryption-key": bytesToBase64(new Uint8Array(32)),
        "decryption-nonce": bytesToBase64(new Uint8Array(12)),
      }],
    },
    tags: [["a", h.coordinate]],
  });

  await h.coordinator.handleInboxWrap(h.coordinate, joinWrap as any);
  await h.coordinator.handleInboxWrap(h.coordinate, subWrap as any);
  return attendeePubkey;
}

/** Re-record an already-joined attendee's intro: a NEW media blob (new sha256) →
 *  re-transcription → a changed ai_profile (transcript carries "CHANGED-INTRO"). */
async function resubmitIntro(h: Harness, attendeeSk: Uint8Array, fixture: FixtureKey): Promise<void> {
  const f = FIXTURES[fixture];
  const inboxPk = getPublicKey(h.einboxSk);
  const newSize = 900 + ORDER.indexOf(fixture);
  h.stt.setTranscript(String(newSize), `CHANGED-INTRO ${f.transcript}`);
  const subWrap = wrapRumor(attendeeSk, inboxPk, {
    kind: KIND_PROFILE_SUBMISSION,
    content: {
      v: 1,
      profile: { about: f.about, skills: f.skills, looking_for: "", links: [] },
      media: [{
        kind: "intro", url: ["https://blob/x2"],
        x: String(9).repeat(64).slice(0, 63) + String(ORDER.indexOf(fixture)),
        ox: "c".repeat(64),
        size: newSize, m: "video/webm",
        "encryption-algorithm": "aes-gcm",
        "decryption-key": bytesToBase64(new Uint8Array(32)),
        "decryption-nonce": bytesToBase64(new Uint8Array(12)),
      }],
    },
    tags: [["a", h.coordinate]],
  });
  await h.coordinator.handleInboxWrap(h.coordinate, subWrap as any);
}

/** Join + submit an arbitrary intro shape (F1: text-only, audio, or video). */
async function joinCustom(
  h: Harness,
  attendeeSk: Uint8Array,
  about: string,
  skills: string[],
  opts: { media?: any[]; introText?: string } = {},
): Promise<string> {
  const attendeePubkey = getPublicKey(attendeeSk);
  const inboxPk = getPublicKey(h.einboxSk);
  const inviteSk = h.invites[h.nextInvite++]!;
  const proof = makeInviteProof(inviteSk, h.coordinate, attendeePubkey);
  const joinWrap = wrapRumor(attendeeSk, inboxPk, {
    kind: KIND_JOIN_REQUEST,
    content: { v: 1, name: about, message: "", rsvp_public: false },
    tags: [["a", h.coordinate], ["invite", getPublicKey(inviteSk), proof.sig]],
  });
  const subWrap = wrapRumor(attendeeSk, inboxPk, {
    kind: KIND_PROFILE_SUBMISSION,
    content: {
      v: 1,
      profile: { about, skills, looking_for: "", links: [] },
      media: opts.media ?? [],
      ...(opts.introText ? { intro_text: opts.introText } : {}),
    },
    tags: [["a", h.coordinate]],
  });
  await h.coordinator.handleInboxWrap(h.coordinate, joinWrap as any);
  await h.coordinator.handleInboxWrap(h.coordinate, subWrap as any);
  return attendeePubkey;
}

/** A media descriptor for an audio/video blob of a given byte length and hash. */
function mediaDesc(sizeKey: number, x: string, mime: string) {
  return {
    kind: "intro" as const,
    url: ["https://blob/" + x],
    x,
    ox: "b".repeat(64),
    size: sizeKey,
    m: mime,
    "encryption-algorithm": "aes-gcm" as const,
    "decryption-key": bytesToBase64(new Uint8Array(32)),
    "decryption-nonce": bytesToBase64(new Uint8Array(12)),
  };
}

/** The most recent 31603 directory entry for blinded d (with or without ai). */
function latestDirectory(transport: FakeTransport, eck: Uint8Array, d: string) {
  const entries = transport.published
    .filter((e) => e.kind === KIND_DIRECTORY_ENTRY && e.tags.find((t) => t[0] === "d")?.[1] === d)
    .map((e) => directoryEntryContentSchema.parse(JSON.parse(eckDecrypt(eck, e.content))));
  return entries[entries.length - 1];
}

describe("F1 — text/audio intro branch + transcript publish (A1)", () => {
  it("a text intro produces an ai_profile with NO STT call, and echoes intro_text on 31603", async () => {
    const h = await setup();
    const sttBefore = h.stt.calls;
    const pk = await joinCustom(h, generateSecretKey(), "designer", ["figma"], {
      introText: "I design privacy-respecting interfaces and mentor newcomers.",
    });
    await h.coordinator.jobs.drain();
    expect(h.stt.calls).toBe(sttBefore); // text skips STT entirely
    const d = blindedD(h.eck, h.coordinate, pk);
    const entry = latestDirectory(h.transport, h.eck, d);
    expect(entry.intro_text).toContain("privacy-respecting");
    expect(entry.media).toHaveLength(0);
    expect(entry.transcripts ?? []).toHaveLength(0); // no blob → no MediaTranscript
    expect(entry.ai_profile).toBeDefined(); // derived from the text intro
  });

  it("an audio intro runs STT and publishes a transcript tied to the blob (A1)", async () => {
    const h = await setup();
    const x = "a1".repeat(32);
    h.stt.setTranscript("500", "I produce ambient music and record field sounds.");
    const pk = await joinCustom(h, generateSecretKey(), "musician", ["audio"], {
      media: [mediaDesc(500, x, "audio/ogg")],
    });
    await h.coordinator.jobs.drain();
    expect(h.stt.calls).toBeGreaterThan(0);
    const d = blindedD(h.eck, h.coordinate, pk);
    const entry = latestDirectory(h.transport, h.eck, d);
    expect(entry.transcripts).toHaveLength(1);
    const tr = entry.transcripts![0]!;
    expect(tr.x).toBe(x);
    expect(tr.source).toBe("stt");
    expect(tr.text).toContain("ambient music");
    expect(tr.lang).toBe("en"); // falls back to the event language
  });

  it("a video intro publishes a machine transcript on the directory entry (A1)", async () => {
    const h = await setup();
    const pk = await join(h, generateSecretKey(), "crypto");
    await h.coordinator.jobs.drain();
    const d = blindedD(h.eck, h.coordinate, pk);
    const entry = latestDirectory(h.transport, h.eck, d);
    expect(entry.transcripts?.length).toBe(1);
    expect(entry.transcripts![0]!.source).toBe("stt");
    expect(entry.transcripts![0]!.text).toBe(FIXTURES.crypto.transcript);
  });

  it("re-recording drops the stale transcript (new blob x) from the entry", async () => {
    const h = await setup();
    const sk = generateSecretKey();
    const pk = await join(h, sk, "crypto");
    await h.coordinator.jobs.drain();
    const d = blindedD(h.eck, h.coordinate, pk);
    const oldX = latestDirectory(h.transport, h.eck, d).transcripts![0]!.x;

    await resubmitIntro(h, sk, "crypto"); // new media blob → new x
    await h.coordinator.jobs.drain();
    const entry = latestDirectory(h.transport, h.eck, d);
    expect(entry.transcripts).toHaveLength(1);
    expect(entry.transcripts![0]!.x).not.toBe(oldX); // only the current blob's transcript
    expect(entry.transcripts![0]!.x).toBe(entry.media[0]!.x);
  });
});

describe("F3 — ai_profile correction / hide (U9)", () => {
  /** Send a 21608 profile correction from `attendeeSk` to E_inbox. */
  async function sendCorrection(
    h: Harness,
    attendeeSk: Uint8Array,
    content: Record<string, unknown>,
  ): Promise<void> {
    const inboxPk = getPublicKey(h.einboxSk);
    const wrap = wrapRumor(attendeeSk, inboxPk, {
      kind: KIND_PROFILE_CORRECTION,
      content: { v: 1, a: h.coordinate, ...content },
      tags: [["a", h.coordinate]],
    });
    await h.coordinator.handleInboxWrap(h.coordinate, wrap as any);
  }

  it("an override replaces named ai_profile fields and flags ai_profile_edited", async () => {
    const h = await setup();
    const sk = generateSecretKey();
    const pk = await join(h, sk, "crypto");
    await h.coordinator.jobs.drain();
    const d = blindedD(h.eck, h.coordinate, pk);
    expect(latestDirectory(h.transport, h.eck, d).ai_profile).toBeDefined();

    await sendCorrection(h, sk, { overrides: { summary: "I build hardware wallets, not apps." } });
    const entry = latestDirectory(h.transport, h.eck, d);
    expect(entry.ai_profile!.summary).toBe("I build hardware wallets, not apps.");
    expect(entry.ai_profile_edited).toBe(true);
    // Authored identity fields are untouched by a correction.
    expect(entry.profile.about).toBe(FIXTURES.crypto.about);
  });

  it("hidden:true publishes the entry WITHOUT an ai_profile (authored fallback)", async () => {
    const h = await setup();
    const sk = generateSecretKey();
    const pk = await join(h, sk, "crypto");
    await h.coordinator.jobs.drain();
    const d = blindedD(h.eck, h.coordinate, pk);

    await sendCorrection(h, sk, { hidden: true });
    const entry = latestDirectory(h.transport, h.eck, d);
    expect(entry.ai_profile).toBeUndefined();
    expect(entry.ai_profile_edited).toBeUndefined(); // hiding is not advertised
    expect(entry.profile.about).toBe(FIXTURES.crypto.about); // authored profile still there
  });

  it("hidden_fields blanks specific generated fields", async () => {
    const h = await setup();
    const sk = generateSecretKey();
    const pk = await join(h, sk, "crypto");
    await h.coordinator.jobs.drain();
    const d = blindedD(h.eck, h.coordinate, pk);

    await sendCorrection(h, sk, { hidden_fields: ["interests", "seeks"] });
    const ai = latestDirectory(h.transport, h.eck, d).ai_profile!;
    expect(ai.interests).toEqual([]);
    expect(ai.seeks).toEqual([]);
    expect(ai.summary.length).toBeGreaterThan(0); // untouched field survives
  });

  it("a forged correction (wrong seal author) cannot alter another attendee's entry", async () => {
    const h = await setup();
    const victimSk = generateSecretKey();
    const victimPk = await join(h, victimSk, "crypto");
    await h.coordinator.jobs.drain();
    const d = blindedD(h.eck, h.coordinate, victimPk);
    const before = latestDirectory(h.transport, h.eck, d).ai_profile!.summary;

    // An attacker who is NOT an approved attendee sends a correction. It is sealed
    // by the attacker's key (unwrapRumor binds rumor.pubkey to the seal author), so
    // it can only ever apply to the attacker's OWN entry — never the victim's.
    const attackerSk = generateSecretKey();
    await sendCorrection(h, attackerSk, { hidden: true });
    const after = latestDirectory(h.transport, h.eck, d).ai_profile!.summary;
    expect(after).toBe(before); // victim's ai_profile untouched
  });

  it("a correction SURVIVES a reprocess (re-applied on top of a fresh ai_profile)", async () => {
    const h = await setup();
    const sk = generateSecretKey();
    const pk = await join(h, sk, "crypto");
    await h.coordinator.jobs.drain();
    const d = blindedD(h.eck, h.coordinate, pk);

    await sendCorrection(h, sk, { overrides: { summary: "Corrected once, kept forever." } });
    expect(latestDirectory(h.transport, h.eck, d).ai_profile!.summary).toBe("Corrected once, kept forever.");

    // Force a full reprocess: regenerates the ai_profile from inputs (artifact cache),
    // then re-publishes. The stored correction is NOT baked into the cached artifact,
    // so it is re-applied at publish time.
    const adminWrap = wrapRumor(h.eidSk, getPublicKey(h.coordSk), {
      kind: KIND_ADMIN_COMMAND,
      content: { v: 1, a: h.coordinate, cmd: "reprocess", args: { pubkey: pk } },
    });
    await h.coordinator.handleCoordinatorWrap(adminWrap as any);
    await h.coordinator.jobs.drain();

    const entry = latestDirectory(h.transport, h.eck, d);
    expect(entry.ai_profile!.summary).toBe("Corrected once, kept forever.");
    expect(entry.ai_profile_edited).toBe(true);
  });
});

describe("Coordinator pipeline (spec §9, P4 acceptance)", () => {
  it("3 complementary attendees each get a ranked 31605 with complementarity reasoning", async () => {
    const h = await setup();
    const cryptoSk = generateSecretKey();
    const cryptoPk = await join(h, cryptoSk, "crypto");
    await join(h, generateSecretKey(), "design");
    await join(h, generateSecretKey(), "code");
    await h.coordinator.jobs.drain();

    const lists = h.transport.published.filter((e) => e.kind === KIND_MATCH_LIST);
    expect(lists.length).toBeGreaterThanOrEqual(3);

    // The cryptographer decrypts their own list and reads the reasoning.
    const cryptoD = blindedD(h.eck, h.coordinate, cryptoPk);
    const contents = lists
      .filter((e) => e.tags.find((t) => t[0] === "d")?.[1] === cryptoD)
      .map((e) => matchListContentSchema.parse(JSON.parse(nip44Decrypt(cryptoSk, getPublicKey(h.coordSk), e.content))));
    const content = contents.sort((a, b) => b.matches.length - a.matches.length)[0]!;
    expect(content.matches.length).toBe(2); // design + code
    const top = content.matches[0]!;
    expect(top.complementarity).toBeGreaterThan(top.similarity);
    expect(top.reasoning.toLowerCase()).toContain("complementary");
  });

  it("directory entry (31603) folds in ai_profile after processing", async () => {
    const h = await setup();
    const pk = await join(h, generateSecretKey(), "crypto");
    await h.coordinator.jobs.drain();
    const d = blindedD(h.eck, h.coordinate, pk);
    const entry = latestDirectoryWithAi(h.transport, h.eck, d);
    expect(entry?.ai_profile?.summary).toContain("cryptographer");
  });

  it("a 4th joiner costs exactly 3 new pairs (incremental N−1)", async () => {
    const h = await setup();
    await join(h, generateSecretKey(), "crypto");
    await join(h, generateSecretKey(), "design");
    await join(h, generateSecretKey(), "code");
    await h.coordinator.jobs.drain();
    const before = countPairs(h.store, h.coordinate);
    expect(before).toBe(3); // C(3,2)

    await join(h, generateSecretKey(), "music");
    await h.coordinator.jobs.drain();
    const after = countPairs(h.store, h.coordinate);
    expect(after - before).toBe(3); // music vs the 3 existing
  });

  it("batched scoring groups pending pairs into ≤K-candidate calls (K boundary)", async () => {
    const h = await setup(0, { batchSize: 2 });
    await join(h, generateSecretKey(), "crypto");
    await join(h, generateSecretKey(), "design");
    await join(h, generateSecretKey(), "code");
    await join(h, generateSecretKey(), "music");
    await h.coordinator.jobs.drain();

    // Every FORWARD batched call is one target + at most K=2 candidates.
    expect(h.counters.batchCalls.length).toBeGreaterThan(0);
    for (const call of h.counters.batchCalls) {
      expect(call.targetRole).toBeDefined();
      expect(call.candidateRoles.length).toBeGreaterThanOrEqual(1);
      expect(call.candidateRoles.length).toBeLessThanOrEqual(2);
    }
    // Every REVERSE batched call is one shared candidate + at most K=2 targets — the
    // reverse-batch variant keeps the reverse direction batched too (no tiny calls).
    for (const call of h.counters.reverseCalls) {
      expect(call.sharedRole).toBeDefined();
      expect(call.targetRoles.length).toBeGreaterThanOrEqual(1);
      expect(call.targetRoles.length).toBeLessThanOrEqual(2);
    }
    // All 4×3 directions converge; still C(4,2)=6 pair rows; each direction scored
    // exactly once (12 directed slots across forward+reverse calls, no re-billing).
    expect(countPairs(h.store, h.coordinate)).toBe(6);
    const fwd = h.counters.batchCalls.reduce((n, c) => n + c.candidateRoles.length, 0);
    const rev = h.counters.reverseCalls.reduce((n, c) => n + c.targetRoles.length, 0);
    expect(fwd + rev).toBe(12);
  });

  it("partial batch failure: good candidates persist, only the missing one is re-sent", async () => {
    const h = await setup(0, { batchSize: 10 });
    await join(h, generateSecretKey(), "crypto");
    await join(h, generateSecretKey(), "design");
    await join(h, generateSecretKey(), "music");
    // The first batch that lists a musician candidate omits that entry once
    // (model skipped a candidate). Other candidates in that batch must persist.
    h.counters.dropRoleOnce = "musician";
    await h.coordinator.jobs.drain();

    // All 3×2 directions converge: the dropped direction was re-sent ALONE in a
    // follow-up batch (its batch-mate was never re-billed).
    expect(countPairs(h.store, h.coordinate)).toBe(3);
    for (const row of allPairRows(h.store, h.coordinate)) {
      expect(row.reasoning).not.toBe("");
      expect(row.reasoning_b).not.toBeNull();
    }
    // The dropped crypto→music direction is recovered without poisoning its
    // batch-mates: either the batch retry re-sends it, or (as here) music's own
    // recompute scores it via the reverse batch first. Either way every direction
    // lands. Across forward+reverse we see exactly 6 directed slots + 1 redundant
    // (the dropped slot), never more — nothing is double-billed.
    const fwd = h.counters.batchCalls.reduce((n, c) => n + c.candidateRoles.length, 0);
    const rev = h.counters.reverseCalls.reduce((n, c) => n + c.targetRoles.length, 0);
    expect(fwd + rev).toBe(6 + 1);

    // The failed batch job's backoff retry is a no-op: everything already scored.
    const callsBefore = h.counters.batchCalls.length;
    h.clock.t += 60_000;
    await h.coordinator.jobs.drain();
    expect(h.counters.batchCalls.length).toBe(callsBefore);
    expect(h.store.pendingJobCount()).toBe(0);
  });

  it("restart / re-delivery never re-bills STT or LLM (idempotent)", async () => {
    const h = await setup();
    const sk = generateSecretKey();
    await join(h, sk, "crypto");
    await join(h, generateSecretKey(), "design");
    await h.coordinator.jobs.drain();
    const sttCalls = h.stt.calls;
    const llmCalls = h.llm.completeCalls;

    // Re-deliver the identical wraps and drain again (simulating a restart with
    // overlapping subscription window): rumor-id dedupe + job dedupe + caches.
    await join(h, sk, "crypto");
    await h.coordinator.jobs.drain();
    expect(h.stt.calls).toBe(sttCalls);
    expect(h.llm.completeCalls).toBe(llmCalls);
  });

  it("nostr-context influences the profile when N>0, and is skipped when N=0", async () => {
    // N = 0: no summary calls.
    const off = await setup(0);
    await join(off, generateSecretKey(), "crypto");
    await off.coordinator.jobs.drain();
    expect(off.counters.nostrSummary).toBe(0);

    // N = 100 with seeded posts: summary runs and folds into the ai_profile.
    const on = await setup(100);
    const attendeeSk = generateSecretKey();
    const attendeePk = getPublicKey(attendeeSk);
    on.transport.seed.push(
      { kind: 1, pubkey: attendeePk, created_at: 11, tags: [], content: "more zk musings", id: "p2", sig: "" } as any,
    );
    await join(on, attendeeSk, "crypto");
    await on.coordinator.jobs.drain();
    expect(on.counters.nostrSummary).toBeGreaterThan(0);
    const d = blindedD(on.eck, on.coordinate, attendeePk);
    const entry = latestDirectoryWithAi(on.transport, on.eck, d);
    expect(entry?.ai_profile?.interests).toContain("from-nostr");
  });

  it("revoke rotates the ECK forward-only: removed attendee can't read new content, remaining can", async () => {
    const h = await setup();
    const cryptoSk = generateSecretKey();
    const designSk = generateSecretKey();
    const cryptoPk = await join(h, cryptoSk, "crypto");
    const designPk = await join(h, designSk, "design");
    await join(h, generateSecretKey(), "code");
    await h.coordinator.jobs.drain();
    const publishedBefore = h.transport.published.length;

    // Organizer (E_id) sends a 21604 revoke admin command for the cryptographer.
    const adminWrap = wrapRumor(h.eidSk, getPublicKey(h.coordSk), {
      kind: KIND_ADMIN_COMMAND,
      content: { v: 1, a: h.coordinate, cmd: "revoke", args: { pubkey: cryptoPk } },
    });
    await h.coordinator.handleCoordinatorWrap(adminWrap as any);
    await h.coordinator.jobs.drain();

    const after = h.transport.published.slice(publishedBefore);

    // The removed attendee's directory entry was deleted (NIP-09).
    expect(after.some((e) => e.kind === KIND_DELETION)).toBe(true);

    // A remaining attendee (design) received a re-grant carrying the new ECK v2.
    const grantsToDesign = after
      .filter((e) => e.kind === 1059)
      .map((e) => {
        try {
          return unwrapRumor(e as any, designSk);
        } catch {
          return null;
        }
      })
      .filter((r): r is NonNullable<typeof r> => !!r);
    expect(grantsToDesign.length).toBeGreaterThan(0);
    const grant = keyGrantContentSchema.parse(JSON.parse(grantsToDesign[0]!.content));
    expect(grant.eck.length).toBe(2); // v1 + v2
    const eckV2 = base64ToBytes(grant.eck.find((v) => v.id === 2)!.key);

    // The newest roster is under v2: design can decrypt it, and crypto is gone.
    const rosters = after.filter((e) => e.kind === 31604);
    const newestRoster = rosters[rosters.length - 1]!;
    const roster = rosterContentSchema.parse(JSON.parse(eckDecrypt(eckV2, newestRoster.content)));
    expect(roster.attendees.map((a) => a.pubkey)).not.toContain(cryptoPk);
    expect(roster.attendees.map((a) => a.pubkey)).toContain(designPk);

    // Forward-only: the removed attendee holds only v1 → cannot read v2 content.
    expect(() => eckDecrypt(h.eck, newestRoster.content)).toThrow();
  });

  it("re-recording an intro re-processes only the changed attendee's pairs, batched, and republishes fresh match lists", async () => {
    const h = await setup(0, { batchSize: 10 });
    const cryptoSk = generateSecretKey();
    const cryptoPk = await join(h, cryptoSk, "crypto");
    const designPk = await join(h, generateSecretKey(), "design");
    const codePk = await join(h, generateSecretKey(), "code");
    await h.coordinator.jobs.drain();

    // Snapshot: pair rows keyed by (a,b), and the cryptographer's latest match list.
    const rowsBefore = new Map(allPairRows(h.store, h.coordinate).map((r) => [`${r.a}|${r.b}`, r]));
    expect(rowsBefore.size).toBe(3); // C(3,2)
    const cryptoD = blindedD(h.eck, h.coordinate, cryptoPk);
    const listBefore = latestMatchList(h.transport, cryptoSk, getPublicKey(h.coordSk), cryptoD);
    const pairKey = (x: string, y: string) => (x < y ? `${x}|${y}` : `${y}|${x}`);
    const designCodeKey = pairKey(designPk, codePk);
    const designCodeBefore = rowsBefore.get(designCodeKey)!;

    // Re-record ONLY the cryptographer's intro; a fresh ai_profile → new profile_hash.
    const fwdBefore = h.counters.batchCalls.length;
    const revBefore = h.counters.reverseCalls.length;
    await resubmitIntro(h, cryptoSk, "crypto");
    await h.coordinator.jobs.drain();

    // (a) SCOPE: the design↔code pair (which does NOT involve crypto) is untouched —
    //     same inputs_hash, same reasoning, no rescore.
    const rowsAfter = new Map(allPairRows(h.store, h.coordinate).map((r) => [`${r.a}|${r.b}`, r]));
    const designCodeAfter = rowsAfter.get(designCodeKey)!;
    expect(designCodeAfter.inputs_hash).toBe(designCodeBefore.inputs_hash);
    expect(designCodeAfter.reasoning).toBe(designCodeBefore.reasoning);
    expect(designCodeAfter.reasoning_b).toBe(designCodeBefore.reasoning_b);

    // (b) BOTH directions of crypto's pairs are invalidated + rescored: the pair's
    //     inputs_hash changed (new profile_hash) and both reasoning sides re-set.
    for (const other of [designPk, codePk]) {
      const before = rowsBefore.get(pairKey(cryptoPk, other))!;
      const after = rowsAfter.get(pairKey(cryptoPk, other))!;
      expect(after.inputs_hash).not.toBe(before.inputs_hash);
      expect(after.reasoning).not.toBe("");
      expect(after.reasoning_b).not.toBeNull();
      expect(after.reasoning_b).not.toBe("");
    }

    // (c) BATCHED, not a shower of tiny calls: the changed→others forward direction
    //     is one batch; the reverse (others→changed) is one shared-candidate batch.
    const fwdNew = h.counters.batchCalls.slice(fwdBefore);
    const revNew = h.counters.reverseCalls.slice(revBefore);
    // The forward recompute for crypto scores {design,code} in a single batch.
    expect(fwdNew.some((c) => c.targetRole === "cryptographer" && c.candidateRoles.length === 2)).toBe(true);
    // The reverse direction {design,code}→crypto is one shared-candidate batch (2 targets),
    // NOT two single-target calls.
    const cryptoReverse = revNew.filter((c) => c.sharedRole === "cryptographer");
    expect(cryptoReverse.length).toBe(1);
    expect(cryptoReverse[0]!.targetRoles.length).toBe(2);

    // (d) The cryptographer's republished 31605 differs from before (fresh content).
    const listAfter = latestMatchList(h.transport, cryptoSk, getPublicKey(h.coordSk), cryptoD);
    expect(listAfter).not.toBeUndefined();
    expect(JSON.stringify(listAfter!.matches)).not.toBe(JSON.stringify(listBefore!.matches));
  });

  it("rejects a 21603 install grant whose seal author is not E_id, accepts the genuine one (F2)", async () => {
    const h = await setup();
    // A second event the coordinator has never seen.
    const eid2Sk = generateSecretKey();
    const coordinate2 = makeCoordinate(getPublicKey(eid2Sk), "second-event");
    const grantContent = {
      v: 1,
      a: coordinate2,
      inbox_nsec: bytesToHex(generateSecretKey()),
      eck: [{ id: 1, key: bytesToBase64(generateEck()) }],
      config_relays: ["wss://test"],
    };

    // Forged install: a well-formed grant sealed by an arbitrary key. The seal
    // author (rumor.pubkey) is not the coordinate's E_id → must be dropped.
    const attackerSk = generateSecretKey();
    const forged = wrapRumor(attackerSk, getPublicKey(h.coordSk), {
      kind: KIND_COORDINATOR_GRANT,
      content: grantContent,
    });
    await h.coordinator.handleCoordinatorWrap(forged as any);
    expect(h.store.getEvent(coordinate2)).toBeUndefined();

    // Genuine install: same payload sealed by E_id → installed.
    const genuine = wrapRumor(eid2Sk, getPublicKey(h.coordSk), {
      kind: KIND_COORDINATOR_GRANT,
      content: grantContent,
    });
    await h.coordinator.handleCoordinatorWrap(genuine as any);
    const row = h.store.getEvent(coordinate2);
    expect(row).toBeDefined();
    expect(row!.inbox_nsec).toBe(grantContent.inbox_nsec);
  });

  it("stores event keys encrypted at rest, transparently decrypted on read (F1)", async () => {
    const h = await setup();
    // The public read path returns plaintext…
    const row = h.store.getEvent(h.coordinate);
    expect(row?.inbox_nsec).toBe(bytesToHex(h.einboxSk));
    expect(JSON.parse(row!.eck_json)[0].key).toBe(bytesToBase64(h.eck));
    // …but the raw SQLite columns hold NIP-44 ciphertext, not the secrets.
    const raw = (h.store as any).db
      .prepare("SELECT inbox_nsec, eck_json FROM events WHERE coordinate = ?")
      .get(h.coordinate);
    expect(raw.inbox_nsec.startsWith("nip44:")).toBe(true);
    expect(raw.eck_json.startsWith("nip44:")).toBe(true);
    expect(raw.inbox_nsec).not.toContain(bytesToHex(h.einboxSk));
    expect(raw.eck_json).not.toContain(bytesToBase64(h.eck));
  });

  it("a Slovak event scores match reasoning in Slovak and translates non-Slovak user fields", async () => {
    const h = await setup(0, { lang: "sk" });
    const cryptoPk = await join(h, generateSecretKey(), "crypto");
    await join(h, generateSecretKey(), "design");
    await h.coordinator.jobs.drain();

    // The match-scoring prompt carried the Slovak output-language instruction.
    const scoringReq = h.llm.lastBySchema("batch_score");
    expect(scoringReq?.system).toContain("Slovak (sk)");
    // The directory entry carries a translation of the (English) user fields, and
    // the ORIGINAL profile fields are untouched.
    const d = blindedD(h.eck, h.coordinate, cryptoPk);
    const entry = latestDirectoryWithAi(h.transport, h.eck, d);
    expect(entry?.profile.about).toBe("cryptographer"); // original preserved
    expect(entry?.ai_profile?.translations?.lang).toBe("sk");
    expect(entry?.ai_profile?.translations?.about).toBe("[sk] cryptographer");
    expect(entry?.ai_profile?.translations?.skills).toContain("[sk] zk");
  });

  // ── H4: matching=off is honored; 31606 matrix published for visibility=event ─
  it("matching=off runs no AI pipeline and publishes no match lists/matrix (H4)", async () => {
    const h = await setup(100, { matching: "off" });
    const pk = await join(h, generateSecretKey(), "crypto");
    await join(h, generateSecretKey(), "design");
    await h.coordinator.jobs.drain();

    // No provider was ever called; no match jobs remained.
    expect(h.stt.calls).toBe(0);
    expect(h.llm.completeCalls).toBe(0);
    expect(h.llm.embedCalls).toBe(0);
    expect(h.store.pendingJobCount()).toBe(0);
    // No 31605 match lists, no 31606 matrix.
    expect(h.transport.published.some((e) => e.kind === KIND_MATCH_LIST)).toBe(false);
    expect(h.transport.published.some((e) => e.kind === KIND_MATCH_MATRIX)).toBe(false);
    // …but the authored directory entry (no ai_profile) and roster still publish.
    const d = blindedD(h.eck, h.coordinate, pk);
    const dir = h.transport.published.filter(
      (e) => e.kind === KIND_DIRECTORY_ENTRY && e.tags.find((t) => t[0] === "d")?.[1] === d,
    );
    expect(dir.length).toBeGreaterThan(0);
    const entry = directoryEntryContentSchema.parse(JSON.parse(eckDecrypt(h.eck, dir[dir.length - 1]!.content)));
    expect(entry.profile.about).toBe("cryptographer"); // fixture's `about`
    expect(entry.ai_profile).toBeUndefined();
  });

  it("publishes the 31606 matrix (scores only) when match_visibility=event (H4)", async () => {
    const h = await setup(0, { matchVisibility: "event" });
    const cryptoPk = await join(h, generateSecretKey(), "crypto");
    const designPk = await join(h, generateSecretKey(), "design");
    await h.coordinator.jobs.drain();

    const matrices = h.transport.published.filter((e) => e.kind === KIND_MATCH_MATRIX);
    expect(matrices.length).toBeGreaterThan(0);
    const matrix = matchMatrixContentSchema.parse(JSON.parse(eckDecrypt(h.eck, matrices[matrices.length - 1]!.content)));
    // One pair (crypto↔design), scores only, both members present.
    expect(matrix.pairs.length).toBe(1);
    const pair = matrix.pairs[0]!;
    expect([pair.a, pair.b].sort()).toEqual([cryptoPk, designPk].sort());
    expect(typeof pair.score).toBe("number");
  });

  // ── H3: rotation republishes match lists + matrix under the new ECK ──────────
  it("revocation republishes remaining attendees' match lists + matrix under the new d, excluding the revoked (H3)", async () => {
    const h = await setup(0, { matchVisibility: "event" });
    const cryptoSk = generateSecretKey();
    const designSk = generateSecretKey();
    const cryptoPk = await join(h, cryptoSk, "crypto");
    const designPk = await join(h, designSk, "design");
    await join(h, generateSecretKey(), "code");
    await h.coordinator.jobs.drain();
    const llmBefore = h.llm.completeCalls;
    const publishedBefore = h.transport.published.length;

    // Revoke the cryptographer.
    const adminWrap = wrapRumor(h.eidSk, getPublicKey(h.coordSk), {
      kind: KIND_ADMIN_COMMAND,
      content: { v: 1, a: h.coordinate, cmd: "revoke", args: { pubkey: cryptoPk } },
    });
    await h.coordinator.handleCoordinatorWrap(adminWrap as any);
    await h.coordinator.jobs.drain();

    const after = h.transport.published.slice(publishedBefore);
    // Rotation re-encrypts cached scores — NO provider calls.
    expect(h.llm.completeCalls).toBe(llmBefore);

    // Recover the new ECK v2 from design's re-grant.
    const grant = after
      .filter((e) => e.kind === 1059)
      .map((e) => { try { return unwrapRumor(e as any, designSk); } catch { return null; } })
      .filter((r): r is NonNullable<typeof r> => !!r)
      .map((r) => keyGrantContentSchema.parse(JSON.parse(r.content)))
      .find((g) => g.eck.some((v) => v.id === 2))!;
    const eckV2 = base64ToBytes(grant.eck.find((v) => v.id === 2)!.key);

    // design's match list is republished under the NEW blinded d (over eck v2) and
    // no longer references the revoked cryptographer.
    const designV2D = blindedD(eckV2, h.coordinate, designPk);
    const designList = after
      .filter((e) => e.kind === KIND_MATCH_LIST && e.tags.find((t) => t[0] === "d")?.[1] === designV2D)
      .map((e) => matchListContentSchema.parse(JSON.parse(nip44Decrypt(designSk, getPublicKey(h.coordSk), e.content))));
    expect(designList.length).toBeGreaterThan(0);
    const newest = designList[designList.length - 1]!;
    expect(newest.matches.map((m) => m.pubkey)).not.toContain(cryptoPk);

    // The 31606 matrix is republished under eck v2 excluding any crypto pair.
    const matrices = after.filter((e) => e.kind === KIND_MATCH_MATRIX);
    expect(matrices.length).toBeGreaterThan(0);
    const matrix = matchMatrixContentSchema.parse(JSON.parse(eckDecrypt(eckV2, matrices[matrices.length - 1]!.content)));
    for (const p of matrix.pairs) {
      expect(p.a).not.toBe(cryptoPk);
      expect(p.b).not.toBe(cryptoPk);
    }
  });

  // ── H5: live 31600 config subscription drives a config refresh ───────────────
  it("applies a live 31600 update: visibility pair→event publishes the matrix (H5)", async () => {
    const h = await setup(0, { matchVisibility: "pair" });
    await join(h, generateSecretKey(), "crypto");
    await join(h, generateSecretKey(), "design");
    await h.coordinator.jobs.drain();
    expect(h.transport.published.some((e) => e.kind === KIND_MATCH_MATRIX)).toBe(false);

    // A newer signed 31600 flips visibility to "event".
    const eidPubkey = getPublicKey(h.eidSk);
    const newer = {
      kind: 31600, pubkey: eidPubkey, created_at: 100,
      tags: [["d", "cypherpunk"], ["inbox", getPublicKey(h.einboxSk)], ["matching", "on"], ["match_visibility", "event"]],
      content: "", id: "cfg-2", sig: "",
    } as any;
    await h.coordinator.handleConfigUpdate(h.coordinate, newer);
    await h.coordinator.jobs.drain();
    expect(h.transport.published.some((e) => e.kind === KIND_MATCH_MATRIX)).toBe(true);
  });

  it("ignores a stale or wrong-author 31600 update (H5)", async () => {
    const h = await setup(0, { matchVisibility: "pair" });
    await join(h, generateSecretKey(), "crypto");
    await join(h, generateSecretKey(), "design");
    await h.coordinator.jobs.drain();

    // Wrong author (not E_id) → ignored.
    const attacker = generateSecretKey();
    await h.coordinator.handleConfigUpdate(h.coordinate, {
      kind: 31600, pubkey: getPublicKey(attacker), created_at: 100,
      tags: [["d", "cypherpunk"], ["inbox", getPublicKey(h.einboxSk)], ["matching", "on"], ["match_visibility", "event"]],
      content: "", id: "forged", sig: "",
    } as any);
    // Older-than-applied (created_at < install's 1) → ignored.
    await h.coordinator.handleConfigUpdate(h.coordinate, {
      kind: 31600, pubkey: getPublicKey(h.eidSk), created_at: 0,
      tags: [["d", "cypherpunk"], ["inbox", getPublicKey(h.einboxSk)], ["matching", "on"], ["match_visibility", "event"]],
      content: "", id: "stale", sig: "",
    } as any);
    await h.coordinator.jobs.drain();
    expect(h.transport.published.some((e) => e.kind === KIND_MATCH_MATRIX)).toBe(false);
  });

  // ── H7: a reprocess reuses content-addressed artifacts (no re-bill) ──────────
  it("reprocessing an unchanged submission re-bills no profile/translation model call (H7)", async () => {
    const h = await setup(0, { lang: "sk" }); // sk forces a translation call the first time
    const cryptoPk = await join(h, generateSecretKey(), "crypto");
    await join(h, generateSecretKey(), "design");
    await h.coordinator.jobs.drain();
    // The ai_profile + translation artifacts were persisted (content-addressed).
    expect(artifactCount(h.store, "ai_profile")).toBeGreaterThan(0);
    expect(artifactCount(h.store, "translation")).toBeGreaterThan(0);
    const llmBefore = h.llm.completeCalls;
    const sttBefore = h.stt.calls;

    // Manual reprocess (fresh dedupe key → the job DOES run) must hit the caches.
    const adminWrap = wrapRumor(h.eidSk, getPublicKey(h.coordSk), {
      kind: KIND_ADMIN_COMMAND,
      content: { v: 1, a: h.coordinate, cmd: "reprocess", args: { pubkey: cryptoPk } },
    });
    await h.coordinator.handleCoordinatorWrap(adminWrap as any);
    await h.coordinator.jobs.drain();
    expect(h.llm.completeCalls).toBe(llmBefore); // no profile/translation re-bill
    expect(h.stt.calls).toBe(sttBefore); // transcript cache too
  });

  // ── Q10: a changed submission never publishes a stale ai_profile ─────────────
  it("a resubmission omits the stale ai_profile until reprocessing catches up (Q10)", async () => {
    const h = await setup(0, { batchSize: 10 });
    const cryptoSk = generateSecretKey();
    const cryptoPk = await join(h, cryptoSk, "crypto");
    await join(h, generateSecretKey(), "design");
    await h.coordinator.jobs.drain();
    const d = blindedD(h.eck, h.coordinate, cryptoPk);
    expect(latestDirectoryWithAi(h.transport, h.eck, d)?.ai_profile).toBeDefined();

    // Re-record the intro but DON'T drain yet: the entry published synchronously by
    // handleSubmission must carry the new authored fields with NO stale ai_profile.
    const beforeResubmit = h.transport.published.length;
    await resubmitIntro(h, cryptoSk, "crypto");
    const justPublished = h.transport.published
      .slice(beforeResubmit)
      .filter((e) => e.kind === KIND_DIRECTORY_ENTRY && e.tags.find((t) => t[0] === "d")?.[1] === d)
      .map((e) => directoryEntryContentSchema.parse(JSON.parse(eckDecrypt(h.eck, e.content))));
    expect(justPublished.length).toBeGreaterThan(0);
    expect(justPublished[justPublished.length - 1]!.ai_profile).toBeUndefined();

    // After reprocessing, the fresh ai_profile reappears (derived from the new source).
    await h.coordinator.jobs.drain();
    expect(latestDirectoryWithAi(h.transport, h.eck, d)?.ai_profile?.summary).toContain("updated");
  });

  // ── Q12: a poisoned job is surfaced to the organizer via a 21606 gift wrap ───
  it("surfaces a poisoned job to the organizer (21606 + status row) (Q12)", async () => {
    const h = await setup(0, { failTranscribe: true });
    const pk = await join(h, generateSecretKey(), "crypto");
    // Exhaust the retry/backoff schedule so the process job poisons.
    for (let i = 0; i < 8; i++) {
      await h.coordinator.jobs.drain();
      h.clock.t += 120_000;
    }
    // A 21606 coordinator-status gift wrap was published to E_id and decodes.
    const statuses = h.transport.published
      .filter((e) => e.kind === 1059)
      .map((e) => { try { return unwrapRumor(e as any, h.eidSk); } catch { return null; } })
      .filter((r): r is NonNullable<typeof r> => !!r && r.kind === KIND_COORDINATOR_STATUS)
      .map((r) => coordinatorStatusContentSchema.parse(JSON.parse(r.content)));
    expect(statuses.length).toBeGreaterThan(0);
    const s = statuses[statuses.length - 1]!;
    expect(s.state).toBe("poison");
    expect(s.stage).toBe("process_attendee");
    expect(s.pubkey).toBe(pk);
    expect(s.error_category).not.toContain("crypto"); // sanitized, no attendee text
    // A queryable status row is recorded for the Admin UI (app-side follow-up).
    expect(h.store.poisonStatuses(h.coordinate).length).toBeGreaterThan(0);
  });
});

function countPairs(store: Store, coordinate: string): number {
  return (store as any).db.prepare("SELECT COUNT(*) AS c FROM pairs WHERE coordinate = ?").get(coordinate).c;
}

function artifactCount(store: Store, stage: string): number {
  return (store as any).db.prepare("SELECT COUNT(*) AS c FROM pipeline_artifacts WHERE stage = ?").get(stage).c;
}

function allPairRows(store: Store, coordinate: string): any[] {
  return (store as any).db.prepare("SELECT * FROM pairs WHERE coordinate = ?").all(coordinate);
}

/** The newest 31605 match list for blinded d, decrypted by the reader. */
function latestMatchList(transport: FakeTransport, readerSk: Uint8Array, coordPk: string, d: string) {
  const lists = transport.published
    .filter((e) => e.kind === KIND_MATCH_LIST && e.tags.find((t) => t[0] === "d")?.[1] === d)
    .map((e) => matchListContentSchema.parse(JSON.parse(nip44Decrypt(readerSk, coordPk, e.content))));
  return lists[lists.length - 1];
}

/** The published directory entry for blinded d that carries an ai_profile (if any). */
function latestDirectoryWithAi(transport: FakeTransport, eck: Uint8Array, d: string) {
  const candidates = transport.published
    .filter((e) => e.kind === KIND_DIRECTORY_ENTRY && e.tags.find((t) => t[0] === "d")?.[1] === d)
    .map((e) => directoryEntryContentSchema.parse(JSON.parse(eckDecrypt(eck, e.content))));
  return candidates.reverse().find((c) => c.ai_profile) ?? candidates[0];
}

// ── F2: prerecorded talks journey (audit U11) ─────────────────────────────────
/** A kind:"talk" media descriptor with a given size/hash. */
function talkMedia(size: number, x: string) {
  return {
    kind: "talk" as const,
    url: ["https://blob/" + x],
    x,
    ox: "b".repeat(64),
    size,
    m: "video/webm",
    "encryption-algorithm": "aes-gcm" as const,
    "decryption-key": bytesToBase64(new Uint8Array(32)),
    "decryption-nonce": bytesToBase64(new Uint8Array(12)),
  };
}

/** Submit (or edit) a talk via a 21609 rumor to E_inbox. */
async function submitTalk(
  h: Harness,
  speakerSk: Uint8Array,
  args: { talkD: string; title: string; description?: string; media: any; revision?: number },
): Promise<void> {
  const inboxPk = getPublicKey(h.einboxSk);
  const wrap = wrapRumor(speakerSk, inboxPk, {
    kind: KIND_TALK_SUBMISSION,
    content: {
      v: 1,
      a: h.coordinate,
      talk_d: args.talkD,
      title: args.title,
      description: args.description ?? "",
      speakers: [],
      media: args.media,
      revision: args.revision ?? 0,
    },
    tags: [["a", h.coordinate]],
  });
  await h.coordinator.handleInboxWrap(h.coordinate, wrap as any);
}

/** Send an organizer admin command (sealed by E_id). The `_n` nonce keeps two
 *  otherwise-identical commands from colliding on rumor id under the fixed test
 *  clock (production `created_at` varies); handleAdmin ignores unknown args. */
let adminNonce = 0;
async function admin(h: Harness, cmd: string, args: Record<string, unknown>): Promise<void> {
  const wrap = wrapRumor(h.eidSk, getPublicKey(h.coordSk), {
    kind: KIND_ADMIN_COMMAND,
    content: { v: 1, a: h.coordinate, cmd, args: { ...args, _n: adminNonce++ } },
  });
  await h.coordinator.handleCoordinatorWrap(wrap as any);
}

/** Every published 31610 talk entry (decrypted). */
function publishedTalks(h: Harness) {
  return h.transport.published
    .filter((e) => e.kind === KIND_TALK)
    .map((e) => talkContentSchema.parse(JSON.parse(eckDecrypt(h.eck, e.content))));
}

describe("F2 — prerecorded talks journey (U11)", () => {
  it("talks=off: a talk submission is ignored and never publishes", async () => {
    const h = await setup(0, { talks: "off" });
    const speakerSk = generateSecretKey();
    const pk = await join(h, speakerSk, "crypto");
    await h.coordinator.jobs.drain();
    await submitTalk(h, speakerSk, { talkD: "t1", title: "Zero-knowledge proofs", media: talkMedia(700, "aa".repeat(32)) });
    await h.coordinator.jobs.drain();
    expect(h.store.getTalk(h.coordinate, pk, "t1")).toBeUndefined();
    // Even an (erroneous) publish command produces no 31610 when talks are off.
    await admin(h, "talk_publish", { pubkey: pk, talk_d: "t1" });
    expect(publishedTalks(h)).toHaveLength(0);
  });

  it("talks=on: a submitted talk is pending until the organizer publishes it", async () => {
    const h = await setup(0, { talks: "on" });
    const speakerSk = generateSecretKey();
    const pk = await join(h, speakerSk, "crypto");
    await h.coordinator.jobs.drain();
    const x = "bb".repeat(32);
    h.stt.setTranscript("700", "In this talk I explain zk-SNARKs from first principles.");
    await submitTalk(h, speakerSk, { talkD: "t1", title: "Zero-knowledge proofs", description: "A gentle intro", media: talkMedia(700, x) });
    await h.coordinator.jobs.drain();
    // Stored, transcribed, but NOT published (pending moderation).
    const row = h.store.getTalk(h.coordinate, pk, "t1")!;
    expect(row.status).toBe("pending");
    expect(row.transcript_json).toBeTruthy();
    expect(publishedTalks(h)).toHaveLength(0);
    // Organizer publishes → a 31610 appears, carrying title + transcript.
    await admin(h, "talk_publish", { pubkey: pk, talk_d: "t1" });
    const talks = publishedTalks(h);
    expect(talks).toHaveLength(1);
    expect(talks[0]!.title).toBe("Zero-knowledge proofs");
    expect(talks[0]!.status).toBe("published");
    expect(talks[0]!.media.kind).toBe("talk");
    expect(talks[0]!.transcript?.text).toContain("zk-SNARKs");
    expect(h.store.getTalk(h.coordinate, pk, "t1")!.status).toBe("published");
  });

  it("only an approved attendee may submit a talk", async () => {
    const h = await setup(0, { talks: "on" });
    const strangerSk = generateSecretKey();
    // Never joined → not approved.
    await submitTalk(h, strangerSk, { talkD: "t1", title: "Spam", media: talkMedia(700, "cc".repeat(32)) });
    await h.coordinator.jobs.drain();
    expect(h.store.getTalk(h.coordinate, getPublicKey(strangerSk), "t1")).toBeUndefined();
  });

  it("talk_reject deletes a published talk and marks it rejected", async () => {
    const h = await setup(0, { talks: "on" });
    const speakerSk = generateSecretKey();
    const pk = await join(h, speakerSk, "crypto");
    await h.coordinator.jobs.drain();
    await submitTalk(h, speakerSk, { talkD: "t1", title: "Talk", media: talkMedia(700, "dd".repeat(32)) });
    await h.coordinator.jobs.drain();
    await admin(h, "talk_publish", { pubkey: pk, talk_d: "t1" });
    expect(publishedTalks(h)).toHaveLength(1);
    await admin(h, "talk_reject", { pubkey: pk, talk_d: "t1" });
    expect(h.store.getTalk(h.coordinate, pk, "t1")!.status).toBe("rejected");
    // A NIP-09 deletion for the talk kind was published.
    expect(h.transport.published.some((e) => e.kind === KIND_DELETION && e.tags.some((t) => t[0] === "k" && t[1] === String(KIND_TALK)))).toBe(true);
  });

  it("editing a talk bumps the revision and re-publishes in place", async () => {
    const h = await setup(0, { talks: "on" });
    const speakerSk = generateSecretKey();
    const pk = await join(h, speakerSk, "crypto");
    await h.coordinator.jobs.drain();
    await submitTalk(h, speakerSk, { talkD: "t1", title: "First cut", media: talkMedia(700, "ee".repeat(32)), revision: 0 });
    await h.coordinator.jobs.drain();
    await admin(h, "talk_publish", { pubkey: pk, talk_d: "t1" });
    // Edit: same talk_d, new media, bumped revision → back to pending.
    await submitTalk(h, speakerSk, { talkD: "t1", title: "Revised cut", media: talkMedia(710, "ff".repeat(32)), revision: 1 });
    await h.coordinator.jobs.drain();
    expect(h.store.getTalk(h.coordinate, pk, "t1")!.status).toBe("pending");
    await admin(h, "talk_publish", { pubkey: pk, talk_d: "t1" });
    const talks = publishedTalks(h);
    const last = talks[talks.length - 1]!;
    expect(last.title).toBe("Revised cut");
    expect(last.revision).toBe(1);
    expect(last.talk_d).toBe("t1"); // same address — replaced in place
  });

  it("a talk transcript feeds the speaker's ai_profile (§9.2)", async () => {
    const h = await setup(0, { talks: "on", matching: "on" });
    const speakerSk = generateSecretKey();
    const pk = await join(h, speakerSk, "crypto");
    await h.coordinator.jobs.drain();
    const x = "1a".repeat(32);
    h.stt.setTranscript("650", "My talk covers homomorphic encryption and secure MPC.");
    await submitTalk(h, speakerSk, { talkD: "t1", title: "MPC talk", media: talkMedia(650, x) });
    await h.coordinator.jobs.drain();
    // The reprocess folds the talk transcript in — the ai_profile is regenerated.
    const attendee = h.store.getAttendee(h.coordinate, pk)!;
    expect(attendee.ai_profile_json).toBeTruthy();
  });
});
