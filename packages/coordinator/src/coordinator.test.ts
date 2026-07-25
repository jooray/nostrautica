import { describe, it, expect, vi } from "vitest";
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
  KIND_KEY_GRANT,
  KIND_MATCH_LIST,
  KIND_MATCH_MATRIX,
  KIND_DIRECTORY_ENTRY,
  KIND_ROSTER,
  KIND_ADMIN_COMMAND,
  KIND_COORDINATOR_GRANT,
  KIND_COORDINATOR_STATUS,
  KIND_PROFILE_CORRECTION,
  KIND_TALK,
  KIND_TALK_SUBMISSION,
  KIND_ATTENDEE_WITHDRAWAL,
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
import type { RoleRoutes } from "./providers/types.js";
import type { ChatMls } from "./chat/mls.js";
import type { PrefilterConfig } from "./matching/prefilter.js";
import { talkBlindedD } from "./nostr/publisher.js";

class FakeTransport implements Transport {
  published: NostrEvent[] = [];
  seed: NostrEvent[] = [];
  /** Recorded subscriptions (COORD-8/COORD-29 tests): filter, relays, handler, closed. */
  subs: { filter: any; relays?: string[]; onEvent: (e: NostrEvent) => void; closed: boolean }[] = [];
  /** Recorded fetch filters (COORD-29 tests). */
  fetches: any[] = [];
  /** Throw on the next N publishes (COORD-2 failure injection). */
  failPublishes = 0;
  /** When true, a fetch touching kind 31600 returns [] — simulates an unfetchable
   *  config for the NIP §3.5 startup-revalidation suspension path. */
  blockConfig = false;
  /** Replaceable addresses (`${kind}:${d}`) for which the next publish reports
   *  "replaced/have newer" — drives the reliability-tail reconciliation path. */
  replacedAddresses = new Set<string>();
  /** Test hook (audit R1 concurrency gate): awaited at the START of a publish so a
   *  test can hold a command's effect chain in-flight (holding its subject mutex)
   *  while a concurrent command is dispatched. */
  onPublish?: (event: NostrEvent) => Promise<void> | void;
  async publish(event: NostrEvent): Promise<void | { replaced?: boolean }> {
    if (this.onPublish) await this.onPublish(event);
    if (this.failPublishes > 0) {
      this.failPublishes--;
      throw new Error("simulated relay outage");
    }
    const d = event.tags.find((t) => t[0] === "d")?.[1];
    const addr = d !== undefined ? `${event.kind}:${d}` : undefined;
    if (addr && this.replacedAddresses.has(addr)) {
      // The relay REJECTED our event as superseded — don't store it. One-shot, so a
      // reconciliation republish (address cleared) is then accepted normally.
      this.replacedAddresses.delete(addr);
      return { replaced: true };
    }
    this.published.push(event);
    return undefined;
  }
  /** Test hook (Bug 1 config-propagation race): invoked at the START of every fetch,
   *  so a test can mutate `seed` to model a 31600 that only names the coordinator
   *  after propagation (i.e. the value differs between the 1st and a later fetch). */
  beforeFetch?: (filter: any) => void;
  async fetch(filter: any): Promise<NostrEvent[]> {
    this.fetches.push(filter);
    this.beforeFetch?.(filter);
    if (this.blockConfig && filter.kinds?.includes(31600)) return [];
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
  subscribe(filter: any, onEvent: (e: NostrEvent) => void, relays?: string[]): () => void {
    const sub = { filter, relays, onEvent, closed: false };
    this.subs.push(sub);
    return () => {
      sub.closed = true;
    };
  }
  /** C9 make-before-break: relay sets (sorted, space-joined) the probe reports as
   *  UNREACHABLE. Any other set is reachable. Also records every probed set. */
  unreachableRelays = new Set<string>();
  probed: string[][] = [];
  /** Test hook (audit R10 CAS gate): awaited at the START of a probe so a test can
   *  hold an OLDER config's handover mid-probe while a NEWER config supersedes it. */
  onProbe?: (relays: string[]) => Promise<void> | void;
  async probe(relays: string[]): Promise<boolean> {
    this.probed.push(relays);
    if (this.onProbe) await this.onProbe(relays);
    return !this.unreachableRelays.has([...relays].sort().join(" "));
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
  /** When set, every batch-scoring call throws — drives the batch FAILED log line. */
  failBatchScore?: boolean;
}

const ROLES = ["cryptographer", "designer", "programmer", "musician"] as const;
const roleOf = (text: string) => ROLES.find((r) => text.includes(r));

// Per-attendee monotonic 21601 rev (NIP §3.3): the app bumps a per-(coordinate)
// counter on every edit, so a re-submission MUST carry a strictly higher rev or the
// coordinator rejects it as stale. Tracked per attendee pubkey for the test helpers.
const revByAttendee = new Map<string, number>();
const correctionRevByAttendee = new Map<string, number>();
function nextSubmissionRev(pubkey: string): number {
  const rev = (revByAttendee.get(pubkey) ?? -1) + 1;
  revByAttendee.set(pubkey, rev);
  return rev;
}

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
    // Icebreakers (NIP §6.2): the model returns MORE than the ≤3 cap and an empty
    // entry, so the parse's cap + non-empty filter is exercised end-to-end.
    icebreakers: complementary
      ? [`Ask them about ${bRole} work`, "", "What brings you here?", `Compare notes on ${aRole}`, "extra-over-cap"]
      : [],
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
    if (req.schemaName === "batch_score" || req.schemaName === "reverse_batch_score") {
      if (counters.failBatchScore) throw new Error("venice is on fire");
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
  /** Per-role split providers (H-1, splitProviders opt): summary+translate / match+embed. */
  llmA?: MockLlm;
  llmB?: MockLlm;
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
    /** Seed max_video_sec/max_talk_sec tags (COORD-4). */
    maxVideoSec?: number;
    maxTalkSec?: number;
    /** Enable Marmot chat on the seeded 31600 (needs chatMls too). */
    chat?: boolean;
    chatMls?: ChatMls;
    /** Install guards (COORD-3). */
    maxEvents?: number;
    allowedEidPubkeys?: string[];
    /** A different coordinator tag for the seeded 31600 (COORD-3). */
    foreignCoordinator?: string;
    /** Extra seed events, built with the harness keys (COORD-14: a second 31600). */
    extraSeed?: (keys: { eidPubkey: string; d: string; coordPubkey: string; inboxPubkey: string }) => NostrEvent[];
    /** Prefilter override (COORD-13). */
    prefilter?: PrefilterConfig;
    /** Per-role provider routing (H-1): route summary+translate to one instance
     *  ("provA") and match+embed to another ("provB"), exposed as h.llmA/h.llmB. */
    splitProviders?: boolean;
    /** Retention policy (NIP §6.2): seed a `retention` tag on the 31600 and an
     *  `end` tag on the 31923 so the retention sweep has a deadline to test. */
    retentionDays?: number;
    eventEndSec?: number;
    /** Billing policy (§9, D5): the wire verdict evaluator + optional grace window. */
    evaluateBilling?: (eid: string, count: number) => import("@nostrautica/protocol").CoordinatorBilling;
    billingGracePeriodSec?: number;
    /** Usage budgets (§8, H-2). The object is passed by reference, so a test can
     *  mutate a limit to simulate a config raise. */
    budgets?: {
      perAttendeeBytes: number;
      perEventBytes: number;
      perAttendeeDurationSec: number;
      perEventDurationSec: number;
      perAttendeeCalls: number;
      perEventCalls: number;
    };
    /** C2 race hook: awaited by the injected transcribe BEFORE it returns, so a test
     *  can pause a specific revision's STT/LLM mid-flight and interleave a newer one. */
    beforeTranscribe?: (descriptor: any, signal?: AbortSignal) => Promise<void>;
    /** C1 attach test: skip the auto-install so the test can drive installEvent via a
     *  grant wrap (and inject a mid-install failure). */
    skipAutoInstall?: boolean;
    transcribeError?: string;
  } = {},
): Promise<Harness> {
  adminNonce = 0; // per-test admin created_at offset (NIP §3.4 watermark ordering)
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
  const coordPubkey = getPublicKey(coordSk);
  const store = new Store(":memory:", coordSk);
  const transport = new FakeTransport();
  transport.seed.push(
    { kind: 31923, pubkey: eidPubkey, created_at: 1, tags: [["d", d], ["title", "Cypherpunk Assembly"], ["t", "cypherpunk"], ...(opts.eventEndSec !== undefined ? [["end", String(opts.eventEndSec)]] : [])], content: "", id: "e1", sig: "" } as any,
    { kind: 31600, pubkey: eidPubkey, created_at: 1, tags: [["d", d], ["v", "2"], ["inbox", getPublicKey(einboxSk)], ["matching", opts.matching ?? "on"], ["nostr_context", String(nostrContextN)], ["match_visibility", opts.matchVisibility ?? "pair"], ...(opts.maxVideoSec !== undefined ? [["max_video_sec", String(opts.maxVideoSec)]] : []), ...(opts.maxTalkSec !== undefined ? [["max_talk_sec", String(opts.maxTalkSec)]] : []), ["coordinator", opts.foreignCoordinator ?? coordPubkey, "1"], ...(opts.chat ? [["chat", "marmot"]] : []), ...(opts.lang ? [["lang", opts.lang]] : []), ...(opts.talks ? [["talks", opts.talks]] : []), ...(opts.retentionDays !== undefined ? [["retention", String(opts.retentionDays)]] : [])], content: "", id: "e2", sig: "" } as any,
    { kind: 31601, pubkey: eidPubkey, created_at: 1, tags: [["d", d]], content: JSON.stringify({ v: 2, invites: invites.map((sk) => ({ h: inviteHash(getPublicKey(sk)) })) }), id: "e3", sig: "" } as any,
    ...(opts.extraSeed?.({ eidPubkey, d, coordPubkey, inboxPubkey: getPublicKey(einboxSk) }) ?? []),
  );

  const counters: Counters = { nostrSummary: 0, batchCalls: [], reverseCalls: [], translateCalls: 0 };
  const llm = makeLlm(counters);
  // Per-role split providers (H-1): two distinct instances sharing the same mock
  // handler so the pipeline still produces sensible outputs, but each role's calls
  // land on its own instance — the routing can then be asserted call-by-call.
  const llmA = opts.splitProviders ? makeLlm(counters) : undefined;
  const llmB = opts.splitProviders ? makeLlm(counters) : undefined;
  const roles: RoleRoutes | undefined = opts.splitProviders
    ? {
        summary: { llm: llmA!, model: "mock-cheap", provider: "provA", requirePrivate: true, privacy: "private" },
        translate: { llm: llmA!, model: "mock-cheap", provider: "provA", requirePrivate: true, privacy: "private" },
        match: { llm: llmB!, model: "mock-strong", provider: "provB", requirePrivate: false, privacy: "non-private" },
        embed: { llm: llmB!, model: "mock-embed", provider: "provB", requirePrivate: false, privacy: "non-private" },
      }
    : undefined;
  const stt = new MockStt({
    [String(blobSize("crypto"))]: FIXTURES.crypto.transcript,
    [String(blobSize("design"))]: FIXTURES.design.transcript,
    [String(blobSize("code"))]: FIXTURES.code.transcript,
    [String(blobSize("music"))]: FIXTURES.music.transcript,
    default: "generic",
  });

  // Start at real time: wrapRumor stamps rumors with the wall clock, and the
  // coordinator rejects rumors future-dated > 15 min (audit COORD-11) — a fixed
  // past epoch would make every test rumor look future-dated.
  const clock = { t: Date.now() };
  const coordinator = new Coordinator({
    store, transport, coordSk, stt,
    ...(roles
      ? { roles }
      : {
          llm,
          summaryModel: { provider: "mock", model: "mock-cheap" },
          matchModel: { provider: "mock", model: "mock-strong" },
          embedModel: { provider: "mock", model: "mock-embed" },
          translateModel: { provider: "mock", model: "mock-cheap" },
        }),
    sttModel: "mock",
    ...(opts.evaluateBilling ? { evaluateBilling: opts.evaluateBilling } : {}),
    ...(opts.billingGracePeriodSec !== undefined ? { billingGracePeriodSec: opts.billingGracePeriodSec } : {}),
    ...(opts.budgets ? { budgets: opts.budgets } : {}),
    defaultRelays: ["wss://test"],
    batchSize: opts.batchSize,
    prefilter: opts.prefilter,
    chatMls: opts.chatMls,
    maxEvents: opts.maxEvents,
    allowedEidPubkeys: opts.allowedEidPubkeys,
    now: () => clock.t,
    // No real backoff sleeps in tests (COORD-2 retries run inline).
    sleep: async () => {},
    // Inject transcription: skip real Blossom/ffmpeg, still exercise the STT mock
    // + the blob-sha256 transcript cache (so idempotency is genuinely tested).
    transcribe: async (descriptor, signal) => {
      if (opts.beforeTranscribe) await opts.beforeTranscribe(descriptor, signal);
      if (opts.failTranscribe) throw new Error(opts.transcribeError ?? "could not fetch blob (simulated)");
      const cached = store.getTranscript(descriptor.x);
      if (cached !== undefined) return cached;
      const { text } = await stt.transcribe({ data: new Uint8Array(descriptor.size), mime: "audio/ogg" }, { signal });
      store.putTranscript(descriptor.x, text, 1);
      return text;
    },
  });

  // Install as a fresh grant at gen 1 (exercises the NIP §3.5 grant-gen validation:
  // the seeded 31600 names this coordinator at gen 1). A foreignCoordinator seed
  // names a DIFFERENT coordinator, so the grant is rejected and the event never
  // installs — the behavior those tests assert.
  if (!opts.skipAutoInstall) {
    await coordinator.installEvent({
      coordinate, inboxSkHex: bytesToHex(einboxSk), eck: eckVersions, configRelays: ["wss://test"], gen: 1, source: "grant", backfill: "full",
    });
  }

  return { coordinator, transport, store, llm, llmA, llmB, stt, counters, coordSk, eidSk, einboxSk, coordinate, eck, invites, nextInvite: 0, clock };
}

async function join(h: Harness, attendeeSk: Uint8Array, fixture: FixtureKey): Promise<string> {
  const attendeePubkey = getPublicKey(attendeeSk);
  const f = FIXTURES[fixture];
  const inboxPk = getPublicKey(h.einboxSk);
  const inviteSk = h.invites[h.nextInvite++]!; // a distinct single-use invite per attendee
  const proof = makeInviteProof(inviteSk, h.coordinate, attendeePubkey);

  const joinWrap = wrapRumor(attendeeSk, inboxPk, {
    kind: KIND_JOIN_REQUEST,
    content: { v: 2, name: f.about, message: "", rsvp_public: false },
    tags: [["a", h.coordinate], ["invite", getPublicKey(inviteSk), proof.sig]],
  });
  const subWrap = wrapRumor(attendeeSk, inboxPk, {
    kind: KIND_PROFILE_SUBMISSION,
    content: {
      v: 2,
      rev: nextSubmissionRev(attendeePubkey),
      profile: { about: f.about, skills: f.skills, looking_for: "", links: [] },
      media: [{
        kind: "intro", url: ["https://blob/x"],
        x: String(ORDER.indexOf(fixture)).repeat(64).slice(0, 64),
        ox: "b".repeat(64),
        size: blobSize(fixture), m: "video/webm", duration: 30,
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
      v: 2,
      rev: nextSubmissionRev(getPublicKey(attendeeSk)),
      profile: { about: f.about, skills: f.skills, looking_for: "", links: [] },
      media: [{
        kind: "intro", url: ["https://blob/x2"],
        x: String(9).repeat(64).slice(0, 63) + String(ORDER.indexOf(fixture)),
        ox: "c".repeat(64),
        size: newSize, m: "video/webm", duration: 30,
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
    content: { v: 2, name: about, message: "", rsvp_public: false },
    tags: [["a", h.coordinate], ["invite", getPublicKey(inviteSk), proof.sig]],
  });
  const subWrap = wrapRumor(attendeeSk, inboxPk, {
    kind: KIND_PROFILE_SUBMISSION,
    content: {
      v: 2,
      rev: nextSubmissionRev(attendeePubkey),
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
    duration: 30,
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
    const attendeeSk = generateSecretKey();
    const pk = await join(h, attendeeSk, "crypto");
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
    // Corrections carry a monotonic per-(coordinate) rev (NIP §3.3); auto-bump per
    // attendee unless the caller pins one explicitly (stale-ordering tests do).
    const pk = getPublicKey(attendeeSk);
    const rev = "rev" in content ? content.rev : (correctionRevByAttendee.set(pk, (correctionRevByAttendee.get(pk) ?? -1) + 1), correctionRevByAttendee.get(pk));
    const wrap = wrapRumor(attendeeSk, inboxPk, {
      kind: KIND_PROFILE_CORRECTION,
      content: { v: 2, a: h.coordinate, rev, ...content },
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
      content: { v: 2, a: h.coordinate, cmd: "reprocess", args: { pubkey: pk }, expires: Math.floor(h.clock.t / 1000) + 172800 },
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
    const attendeeSk = generateSecretKey();
    const pk = await join(h, attendeeSk, "crypto");
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
      content: { v: 2, a: h.coordinate, cmd: "revoke", args: { pubkey: cryptoPk }, expires: Math.floor(h.clock.t / 1000) + 172800 },
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
    const inbox2Sk = generateSecretKey();
    const grantContent = {
      v: 2,
      a: coordinate2,
      gen: 1,
      inbox_nsec: bytesToHex(inbox2Sk),
      eck: [{ id: 1, key: bytesToBase64(generateEck()) }],
      config_relays: ["wss://test"],
    };
    // A fresh grant install now fails closed (P0-4/§3.5) unless a 31600 exists that
    // names THIS coordinator at the grant's gen and whose inbox the grant key
    // derives — seed it.
    h.transport.seed.push({
      kind: 31600,
      pubkey: getPublicKey(eid2Sk),
      created_at: 1,
      id: "cfg-second-event",
      sig: "",
      content: "",
      tags: [
        ["d", "second-event"],
        ["v", "2"],
        ["inbox", getPublicKey(inbox2Sk)],
        ["coordinator", getPublicKey(h.coordSk), "1"],
      ],
    } as any);

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
    const attendeeSk = generateSecretKey();
    const pk = await join(h, attendeeSk, "crypto");
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
      content: { v: 2, a: h.coordinate, cmd: "revoke", args: { pubkey: cryptoPk }, expires: Math.floor(h.clock.t / 1000) + 172800 },
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
      tags: [["d", "cypherpunk"], ["v", "2"], ["inbox", getPublicKey(h.einboxSk)], ["coordinator", getPublicKey(h.coordSk), "1"], ["matching", "on"], ["match_visibility", "event"]],
      content: "", id: "cfg-2", sig: "",
    } as any;
    await h.coordinator.handleConfigUpdate(h.coordinate, newer);
    await h.coordinator.jobs.drain();
    expect(h.transport.published.some((e) => e.kind === KIND_MATCH_MATRIX)).toBe(true);
  });

  it("on a created_at tie, the LOWEST-id 31600 wins (NIP §3.1 flip; converges either arrival order)", async () => {
    const mkCfg = (h: Awaited<ReturnType<typeof setup>>, id: string, matching: "on" | "off") => ({
      kind: 31600, pubkey: getPublicKey(h.eidSk), created_at: 500,
      tags: [["d", "cypherpunk"], ["v", "2"], ["inbox", getPublicKey(h.einboxSk)], ["coordinator", getPublicKey(h.coordSk), "1"], ["matching", matching]],
      content: "", id, sig: "",
    });
    const applied = (h: Awaited<ReturnType<typeof setup>>) =>
      JSON.parse(h.store.getEvent(h.coordinate)!.config_json).matching as string;

    // Deliver high-id first, then low-id: the lower id supersedes on the tie.
    const hA = await setup(0);
    await hA.coordinator.handleConfigUpdate(hA.coordinate, mkCfg(hA, "ffff", "off") as any);
    await hA.coordinator.handleConfigUpdate(hA.coordinate, mkCfg(hA, "0000", "on") as any);
    expect(applied(hA)).toBe("on"); // low id "0000" won

    // Reverse arrival order on a fresh event: same winner (the higher id never
    // displaces the already-applied lower one).
    const hB = await setup(0);
    await hB.coordinator.handleConfigUpdate(hB.coordinate, mkCfg(hB, "0000", "on") as any);
    await hB.coordinator.handleConfigUpdate(hB.coordinate, mkCfg(hB, "ffff", "off") as any);
    expect(applied(hB)).toBe("on"); // "ffff" did NOT supersede "0000"
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
      tags: [["d", "cypherpunk"], ["v", "2"], ["inbox", getPublicKey(h.einboxSk)], ["matching", "on"], ["match_visibility", "event"]],
      content: "", id: "forged", sig: "",
    } as any);
    // Older-than-applied (created_at < install's 1) → ignored.
    await h.coordinator.handleConfigUpdate(h.coordinate, {
      kind: 31600, pubkey: getPublicKey(h.eidSk), created_at: 0,
      tags: [["d", "cypherpunk"], ["v", "2"], ["inbox", getPublicKey(h.einboxSk)], ["matching", "on"], ["match_visibility", "event"]],
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
      content: { v: 2, a: h.coordinate, cmd: "reprocess", args: { pubkey: cryptoPk }, expires: Math.floor(h.clock.t / 1000) + 172800 },
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
    // Exhaust the long-tail retry/backoff schedule (jobs.ts) so the process job
    // poisons — each iteration clears one step (the schedule tops out at 4h).
    for (let i = 0; i < 30; i++) {
      await h.coordinator.jobs.drain();
      h.clock.t += 5 * 60 * 60_000;
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

  // ── billing errors get their own category, not the processing_error catch-all ─
  it("classifies a depleted-provider-balance failure as provider_billing (2026-07-21)", async () => {
    const h = await setup(0, {
      failTranscribe: true,
      transcribeError: 'Venice billing: insufficient balance (402) — Venice chat/completions: {"error":"insufficient balance"}',
    });
    await join(h, generateSecretKey(), "crypto");
    for (let i = 0; i < 30; i++) {
      await h.coordinator.jobs.drain();
      h.clock.t += 5 * 60 * 60_000;
    }
    const s = lastCoordinatorStatus(h);
    expect(s?.state).toBe("poison");
    expect(s?.error_category).toBe("provider_billing");
  });
});

function lastCoordinatorStatus(h: Harness) {
  const statuses = h.transport.published
    .filter((e) => e.kind === 1059)
    .map((e) => { try { return unwrapRumor(e as any, h.eidSk); } catch { return null; } })
    .filter((r): r is NonNullable<typeof r> => !!r && r.kind === KIND_COORDINATOR_STATUS)
    .map((r) => coordinatorStatusContentSchema.parse(JSON.parse(r.content)));
  return statuses[statuses.length - 1];
}

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
    duration: 30,
    "encryption-algorithm": "aes-gcm" as const,
    "decryption-key": bytesToBase64(new Uint8Array(32)),
    "decryption-nonce": bytesToBase64(new Uint8Array(12)),
  };
}

/** Submit (or edit) a talk via a 21609 rumor to E_inbox. A talk carries EITHER
 *  `media` (Blossom) or `externalUrl` (+ `externalKind`). `processForMatching`
 *  opts a Blossom talk into STT + matching (default off, as on the wire). */
async function submitTalk(
  h: Harness,
  speakerSk: Uint8Array,
  args: {
    talkD: string;
    title: string;
    description?: string;
    media?: any;
    externalUrl?: string;
    externalKind?: "youtube" | "video";
    processForMatching?: boolean;
    revision?: number;
  },
): Promise<void> {
  const inboxPk = getPublicKey(h.einboxSk);
  const isExternal = args.externalUrl !== undefined;
  const wrap = wrapRumor(speakerSk, inboxPk, {
    kind: KIND_TALK_SUBMISSION,
    content: {
      v: 2,
      a: h.coordinate,
      talk_d: args.talkD,
      title: args.title,
      description: args.description ?? "",
      speakers: [],
      source_type: isExternal ? "external" : "recording",
      process_for_matching: args.processForMatching ?? false,
      revision: args.revision ?? 0,
      ...(isExternal
        ? { external_url: args.externalUrl, external_kind: args.externalKind }
        : { media: args.media }),
    },
    tags: [["a", h.coordinate]],
  });
  await h.coordinator.handleInboxWrap(h.coordinate, wrap as any);
}

/** Send an organizer admin command (sealed by E_id). Each call stamps a strictly
 *  increasing `created_at` (via `adminNonce`, reset per test in setup) so the NIP
 *  §3.4 per-subject watermark accepts sequential same-subject commands under the
 *  fixed test clock — in production the wall clock supplies the ordering. The `_n`
 *  nonce also keeps two otherwise-identical commands from colliding on rumor id;
 *  handleAdmin ignores unknown args. Commands are stamped with a far-future
 *  `expires` unless the caller overrides it (expiry tests do). */
let adminNonce = 0;
async function admin(
  h: Harness,
  cmd: string,
  args: Record<string, unknown>,
  opts: { expires?: number } = {},
): Promise<void> {
  const createdAt = Math.floor(h.clock.t / 1000) + adminNonce++;
  const wrap = wrapRumor(h.eidSk, getPublicKey(h.coordSk), {
    kind: KIND_ADMIN_COMMAND,
    content: { v: 2, a: h.coordinate, cmd, args, expires: opts.expires ?? createdAt + 172_800 },
    created_at: createdAt,
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
    // process_for_matching opts this talk into STT (default off).
    await submitTalk(h, speakerSk, { talkD: "t1", title: "Zero-knowledge proofs", description: "A gentle intro", media: talkMedia(700, x), processForMatching: true });
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

  it("talks are NOT transcribed/matched by default (process_for_matching off)", async () => {
    const h = await setup(0, { talks: "on" });
    const speakerSk = generateSecretKey();
    const pk = await join(h, speakerSk, "crypto");
    await h.coordinator.jobs.drain();
    h.stt.setTranscript("700", "should never be requested");
    // No processForMatching → coordinator stores but skips paid STT entirely.
    await submitTalk(h, speakerSk, { talkD: "t1", title: "Unprocessed talk", media: talkMedia(700, "b1".repeat(32)) });
    await h.coordinator.jobs.drain();
    const row = h.store.getTalk(h.coordinate, pk, "t1")!;
    expect(row.status).toBe("pending");
    expect(row.transcript_json).toBeNull(); // never transcribed
    expect(row.process_for_matching).toBe(0);
    // Still fully publishable — moderation is independent of processing.
    await admin(h, "talk_publish", { pubkey: pk, talk_d: "t1" });
    const talks = publishedTalks(h);
    expect(talks).toHaveLength(1);
    expect(talks[0]!.title).toBe("Unprocessed talk");
    expect(talks[0]!.transcript).toBeUndefined();
  });

  it("an external (YouTube) talk is stored + published without any Blossom fetch", async () => {
    const h = await setup(0, { talks: "on" });
    const speakerSk = generateSecretKey();
    const pk = await join(h, speakerSk, "crypto");
    await h.coordinator.jobs.drain();
    await submitTalk(h, speakerSk, {
      talkD: "t1",
      title: "My big talk",
      externalUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      externalKind: "youtube",
    });
    await h.coordinator.jobs.drain();
    const row = h.store.getTalk(h.coordinate, pk, "t1")!;
    expect(row.status).toBe("pending");
    expect(row.external_url).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(row.external_kind).toBe("youtube");
    expect(row.media_json).toBe("null"); // no Blossom descriptor
    expect(row.transcript_json).toBeNull(); // never fetched/transcribed
    // Publishes a 31610 that carries the external URL (members can play it).
    await admin(h, "talk_publish", { pubkey: pk, talk_d: "t1" });
    const talks = publishedTalks(h);
    expect(talks).toHaveLength(1);
    expect(talks[0]!.external_url).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(talks[0]!.external_kind).toBe("youtube");
    expect(talks[0]!.media).toBeUndefined();
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

  it("equal revision + different content is REJECTED (a content change requires a revision bump) — NIP §3.3", async () => {
    const h = await setup(0, { talks: "on" });
    const speakerSk = generateSecretKey();
    const pk = await join(h, speakerSk, "crypto");
    await h.coordinator.jobs.drain();
    await submitTalk(h, speakerSk, { talkD: "t1", title: "First", media: talkMedia(700, "ee".repeat(32)), revision: 0 });
    await h.coordinator.jobs.drain();
    await admin(h, "talk_publish", { pubkey: pk, talk_d: "t1" });
    expect(h.store.getTalk(h.coordinate, pk, "t1")!.status).toBe("published");

    // Same revision, DIFFERENT content (new title + media) — a content change with
    // no revision bump. Must be rejected: the stored talk is unchanged and stays
    // published (never reset to pending), so a delayed duplicate can't silently
    // replace moderated content.
    await submitTalk(h, speakerSk, { talkD: "t1", title: "Sneaky edit", media: talkMedia(720, "ac".repeat(32)), revision: 0 });
    await h.coordinator.jobs.drain();
    const row = h.store.getTalk(h.coordinate, pk, "t1")!;
    expect(row.title).toBe("First");
    expect(row.status).toBe("published");

    // A proper edit (revision bumped) IS accepted and re-enters moderation.
    await submitTalk(h, speakerSk, { talkD: "t1", title: "Proper edit", media: talkMedia(720, "ac".repeat(32)), revision: 1 });
    await h.coordinator.jobs.drain();
    const row2 = h.store.getTalk(h.coordinate, pk, "t1")!;
    expect(row2.title).toBe("Proper edit");
    expect(row2.status).toBe("pending");
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

/** Decode every gift-wrapped kind-21602 key grant addressed to `recipientSk`. */
function grantsTo(h: Harness, recipientSk: Uint8Array) {
  return h.transport.published
    .filter((e) => e.kind === 1059)
    .map((e) => {
      try {
        return unwrapRumor(e as any, recipientSk);
      } catch {
        return null;
      }
    })
    .filter((r): r is NonNullable<typeof r> => !!r && r.kind === 21602);
}

/** Build + send a join-request wrap (no submission), returning the wrap + pubkey. */
async function joinOnly(
  h: Harness,
  attendeeSk: Uint8Array,
  name: string,
  opts: { created_at?: number } = {},
): Promise<{ wrap: any; pubkey: string }> {
  const attendeePubkey = getPublicKey(attendeeSk);
  const inboxPk = getPublicKey(h.einboxSk);
  const inviteSk = h.invites[h.nextInvite++]!;
  const proof = makeInviteProof(inviteSk, h.coordinate, attendeePubkey);
  const wrap = wrapRumor(attendeeSk, inboxPk, {
    kind: KIND_JOIN_REQUEST,
    content: { v: 2, name, message: "", rsvp_public: false },
    tags: [["a", h.coordinate], ["invite", getPublicKey(inviteSk), proof.sig]],
    ...(opts.created_at !== undefined ? { created_at: opts.created_at } : {}),
  });
  await h.coordinator.handleInboxWrap(h.coordinate, wrap as any);
  return { wrap, pubkey: attendeePubkey };
}

describe("audit COORD-2 — rumor handling is failure-safe", () => {
  it("a transient publish failure leaves the rumor unseen; the retry re-grants and recovers", async () => {
    const h = await setup();
    const sk = generateSecretKey();

    // Every publish fails: three inline attempts (5s/30s backoffs are no-op-slept
    // in tests) all fail → the rumor is left UNSEEN for the startup rescan.
    h.transport.failPublishes = 99;
    const { wrap, pubkey } = await joinOnly(h, sk, "crypto");
    expect(grantsTo(h, sk)).toHaveLength(0);
    expect(h.store.isRumorSeen(wrap.id)).toBe(false);
    // …but the attendee row IS approved (attempt 1 got that far), so a plain
    // re-delivery must still re-send the grant (idempotent re-grant path).
    expect(h.store.getAttendee(h.coordinate, pubkey)?.status).toBe("approved");

    // "Startup rescan": the same wrap re-arrives after the outage clears.
    h.transport.failPublishes = 0;
    await h.coordinator.handleInboxWrap(h.coordinate, wrap as any);
    expect(grantsTo(h, sk)).toHaveLength(1);
    expect(h.store.isRumorSeen(wrap.id)).toBe(true);

    // A further duplicate is a no-op (dedupe): still exactly one grant.
    await h.coordinator.handleInboxWrap(h.coordinate, wrap as any);
    expect(grantsTo(h, sk)).toHaveLength(1);
  });

  it("an in-memory retry recovers a one-off publish failure within the live handler", async () => {
    const h = await setup();
    const sk = generateSecretKey();
    h.transport.failPublishes = 1; // the first grant publish fails once
    const { pubkey } = await joinOnly(h, sk, "crypto");
    expect(grantsTo(h, sk)).toHaveLength(1); // attempt 2 (re-grant path) got it out
    expect(h.store.getAttendee(h.coordinate, pubkey)?.status).toBe("approved");
  });

  it("a repeated organizer approve re-grants the ECK (idempotent)", async () => {
    const h = await setup();
    const sk = generateSecretKey();
    const { pubkey } = await joinOnly(h, sk, "crypto");
    expect(grantsTo(h, sk)).toHaveLength(1);
    await admin(h, "approve", { pubkey });
    expect(grantsTo(h, sk)).toHaveLength(2); // re-granted, no error
  });
});

describe("audit P0-3 — duplicate rumors don't execute concurrently", () => {
  it("a rumor delivered via two concurrent wraps runs its side effects once", async () => {
    const h = await setup();
    const attendeeSk = generateSecretKey();
    const attendeePubkey = getPublicKey(attendeeSk);
    const inboxPk = getPublicKey(h.einboxSk);
    const inviteSk = h.invites[h.nextInvite++]!;
    const proof = makeInviteProof(inviteSk, h.coordinate, attendeePubkey);
    // One rumor, wrapped once — delivered TWICE at the same instant. The durable
    // "seen" mark lands only after the handler succeeds, so pre-fix both
    // subscription callbacks pass the read-only seen check and grant in parallel.
    const wrap = wrapRumor(attendeeSk, inboxPk, {
      kind: KIND_JOIN_REQUEST,
      content: { v: 2, name: "crypto", message: "", rsvp_public: false },
      tags: [["a", h.coordinate], ["invite", getPublicKey(inviteSk), proof.sig]],
    });
    await Promise.all([
      h.coordinator.handleInboxWrap(h.coordinate, wrap as any),
      h.coordinator.handleInboxWrap(h.coordinate, wrap as any),
    ]);
    expect(grantsTo(h, attendeeSk)).toHaveLength(1); // pre-fix: 2
    expect(h.store.isRumorSeen(wrap.id)).toBe(true);
  });
});

describe("NIP §3.3 — 21601 profile submissions ordered by (rev, created_at, id)", () => {
  it("higher rev wins regardless of created_at; a lower/equal-loser rev is rejected", async () => {
    const h = await setup();
    const sk = generateSecretKey();
    const pk = await join(h, sk, "crypto"); // approved; join stored rev 0
    const inboxPk = getPublicKey(h.einboxSk);
    const nowSec = Math.floor(h.clock.t / 1000);
    const about = () => JSON.parse(h.store.getAttendee(h.coordinate, pk)!.profile_json!).about;
    const mkSub = (label: string, rev: number, createdAt: number) =>
      wrapRumor(sk, inboxPk, {
        kind: KIND_PROFILE_SUBMISSION,
        content: { v: 2, rev, profile: { about: label, skills: [], looking_for: "", links: [] }, media: [] },
        tags: [["a", h.coordinate]],
        created_at: createdAt,
      });

    // rev 2 lands (regardless of created_at) over the join's rev 0.
    await h.coordinator.handleInboxWrap(h.coordinate, mkSub("REV2", 2, nowSec + 10) as any);
    expect(about()).toBe("REV2");

    // A LOWER rev with a much NEWER created_at is still rejected (rev is primary).
    // (+800s stays under the +900s future-clamp so the rejection is the rev rule,
    // not the freshness drop.)
    await h.coordinator.handleInboxWrap(h.coordinate, mkSub("REV1-LATER", 1, nowSec + 800) as any);
    expect(about()).toBe("REV2");

    // EQUAL rev, higher created_at supersedes.
    await h.coordinator.handleInboxWrap(h.coordinate, mkSub("REV2-NEWER", 2, nowSec + 20) as any);
    expect(about()).toBe("REV2-NEWER");

    // EQUAL rev, LOWER created_at is rejected.
    await h.coordinator.handleInboxWrap(h.coordinate, mkSub("REV2-OLDER", 2, nowSec + 5) as any);
    expect(about()).toBe("REV2-NEWER");

    // A strictly higher rev always wins.
    await h.coordinator.handleInboxWrap(h.coordinate, mkSub("REV3", 3, nowSec) as any);
    expect(about()).toBe("REV3");
  });
});

describe("NIP §3.4 — admin command expiry + per-subject watermarks", () => {
  /** Send a 21604 command with an explicit created_at + expires (ordering tests). */
  async function sendAdminAt(
    h: Harness,
    cmd: string,
    args: Record<string, unknown>,
    createdAt: number,
    expires: number,
  ): Promise<void> {
    const wrap = wrapRumor(h.eidSk, getPublicKey(h.coordSk), {
      kind: KIND_ADMIN_COMMAND,
      content: { v: 2, a: h.coordinate, cmd, args, expires },
      created_at: createdAt,
    });
    await h.coordinator.handleCoordinatorWrap(wrap as any);
  }

  it("skips an expired command on live delivery AND on a backfill rescan", async () => {
    const h = await setup();
    const sk = generateSecretKey();
    const pk = await join(h, sk, "crypto"); // approved
    const now = Math.floor(h.clock.t / 1000);
    // A revoke that expired an hour ago must be skipped on live delivery — the
    // attendee stays approved.
    await sendAdminAt(h, "revoke", { pubkey: pk }, now - 7200, now - 3600);
    expect(h.store.getAttendee(h.coordinate, pk)!.status).toBe("approved");
    // A DIFFERENT (never-seen) expired command — as a fresh startup backfill would
    // replay from full history after a DB loss — is also skipped by the expiry gate
    // in handleAdmin (the same code path live and backfill use). An old revoke can
    // never re-execute.
    await sendAdminAt(h, "revoke", { pubkey: pk }, now - 7300, now - 3600);
    expect(h.store.getAttendee(h.coordinate, pk)!.status).toBe("approved");
  });

  it("rejects a command older than the subject watermark, but a newer command for a DIFFERENT subject applies", async () => {
    const h = await setup();
    const aSk = generateSecretKey();
    const bSk = generateSecretKey();
    const aPk = await join(h, aSk, "crypto");
    const bPk = await join(h, bSk, "design");
    const now = Math.floor(h.clock.t / 1000);
    const exp = now + 172_800;
    // Revoke A at T=now+50 → applied (A revoked), watermark(pubkey:A)=now+50.
    await sendAdminAt(h, "revoke", { pubkey: aPk }, now + 50, exp);
    expect(h.store.getAttendee(h.coordinate, aPk)!.status).toBe("revoked");
    // Reprocess B at T=now+10 (older than A's watermark, but a DIFFERENT subject)
    // → applies (independent watermark). Observable via an enqueued process job.
    await sendAdminAt(h, "reprocess", { pubkey: bPk }, now + 10, exp);
    expect(h.store.getCommandWatermark(h.coordinate, `member:${bPk}`)).toMatchObject({ created_at: now + 10 });
    // A reprocess for A older than A's watermark is rejected (watermark unchanged).
    await sendAdminAt(h, "reprocess", { pubkey: aPk }, now + 20, exp);
    expect(h.store.getCommandWatermark(h.coordinate, `member:${aPk}`)!.created_at).toBe(now + 50);
  });

  it("approve/revoke interleavings converge per subject regardless of arrival order", async () => {
    const now0 = Math.floor(Date.now() / 1000);
    const exp = now0 + 172_800;
    // Revoke is the NEWER command (T2). Both arrival orders converge to revoked.
    for (const order of ["approve-first", "revoke-first"] as const) {
      const h = await setup();
      const sk = generateSecretKey();
      const pk = await join(h, sk, "crypto"); // approved
      const t1 = now0 - 100; // approve
      const t2 = now0 - 50; // revoke (newer → wins)
      if (order === "approve-first") {
        await sendAdminAt(h, "approve", { pubkey: pk }, t1, exp);
        await sendAdminAt(h, "revoke", { pubkey: pk }, t2, exp);
      } else {
        await sendAdminAt(h, "revoke", { pubkey: pk }, t2, exp);
        await sendAdminAt(h, "approve", { pubkey: pk }, t1, exp); // older → rejected
      }
      expect(h.store.getAttendee(h.coordinate, pk)!.status).toBe("revoked");
    }
    // Approve is the NEWER command (T2). Both arrival orders converge to approved.
    for (const order of ["approve-first", "revoke-first"] as const) {
      const h = await setup();
      const sk = generateSecretKey();
      const pk = await join(h, sk, "crypto");
      const t1 = now0 - 100; // revoke
      const t2 = now0 - 50; // approve (newer → wins)
      if (order === "revoke-first") {
        await sendAdminAt(h, "revoke", { pubkey: pk }, t1, exp);
        await sendAdminAt(h, "approve", { pubkey: pk }, t2, exp);
      } else {
        await sendAdminAt(h, "approve", { pubkey: pk }, t2, exp);
        await sendAdminAt(h, "revoke", { pubkey: pk }, t1, exp); // older → rejected
      }
      expect(h.store.getAttendee(h.coordinate, pk)!.status).toBe("approved");
    }
  });

  it("a signed detach command tombstones the install, deletes custody, and stops serving", async () => {
    const h = await setup();
    const sk = generateSecretKey();
    const pk = await join(h, sk, "crypto");
    expect(h.store.getEvent(h.coordinate)).toBeDefined();
    const now = Math.floor(h.clock.t / 1000);
    await sendAdminAt(h, "detach", {}, now, now + 172_800);
    // Custody deleted (D6), install tombstoned, subscriptions closed.
    expect(h.store.getEvent(h.coordinate)).toBeUndefined();
    expect(h.store.isInstallTombstoned(h.coordinate)).toBe(true);
    expect(h.transport.subs.some((s) => s.closed)).toBe(true);
    // The event no longer serves: a further join is a no-op (no new grant).
    const before = h.transport.published.length;
    const sk2 = generateSecretKey();
    await join(h, sk2, "design").catch(() => {});
    expect(h.transport.published.length).toBe(before);
    void pk;
  });
});

describe("audit P0-7 — stale scoring output can't undo a revocation", () => {
  it("a score returned after an attendee is revoked does not recreate their deleted pair", async () => {
    const h = await setup();
    const cryptoSk = generateSecretKey();
    const designSk = generateSecretKey();
    const cryptoPk = await join(h, cryptoSk, "crypto");
    const designPk = await join(h, designSk, "design");
    await h.coordinator.jobs.drain();
    // Both directions were scored during the initial pipeline.
    const dir = h.store.getPairDirection(h.coordinate, cryptoPk, designPk);
    expect(dir).toBeDefined();
    const inputsHash = dir!.inputs_hash;

    // Revoke the cryptographer — this deletes their pairs.
    await admin(h, "revoke", { pubkey: cryptoPk });
    await h.coordinator.jobs.drain();
    expect(h.store.getPairDirection(h.coordinate, cryptoPk, designPk)).toBeUndefined();

    // A score_batch enqueued BEFORE the revoke now runs for the stale pair. The
    // batch scores fine, but recording must be discarded (the attendee is no
    // longer approved) rather than recreating the pair revocation just removed.
    h.coordinator.jobs.enqueue("score_batch", "stale-after-revoke", {
      coordinate: h.coordinate,
      pairs: [{ a: cryptoPk, b: designPk, inputsHash }],
    });
    await h.coordinator.jobs.drain();

    expect(h.store.getPairDirection(h.coordinate, cryptoPk, designPk)).toBeUndefined(); // pre-fix: recreated
  });
});

describe("audit COORD-3 — install authorization + unsolicited-install caps", () => {
  it("rejects an install whose 31600 names a DIFFERENT coordinator", async () => {
    const foreign = getPublicKey(generateSecretKey());
    const h = await setup(0, { foreignCoordinator: foreign });
    // installEvent rejected the event: no state, no stored event, joins are no-ops.
    expect(h.store.getEvent(h.coordinate)).toBeUndefined();
    const sk = generateSecretKey();
    const { pubkey } = await joinOnly(h, sk, "crypto");
    expect(h.store.getAttendee(h.coordinate, pubkey)).toBeUndefined();
  });

  it("a live 31600 re-pointing at another coordinator uninstalls the event", async () => {
    const h = await setup();
    const foreign = getPublicKey(generateSecretKey());
    await h.coordinator.handleConfigUpdate(h.coordinate, {
      kind: 31600,
      pubkey: getPublicKey(h.eidSk),
      created_at: 2,
      id: "cfg-foreign",
      tags: [["d", "cypherpunk"], ["v", "2"], ["inbox", getPublicKey(h.einboxSk)], ["coordinator", foreign]],
      content: "",
      sig: "",
    } as any);
    const sk = generateSecretKey();
    const { pubkey } = await joinOnly(h, sk, "crypto");
    expect(h.store.getAttendee(h.coordinate, pubkey)).toBeUndefined(); // uninstalled → no-op
  });

  it("rejects installs beyond the security.max_events cap", async () => {
    const h = await setup(0, { maxEvents: 1 }); // the setup event fills the slot
    const eid2 = generateSecretKey();
    const coord2 = makeCoordinate(getPublicKey(eid2), "second-event");
    const einbox2 = generateSecretKey();
    const grantWrap = wrapRumor(eid2, getPublicKey(h.coordSk), {
      kind: KIND_COORDINATOR_GRANT,
      content: {
        v: 2,
        a: coord2,
        gen: 1,
        inbox_nsec: bytesToHex(einbox2),
        eck: [{ id: 1, key: bytesToBase64(generateEck()) }],
        config_relays: [],
      },
    });
    await h.coordinator.handleCoordinatorWrap(grantWrap as any);
    expect(h.store.getEvent(coord2)).toBeUndefined(); // rejected by the cap
  });

  it("rejects installs from an E_id not in security.allowed_eid_pubkeys", async () => {
    // Non-empty allowlist that does NOT contain the granting E_id → rejected.
    const h = await setup(0, { allowedEidPubkeys: [getPublicKey(generateSecretKey())] });
    const eid2 = generateSecretKey();
    const coord2 = makeCoordinate(getPublicKey(eid2), "foreign-event");
    const einbox2 = generateSecretKey();
    const grantWrap = wrapRumor(eid2, getPublicKey(h.coordSk), {
      kind: KIND_COORDINATOR_GRANT,
      content: {
        v: 2,
        a: coord2,
        gen: 1,
        inbox_nsec: bytesToHex(einbox2),
        eck: [{ id: 1, key: bytesToBase64(generateEck()) }],
        config_relays: [],
      },
    });
    await h.coordinator.handleCoordinatorWrap(grantWrap as any);
    expect(h.store.getEvent(coord2)).toBeUndefined(); // not on the allowlist
  });

  it("sanitizes grant config_relays (audit COORD-16): wss-only, deduped", async () => {
    const h = await setup();
    const eid2 = generateSecretKey();
    const coord2 = makeCoordinate(getPublicKey(eid2), "relay-check");
    const einbox2 = generateSecretKey();
    // Authorizing 31600 for the grant install (P0-4): names this coordinator,
    // inbox derives from the grant's inbox key.
    h.transport.seed.push({
      kind: 31600,
      pubkey: getPublicKey(eid2),
      created_at: 1,
      id: "cfg-relay-check",
      sig: "",
      content: "",
      tags: [
        ["d", "relay-check"],
        ["v", "2"],
        ["inbox", getPublicKey(einbox2)],
        ["coordinator", getPublicKey(h.coordSk), "1"],
      ],
    } as any);
    const grantWrap = wrapRumor(eid2, getPublicKey(h.coordSk), {
      kind: KIND_COORDINATOR_GRANT,
      content: {
        v: 2,
        a: coord2,
        gen: 1,
        inbox_nsec: bytesToHex(einbox2),
        eck: [{ id: 1, key: bytesToBase64(generateEck()) }],
        config_relays: ["ws://insecure.example", "wss://ok.example/", "wss://ok.example"],
      },
    });
    await h.coordinator.handleCoordinatorWrap(grantWrap as any);
    expect(JSON.parse(h.store.getEvent(coord2)!.config_relays)).toEqual(["wss://ok.example"]);
  });
});

describe("audit P0-4 — install requires current authenticated assignment", () => {
  // A genuine grant (sealed by the event's E_id), varying only the authorizing 31600.
  async function grantFor(
    h: Harness,
    eid2: Uint8Array,
    inbox2: Uint8Array,
    d: string,
  ) {
    const coord2 = makeCoordinate(getPublicKey(eid2), d);
    const grantWrap = wrapRumor(eid2, getPublicKey(h.coordSk), {
      kind: KIND_COORDINATOR_GRANT,
      content: {
        v: 2,
        a: coord2,
        gen: 1,
        inbox_nsec: bytesToHex(inbox2),
        eck: [{ id: 1, key: bytesToBase64(generateEck()) }],
        config_relays: ["wss://test"],
      },
    });
    return { coord2, grantWrap };
  }

  function seedConfig(
    h: Harness,
    eid2: Uint8Array,
    d: string,
    tags: string[][],
  ) {
    h.transport.seed.push({
      kind: 31600,
      pubkey: getPublicKey(eid2),
      created_at: 1,
      id: `cfg-${d}`,
      sig: "",
      content: "",
      tags: [["d", d], ["v", "2"], ...tags],
    } as any);
  }

  it("rejects a grant install with NO fetchable 31600 (retryable, never installs blind)", async () => {
    const h = await setup();
    const eid2 = generateSecretKey();
    const inbox2 = generateSecretKey();
    const { coord2, grantWrap } = await grantFor(h, eid2, inbox2, "no-config");
    // No 31600 seeded → the grant can't be authorized → left unseen, not installed.
    await h.coordinator.handleCoordinatorWrap(grantWrap as any);
    expect(h.store.getEvent(coord2)).toBeUndefined();
  });

  it("rejects a grant whose 31600 names NO coordinator", async () => {
    const h = await setup();
    const eid2 = generateSecretKey();
    const inbox2 = generateSecretKey();
    const { coord2, grantWrap } = await grantFor(h, eid2, inbox2, "unassigned");
    seedConfig(h, eid2, "unassigned", [["inbox", getPublicKey(inbox2)]]); // no coordinator tag
    await h.coordinator.handleCoordinatorWrap(grantWrap as any);
    expect(h.store.getEvent(coord2)).toBeUndefined();
  });

  it("rejects a grant whose inbox key does not derive the config's declared inbox", async () => {
    const h = await setup();
    const eid2 = generateSecretKey();
    const inbox2 = generateSecretKey();
    const { coord2, grantWrap } = await grantFor(h, eid2, inbox2, "wrong-inbox");
    // Config names this coordinator but declares a DIFFERENT inbox than the grant.
    seedConfig(h, eid2, "wrong-inbox", [
      ["inbox", getPublicKey(generateSecretKey())],
      ["coordinator", getPublicKey(h.coordSk), "1"],
    ]);
    await h.coordinator.handleCoordinatorWrap(grantWrap as any);
    expect(h.store.getEvent(coord2)).toBeUndefined();
  });

  it("installs when a newest 31600 names this coordinator and the inbox matches", async () => {
    const h = await setup();
    const eid2 = generateSecretKey();
    const inbox2 = generateSecretKey();
    const { coord2, grantWrap } = await grantFor(h, eid2, inbox2, "authorized");
    seedConfig(h, eid2, "authorized", [
      ["inbox", getPublicKey(inbox2)],
      ["coordinator", getPublicKey(h.coordSk), "1"],
    ]);
    await h.coordinator.handleCoordinatorWrap(grantWrap as any);
    expect(h.store.getEvent(coord2)).toBeDefined();
  });

  // ── config-propagation race (attach) ──────────────────────────────────────
  // An organizer's attach publishes the coordinator-naming 31600 and the 21603 grant
  // nearly simultaneously; a fresh event is created coordinator-LESS. If the install
  // fetch races ahead of relay propagation it reads the prior coordinator-less config.
  // That must be RETRYABLE (the attach's config will land), not a hard reject — the
  // pre-fix code returned outright, so a legitimate attach that lost this race never
  // installed and the coordinator never watched the E_inbox.
  it("a 31600 that names this coordinator only AFTER propagation installs via retry (config-less race is retryable, not a hard reject)", async () => {
    const h = await setup();
    const eid2 = generateSecretKey();
    const inbox2 = generateSecretKey();
    const { coord2, grantWrap } = await grantFor(h, eid2, inbox2, "race");
    // The only config fetchable right now is coordinator-LESS (the pre-attach create).
    seedConfig(h, eid2, "race", [["inbox", getPublicKey(inbox2)]]);
    // On the SECOND config fetch (the inline retry), the attach's coordinator-naming
    // config has propagated.
    let cfgFetches = 0;
    h.transport.beforeFetch = (filter) => {
      if (filter.kinds?.includes(31600) && filter["#d"]?.includes("race")) {
        cfgFetches++;
        if (cfgFetches === 2) {
          h.transport.seed = h.transport.seed.filter((e) => e.id !== "cfg-race");
          seedConfig(h, eid2, "race", [
            ["inbox", getPublicKey(inbox2)],
            ["coordinator", getPublicKey(h.coordSk), "1"],
          ]);
        }
      }
    };
    await h.coordinator.handleCoordinatorWrap(grantWrap as any);
    // Installed via the retry — not lost. (Pre-fix: hard reject on fetch #1, no retry.)
    expect(h.store.getEvent(coord2)).toBeDefined();
    expect(cfgFetches).toBeGreaterThanOrEqual(2);
    // A retryable failure never marks the grant seen prematurely; success does.
    expect(h.store.isRumorSeen(grantWrap.id)).toBe(true);
  });

  it("the security guards stay TERMINAL under retry: a config naming a DIFFERENT coordinator, and a replay below the high-water mark, never install", async () => {
    const h = await setup();
    // (a) A config that permanently names a DIFFERENT, real coordinator is terminal —
    // that grant is genuinely not for this daemon; retrying can never resolve it, so
    // it is rejected immediately and marked seen (no retry loop rescues it).
    const eid2 = generateSecretKey();
    const inbox2 = generateSecretKey();
    const foreign = getPublicKey(generateSecretKey());
    const { coord2, grantWrap } = await grantFor(h, eid2, inbox2, "foreign");
    seedConfig(h, eid2, "foreign", [["inbox", getPublicKey(inbox2)], ["coordinator", foreign, "1"]]);
    await h.coordinator.handleCoordinatorWrap(grantWrap as any);
    expect(h.store.getEvent(coord2)).toBeUndefined();
    expect(h.store.isRumorSeen(grantWrap.id)).toBe(true); // terminal → seen, not retried

    // (b) A replay whose gen is at/below the high-water mark after a detach stays
    // rejected — the reordered replay guard runs before any config check.
    expect(h.store.installHighGen(h.coordinate)).toBe(1);
    const now = Math.floor(h.clock.t / 1000);
    const detachWrap = wrapRumor(h.eidSk, getPublicKey(h.coordSk), {
      kind: KIND_ADMIN_COMMAND,
      content: { v: 2, a: h.coordinate, cmd: "detach", args: {}, expires: now + 172_800 },
      created_at: now,
    });
    await h.coordinator.handleCoordinatorWrap(detachWrap as any);
    expect(h.store.isInstallTombstoned(h.coordinate)).toBe(true);
    const replay = wrapRumor(h.eidSk, getPublicKey(h.coordSk), {
      kind: KIND_COORDINATOR_GRANT,
      content: { v: 2, a: h.coordinate, gen: 1, inbox_nsec: bytesToHex(h.einboxSk), eck: [{ id: 1, key: bytesToBase64(h.eck) }], config_relays: ["wss://test"] },
    });
    await h.coordinator.handleCoordinatorWrap(replay as any);
    expect(h.store.getEvent(h.coordinate)).toBeUndefined();
  });
});

describe("NIP §3.5 — install generation + durable detach + startup revalidation", () => {
  /** Build a genuine 21603 grant (sealed by E_id) + seed its authorizing 31600. */
  function grantAndSeed(
    h: Harness,
    eid2: Uint8Array,
    inbox2: Uint8Array,
    d: string,
    gen: number,
    configGen = gen,
  ): { coord2: string; grantWrap: any } {
    const coord2 = makeCoordinate(getPublicKey(eid2), d);
    h.transport.seed.push({
      kind: 31600, pubkey: getPublicKey(eid2), created_at: 1, id: `cfg-${d}`, sig: "", content: "",
      tags: [["d", d], ["v", "2"], ["inbox", getPublicKey(inbox2)], ["coordinator", getPublicKey(h.coordSk), String(configGen)]],
    } as any);
    const grantWrap = wrapRumor(eid2, getPublicKey(h.coordSk), {
      kind: KIND_COORDINATOR_GRANT,
      content: { v: 2, a: coord2, gen, inbox_nsec: bytesToHex(inbox2), eck: [{ id: 1, key: bytesToBase64(generateEck()) }], config_relays: ["wss://test"] },
    });
    return { coord2, grantWrap };
  }

  it("rejects a grant whose gen is BELOW the newest 31600's gen (superseded/stale)", async () => {
    const h = await setup();
    // Config declares gen 2, grant carries gen 1 → grant behind config → hard reject.
    const { coord2, grantWrap } = grantAndSeed(h, generateSecretKey(), generateSecretKey(), "genmismatch", 1, 2);
    await h.coordinator.handleCoordinatorWrap(grantWrap as any);
    expect(h.store.getEvent(coord2)).toBeUndefined();
  });

  it("a grant AHEAD of the config's gen is retryable (config lag), installs once it propagates (NIP §3.7)", async () => {
    const h = await setup();
    const eid2 = generateSecretKey();
    const inbox2 = generateSecretKey();
    // Grant carries gen 2; the config we can fetch still names gen 1 (propagation lag).
    const { coord2, grantWrap } = grantAndSeed(h, eid2, inbox2, "genlag", 2, 1);
    await h.coordinator.handleCoordinatorWrap(grantWrap as any);
    // Not installed yet — retryable, NOT a hard reject; the wrap was left unseen.
    expect(h.store.getEvent(coord2)).toBeUndefined();

    // The organizer's newer 31600 (gen 2) now propagates.
    h.transport.seed = h.transport.seed.filter((e) => e.id !== "cfg-genlag");
    h.transport.seed.push({
      kind: 31600, pubkey: getPublicKey(eid2), created_at: 2, id: "cfg-genlag2", sig: "", content: "",
      tags: [["d", "genlag"], ["v", "2"], ["inbox", getPublicKey(inbox2)], ["coordinator", getPublicKey(h.coordSk), "2"]],
    } as any);
    // Re-delivering the SAME grant now installs (a retryable failure never marks it seen).
    await h.coordinator.handleCoordinatorWrap(grantWrap as any);
    expect(h.store.getEvent(coord2)).toBeDefined();
  });

  it("rejects a replayed old-gen 21603 after a detach (gen ≤ high-water mark)", async () => {
    const h = await setup(); // installed at gen 1
    expect(h.store.installHighGen(h.coordinate)).toBe(1);
    // Detach (signed command) → tombstone at gen 1, custody deleted.
    const now = Math.floor(h.clock.t / 1000);
    const detachWrap = wrapRumor(h.eidSk, getPublicKey(h.coordSk), {
      kind: KIND_ADMIN_COMMAND,
      content: { v: 2, a: h.coordinate, cmd: "detach", args: {}, expires: now + 172_800 },
      created_at: now,
    });
    await h.coordinator.handleCoordinatorWrap(detachWrap as any);
    expect(h.store.getEvent(h.coordinate)).toBeUndefined();
    expect(h.store.isInstallTombstoned(h.coordinate)).toBe(true);

    // Replay the ORIGINAL gen-1 grant (config still seeded at gen 1). gen 1 ≤ the
    // high-water mark (1) → rejected, no re-install.
    const replay = wrapRumor(h.eidSk, getPublicKey(h.coordSk), {
      kind: KIND_COORDINATOR_GRANT,
      content: { v: 2, a: h.coordinate, gen: 1, inbox_nsec: bytesToHex(h.einboxSk), eck: [{ id: 1, key: bytesToBase64(h.eck) }], config_relays: ["wss://test"] },
    });
    await h.coordinator.handleCoordinatorWrap(replay as any);
    expect(h.store.getEvent(h.coordinate)).toBeUndefined();
  });

  it("startup revalidation detaches an event whose newest 31600 names another coordinator", async () => {
    const h = await setup(); // installed at gen 1, serving
    expect(h.store.getEvent(h.coordinate)).toBeDefined();
    const subsBefore = h.transport.subs.filter((s) => !s.closed).length;
    // The newest config now names a DIFFERENT coordinator (a re-point).
    const foreign = getPublicKey(generateSecretKey());
    h.transport.seed.push({
      kind: 31600, pubkey: getPublicKey(h.eidSk), created_at: 100, id: "cfg-repoint", sig: "", content: "",
      tags: [["d", "cypherpunk"], ["v", "2"], ["inbox", getPublicKey(h.einboxSk)], ["coordinator", foreign, "2"]],
    } as any);
    // Restart revalidation for this event (what start() does before resuming).
    await h.coordinator.installEvent({
      coordinate: h.coordinate, inboxSkHex: bytesToHex(h.einboxSk),
      eck: [{ id: 1, key: bytesToBase64(h.eck) }], configRelays: ["wss://test"],
      gen: 1, source: "restore",
    });
    // Detached: custody deleted (D6), tombstoned, subscriptions closed.
    expect(h.store.getEvent(h.coordinate)).toBeUndefined();
    expect(h.store.isInstallTombstoned(h.coordinate)).toBe(true);
    expect(h.transport.subs.filter((s) => s.closed).length).toBeGreaterThanOrEqual(subsBefore);
    // No longer serving: a join is a no-op.
    const { pubkey } = await joinOnly(h, generateSecretKey(), "crypto");
    expect(h.store.getAttendee(h.coordinate, pubkey)).toBeUndefined();
  });

  it("startup with an unfetchable config SUSPENDS the event (not resumed, not detached), then resumes when fetchable", async () => {
    const h = await setup();
    // Make the config unfetchable and revalidate on "restart".
    h.transport.blockConfig = true;
    await h.coordinator.installEvent({
      coordinate: h.coordinate, inboxSkHex: bytesToHex(h.einboxSk),
      eck: [{ id: 1, key: bytesToBase64(h.eck) }], configRelays: ["wss://test"],
      gen: 1, source: "restore",
    });
    // Suspended: custody RETAINED (not detached), NOT tombstoned, and NOT serving.
    expect(h.store.getEvent(h.coordinate)).toBeDefined();
    expect(h.store.isInstallTombstoned(h.coordinate)).toBe(false);
    const { pubkey } = await joinOnly(h, generateSecretKey(), "crypto");
    expect(h.store.getAttendee(h.coordinate, pubkey)).toBeUndefined(); // not resumed

    // Config becomes fetchable; advance past the backoff and retry → resumes.
    h.transport.blockConfig = false;
    h.clock.t += 60_000;
    await h.coordinator.retrySuspendedEvents();
    expect(h.store.getEvent(h.coordinate)).toBeDefined();
    // Serving again: a fresh join is processed.
    const p2 = await joinOnly(h, generateSecretKey(), "design");
    expect(h.store.getAttendee(h.coordinate, p2.pubkey)).toBeDefined();
  });

  // Regression (prod incident): after the v2 deploy the coordinator crash-looped at
  // startup because a still-installed pre-v2 event's newest 31600 carried ["v","1"];
  // parseEventConfig threw "unsupported v tag 1" out of installEvent → start() → fatal.
  it("startup restore: a stored event whose newest 31600 is v1 SUSPENDS while other v2 events restore (no crash)", async () => {
    const h = await setup(); // event A (cypherpunk, v2) installed at gen 1, in the store
    // A healthy peer B (v2) so we can prove one bad event doesn't block the others.
    const eidB = generateSecretKey();
    const inboxB = generateSecretKey();
    const { coord2, grantWrap } = grantAndSeed(h, eidB, inboxB, "healthy-peer", 1);
    await h.coordinator.handleCoordinatorWrap(grantWrap as any);
    expect(h.store.getEvent(coord2)).toBeDefined(); // B installed

    // A's newest fetchable 31600 is now a pre-v2 wire config (newer created_at wins).
    h.transport.seed.push({
      kind: 31600, pubkey: getPublicKey(h.eidSk), created_at: 100, id: "cfg-v1-restore", sig: "", content: "",
      tags: [["d", "cypherpunk"], ["v", "1"], ["inbox", getPublicKey(h.einboxSk)], ["coordinator", getPublicKey(h.coordSk), "1"]],
    } as any);

    // A fresh Coordinator on the SAME persistent store runs start() — exactly a restart.
    const restarted = new Coordinator({
      store: h.store, transport: h.transport, coordSk: h.coordSk,
      llm: new MockLlm(() => ({})), stt: new MockStt(), sttModel: "mock",
      summaryModel: { provider: "mock", model: "mock-cheap" },
      matchModel: { provider: "mock", model: "mock-strong" },
      embedModel: { provider: "mock", model: "mock-embed" },
      translateModel: { provider: "mock", model: "mock-cheap" },
      defaultRelays: ["wss://test"], sleep: async () => {}, now: () => h.clock.t,
    });
    await expect(restarted.start()).resolves.toBeUndefined(); // starts, does NOT crash

    // A: custody RETAINED — suspended, not detached, not tombstoned.
    expect(h.store.getEvent(h.coordinate)).toBeDefined();
    expect(h.store.isInstallTombstoned(h.coordinate)).toBe(false);
    // B: restored fine — the v1 event did not abort the restore loop.
    expect(h.store.getEvent(coord2)).toBeDefined();
    expect(h.store.isInstallTombstoned(coord2)).toBe(false);
  });

  it("a live 31600 update carrying ['v','1'] is ignored (not applied, not a detach), no crash", async () => {
    const h = await setup(); // serving with a v2 config, matching "on"
    // A NEWER but pre-v2 config delivered on the live subscription. It names this
    // daemon at the current gen, so if parsing didn't fail-soft it would flip
    // matching off / be applied; the pre-v2 guard must drop it BEFORE any effect.
    const v1Update = {
      kind: 31600, pubkey: getPublicKey(h.eidSk), created_at: 999, id: "cfg-live-v1", sig: "", content: "",
      tags: [["d", "cypherpunk"], ["v", "1"], ["inbox", getPublicKey(h.einboxSk)], ["coordinator", getPublicKey(h.coordSk), "1"], ["matching", "off"]],
    };
    await expect(h.coordinator.handleConfigUpdate(h.coordinate, v1Update as any)).resolves.toBeUndefined();
    // Not detached, still serving, and the stored config is UNCHANGED (still v2/on).
    expect(h.store.isInstallTombstoned(h.coordinate)).toBe(false);
    const stored = JSON.parse(h.store.getEvent(h.coordinate)!.config_json);
    expect(stored.matching).toBe("on");
  });

  it("a fresh 21603 grant whose authorizing 31600 is v1 is retryable (never installs blind), no crash", async () => {
    const h = await setup();
    const eidB = generateSecretKey();
    const inboxB = generateSecretKey();
    const coordB = makeCoordinate(getPublicKey(eidB), "v1-grant");
    // The only fetchable 31600 for this event is a pre-v2 config — unparseable, so
    // it can never authorize the grant. Same class as an unfetchable config: the
    // grant is retryable (left unseen), NOT installed, and must not crash the daemon.
    h.transport.seed.push({
      kind: 31600, pubkey: getPublicKey(eidB), created_at: 1, id: "cfg-v1-grant", sig: "", content: "",
      tags: [["d", "v1-grant"], ["v", "1"], ["inbox", getPublicKey(inboxB)], ["coordinator", getPublicKey(h.coordSk), "1"]],
    } as any);
    const grantWrap = wrapRumor(eidB, getPublicKey(h.coordSk), {
      kind: KIND_COORDINATOR_GRANT,
      content: { v: 2, a: coordB, gen: 1, inbox_nsec: bytesToHex(inboxB), eck: [{ id: 1, key: bytesToBase64(generateEck()) }], config_relays: ["wss://test"] },
    });
    await expect(h.coordinator.handleCoordinatorWrap(grantWrap as any)).resolves.toBeUndefined();
    expect(h.store.getEvent(coordB)).toBeUndefined();
  });
});

describe("audit COORD-4 — server-side media caps + empty-input skip", () => {
  it("processes a submission at the 4-media cap", async () => {
    const h = await setup();
    const sk = generateSecretKey();
    const media = [0, 1, 2, 3].map((i) => mediaDesc(100 + i, String(i).repeat(64), "video/webm"));
    const pk = await joinCustom(h, sk, "tester", ["zk"], { media });
    const d = blindedD(h.eck, h.coordinate, pk);
    const entry = latestDirectory(h.transport, h.eck, d);
    expect(entry.media).toHaveLength(4);
  });

  it("rejects a submission carrying MORE than 4 media descriptors (schema cap, v2 NIP §8)", async () => {
    // v1 sliced extras off a >4 submission; v2 caps the 21601 media array at
    // MAX_SUBMISSION_MEDIA=4 in the schema, so a 5-media submission fails to parse
    // and is dropped wholesale — no directory entry is ever published for it.
    const h = await setup();
    const sk = generateSecretKey();
    const media = [0, 1, 2, 3, 4].map((i) => mediaDesc(100 + i, String(i).repeat(64), "video/webm"));
    const pk = await joinCustom(h, sk, "tester", ["zk"], { media });
    const d = blindedD(h.eck, h.coordinate, pk);
    // The approval still publishes a directory entry, but the over-cap submission
    // never parsed, so none of its media landed on it.
    const entry = latestDirectory(h.transport, h.eck, d);
    expect(entry.media).toHaveLength(0);
  });

  it("skips transcription of media over the event's duration cap", async () => {
    // max_video_sec=90, max_talk_sec=900 → the per-descriptor cap is 900s.
    const h = await setup(0, { maxVideoSec: 90, maxTalkSec: 900 });
    const sk = generateSecretKey();
    const overLong = { ...mediaDesc(500, "1".repeat(64), "video/webm"), duration: 1000 };
    const pk = await joinCustom(h, sk, "tester", ["zk"], { media: [overLong] });
    await h.coordinator.jobs.drain();
    expect(h.stt.calls).toBe(0); // never transcribed
    const d = blindedD(h.eck, h.coordinate, pk);
    const entry = latestDirectory(h.transport, h.eck, d);
    expect(entry.transcripts ?? []).toHaveLength(0);

    // A within-cap descriptor IS transcribed.
    const sk2 = generateSecretKey();
    const ok = { ...mediaDesc(500, "2".repeat(64), "video/webm"), duration: 800 };
    await joinCustom(h, sk2, "tester2", ["ux"], { media: [ok] });
    await h.coordinator.jobs.drain();
    expect(h.stt.calls).toBe(1);
  });

  it("caps total downloaded bytes per submission at 500 MB", async () => {
    const h = await setup();
    // Each file is within the 250 MiB per-file cap (R17 follow-up); three of them
    // together exceed the 500 MiB cumulative budget so the third is dropped.
    const BIG = 200 * 1024 * 1024;
    h.stt.setTranscript(String(BIG), "big file transcript");
    const sk = generateSecretKey();
    const media = [
      mediaDesc(BIG, "a".repeat(64), "video/webm"),
      mediaDesc(BIG, "b".repeat(64), "video/webm"),
      mediaDesc(BIG, "c".repeat(64), "video/webm"), // over the cumulative budget
    ];
    await joinCustom(h, sk, "tester", ["zk"], { media });
    await h.coordinator.jobs.drain();
    expect(h.stt.calls).toBe(2); // the first two fit; the third exceeds the budget
  });

  it("skips the paid ai_profile call when ALL inputs are empty", async () => {
    const h = await setup(); // nostr_context=0
    const sk = generateSecretKey();
    const { pubkey } = await joinOnly(h, sk, "quiet attendee"); // no submission at all
    await h.coordinator.jobs.drain();
    expect(h.llm.completeCalls).toBe(0); // nothing to ground a profile in → no call
    const attendee = h.store.getAttendee(h.coordinate, pubkey)!;
    const ai = JSON.parse(attendee.ai_profile_json!);
    expect(ai).toEqual({ summary: "", skills: [], interests: [], offers: [], seeks: [] });
  });

  it("caps distinct talk submissions per speaker at 10 — editing an existing talk stays unaffected", async () => {
    const h = await setup(0, { talks: "on" });
    const speakerSk = generateSecretKey();
    const pk = await join(h, speakerSk, "crypto");
    for (let i = 0; i < 11; i++) {
      await submitTalk(h, speakerSk, {
        talkD: `t${i}`,
        title: `Talk ${i}`,
        media: talkMedia(700, i.toString(16).padStart(2, "0").repeat(32)),
      });
    }
    expect(h.store.countTalksBySpeaker(h.coordinate, pk)).toBe(10);
    expect(h.store.getTalk(h.coordinate, pk, "t10")).toBeUndefined(); // the 11th was ignored
    expect(h.store.getTalk(h.coordinate, pk, "t9")).toBeDefined();

    // Editing one of the 10 already-accepted talks is never blocked by the cap.
    await submitTalk(h, speakerSk, {
      talkD: "t0",
      title: "Talk 0 (revised)",
      media: talkMedia(700, "0".repeat(64)),
      revision: 1,
    });
    expect(h.store.countTalksBySpeaker(h.coordinate, pk)).toBe(10);
    expect(h.store.getTalk(h.coordinate, pk, "t0")!.title).toBe("Talk 0 (revised)");
  });

  it("a rejected talk frees its quota slot back up — a new submission is accepted", async () => {
    const h = await setup(0, { talks: "on" });
    const speakerSk = generateSecretKey();
    const pk = await join(h, speakerSk, "crypto");
    for (let i = 0; i < 10; i++) {
      await submitTalk(h, speakerSk, {
        talkD: `t${i}`,
        title: `Talk ${i}`,
        media: talkMedia(700, i.toString(16).padStart(2, "0").repeat(32)),
      });
    }
    expect(h.store.countTalksBySpeaker(h.coordinate, pk)).toBe(10);
    // At the cap: an 11th distinct talk is ignored.
    await submitTalk(h, speakerSk, {
      talkD: "t10",
      title: "Talk 10",
      media: talkMedia(700, "0a".repeat(32)),
    });
    expect(h.store.getTalk(h.coordinate, pk, "t10")).toBeUndefined();

    // The organizer rejects one of the 10 — that frees a slot, not a permanent lock-out.
    await admin(h, "talk_reject", { pubkey: pk, talk_d: "t0" });
    expect(h.store.countTalksBySpeaker(h.coordinate, pk)).toBe(9);

    // Distinct content from the ignored attempt above (a byte-identical
    // resubmission within the same wall-clock second would hash to the same
    // rumor id and get silently deduped — a test-harness artifact, not
    // something a real resubmission would hit).
    await submitTalk(h, speakerSk, {
      talkD: "t10",
      title: "Talk 10 (resubmitted)",
      media: talkMedia(700, "0b".repeat(32)),
    });
    expect(h.store.getTalk(h.coordinate, pk, "t10")).toBeDefined();
    expect(h.store.countTalksBySpeaker(h.coordinate, pk)).toBe(10);
  });
});

describe("audit COORD-7 — talks survive ECK rotation", () => {
  it("rotation republishes published talks under the new ECK and deletes the old-ECK copy; reject deletes at the publish-time ECK", async () => {
    const h = await setup(0, { talks: "on" });
    const speakerSk = generateSecretKey();
    const pk = await join(h, speakerSk, "crypto");
    await h.coordinator.jobs.drain();
    await submitTalk(h, speakerSk, { talkD: "t1", title: "Talk", media: talkMedia(700, "ab".repeat(32)) });
    await h.coordinator.jobs.drain();
    await admin(h, "talk_publish", { pubkey: pk, talk_d: "t1" });
    expect(publishedTalks(h)).toHaveLength(1);
    expect(h.store.getTalk(h.coordinate, pk, "t1")!.published_eck_id).toBe(1);

    // Revoke someone else → ECK rotation.
    const otherSk = generateSecretKey();
    const otherPk = await join(h, otherSk, "design");
    await admin(h, "revoke", { pubkey: otherPk });

    // The talk was republished under the NEW ECK (eck tag id 2)…
    const talkEvents = h.transport.published.filter((e) => e.kind === KIND_TALK);
    const last = talkEvents[talkEvents.length - 1]!;
    expect(last.tags.find((t) => t[0] === "eck")?.[1]).toBe("2");
    expect(h.store.getTalk(h.coordinate, pk, "t1")!.published_eck_id).toBe(2);
    // …and the OLD-ECK copy was deleted (deletion addressed at the OLD blinded d).
    const coordPub = getPublicKey(h.coordSk);
    const oldD = talkBlindedD(h.eck, h.coordinate, pk, "t1");
    expect(
      h.transport.published.some(
        (e) => e.kind === KIND_DELETION && e.tags.some((t) => t[0] === "a" && t[1] === `${KIND_TALK}:${coordPub}:${oldD}`),
      ),
    ).toBe(true);

    // A reject AFTER rotation deletes at the publish-time (new) ECK's address.
    const newEck = base64ToBytes(h.coordinator.eckOf(h.coordinate).find((v) => v.id === 2)!.key);
    const newD = talkBlindedD(newEck, h.coordinate, pk, "t1");
    await admin(h, "talk_reject", { pubkey: pk, talk_d: "t1" });
    expect(
      h.transport.published.some(
        (e) => e.kind === KIND_DELETION && e.tags.some((t) => t[0] === "a" && t[1] === `${KIND_TALK}:${coordPub}:${newD}`),
      ),
    ).toBe(true);
  });
});

describe("audit COORD-8 — relay handover re-creates subscriptions", () => {
  it("a 31600 relay change closes the old inbox sub and re-subscribes on the new relays", async () => {
    const h = await setup();
    const inboxSubsBefore = h.transport.subs.filter((s) => s.filter.kinds?.includes(1059));
    expect(inboxSubsBefore).toHaveLength(1);

    await h.coordinator.handleConfigUpdate(h.coordinate, {
      kind: 31600,
      pubkey: getPublicKey(h.eidSk),
      created_at: 2,
      id: "cfg-relays",
      tags: [
        ["d", "cypherpunk"],
        ["v", "2"],
        ["inbox", getPublicKey(h.einboxSk)],
        ["coordinator", getPublicKey(h.coordSk), "1"],
        ["relay", "wss://new.relay"],
        ["matching", "on"],
      ],
      content: "",
      sig: "",
    } as any);

    const inboxSubs = h.transport.subs.filter((s) => s.filter.kinds?.includes(1059));
    expect(inboxSubs).toHaveLength(2);
    expect(inboxSubs[0]!.closed).toBe(true); // old sub closed
    expect(inboxSubs[1]!.closed).toBe(false);
    expect(inboxSubs[1]!.relays).toEqual(["wss://new.relay"]);
  });
});

/** A minimal ChatMls stub (COORD-9 tests). */
class StubMls implements ChatMls {
  invited: string[] = [];
  removed: string[][] = [];
  failIsMember = false;
  async createGroup() {
    return { mlsGroupIdHex: "mls-1", nostrGroupIdHex: "ng-1" };
  }
  async isEligible() {
    return true;
  }
  async isMember() {
    if (this.failIsMember) throw new Error("simulated MLS outage");
    return false;
  }
  async invite(_g: string, kp: any) {
    this.invited.push(kp.pubkey);
  }
  async removePubkeys(_g: string, pks: string[]) {
    this.removed.push(pks);
  }
  async ingest() {}
  async getRelays() {
    return [];
  }
  async ensureRelays() {}
  admins: string[] = [];
  async getAdmins() {
    return this.admins;
  }
  async setAdmins(_g: string, adminPubkeys: string[]) {
    this.admins = adminPubkeys;
  }
}

describe("audit COORD-9 — MLS membership runs through the durable job runner", () => {
  it("approval enqueues chat_sync_member; the attested device is added on drain", async () => {
    const mls = new StubMls();
    const h = await setup(0, { chat: true, chatMls: mls });
    const sk = generateSecretKey();
    const pk = await join(h, sk, "crypto"); // auto-approved → job enqueued
    // P6: the account attests a device key; the DEVICE key is what gets added.
    const devicePk = getPublicKey(generateSecretKey());
    h.store.upsertChatKey({ coordinate: h.coordinate, accountPubkey: pk, chatPubkey: devicePk, now: h.clock.t });
    h.transport.seed.push({ kind: 30443, pubkey: devicePk, created_at: 1, id: "kp-1", tags: [], content: "", sig: "" } as any);
    await h.coordinator.jobs.drain();
    expect(mls.invited).toEqual([devicePk]);
  });

  it("a persistently failing sync poisons and surfaces a 21606 to the organizer", async () => {
    const mls = new StubMls();
    mls.failIsMember = true;
    const h = await setup(0, { chat: true, chatMls: mls });
    const sk = generateSecretKey();
    const pk = await join(h, sk, "crypto");
    const devicePk = getPublicKey(generateSecretKey());
    h.store.upsertChatKey({ coordinate: h.coordinate, accountPubkey: pk, chatPubkey: devicePk, now: h.clock.t });
    h.transport.seed.push({ kind: 30443, pubkey: devicePk, created_at: 1, id: "kp-1", tags: [], content: "", sig: "" } as any);
    await h.coordinator.jobs.drain(); // attempt 1 fails, long-tail backoff begins
    expect(mls.invited).toEqual([]);
    // Burn through the retry schedule (virtual clock) until the job poisons.
    for (let i = 0; i < 60 && !h.store.poisonStatuses(h.coordinate).some((p) => p.stage === "chat_sync_member"); i++) {
      h.clock.t += 4 * 60 * 60_000; // 4h per step — past every schedule backoff
      await h.coordinator.jobs.drain();
    }
    const poisoned = h.store.poisonStatuses(h.coordinate);
    expect(poisoned.some((p) => p.stage === "chat_sync_member")).toBe(true);
    // …and a 21606 status wrap went to the organizer.
    const statusWraps = h.transport.published
      .filter((e) => e.kind === 1059)
      .map((e) => {
        try {
          return unwrapRumor(e as any, h.eidSk);
        } catch {
          return null;
        }
      })
      .filter((r): r is NonNullable<typeof r> => !!r && r.kind === KIND_COORDINATOR_STATUS);
    expect(statusWraps.length).toBeGreaterThan(0);
  });

  it("revoke enqueues chat_revoke_member; the member's keys are MLS-removed on drain", async () => {
    const mls = new StubMls();
    const h = await setup(0, { chat: true, chatMls: mls });
    const sk = generateSecretKey();
    const pk = await join(h, sk, "crypto");
    await h.coordinator.jobs.drain();
    await admin(h, "revoke", { pubkey: pk });
    await h.coordinator.jobs.drain();
    expect(mls.removed).toEqual([[pk]]);
  });

  it("detach freezes the group and emits a chat-orphaned 21606 (reliability tail 6e)", async () => {
    const mls = new StubMls();
    const h = await setup(0, { chat: true, chatMls: mls });
    await join(h, generateSecretKey(), "crypto");
    await h.coordinator.jobs.drain();

    await admin(h, "detach", {});

    const status = h.transport.published
      .filter((e) => e.kind === 1059)
      .map((e) => { try { return unwrapRumor(e as any, h.eidSk); } catch { return null; } })
      .filter((r): r is NonNullable<typeof r> => !!r && r.kind === KIND_COORDINATOR_STATUS)
      .map((r) => coordinatorStatusContentSchema.parse(JSON.parse(r.content)))
      .find((s) => s.error_category === "chat_orphaned_on_detach");
    expect(status).toBeDefined();
    expect(status!.retryable).toBe(false);
    // The event is fully detached (custody deleted).
    expect(h.store.getEvent(h.coordinate)).toBeUndefined();
  });
});

describe("audit COORD-11 — rumor freshness + coordinator-inbox backfill", () => {
  it("drops a rumor future-dated > 15 min past the coordinator's clock", async () => {
    const h = await setup();
    const sk = generateSecretKey();
    // The protocol layer clamps a future-dated rumor to wall-now+15min (PROTO-8);
    // the coordinator re-checks against its OWN clock at ingestion (defense in
    // depth). With the daemon clock 1h behind the wall clock, a fresh rumor
    // (real-time stamped) is >15 min ahead of it → dropped with a log.
    h.clock.t = Date.now() - 60 * 60_000;
    const { pubkey } = await joinOnly(h, sk, "future");
    expect(h.store.getAttendee(h.coordinate, pubkey)).toBeUndefined(); // dropped
  });

  it("startup backfills the coordinator inbox's FULL history (since=0)", async () => {
    const coordSk = generateSecretKey();
    const coordPub = getPublicKey(coordSk);
    const eidSk = generateSecretKey();
    const eidPub = getPublicKey(eidSk);
    const einboxSk = generateSecretKey();
    const coordinate = makeCoordinate(eidPub, "backfilled-event");
    const store = new Store(":memory:", coordSk);
    const transport = new FakeTransport();
    // A grant "sent during the outage" — only a since=0 fetch would see it.
    transport.seed.push(
      wrapRumor(eidSk, coordPub, {
        kind: KIND_COORDINATOR_GRANT,
        content: {
          v: 2,
          a: coordinate,
          gen: 1,
          inbox_nsec: bytesToHex(einboxSk),
          eck: [{ id: 1, key: bytesToBase64(generateEck()) }],
          config_relays: [],
        },
      }) as any,
    );
    // Authorizing 31600 for the backfilled grant install (P0-4).
    transport.seed.push({
      kind: 31600,
      pubkey: eidPub,
      created_at: 1,
      id: "cfg-backfilled",
      sig: "",
      content: "",
      tags: [
        ["d", "backfilled-event"],
        ["v", "2"],
        ["inbox", getPublicKey(einboxSk)],
        ["coordinator", coordPub, "1"],
      ],
    } as any);
    const coordinator = new Coordinator({
      store,
      transport,
      coordSk,
      llm: new MockLlm(() => ({})),
      stt: new MockStt(),
      sttModel: "mock",
      summaryModel: { provider: "mock", model: "mock-cheap" },
      matchModel: { provider: "mock", model: "mock-strong" },
      embedModel: { provider: "mock", model: "mock-embed" },
      translateModel: { provider: "mock", model: "mock-cheap" },
      defaultRelays: ["wss://test"],
      sleep: async () => {},
    });
    await coordinator.start();
    expect(store.getEvent(coordinate)).toBeDefined(); // the backfilled grant installed
  });
});

describe("audit COORD-12 — publish-boundary output hygiene", () => {
  it("match-list reasoning is URL-neutralized and capped at 2000 chars", async () => {
    const h = await setup();
    const aSk = generateSecretKey();
    const bSk = generateSecretKey();
    const aPk = await join(h, aSk, "crypto");
    const bPk = await join(h, bSk, "design");
    await h.coordinator.jobs.drain(); // let the real pipeline finish first
    // Now plant a pair whose stored reasoning carries an injected link + oversized
    // text — the publish boundary must sanitize it (the store is the LLM's output
    // cache; poisoning it simulates a successful prompt injection).
    h.store.putPair({
      coordinate: h.coordinate,
      a: aPk,
      b: bPk,
      inputsHash: "h1",
      score: 0.99,
      similarity: 0.5,
      complementarity: 0.9,
      reasoningForA: `Meet them! https://evil.example/phish ${"x".repeat(3000)}`,
      reasoningForB: "ok",
      now: 1,
    });
    h.coordinator.jobs.enqueue("publish_matches", "pub-hygiene", { coordinate: h.coordinate, pubkey: aPk });
    await h.coordinator.jobs.drain();
    const cryptoD = blindedD(h.eck, h.coordinate, aPk);
    const listEvent = h.transport.published
      .filter((e) => e.kind === KIND_MATCH_LIST && e.tags.find((t) => t[0] === "d")?.[1] === cryptoD)
      .at(-1)!;
    const list = matchListContentSchema.parse(JSON.parse(nip44Decrypt(aSk, getPublicKey(h.coordSk), listEvent.content)));
    expect(list.matches[0]!.reasoning).not.toContain("https://");
    expect(list.matches[0]!.reasoning).toContain("evil.example"); // readable, unclickable
    expect(list.matches[0]!.reasoning.length).toBeLessThanOrEqual(2000);
  });

  it("the published ai_profile is URL-neutralized at the directory boundary", async () => {
    const h = await setup();
    const sk = generateSecretKey();
    const pk = await join(h, sk, "crypto");
    // Store a (fresh) ai_profile carrying an injected link, then re-publish via a correction.
    const attendee = h.store.getAttendee(h.coordinate, pk)!;
    h.store.upsertAttendee({
      coordinate: h.coordinate,
      pubkey: pk,
      aiProfileJson: JSON.stringify({
        summary: "see https://evil.example for my portfolio",
        skills: ["zk"],
        interests: [],
        offers: [],
        seeks: [],
      }),
      aiSourceRevision: attendee.source_revision,
      now: h.clock.t,
    });
    const wrap = wrapRumor(sk, getPublicKey(h.einboxSk), {
      kind: KIND_PROFILE_CORRECTION,
      content: { v: 2, a: h.coordinate, rev: 0 },
      tags: [["a", h.coordinate]],
    });
    await h.coordinator.handleInboxWrap(h.coordinate, wrap as any);
    const d = blindedD(h.eck, h.coordinate, pk);
    const entry = latestDirectory(h.transport, h.eck, d);
    expect(entry.ai_profile?.summary).toBe("see evil.example for my portfolio");
  });
});

describe("audit COORD-13 — roster embeddings are cached by profile hash + model", () => {
  it("a second recompute with unchanged profiles re-embeds nothing", async () => {
    const h = await setup(0, { prefilter: { threshold: 1, topM: 5, randomN: 1 } });
    const aSk = generateSecretKey();
    const aPk = await join(h, aSk, "crypto");
    await join(h, generateSecretKey(), "design");
    await h.coordinator.jobs.drain();
    const callsAfterFirst = h.llm.embedCalls;
    expect(callsAfterFirst).toBeGreaterThan(0); // prefilter kicked in (roster > threshold)

    h.coordinator.jobs.enqueue("match_recompute", "re-embed-check", { coordinate: h.coordinate, pubkey: aPk });
    await h.coordinator.jobs.drain();
    expect(h.llm.embedCalls).toBe(callsAfterFirst); // all embeddings came from the cache
  });
});

describe("H-1 — per-role provider routing (§12 item 7)", () => {
  function schemasOf(llm: MockLlm): Set<string> {
    return new Set(llm.requests.map((r) => r.schemaName));
  }

  it("each role's provider call lands on its OWN instance, none on the other", async () => {
    // nostr_context>0 so the summary role runs; lang!=en so translate runs; a low
    // prefilter threshold so the embed role runs; ai_profile + batch_score are match.
    const h = await setup(3, { splitProviders: true, lang: "sk", prefilter: { threshold: 1, topM: 5, randomN: 1 } });
    const aSk = generateSecretKey();
    h.transport.seed.push({ kind: 1, pubkey: getPublicKey(aSk), created_at: 11, tags: [], content: "zk musings", id: "post-a", sig: "" } as any);
    await join(h, aSk, "crypto");
    await join(h, generateSecretKey(), "design");
    await h.coordinator.jobs.drain();

    // provA = summary + translate.
    const a = schemasOf(h.llmA!);
    expect(a.has("nostr_summary")).toBe(true);
    expect(a.has("profile_translation")).toBe(true);
    expect(a.has("ai_profile")).toBe(false);
    expect(a.has("batch_score")).toBe(false);

    // provB = match (ai_profile + batch scoring) + embed.
    const b = schemasOf(h.llmB!);
    expect(b.has("ai_profile")).toBe(true);
    expect([...b].some((s) => s.includes("batch_score"))).toBe(true);
    expect(b.has("nostr_summary")).toBe(false);
    expect(b.has("profile_translation")).toBe(false);
    expect(h.llmB!.embedCalls).toBeGreaterThan(0); // embed role ran on provB
    expect(h.llmA!.embedCalls).toBe(0);
  });

  it("a one-provider outage on the match instance does not disable the summary/translate roles", async () => {
    const h = await setup(3, { splitProviders: true, lang: "sk", prefilter: { threshold: 100, topM: 5, randomN: 1 } });
    // Make the MATCH/EMBED provider (provB) fail every completion — ai_profile can't
    // be built — but the summary+translate provider (provA) must still be reachable
    // and its stages must still be exercised for the attendee.
    (h.llmB as any).completeStructured = async () => {
      throw new Error("provB provider outage");
    };
    const aSk = generateSecretKey();
    h.transport.seed.push({ kind: 1, pubkey: getPublicKey(aSk), created_at: 11, tags: [], content: "zk musings", id: "post-b", sig: "" } as any);
    await join(h, aSk, "crypto");
    await h.coordinator.jobs.drain();
    // provA still served its roles despite provB being down.
    expect(h.llmA!.completeCalls).toBeGreaterThan(0);
    expect(schemasOf(h.llmA!).has("nostr_summary")).toBe(true);
  });
});

describe("H-1 — provider/model change invalidates affected cached artifacts (§12 item 7)", () => {
  it("re-routing the summary role to a new model recomputes the summary (not cache-reused)", async () => {
    // The nostr-summary cache keys on the summary provider/model; a role reroute
    // must not silently reuse a summary produced by the previous model.
    const { nostrInputsHash } = await import("./pipeline/profile.js");
    const k1 = nostrInputsHash("pk", [{ kind: 1, content: "gm", created_at: 1 }], "en", "venice:sum-a");
    const k2 = nostrInputsHash("pk", [{ kind: 1, content: "gm", created_at: 1 }], "en", "venice:sum-b");
    expect(k1).not.toBe(k2);
  });
});

describe("D5 §9 — persisted billing state machine (§13.4)", () => {
  const overTier = (reason = "over free tier"): (eid: string, count: number) => any =>
    (_eid, count) => (count >= 1 ? { state: "payment_required", reason, checkout_url: "https://pay/x" } : { state: "ok" });

  it("a blocked event parks paid work (no provider spend) but still admits + publishes status", async () => {
    const h = await setup(0, { evaluateBilling: overTier() });
    const aPk = await join(h, generateSecretKey(), "crypto");
    await h.coordinator.jobs.drain();

    // No STT / LLM spend happened — the paid pipeline is parked, not run.
    expect(h.llm.completeCalls).toBe(0);
    expect(h.stt.calls).toBe(0);
    expect(h.store.waitingJobCount(h.coordinate)).toBeGreaterThan(0);
    // State persisted as blocked with the typed EID principal.
    const bs = h.store.getBillingState(h.coordinate)!;
    expect(bs.state).toBe("blocked");
    expect(bs.principal_kind).toBe("eid");
    expect(bs.principal_id).toBe(getPublicKey(h.eidSk));
    // BUT admission still happened: the attendee's directory entry was published.
    const d = blindedD(h.eck, h.coordinate, aPk);
    expect(latestDirectory(h.transport, h.eck, d)).toBeDefined();
    // And a 21606 billing status (payment_required on the wire) was gift-wrapped.
    const s = lastCoordinatorStatus(h);
    expect(s?.billing?.state).toBe("payment_required");
    expect(s?.billing?.checkout_url).toBe("https://pay/x");
  });

  it("revoke, detach and roster/status paths are NOT blocked by billing", async () => {
    const h = await setup(0, { evaluateBilling: overTier() });
    const aSk = generateSecretKey();
    const bSk = generateSecretKey();
    const aPk = await join(h, aSk, "crypto");
    const bPk = await join(h, bSk, "design");
    await h.coordinator.jobs.drain();
    expect(h.store.getBillingState(h.coordinate)?.state).toBe("blocked");
    const rosterBefore = h.transport.published.filter((e) => e.kind === 31604).length;

    // Revoke b — must succeed (roster republished) even while billing is blocked.
    await admin(h, "revoke", { pubkey: bPk });
    await h.coordinator.jobs.drain();
    expect(h.store.getAttendee(h.coordinate, bPk)?.status).toBe("revoked");
    expect(h.transport.published.filter((e) => e.kind === 31604).length).toBeGreaterThan(rosterBefore);
    void aPk;
  });

  it("unblocking (payment resolved) via organizer recompute resumes parked work and it then spends", async () => {
    let over = true;
    const h = await setup(0, {
      evaluateBilling: (_eid, count) => (over && count >= 1 ? { state: "payment_required", reason: "x" } : { state: "ok" }),
    });
    await join(h, generateSecretKey(), "crypto");
    await h.coordinator.jobs.drain();
    expect(h.store.getBillingState(h.coordinate)?.state).toBe("blocked");
    expect(h.llm.completeCalls).toBe(0);
    expect(h.store.waitingJobCount(h.coordinate)).toBeGreaterThan(0);

    // Payment resolved (operator lifts the block) → organizer recompute re-evaluates,
    // transitions blocked→ok, re-enqueues the parked work, which now runs and spends.
    over = false;
    await admin(h, "recompute", {});
    await h.coordinator.jobs.drain();
    expect(h.store.getBillingState(h.coordinate)?.state).toBe("ok");
    expect(h.store.waitingJobCount(h.coordinate)).toBe(0);
    expect(h.llm.completeCalls).toBeGreaterThan(0);
  });

  it("billing state persists across a coordinator restart", async () => {
    const h = await setup(0, { evaluateBilling: overTier() });
    await join(h, generateSecretKey(), "crypto");
    await h.coordinator.jobs.drain();
    expect(h.store.getBillingState(h.coordinate)?.state).toBe("blocked");

    // A brand-new Coordinator over the SAME store reads the persisted blocked state.
    const restarted = new Coordinator({
      store: h.store,
      transport: h.transport,
      coordSk: h.coordSk,
      llm: h.llm,
      stt: h.stt,
      sttModel: "mock",
      summaryModel: { provider: "mock", model: "mock-cheap" },
      matchModel: { provider: "mock", model: "mock-strong" },
      embedModel: { provider: "mock", model: "mock-embed" },
      translateModel: { provider: "mock", model: "mock-cheap" },
      defaultRelays: ["wss://test"],
      evaluateBilling: overTier(),
      now: () => h.clock.t,
      sleep: async () => {},
    });
    void restarted;
    expect(h.store.getBillingState(h.coordinate)?.state).toBe("blocked");
  });

  it("a grace window keeps paid work running until it elapses, then blocks", async () => {
    const h = await setup(0, {
      evaluateBilling: (_eid, count) => (count >= 1 ? { state: "payment_required", reason: "grace me" } : { state: "ok" }),
      billingGracePeriodSec: 3600,
    });
    await join(h, generateSecretKey(), "crypto");
    // During grace, the state is 'grace' and paid work is NOT parked.
    expect(h.store.getBillingState(h.coordinate)?.state).toBe("grace");
    await h.coordinator.jobs.drain();
    expect(h.llm.completeCalls).toBeGreaterThan(0); // spent during grace
    expect(h.store.waitingJobCount(h.coordinate)).toBe(0);

    // Advance past the grace window → next evaluation blocks.
    h.clock.t += 3600_000 + 1000;
    await admin(h, "recompute", {});
    await h.coordinator.jobs.drain();
    expect(h.store.getBillingState(h.coordinate)?.state).toBe("blocked");
  });
});

describe("H-2 §8 — usage budgets gate paid processing", () => {
  const generous = {
    perAttendeeBytes: 0,
    perEventBytes: 0,
    perAttendeeDurationSec: 0,
    perEventDurationSec: 0,
    perAttendeeCalls: 0,
    perEventCalls: 0,
  };

  it("exceeding a per-attendee call budget parks further paid work + emits budget_exceeded; a raise resumes it", async () => {
    // perAttendeeCalls = 1: the first paid job (process_attendee) consumes the one
    // allowed call, so the downstream match stage exceeds and parks.
    const budgets = { ...generous, perAttendeeCalls: 1 };
    const h = await setup(0, { budgets });
    await join(h, generateSecretKey(), "crypto");
    await join(h, generateSecretKey(), "design"); // a candidate so matching has pairs
    await h.coordinator.jobs.drain();

    // Paid work was parked once the attendee call budget was hit.
    expect(h.store.waitingJobCount(h.coordinate)).toBeGreaterThan(0);
    // A 21606 budget_exceeded status was gift-wrapped to the organizer.
    const s = lastCoordinatorStatus(h);
    expect(s?.error_category).toBe("budget_exceeded");
    expect(s?.billing?.state).toBe("payment_required");

    // Raise the budget (config reload) + organizer recompute → parked work resumes.
    budgets.perAttendeeCalls = 10_000;
    await admin(h, "recompute", {});
    await h.coordinator.jobs.drain();
    expect(h.store.waitingJobCount(h.coordinate)).toBe(0);
  });

  it("actual downloaded bytes (not declared size) accrue to the per-attendee budget", async () => {
    // A tiny per-attendee byte budget: the injected transcribe accounts real bytes.
    const h = await setup(0, { budgets: { ...generous } });
    const aPk = await join(h, generateSecretKey(), "crypto");
    await h.coordinator.jobs.drain();
    // The harness transcribe injection doesn't route through transcribeMedia's
    // accounting, so per-attendee call accounting is what we can assert here: the
    // process job spent, recording ≥ 1 call.
    expect(h.store.getUsage(h.coordinate, aPk).calls).toBeGreaterThanOrEqual(1);
  });
});

describe("R17 follow-up — per-file media cap (consistent with the app's 250 MiB bound)", () => {
  const MiB = 1024 * 1024;
  const mk = (sha: string, sizeBytes: number) =>
    ({ size: sizeBytes, duration: 10, url: [], sha256: sha.repeat(64), mime: "video/mp4" }) as any;

  it("rejects a single descriptor over the 250 MiB per-file cap, keeps in-cap files", async () => {
    const h = await setup();
    const state = { maxMediaSec: 900 } as any;
    const out = (h.coordinator as any).capMedia(state, "pk", [mk("a", 100 * MiB), mk("b", 300 * MiB)]);
    // The 300 MiB file (which the app would refuse to upload/play) is dropped; the
    // 100 MiB one is kept — no confusing late aggregate-only failure.
    expect(out).toHaveLength(1);
    expect(out[0].sha256).toBe("a".repeat(64));
  });

  it("still enforces the 500 MiB aggregate across multiple in-cap files", async () => {
    const h = await setup();
    const state = { maxMediaSec: 900 } as any;
    // Three 250 MiB files each pass the per-file cap; the aggregate budget fits two,
    // the third overflows and is dropped (the R17 scenario, now bounded predictably).
    const out = (h.coordinator as any).capMedia(state, "pk", [
      mk("a", 250 * MiB),
      mk("b", 250 * MiB),
      mk("c", 250 * MiB),
    ]);
    expect(out).toHaveLength(2);
  });
});

describe("H-2 — superseded revisions coalesce pending jobs (no pay for stale rev)", () => {
  function pendingProcessJobs(h: Harness, pubkey: string): string[] {
    return ((h.store as any).db
      .prepare("SELECT dedupe_key FROM jobs WHERE type = 'process_attendee' AND state IN ('pending','waiting') AND dedupe_key LIKE ?")
      .all(`proc:${h.coordinate}:${pubkey}:%`) as { dedupe_key: string }[]).map((r) => r.dedupe_key);
  }

  it("a new submission cancels the older revision's still-pending process job", async () => {
    const h = await setup();
    const aSk = generateSecretKey();
    const aPk = getPublicKey(aSk);
    // Join (enqueues a process job for rev 0) — do NOT drain yet.
    await join(h, aSk, "crypto");
    const before = pendingProcessJobs(h, aPk);
    expect(before.length).toBe(1);

    // A NEW submission (different intro → different profile_json → new dedupe key)
    // must supersede the older pending job, not stack a second one.
    await resubmitIntro(h, aSk, "crypto");
    const after = pendingProcessJobs(h, aPk);
    expect(after.length).toBe(1); // exactly one — the stale rev's job was cancelled
    expect(after[0]).not.toBe(before[0]); // and it's the NEW revision's key
  });
});

describe("audit COORD-14 — install picks the newest 31600", () => {
  it("a newer 31600 wins over an older one regardless of fetch order", async () => {
    const h = await setup(0, {
      // A NEWER config (created_at 2 > the default seed's 1) with matching OFF. It
      // still names THIS coordinator at gen 1 (like the default seed) — otherwise the
      // install has no authority to run at all; the point under test is that the
      // NEWEST revision's matching=off is what takes effect, not the older seed's on.
      extraSeed: ({ eidPubkey, d, coordPubkey, inboxPubkey }) => [
        {
          kind: 31600,
          pubkey: eidPubkey,
          created_at: 2,
          id: "e2-newer",
          sig: "",
          content: "",
          tags: [["d", d], ["v", "2"], ["inbox", inboxPubkey], ["matching", "off"], ["coordinator", coordPubkey, "1"]],
        } as any,
      ],
    });
    const sk = generateSecretKey();
    await join(h, sk, "crypto");
    await h.coordinator.jobs.drain();
    // matching=off won → no AI pipeline ran at all.
    expect(h.llm.completeCalls).toBe(0);
  });
});

describe("audit COORD-15 — poison status clears on later success", () => {
  it("a successful pipeline run clears the attendee's recorded poison status", async () => {
    const h = await setup();
    const sk = generateSecretKey();
    const pk = await join(h, sk, "crypto");
    h.store.recordJobStatus({
      coordinate: h.coordinate,
      stage: "process_attendee",
      pubkey: pk,
      state: "poison",
      attempts: 5,
      error_category: "media_fetch",
      retryable: 1,
      updated_at: 1,
    });
    expect(h.store.poisonStatuses(h.coordinate)).toHaveLength(1);
    await h.coordinator.jobs.drain(); // the pipeline succeeds
    expect(h.store.poisonStatuses(h.coordinate)).toHaveLength(0);
  });
});

describe("audit COORD-28 — talk jobs re-check talks mode at execution", () => {
  it("a queued process_talk job runs no STT after talks are turned off", async () => {
    const h = await setup(0, { talks: "on" });
    const sk = generateSecretKey();
    const pk = await join(h, sk, "crypto");
    await h.coordinator.jobs.drain(); // intro processed; baseline
    const sttBaseline = h.stt.calls;
    await submitTalk(h, sk, { talkD: "t1", title: "Talk", media: talkMedia(700, "9a".repeat(32)) });
    // Talks turned OFF before the queued job runs.
    await h.coordinator.handleConfigUpdate(h.coordinate, {
      kind: 31600,
      pubkey: getPublicKey(h.eidSk),
      created_at: 2,
      id: "cfg-talks-off",
      tags: [["d", "cypherpunk"], ["v", "2"], ["inbox", getPublicKey(h.einboxSk)], ["matching", "on"]],
      content: "",
      sig: "",
    } as any);
    await h.coordinator.jobs.drain();
    expect(h.stt.calls).toBe(sttBaseline); // no paid STT for the queued talk
    expect(h.store.getTalk(h.coordinate, pk, "t1")!.transcript_json).toBeNull();
  });
});

describe("audit COORD-29 — invite hashes are cached per event", () => {
  it("joins reuse the cached 31601; a new 31601 on the config sub invalidates it", async () => {
    const h = await setup();
    const inviteFetches = () => h.transport.fetches.filter((f) => f.kinds?.includes(31601)).length;
    await join(h, generateSecretKey(), "crypto");
    await join(h, generateSecretKey(), "design");
    expect(inviteFetches()).toBe(1); // the second join hit the cache

    // A new invite list arrives on the config subscription → cache invalidated.
    const configSub = h.transport.subs.find((s) => s.filter.kinds?.includes(31600))!;
    configSub.onEvent({
      kind: 31601,
      pubkey: getPublicKey(h.eidSk),
      created_at: 2,
      id: "inv-2",
      tags: [["d", "cypherpunk"]],
      content: "{}",
      sig: "",
    } as any);
    await join(h, generateSecretKey(), "code");
    expect(inviteFetches()).toBe(2); // refetched after invalidation
  });

  it("a code that isn't in the cached hash set gets ONE bypass re-fetch before falling to the manual queue", async () => {
    // Reproduces the reported gap: an organizer generates a fresh invite code
    // and hands it out immediately. The coordinator's cache was already primed
    // (by an earlier join) with the OLD hash set, and — unlike the test above —
    // the new 31601's arrival is NOT delivered through the config subscription
    // (relay propagation lag, or a relay the invalidating publish never
    // reached). Without the fix this attendee is wrongly queued for manual
    // approval despite holding a genuinely valid, freshly-generated code.
    const h = await setup();
    const inviteFetches = () => h.transport.fetches.filter((f) => f.kinds?.includes(31601)).length;

    // Prime the cache with the original 6-invite set.
    await join(h, generateSecretKey(), "crypto");
    expect(inviteFetches()).toBe(1);

    // A NEW invite code, published straight to the relay (as the app really
    // does) but WITHOUT going through the config subscription the cache
    // listens on — exactly the propagation/never-delivered gap.
    const freshInviteSk = generateSecretKey();
    h.transport.published.push({
      kind: 31601,
      pubkey: getPublicKey(h.eidSk),
      created_at: 2,
      id: "inv-fresh",
      tags: [["d", "cypherpunk"]],
      content: JSON.stringify({
        v: 2,
        invites: [...h.invites, freshInviteSk].map((sk) => ({ h: inviteHash(getPublicKey(sk)) })),
      }),
      sig: "",
    } as any);

    const attendeeSk = generateSecretKey();
    const attendeePubkey = getPublicKey(attendeeSk);
    const proof = makeInviteProof(freshInviteSk, h.coordinate, attendeePubkey);
    const inboxPk = getPublicKey(h.einboxSk);
    await h.coordinator.handleInboxWrap(
      h.coordinate,
      wrapRumor(attendeeSk, inboxPk, {
        kind: KIND_JOIN_REQUEST,
        content: { v: 2, name: "fresh-code-holder", message: "", rsvp_public: false },
        tags: [["a", h.coordinate], ["invite", getPublicKey(freshInviteSk), proof.sig]],
      }) as any,
    );

    const attendee = h.store.getAttendee(h.coordinate, attendeePubkey);
    expect(attendee?.status).toBe("approved"); // NOT stuck in manual queue
    expect(inviteFetches()).toBe(2); // exactly one bypass re-fetch, not a fetch storm
  });

  it("does NOT retry when there's simply no invite code, or the code was already used", async () => {
    // The bypass exists to rescue a genuinely valid code the cache hasn't
    // caught up to yet — it must not paper over "no code presented" or
    // "single-use code already claimed", where a re-fetch changes nothing and
    // would just be a wasted relay round-trip on every such join.
    const h = await setup();
    const inviteFetches = () => h.transport.fetches.filter((f) => f.kinds?.includes(31601)).length;

    await join(h, generateSecretKey(), "crypto"); // primes the cache (valid code)
    expect(inviteFetches()).toBe(1);

    // A raw join with NO invite tag at all.
    const attendeeSk = generateSecretKey();
    const inboxPk = getPublicKey(h.einboxSk);
    await h.coordinator.handleInboxWrap(
      h.coordinate,
      wrapRumor(attendeeSk, inboxPk, {
        kind: KIND_JOIN_REQUEST,
        content: { v: 2, name: "no code", message: "", rsvp_public: false },
        tags: [["a", h.coordinate]], // no ["invite", ...] tag
      }) as any,
    );
    expect(h.store.getAttendee(h.coordinate, getPublicKey(attendeeSk))?.status).toBe("pending");
    expect(inviteFetches()).toBe(1); // still cache-only — no pointless retry

    // A valid code, used twice.
    const reuseSk = generateSecretKey();
    await join(h, reuseSk, "design"); // consumes h.invites[1]
    const beforeSecondAttempt = inviteFetches();
    const secondAttendeeSk = generateSecretKey();
    const secondPubkey = getPublicKey(secondAttendeeSk);
    const dupeInviteSk = h.invites[1]!; // same code as `reuseSk` just claimed
    const dupeProof = makeInviteProof(dupeInviteSk, h.coordinate, secondPubkey);
    await h.coordinator.handleInboxWrap(
      h.coordinate,
      wrapRumor(secondAttendeeSk, inboxPk, {
        kind: KIND_JOIN_REQUEST,
        content: { v: 2, name: "reused code", message: "", rsvp_public: false },
        tags: [["a", h.coordinate], ["invite", getPublicKey(dupeInviteSk), dupeProof.sig]],
      }) as any,
    );
    expect(h.store.getAttendee(h.coordinate, secondPubkey)?.status).toBe("pending");
    expect(inviteFetches()).toBe(beforeSecondAttempt); // still no pointless retry
  });
});

describe("audit APPK-3 — roster advertises this event's MLS group id", () => {
  it("publishes nostr_group_id on the roster once the event has an active MLS group", async () => {
    const h = await setup(0, { chat: true });
    const pubkey = await join(h, generateSecretKey(), "crypto");
    // The coordinator's authoritative event→group binding (marmot_groups): a member
    // holding two same-coordinator events' groups cannot tell them apart from an MLS
    // Welcome alone, so the routing id is surfaced on the member-only, ECK roster.
    const gid = "a".repeat(64);
    h.store.upsertMarmotGroup({
      coordinate: h.coordinate,
      mlsGroupId: "b".repeat(64),
      nostrGroupId: gid,
      status: "active",
      now: h.clock.t,
    });

    await admin(h, "approve", { pubkey });

    const rosters = h.transport.published.filter((e) => e.kind === 31604);
    const latest = rosters[rosters.length - 1]!;
    const roster = rosterContentSchema.parse(JSON.parse(eckDecrypt(h.eck, latest.content)));
    expect(roster.nostr_group_id).toBe(gid);
  });

  it("omits nostr_group_id when the event has no MLS group (chat off / not yet created)", async () => {
    const h = await setup();
    const pubkey = await join(h, generateSecretKey(), "crypto");

    await admin(h, "approve", { pubkey });

    const rosters = h.transport.published.filter((e) => e.kind === 31604);
    const latest = rosters[rosters.length - 1]!;
    const roster = rosterContentSchema.parse(JSON.parse(eckDecrypt(h.eck, latest.content)));
    expect(roster.nostr_group_id).toBeUndefined();
  });

  it("omits the id for a FROZEN group — members must no longer route there (§9 Q4)", async () => {
    const h = await setup(0, { chat: true });
    const pubkey = await join(h, generateSecretKey(), "crypto");
    h.store.upsertMarmotGroup({
      coordinate: h.coordinate,
      mlsGroupId: "b".repeat(64),
      nostrGroupId: "a".repeat(64),
      status: "frozen",
      now: h.clock.t,
    });

    await admin(h, "approve", { pubkey });

    const rosters = h.transport.published.filter((e) => e.kind === 31604);
    const latest = rosters[rosters.length - 1]!;
    const roster = rosterContentSchema.parse(JSON.parse(eckDecrypt(h.eck, latest.content)));
    expect(roster.nostr_group_id).toBeUndefined();
  });
});

// ── reliability tail — replaced-publish reconciliation (NIP §3.1/§3.2) ───────
describe("reliability tail — replaced-publish reconciliation", () => {
  it("republishes ours when the relay's competing event is OLDER (ours supersedes)", async () => {
    const h = await setup();
    const identifier = h.coordinate.split(":").slice(2).join(":");
    const rosterAddr = `31604:${identifier}`;
    // The relay holds an OLDER competing roster and answers the next publish "replaced".
    h.transport.seed.push({
      kind: 31604, pubkey: getPublicKey(h.coordSk), created_at: 1, id: "old-roster", sig: "", content: "x",
      tags: [["d", identifier]],
    } as any);
    h.transport.replacedAddresses.add(rosterAddr);

    await join(h, generateSecretKey(), "crypto");
    await h.coordinator.jobs.drain();

    // The first roster publish was rejected as "replaced", but reconcile found the
    // relay's version older and REPUBLISHED ours — so our roster is stored after all.
    const ours = h.transport.published.filter((e) => e.kind === 31604 && e.pubkey === getPublicKey(h.coordSk));
    expect(ours.length).toBeGreaterThan(0);
  });

  it("adopts the relay's competing event when it SUPERSEDES ours (no clobber)", async () => {
    const h = await setup();
    const identifier = h.coordinate.split(":").slice(2).join(":");
    const rosterAddr = `31604:${identifier}`;
    const future = Math.floor(h.clock.t / 1000) + 1_000_000;
    // The relay holds a FAR-NEWER competing roster and answers the next publish "replaced".
    h.transport.seed.push({
      kind: 31604, pubkey: getPublicKey(h.coordSk), created_at: future, id: "future-roster", sig: "", content: "x",
      tags: [["d", identifier]],
    } as any);
    h.transport.replacedAddresses.add(rosterAddr);

    await join(h, generateSecretKey(), "crypto");
    await h.coordinator.jobs.drain();

    // Reconcile ADOPTED the newer roster — the coordinator never republished a roster
    // that would clobber it (nothing at/after the competitor's timestamp was stored).
    const clobbering = h.transport.published.filter(
      (e) => e.kind === 31604 && e.pubkey === getPublicKey(h.coordSk) && (e.created_at ?? 0) >= future,
    );
    expect(clobbering.length).toBe(0);
  });
});

// ── NIP §3.7 — coordinator handover (A → B) ──────────────────────────────────
/** Build a SECOND coordinator (fresh key + store) sharing coordinator A's transport,
 *  so a detach/replace handover can be exercised end-to-end. */
function secondCoordinator(h: Harness, coordSkB: Uint8Array): { coordinator: Coordinator; store: Store } {
  const storeB = new Store(":memory:", coordSkB);
  const coordinator = new Coordinator({
    store: storeB,
    transport: h.transport,
    coordSk: coordSkB,
    stt: h.stt,
    llm: h.llm,
    summaryModel: { provider: "mock", model: "mock-cheap" },
    matchModel: { provider: "mock", model: "mock-strong" },
    embedModel: { provider: "mock", model: "mock-embed" },
    translateModel: { provider: "mock", model: "mock-cheap" },
    sttModel: "mock",
    defaultRelays: ["wss://test"],
    now: () => h.clock.t,
    sleep: async () => {},
    transcribe: async (descriptor) => {
      const cached = storeB.getTranscript(descriptor.x);
      if (cached !== undefined) return cached;
      const { text } = await h.stt.transcribe({ data: new Uint8Array(descriptor.size), mime: "audio/ogg" });
      storeB.putTranscript(descriptor.x, text, 1);
      return text;
    },
  });
  return { coordinator, store: storeB };
}

describe("NIP §3.7 — coordinator handover (A → B convergence)", () => {
  it("a replacement coordinator republishes a complete directory/roster under its own key", async () => {
    // Coordinator A installs + processes two invite-approved attendees.
    const h = await setup();
    const aliceSk = generateSecretKey();
    const bobSk = generateSecretKey();
    const alicePk = await join(h, aliceSk, "crypto");
    const bobPk = await join(h, bobSk, "design");
    await h.coordinator.jobs.drain();
    // A published a roster + directory entries under A's key.
    expect(h.transport.published.some((e) => e.kind === KIND_ROSTER && e.pubkey === getPublicKey(h.coordSk))).toBe(true);

    // The organizer replaces A with B: a NEWER 31600 names B at gen 2 (same E_inbox
    // + same ECK granted to B, so B can decrypt A's still-published records).
    const identifier = h.coordinate.split(":").slice(2).join(":");
    const coordSkB = generateSecretKey();
    const coordPkB = getPublicKey(coordSkB);
    h.transport.seed.push({
      kind: 31600, pubkey: getPublicKey(h.eidSk), created_at: 2, id: "cfg-b", sig: "", content: "",
      tags: [["d", identifier], ["v", "2"], ["inbox", getPublicKey(h.einboxSk)], ["matching", "on"], ["coordinator", coordPkB, "2"]],
    } as any);

    // Install B as a fresh grant at gen 2 → runs the handover bootstrap.
    const { coordinator: coordB, store: storeB } = secondCoordinator(h, coordSkB);
    await coordB.installEvent({
      coordinate: h.coordinate,
      inboxSkHex: bytesToHex(h.einboxSk),
      eck: [{ id: 1, key: bytesToBase64(h.eck) }],
      configRelays: ["wss://test"],
      gen: 2,
      source: "grant",
      backfill: "full",
    });
    await coordB.jobs.drain();

    // B reconstructed the approved set from A's roster.
    const approvedB = storeB.approvedAttendees(h.coordinate).map((a) => a.pubkey).sort();
    expect(approvedB).toEqual([alicePk, bobPk].sort());

    // B published a roster + directory entries under B's OWN key.
    const rosterB = h.transport.published.filter((e) => e.kind === KIND_ROSTER && e.pubkey === coordPkB);
    expect(rosterB.length).toBeGreaterThan(0);
    const roster = rosterContentSchema.parse(JSON.parse(eckDecrypt(h.eck, rosterB[rosterB.length - 1]!.content)));
    expect(roster.attendees.map((a) => a.pubkey).sort()).toEqual([alicePk, bobPk].sort());
    const dirB = h.transport.published.filter((e) => e.kind === KIND_DIRECTORY_ENTRY && e.pubkey === coordPkB);
    expect(dirB.length).toBeGreaterThanOrEqual(2);

    // A client applying the reader rule (accept only B's records now) sees B's roster.
    const authoredByB = dirB.every((e) => e.pubkey === coordPkB);
    expect(authoredByB).toBe(true);
  });
});

// ── NIP §6.2 — match icebreakers (31605) ─────────────────────────────────────
describe("NIP §6.2 — match icebreakers", () => {
  it("published match lists carry ≤3 non-empty icebreakers per entry", async () => {
    const h = await setup();
    const cryptoSk = generateSecretKey();
    const cryptoPk = await join(h, cryptoSk, "crypto");
    await join(h, generateSecretKey(), "design"); // complementary → icebreakers emitted
    await h.coordinator.jobs.drain();

    const eck = h.eck;
    const cryptoD = blindedD(eck, h.coordinate, cryptoPk);
    const list = latestMatchList(h.transport, cryptoSk, getPublicKey(h.coordSk), cryptoD);
    expect(list).toBeDefined();
    const entry = list.matches.find((m) => m.icebreakers);
    expect(entry).toBeDefined();
    // The mock returned 4 non-empty + 1 empty; the parse caps at 3 and drops empties.
    expect(entry!.icebreakers!.length).toBe(3);
    expect(entry!.icebreakers!.every((s) => s.length > 0)).toBe(true);
  });

  it("a match with no icebreakers omits the field entirely", async () => {
    const h = await setup();
    const aSk = generateSecretKey();
    const aPk = await join(h, aSk, "crypto");
    await join(h, generateSecretKey(), "crypto"); // NON-complementary → empty icebreakers
    await h.coordinator.jobs.drain();
    const list = latestMatchList(h.transport, aSk, getPublicKey(h.coordSk), blindedD(h.eck, h.coordinate, aPk));
    if (list) for (const m of list.matches) expect(m.icebreakers).toBeUndefined();
  });
});

// ── NIP §6.3 21610 — attendee withdrawal ─────────────────────────────────────
/** Send a 21610 withdrawal rumor sealed by the attendee's own account key to E_inbox. */
async function withdraw(
  h: Harness,
  attendeeSk: Uint8Array,
  opts: { deleteData?: boolean; createdAt?: number } = {},
): Promise<void> {
  const inboxPk = getPublicKey(h.einboxSk);
  const wrap = wrapRumor(attendeeSk, inboxPk, {
    kind: KIND_ATTENDEE_WITHDRAWAL,
    content: { v: 2, a: h.coordinate, delete_data: opts.deleteData ?? true },
    tags: [["a", h.coordinate]],
    ...(opts.createdAt !== undefined ? { created_at: opts.createdAt } : {}),
  });
  await h.coordinator.handleInboxWrap(h.coordinate, wrap as any);
}

/** The stored media ciphertext hash for an approved attendee (from its submission). */
function attendeeBlobX(h: Harness, pubkey: string): string | undefined {
  const row = h.store.getAttendee(h.coordinate, pubkey);
  if (!row?.profile_json) return undefined;
  try {
    return (JSON.parse(row.profile_json) as { __media?: { x?: string }[] }).__media?.[0]?.x;
  } catch {
    return undefined;
  }
}

describe("NIP §6.3 — attendee withdrawal (21610)", () => {
  it("runs the full revoke effect chain: directory deletion, ECK rotation, re-grant to the rest", async () => {
    const h = await setup();
    const leaverSk = generateSecretKey();
    const stayerSk = generateSecretKey();
    const leaverPk = await join(h, leaverSk, "crypto");
    const stayerPk = await join(h, stayerSk, "design");
    await h.coordinator.jobs.drain();
    const before = h.transport.published.length;

    await withdraw(h, leaverSk, { deleteData: true });
    await h.coordinator.jobs.drain();
    const after = h.transport.published.slice(before);

    // The leaver's directory entry was NIP-09-deleted.
    expect(after.some((e) => e.kind === KIND_DELETION)).toBe(true);
    // The leaver is no longer an approved attendee.
    expect(h.store.approvedAttendees(h.coordinate).some((a) => a.pubkey === leaverPk)).toBe(false);
    // The remaining attendee got a re-grant carrying the rotated ECK v2.
    const grantToStayer = after
      .filter((e) => e.kind === 1059)
      .map((e) => { try { return unwrapRumor(e as any, stayerSk); } catch { return null; } })
      .filter((r): r is NonNullable<typeof r> => !!r && r.kind === KIND_KEY_GRANT)
      .map((r) => keyGrantContentSchema.parse(JSON.parse(r.content)))
      .pop();
    expect(grantToStayer?.eck.length).toBe(2);
    void stayerPk;
  });

  it("delete_data:true purges stored artifacts; delete_data:false retains them", async () => {
    // delete_data:true → attendee row + transcript purged.
    const h1 = await setup();
    const sk1 = generateSecretKey();
    const pk1 = await join(h1, sk1, "crypto");
    await h1.coordinator.jobs.drain();
    const x1 = attendeeBlobX(h1, pk1)!;
    expect(h1.store.getTranscript(x1)).not.toBeUndefined();
    expect(h1.store.getAttendee(h1.coordinate, pk1)?.ai_profile_json).not.toBeNull();
    await withdraw(h1, sk1, { deleteData: true });
    await h1.coordinator.jobs.drain();
    expect(h1.store.getAttendee(h1.coordinate, pk1)).toBeUndefined();
    expect(h1.store.getTranscript(x1)).toBeUndefined();

    // delete_data:false → row retained (status revoked), artifacts kept.
    const h2 = await setup();
    const sk2 = generateSecretKey();
    const pk2 = await join(h2, sk2, "crypto");
    await h2.coordinator.jobs.drain();
    const x2 = attendeeBlobX(h2, pk2)!;
    await withdraw(h2, sk2, { deleteData: false });
    await h2.coordinator.jobs.drain();
    const row = h2.store.getAttendee(h2.coordinate, pk2);
    expect(row?.status).toBe("revoked");
    expect(row?.ai_profile_json).not.toBeNull();
    expect(h2.store.getTranscript(x2)).not.toBeUndefined();
  });

  it("a re-delivered stale withdrawal cannot re-withdraw after a rejoin (per-subject watermark)", async () => {
    const h = await setup();
    const sk = generateSecretKey();
    const pk = await join(h, sk, "crypto");
    await h.coordinator.jobs.drain();
    const t0 = Math.floor(h.clock.t / 1000);

    // Withdraw at t0 (delete_data:false so the row survives to observe status).
    await withdraw(h, sk, { deleteData: false, createdAt: t0 });
    expect(h.store.getAttendee(h.coordinate, pk)?.status).toBe("revoked");

    // Rejoin via a fresh join request → approved again.
    h.clock.t += 60_000;
    await join(h, sk, "crypto");
    await h.coordinator.jobs.drain();
    expect(h.store.getAttendee(h.coordinate, pk)?.status).toBe("approved");

    // A re-delivered COPY of the old withdrawal (same/earlier created_at) is stale
    // under the per-subject watermark and must NOT re-withdraw the rejoined attendee.
    await withdraw(h, sk, { deleteData: false, createdAt: t0 });
    expect(h.store.getAttendee(h.coordinate, pk)?.status).toBe("approved");
  });
});

// ── NIP §6.3 21606 — attendee-scoped status delivery ─────────────────────────
describe("NIP §6.3 — attendee-scoped 21606 status", () => {
  it("a poisoned own-pipeline job is sealed to the affected attendee too", async () => {
    const h = await setup(0, { failTranscribe: true });
    const attendeeSk = generateSecretKey();
    const pk = await join(h, attendeeSk, "crypto");
    for (let i = 0; i < 30; i++) {
      await h.coordinator.jobs.drain();
      h.clock.t += 5 * 60 * 60_000;
    }
    // The organizer received the poison status (unchanged behavior)...
    const toOrg = lastCoordinatorStatus(h);
    expect(toOrg?.state).toBe("poison");
    expect(toOrg?.pubkey).toBe(pk);
    // ...AND the affected attendee received the same status, sealed to THEM.
    const toAttendee = h.transport.published
      .filter((e) => e.kind === 1059)
      .map((e) => { try { return unwrapRumor(e as any, attendeeSk); } catch { return null; } })
      .filter((r): r is NonNullable<typeof r> => !!r && r.kind === KIND_COORDINATOR_STATUS)
      .map((r) => coordinatorStatusContentSchema.parse(JSON.parse(r.content)));
    expect(toAttendee.length).toBeGreaterThan(0);
    expect(toAttendee[toAttendee.length - 1]!.pubkey).toBe(pk);
  });
});

// ── NIP §6.2 — retention sweep ───────────────────────────────────────────────
describe("NIP §6.2 — retention sweep", () => {
  it("does nothing before the retention deadline", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const h = await setup(0, { retentionDays: 30, eventEndSec: nowSec - 10 * 86_400 });
    await join(h, generateSecretKey(), "crypto");
    await h.coordinator.jobs.drain();
    const before = h.transport.published.length;
    await h.coordinator.retentionSweep();
    // 10 days after end, 30-day window: nothing deleted.
    expect(h.transport.published.slice(before).some((e) => e.kind === KIND_DELETION)).toBe(false);
  });

  it("after the deadline: deletes member records, stops processing, emits a 21606", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const h = await setup(0, { retentionDays: 7, eventEndSec: nowSec - 30 * 86_400 });
    const attendeeSk = generateSecretKey();
    const pk = await join(h, attendeeSk, "crypto");
    await h.coordinator.jobs.drain();
    const before = h.transport.published.length;

    await h.coordinator.retentionSweep();
    const after = h.transport.published.slice(before);

    // Member records deleted (NIP-09) — at least the directory + roster addresses.
    const deletion = after.find((e) => e.kind === KIND_DELETION);
    expect(deletion).toBeDefined();
    expect(deletion!.tags.some((t) => t[0] === "k" && t[1] === String(KIND_DIRECTORY_ENTRY))).toBe(true);
    expect(deletion!.tags.some((t) => t[0] === "k" && t[1] === "31604")).toBe(true);
    // A 21606 retention status went to the organizer.
    const status = after
      .filter((e) => e.kind === 1059)
      .map((e) => { try { return unwrapRumor(e as any, h.eidSk); } catch { return null; } })
      .filter((r): r is NonNullable<typeof r> => !!r && r.kind === KIND_COORDINATOR_STATUS)
      .map((r) => coordinatorStatusContentSchema.parse(JSON.parse(r.content)))
      .pop();
    expect(status?.error_category).toBe("retention_expired");
    // Processing is terminally parked: durable flag set, and a fresh submission's
    // paid pipeline does not resume.
    expect(h.store.isRetentionExpired(h.coordinate)).toBe(true);
    // Local data is PURGED too (audit C5): "delete member data after the event" must
    // delete the coordinator's own copies, not only the relay records.
    expect(h.store.getAttendee(h.coordinate, pk)).toBeUndefined();

    // Expiry is terminal at the inbox boundary: a late join cannot recreate a
    // roster/grant, and a fresh profile revision cannot recreate a directory
    // entry or enqueue provider work after the deletion sweep.
    const lateSk = generateSecretKey();
    const beforeLate = h.transport.published.length;
    await join(h, lateSk, "crypto");
    await resubmitIntro(h, attendeeSk, "crypto");
    await h.coordinator.jobs.drain();
    expect(h.store.getAttendee(h.coordinate, getPublicKey(lateSk))).toBeUndefined();
    expect(h.transport.published.slice(beforeLate).some((e) =>
      [KIND_KEY_GRANT, KIND_DIRECTORY_ENTRY, KIND_ROSTER].includes(e.kind)
    )).toBe(false);

    // Idempotent: a second sweep issues no further deletions, and the data stays gone.
    const before2 = h.transport.published.length;
    await h.coordinator.retentionSweep();
    expect(h.transport.published.slice(before2).some((e) => e.kind === KIND_DELETION)).toBe(false);
    expect(h.store.getAttendee(h.coordinate, pk)).toBeUndefined();
  });
});

// ── audit C8 / P9 / C9 / C2 / C1 regression suites ───────────────────────────

/** A live 31600 config-update event superseding the seeded install config. */
function configUpdate(h: Harness, extraTags: string[][], createdAt: number): NostrEvent {
  return {
    kind: 31600,
    pubkey: getPublicKey(h.eidSk),
    created_at: createdAt,
    id: `cfg-${createdAt}-${Math.floor(Math.random() * 1e6)}`,
    tags: [
      ["d", "cypherpunk"], ["v", "2"], ["inbox", getPublicKey(h.einboxSk)],
      ["coordinator", getPublicKey(h.coordSk), "1"], ["matching", "on"],
      ...extraTags,
    ],
    content: "",
    sig: "",
  } as any;
}

describe("audit C8 — live duration limits keep the ffprobe-side caps in sync", () => {
  it("lowering max_video_sec/max_talk_sec updates ALL THREE decoded-duration caps atomically", async () => {
    const h = await setup(0, { maxVideoSec: 600, maxTalkSec: 1200 });
    expect(h.coordinator.durationLimitsOf(h.coordinate)).toEqual({
      maxMediaSec: 1200, maxIntroSec: 600, maxTalkSec: 1200,
    });
    // A live config edit lowers the limits. Pre-fix only maxMediaSec followed; the
    // authoritative ffprobe caps (maxIntroSec/maxTalkSec) stayed at install values.
    await h.coordinator.handleConfigUpdate(
      h.coordinate,
      configUpdate(h, [["max_video_sec", "60"], ["max_talk_sec", "120"]], 2),
    );
    expect(h.coordinator.durationLimitsOf(h.coordinate)).toEqual({
      maxMediaSec: 120, maxIntroSec: 60, maxTalkSec: 120,
    });
  });

  it("raising the limits lifts the decoded-duration caps too", async () => {
    const h = await setup(0, { maxVideoSec: 60, maxTalkSec: 60 });
    expect(h.coordinator.durationLimitsOf(h.coordinate)!.maxIntroSec).toBe(60);
    await h.coordinator.handleConfigUpdate(
      h.coordinate,
      configUpdate(h, [["max_video_sec", "300"], ["max_talk_sec", "900"]], 2),
    );
    expect(h.coordinator.durationLimitsOf(h.coordinate)).toEqual({
      maxMediaSec: 900, maxIntroSec: 300, maxTalkSec: 900,
    });
  });
});

describe("audit P9 — 31923 metadata selection uses the latest-event comparator", () => {
  it("selects the NEWEST 31923 revision regardless of relay return order (retention anchor)", async () => {
    const h = await setup(0, {
      extraSeed: ({ eidPubkey, d }) => [
        // A STALE revision (older, earlier end) returned before the newest one.
        { kind: 31923, pubkey: eidPubkey, created_at: 3, tags: [["d", d], ["title", "Stale"], ["end", "1000"]], content: "", id: "ev-stale", sig: "" } as any,
        { kind: 31923, pubkey: eidPubkey, created_at: 10, tags: [["d", d], ["title", "Latest"], ["end", "5000"]], content: "", id: "ev-latest", sig: "" } as any,
      ],
    });
    // pickLatest → the ca=10 revision (end 5000), not the first-returned base/stale.
    expect(h.coordinator.eventEndSecOf(h.coordinate)).toBe(5000);
  });

  it("a live 31923 edit re-times the retention anchor; a stale revision is ignored", async () => {
    const h = await setup(0, { eventEndSec: 1000 });
    expect(h.coordinator.eventEndSecOf(h.coordinate)).toBe(1000);
    const cfgSub = h.transport.subs.find(
      (s) => s.filter.kinds?.includes(31923) && s.filter.kinds?.includes(31600),
    )!;
    // A newer 31923 moves the end date.
    cfgSub.onEvent({
      kind: 31923, pubkey: getPublicKey(h.eidSk), created_at: 20, id: "ev-20",
      tags: [["d", "cypherpunk"], ["title", "Moved"], ["end", "8000"]], content: "", sig: "",
    } as any);
    expect(h.coordinator.eventEndSecOf(h.coordinate)).toBe(8000);
    // A stale (older) 31923 does NOT regress it.
    cfgSub.onEvent({
      kind: 31923, pubkey: getPublicKey(h.eidSk), created_at: 4, id: "ev-4",
      tags: [["d", "cypherpunk"], ["title", "Stale"], ["end", "1"]], content: "", sig: "",
    } as any);
    expect(h.coordinator.eventEndSecOf(h.coordinate)).toBe(8000);
  });
});

describe("audit C9 — relay handover is make-before-break", () => {
  it("a probe-failing candidate relay set never cuts off the healthy subscription; it promotes when reachable", async () => {
    const h = await setup();
    const inboxSubs0 = h.transport.subs.filter((s) => s.filter.kinds?.includes(1059));
    expect(inboxSubs0).toHaveLength(1);
    expect(inboxSubs0[0]!.relays).toEqual(["wss://test"]);

    // The organizer edits relays to an UNREACHABLE set (typo / outage).
    h.transport.unreachableRelays.add("wss://bad.relay");
    await h.coordinator.handleConfigUpdate(h.coordinate, configUpdate(h, [["relay", "wss://bad.relay"]], 2));

    // The healthy old subscription is STILL open, no new inbox sub on the bad relays,
    // and the candidate is persisted separately as pending.
    const inboxSubs1 = h.transport.subs.filter((s) => s.filter.kinds?.includes(1059));
    expect(inboxSubs1).toHaveLength(1);
    expect(inboxSubs1[0]!.closed).toBe(false);
    expect(h.store.getPendingRelays(h.coordinate)).toEqual(["wss://bad.relay"]);

    // Once the relay recovers, the periodic retry PROMOTES it: new sub opens, old retires.
    h.transport.unreachableRelays.clear();
    await h.coordinator.retryRelayHandovers();
    const inboxSubs2 = h.transport.subs.filter((s) => s.filter.kinds?.includes(1059));
    expect(inboxSubs2.some((s) => !s.closed && s.relays?.includes("wss://bad.relay"))).toBe(true);
    expect(inboxSubs2[0]!.closed).toBe(true); // the original was retired only after promotion
    expect(h.store.getPendingRelays(h.coordinate)).toBeUndefined();
  });

  it("a slow handover for an OLDER config never promotes after a newer config wins (audit R10 CAS)", async () => {
    const h = await setup();
    // Gate config A's probe so its handover stalls mid-probe (an unserialized
    // callback could otherwise finish and promote A after the newer config B).
    let releaseA: () => void = () => {};
    const aGate = new Promise<void>((r) => { releaseA = r; });
    h.transport.onProbe = async (relays) => {
      if (relays.includes("wss://a.relay")) await aGate;
    };

    // Config A (rev 2): switch relays to a.relay. Kick off but DON'T await — its
    // handover blocks on the gated probe after the (serialized) apply records pending.
    const pA = h.coordinator.handleConfigUpdate(h.coordinate, configUpdate(h, [["relay", "wss://a.relay"]], 2));
    await new Promise((r) => setTimeout(r, 5)); // let A apply + reach the gated probe
    expect(h.store.getPendingRelays(h.coordinate)).toEqual(["wss://a.relay"]);

    // Config B (rev 3, NEWER): switch relays to b.relay. Its probe isn't gated, so it
    // catches up and PROMOTES b.relay, and its apply overwrote pending to b.relay.
    await h.coordinator.handleConfigUpdate(h.coordinate, configUpdate(h, [["relay", "wss://b.relay"]], 3));

    // Release A's gated probe: A's handover resumes but must compare-and-set-veto,
    // because the pending target is now b.relay (B superseded it).
    releaseA();
    await pA;

    const inboxOpen = h.transport.subs.filter((s) => s.filter.kinds?.includes(1059) && !s.closed);
    expect(inboxOpen.some((s) => s.relays?.includes("wss://b.relay"))).toBe(true);
    expect(inboxOpen.some((s) => s.relays?.includes("wss://a.relay"))).toBe(false);
    // b.relay was promoted (pending cleared); the stale A handover promoted nothing.
    expect(h.store.getPendingRelays(h.coordinate)).toBeUndefined();
  });
});

describe("audit R4 — the coordinator's own inbox is rate-gated before durable accounting", () => {
  it("drops a single sender's flood past the per-sender window WITHOUT marking the excess seen", async () => {
    const h = await setup();
    const coordPub = getPublicKey(h.coordSk);
    const baseSec = Math.floor(h.clock.t / 1000);
    // 40 distinct admin commands from ONE sender (E_id) in a single rate window.
    // MAX_RUMORS_PER_SENDER_WINDOW is 30, so 30 are accepted and 10 are rate-dropped.
    const wraps = Array.from({ length: 40 }, (_, i) =>
      wrapRumor(h.eidSk, coordPub, {
        kind: KIND_ADMIN_COMMAND,
        content: { v: 2, a: h.coordinate, cmd: "recompute" },
        created_at: baseSec + i, // distinct rumor ids, all within the same 60s window
      }),
    );
    for (const w of wraps) await h.coordinator.handleCoordinatorWrap(w as any);

    const seen = wraps.map((w) => h.store.isRumorSeen((w as any).id));
    const acceptedCount = seen.filter(Boolean).length;
    // Exactly the per-sender window was accepted (and marked seen); the rest were
    // dropped and left UNSEEN — so a flood cannot grow the durable seen ledger (R4).
    expect(acceptedCount).toBe(30);
    expect(seen.slice(0, 30).every(Boolean)).toBe(true);
    expect(seen.slice(30).some(Boolean)).toBe(false);
  });
});

describe("audit C2 — a running attendee job cannot overwrite a newer submission", () => {
  it("pausing rev1 mid-STT while rev2 lands discards rev1's stale commit and matching", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    let signalReached: () => void = () => {};
    const reached = new Promise<void>((r) => { signalReached = r; });
    const X1 = "11".repeat(32);
    const X2 = "22".repeat(32);
    const h = await setup(0, {
      beforeTranscribe: async (d: any) => {
        if (d.x === X1) { signalReached(); await gate; }
      },
    });
    const sk = generateSecretKey();
    const pk = await join(h, sk, "crypto"); // approved, rev 0
    await h.coordinator.jobs.drain();
    const inboxPk = getPublicKey(h.einboxSk);
    const submit = async (rev: number, about: string, x: string, size: number) => {
      h.stt.setTranscript(String(size), `transcript for ${about}`);
      const w = wrapRumor(sk, inboxPk, {
        kind: KIND_PROFILE_SUBMISSION,
        content: { v: 2, rev, profile: { about, skills: ["zk"], looking_for: "", links: [] }, media: [mediaDesc(size, x, "video/webm")] },
        tags: [["a", h.coordinate]],
      });
      await h.coordinator.handleInboxWrap(h.coordinate, w as any);
    };

    // rev1 lands; claim+start ITS job (only) — it blocks inside transcribe(X1).
    await submit(1, "REV1", X1, 501);
    const r1 = h.store.getAttendee(h.coordinate, pk)!.source_revision!;
    const j1 = h.coordinator.jobs.runOne(); // claims rev1, pauses mid-STT
    await reached;

    // rev2 lands while rev1 is paused, and its job runs to COMPLETION first —
    // committing rev2's ai_profile (source_revision now r2).
    await submit(2, "REV2", X2, 502);
    const r2 = h.store.getAttendee(h.coordinate, pk)!.source_revision!;
    expect(r2).not.toBe(r1);
    await h.coordinator.jobs.drain(); // rev1 is leased/running, so drain runs rev2 only
    expect(h.store.getAttendee(h.coordinate, pk)!.ai_source_revision).toBe(r2);

    // NOW release the stale rev1: it finishes but its conditional commit finds
    // source_revision has moved to r2 and is DISCARDED — it must NOT clobber rev2's
    // already-committed newer profile.
    release();
    await j1;
    const row = h.store.getAttendee(h.coordinate, pk)!;
    expect(row.ai_source_revision).toBe(r2);
    expect(row.ai_source_revision).not.toBe(r1);
  });
});

describe("audit C1 — commands resume to full completion after a partial failure", () => {
  /** A raw admin wrap with a FIXED created_at, so redelivery is the SAME rumor. */
  function adminWrapAt(h: Harness, cmd: string, args: Record<string, unknown>, createdAt: number): any {
    return wrapRumor(h.eidSk, getPublicKey(h.coordSk), {
      kind: KIND_ADMIN_COMMAND,
      content: { v: 2, a: h.coordinate, cmd, args, expires: createdAt + 172_800 },
      created_at: createdAt,
    });
  }

  it("approve: a grant-publish failure leaves the rumor UNSEEN and the op PENDING; the same rumor resumes", async () => {
    const h = await setup();
    const sk = generateSecretKey();
    const pk = await join(h, sk, "crypto");
    await h.coordinator.jobs.drain();
    const now = Math.floor(h.clock.t / 1000);
    const wrap = adminWrapAt(h, "approve", { pubkey: pk }, now + 100);
    const grantsBefore = grantsTo(h, sk).length;

    h.transport.failPublishes = 99;
    await h.coordinator.handleCoordinatorWrap(wrap);
    expect(h.store.isRumorSeen(wrap.id)).toBe(false);
    expect(h.store.getCommandWatermark(h.coordinate, `member:${pk}`)!.state).toBe("pending");
    expect(grantsTo(h, sk).length).toBe(grantsBefore); // re-grant never published

    h.transport.failPublishes = 0;
    await h.coordinator.handleCoordinatorWrap(wrap);
    expect(grantsTo(h, sk).length).toBe(grantsBefore + 1);
    expect(h.store.isRumorSeen(wrap.id)).toBe(true);
    expect(h.store.getCommandWatermark(h.coordinate, `member:${pk}`)!.state).toBe("complete");
  });

  it("revoke: a mid-rotation publish failure resumes WITHOUT minting a second ECK", async () => {
    const h = await setup();
    const leaverSk = generateSecretKey();
    const stayerSk = generateSecretKey();
    const leaverPk = await join(h, leaverSk, "crypto");
    await join(h, stayerSk, "design");
    await h.coordinator.jobs.drain();
    expect(h.coordinator.eckOf(h.coordinate).length).toBe(1);
    const now = Math.floor(h.clock.t / 1000);
    const wrap = adminWrapAt(h, "revoke", { pubkey: leaverPk }, now + 100);

    h.transport.failPublishes = 99;
    await h.coordinator.handleCoordinatorWrap(wrap);
    // The new ECK was minted exactly ONCE (persisted) even though every publish failed.
    expect(h.coordinator.eckOf(h.coordinate).length).toBe(2);
    expect(h.store.isRumorSeen(wrap.id)).toBe(false);
    expect(h.store.getCommandWatermark(h.coordinate, `member:${leaverPk}`)!.state).toBe("pending");

    h.transport.failPublishes = 0;
    await h.coordinator.handleCoordinatorWrap(wrap);
    expect(h.coordinator.eckOf(h.coordinate).length).toBe(2); // NOT 3 — no second mint on resume
    expect(h.store.getAttendee(h.coordinate, leaverPk)!.status).toBe("revoked");
    expect(h.store.getCommandWatermark(h.coordinate, `member:${leaverPk}`)!.state).toBe("complete");
  });

  it("delete_data withdrawal is NOT acknowledged until the data is actually purged", async () => {
    const h = await setup();
    const sk = generateSecretKey();
    const pk = await join(h, sk, "crypto");
    await h.coordinator.jobs.drain();
    const x = attendeeBlobX(h, pk)!;
    expect(h.store.getTranscript(x)).not.toBeUndefined();
    const wrap = wrapRumor(sk, getPublicKey(h.einboxSk), {
      kind: KIND_ATTENDEE_WITHDRAWAL,
      content: { v: 2, a: h.coordinate, delete_data: true },
      tags: [["a", h.coordinate]],
    });

    h.transport.failPublishes = 99;
    await h.coordinator.handleInboxWrap(h.coordinate, wrap as any);
    // The revoke chain failed mid-publish → rumor UNSEEN, data STILL present.
    expect(h.store.isRumorSeen((wrap as any).id)).toBe(false);
    expect(h.store.getTranscript(x)).not.toBeUndefined();
    expect(h.store.getAttendee(h.coordinate, pk)).not.toBeUndefined();
    expect(h.store.getCommandWatermark(h.coordinate, `member:${pk}`)!.state).toBe("pending");

    h.transport.failPublishes = 0;
    await h.coordinator.handleInboxWrap(h.coordinate, wrap as any);
    // Only now, after the purge actually ran, is it acknowledged.
    expect(h.store.getAttendee(h.coordinate, pk)).toBeUndefined();
    expect(h.store.getTranscript(x)).toBeUndefined();
    expect(h.store.isRumorSeen((wrap as any).id)).toBe(true);
    expect(h.store.getCommandWatermark(h.coordinate, `member:${pk}`)!.state).toBe("complete");
  });

  it("attach: an install that throws mid-chat-setup RESUMES on the same grant (gen-check allows it)", async () => {
    const mls = new StubMls();
    let calls = 0;
    mls.createGroup = async () => {
      if (calls++ === 0) throw new Error("simulated MLS outage");
      return { mlsGroupIdHex: "mls-1", nostrGroupIdHex: "ng-1" };
    };
    const h = await setup(0, { chat: true, chatMls: mls, skipAutoInstall: true });
    const wrap = wrapRumor(h.eidSk, getPublicKey(h.coordSk), {
      kind: KIND_COORDINATOR_GRANT,
      content: {
        v: 2, a: h.coordinate, gen: 1, inbox_nsec: bytesToHex(h.einboxSk),
        eck: [{ id: 1, key: bytesToBase64(h.eck) }], config_relays: ["wss://test"],
      },
    });
    await h.coordinator.handleCoordinatorWrap(wrap as any);
    // attempt 1 threw in ensureChat AFTER recordInstalledGen bumped the high-water mark
    // to gen 1; the inline retry re-entered installEvent at gen == highGen and was
    // allowed to RESUME (pre-fix: rejected as stale), so the group was finally created.
    expect(h.store.getEvent(h.coordinate)).toBeDefined();
    expect(h.store.getMarmotGroup(h.coordinate)).toBeDefined();
  });
});

// ── audit R1/R2/R3/R12 — concurrency, membership ordering, retention lifecycle ──
describe("audit R1 — same-subject commands are serialized, not merely ordered", () => {
  function adminWrapAt(h: Harness, cmd: string, args: Record<string, unknown>, createdAt: number): any {
    return wrapRumor(h.eidSk, getPublicKey(h.coordSk), {
      kind: KIND_ADMIN_COMMAND,
      content: { v: 2, a: h.coordinate, cmd, args, expires: createdAt + 172_800 },
      created_at: createdAt,
    });
  }

  it("a paused older revoke and a concurrent newer approve converge to the NEWER decision", async () => {
    const h = await setup();
    const leaverSk = generateSecretKey();
    const leaverPk = await join(h, leaverSk, "crypto");
    await join(h, generateSecretKey(), "design"); // a stayer so revoke has re-grant work
    await h.coordinator.jobs.drain();
    expect(h.store.getAttendee(h.coordinate, leaverPk)!.status).toBe("approved");

    const now = Math.floor(h.clock.t / 1000);
    const revokeWrap = adminWrapAt(h, "revoke", { pubkey: leaverPk }, now + 100); // OLDER
    const approveWrap = adminWrapAt(h, "approve", { pubkey: leaverPk }, now + 200); // NEWER

    // Hold the revoke's FIRST publish (its directory deletion) so the revoke is
    // in-flight — holding the member: subject mutex — when the newer approve is
    // dispatched concurrently. Pre-fix (no mutex) the approve would run to completion
    // in this window and then the resuming older revoke would overwrite it → revoked.
    let releaseRevoke: () => void = () => {};
    const gate = new Promise<void>((r) => (releaseRevoke = r));
    let signalReached: () => void = () => {};
    const reached = new Promise<void>((r) => (signalReached = r));
    let gatedOnce = false;
    h.transport.onPublish = async (e) => {
      if (!gatedOnce && e.kind === KIND_DELETION) {
        gatedOnce = true;
        signalReached();
        await gate;
      }
    };

    const revokeRun = h.coordinator.handleCoordinatorWrap(revokeWrap);
    await reached; // the revoke holds the subject mutex, blocked at its deletion publish
    const approveRun = h.coordinator.handleCoordinatorWrap(approveWrap); // must WAIT on the mutex
    await new Promise((r) => setTimeout(r, 5)); // give the approve every chance to (wrongly) run
    releaseRevoke();
    await Promise.all([revokeRun, approveRun]);
    await h.coordinator.jobs.drain();

    // The mutex serialized them; the newer approve superseded the older revoke, so
    // the final membership is APPROVED.
    expect(h.store.getAttendee(h.coordinate, leaverPk)!.status).toBe("approved");
    // A redelivery of the stale older revoke is now rejected by the watermark.
    await h.coordinator.handleCoordinatorWrap(adminWrapAt(h, "revoke", { pubkey: leaverPk }, now + 100));
    expect(h.store.getAttendee(h.coordinate, leaverPk)!.status).toBe("approved");
  });
});

describe("audit R2 — withdrawals share the membership watermark with approve/revoke", () => {
  it("a DISTINCT older withdrawal delivered AFTER a newer reapproval is rejected (no revoke, no purge)", async () => {
    const h = await setup();
    const sk = generateSecretKey();
    const pk = await join(h, sk, "crypto");
    await h.coordinator.jobs.drain();
    const x = attendeeBlobX(h, pk)!;
    expect(h.store.getTranscript(x)).not.toBeUndefined();

    const now = Math.floor(h.clock.t / 1000);
    // A NEWER organizer (re)approval records the member: watermark at now+200.
    const approveWrap = wrapRumor(h.eidSk, getPublicKey(h.coordSk), {
      kind: KIND_ADMIN_COMMAND,
      content: { v: 2, a: h.coordinate, cmd: "approve", args: { pubkey: pk }, expires: now + 200 + 172_800 },
      created_at: now + 200,
    });
    await h.coordinator.handleCoordinatorWrap(approveWrap);
    expect(h.store.getCommandWatermark(h.coordinate, `member:${pk}`)!.created_at).toBe(now + 200);

    // A DISTINCT, strictly OLDER withdrawal (created_at now+100) arrives afterward.
    // Pre-fix it ordered under its own `withdraw:` watermark (empty) and would revoke
    // + purge; now it orders against the member: watermark and is rejected.
    await withdraw(h, sk, { deleteData: true, createdAt: now + 100 });

    expect(h.store.getAttendee(h.coordinate, pk)!.status).toBe("approved");
    expect(h.store.getTranscript(x)).not.toBeUndefined();
    // The membership watermark still reflects the newer approval, not the withdrawal.
    expect(h.store.getCommandWatermark(h.coordinate, `member:${pk}`)!.created_at).toBe(now + 200);
  });
});

describe("audit R3 — retention is a resumable lifecycle; running jobs can't recreate purged data", () => {
  it("resumes local deletion after a crash BETWEEN the terminal mark and the purge", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const h = await setup(0, { retentionDays: 7, eventEndSec: nowSec - 30 * 86_400 });
    const sk = generateSecretKey();
    const pk = await join(h, sk, "crypto");
    await h.coordinator.jobs.drain();
    const x = attendeeBlobX(h, pk)!;
    expect(h.store.getTranscript(x)).not.toBeUndefined();

    // First sweep: the local PURGE throws (a disk error / crash) — this is the exact
    // window the pre-fix code recorded the durable terminal mark in BEFORE purging, so
    // a crash here left the event marked-expired forever with data still present. The
    // fixed order purges FIRST and marks LAST, so a purge failure leaves the event NOT
    // durably expired and the next sweep resumes.
    const realPurge = h.store.purgeEventArtifacts.bind(h.store);
    let failPurge = true;
    (h.store as any).purgeEventArtifacts = (c: string) => {
      if (failPurge) { failPurge = false; throw new Error("simulated disk failure mid-purge"); }
      return realPurge(c);
    };

    await h.coordinator.retentionSweep();
    // The event must NOT be durably recorded as expired (the mark comes AFTER purge),
    // and the local data must still be present so it can be resumed.
    expect(h.store.isRetentionExpired(h.coordinate)).toBe(false);
    expect(h.store.getAttendee(h.coordinate, pk)).not.toBeUndefined();
    expect(h.store.getTranscript(x)).not.toBeUndefined();

    // Next sweep (restart): purge succeeds, resumes to completion, THEN marks expired.
    await h.coordinator.retentionSweep();
    expect(h.store.isRetentionExpired(h.coordinate)).toBe(true);
    expect(h.store.getAttendee(h.coordinate, pk)).toBeUndefined();
    expect(h.store.getTranscript(x)).toBeUndefined();
  });

  it("a job held mid-STT across a retention expiry is aborted and recreates nothing", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const X = "ab".repeat(32);
    let signalReached: () => void = () => {};
    const reached = new Promise<void>((r) => (signalReached = r));
    const h = await setup(0, {
      retentionDays: 7,
      eventEndSec: nowSec - 30 * 86_400,
      beforeTranscribe: async (d: any, signal?: AbortSignal) => {
        if (d.x === X) {
          signalReached();
          // Block until the per-event/shutdown signal aborts (audit R13/R3).
          await new Promise<void>((_res, rej) => {
            if (signal?.aborted) return rej(signal.reason ?? new Error("aborted"));
            signal?.addEventListener("abort", () => rej(signal.reason ?? new Error("aborted")), { once: true });
          });
        }
      },
    });
    const sk = generateSecretKey();
    const pk = await join(h, sk, "crypto");
    await h.coordinator.jobs.drain();

    // A fresh submission enqueues a process_attendee job for blob X; run it — it
    // blocks inside transcribe(X).
    h.stt.setTranscript("777", "held transcript");
    const sub = wrapRumor(sk, getPublicKey(h.einboxSk), {
      kind: KIND_PROFILE_SUBMISSION,
      content: { v: 2, rev: nextSubmissionRev(pk), profile: { about: "held", skills: ["zk"], looking_for: "", links: [] }, media: [mediaDesc(777, X, "video/webm")] },
      tags: [["a", h.coordinate]],
    });
    await h.coordinator.handleInboxWrap(h.coordinate, sub as any);
    const job = h.coordinator.jobs.runOne(); // claims + runs, blocks mid-STT
    await reached;

    // Expire retention while the job is held: it aborts the in-flight handler, awaits
    // it, then purges. The held job must not recreate a transcript / ai_profile.
    await h.coordinator.retentionSweep();
    await job;

    expect(h.store.isRetentionExpired(h.coordinate)).toBe(true);
    expect(h.store.getAttendee(h.coordinate, pk)).toBeUndefined();
    expect(h.store.getTranscript(X)).toBeUndefined();
  });

  it("a job held mid-STT across a DETACH is aborted and cannot publish with stale state", async () => {
    const X = "cd".repeat(32);
    let signalReached: () => void = () => {};
    const reached = new Promise<void>((r) => (signalReached = r));
    const h = await setup(0, {
      beforeTranscribe: async (d: any, signal?: AbortSignal) => {
        if (d.x === X) {
          signalReached();
          await new Promise<void>((_res, rej) => {
            if (signal?.aborted) return rej(signal.reason ?? new Error("aborted"));
            signal?.addEventListener("abort", () => rej(signal.reason ?? new Error("aborted")), { once: true });
          });
        }
      },
    });
    const sk = generateSecretKey();
    const pk = await join(h, sk, "crypto");
    await h.coordinator.jobs.drain();

    h.stt.setTranscript("778", "held transcript");
    const sub = wrapRumor(sk, getPublicKey(h.einboxSk), {
      kind: KIND_PROFILE_SUBMISSION,
      content: { v: 2, rev: nextSubmissionRev(pk), profile: { about: "held", skills: ["zk"], looking_for: "", links: [] }, media: [mediaDesc(778, X, "video/webm")] },
      tags: [["a", h.coordinate]],
    });
    await h.coordinator.handleInboxWrap(h.coordinate, sub as any);
    const job = h.coordinator.jobs.runOne();
    await reached;

    const before = h.transport.published.length;
    // Detach while the job is held: aborts + awaits the handler, THEN deletes custody.
    await h.coordinator.detachEvent(h.coordinate, { reason: "test detach" });
    await job;

    // Custody is gone and the held job published NOTHING after detach (no directory /
    // roster / grant using the captured pre-detach state), nor wrote the transcript.
    expect(h.store.getEvent(h.coordinate)).toBeUndefined();
    expect(h.store.getTranscript(X)).toBeUndefined();
    expect(
      h.transport.published
        .slice(before)
        .some((e) => [KIND_DIRECTORY_ENTRY, KIND_ROSTER, KIND_KEY_GRANT].includes(e.kind)),
    ).toBe(false);
  });
});

describe("audit R12 — event-wide retention purge clears every personal identifier", () => {
  it("purges command watermarks, jobs, and marmot chat/key-package rows", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const h = await setup(0, { retentionDays: 7, eventEndSec: nowSec - 30 * 86_400 });
    const sk = generateSecretKey();
    const pk = await join(h, sk, "crypto");
    await h.coordinator.jobs.drain();
    // A membership command leaves a member: watermark carrying the attendee pubkey.
    await admin(h, "reprocess", { pubkey: pk });
    expect(h.store.getCommandWatermark(h.coordinate, `member:${pk}`)).toBeDefined();

    await h.coordinator.retentionSweep();

    // Every event-scoped personal-identifier table is empty for this coordinate.
    expect(h.store.getCommandWatermark(h.coordinate, `member:${pk}`)).toBeUndefined();
    expect(h.store.getAttendee(h.coordinate, pk)).toBeUndefined();
    const remainingJobs = (h.store as any)["db"]
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE json_extract(payload, '$.coordinate') = ?")
      .get(h.coordinate) as { n: number };
    expect(remainingJobs.n).toBe(0);
  });
});

// ── audit C3 — public inbox population / rate / concurrency bounds ────────────
describe("audit C3 — public inbox is population-bounded", () => {
  it("drops profile submissions from identities with no enrollment row (no DB growth)", async () => {
    const h = await setup();
    const inboxPk = getPublicKey(h.einboxSk);
    // Burst: many unique keypairs each send a profile submission WITHOUT joining.
    for (let i = 0; i < 40; i++) {
      const sk = generateSecretKey();
      const wrap = wrapRumor(sk, inboxPk, {
        kind: KIND_PROFILE_SUBMISSION,
        content: { v: 2, rev: 0, profile: { about: "x", skills: ["a"], looking_for: "", links: [] }, media: [] },
        tags: [["a", h.coordinate]],
      });
      await h.coordinator.handleInboxWrap(h.coordinate, wrap as any);
    }
    // No attendee rows were created — the population attack is bounded.
    expect(h.store.attendeeCount(h.coordinate)).toBe(0);
    // Legitimate traffic still processes end-to-end.
    const legitSk = generateSecretKey();
    const pk = await join(h, legitSk, "crypto");
    expect(h.store.getAttendee(h.coordinate, pk)?.status).toBe("approved");
    expect(h.store.attendeeCount(h.coordinate)).toBe(1);
  });

  it("enrolls a join published BEFORE the coordinator subscribed so a later submission clears the gate (H2 backfill + join-before-submission ordering)", async () => {
    const h = await setup(0, { skipAutoInstall: true });
    const inboxPk = getPublicKey(h.einboxSk);
    const attendeeSk = generateSecretKey();
    const attendeePk = getPublicKey(attendeeSk);
    const inviteSk = h.invites[h.nextInvite++]!;
    const proof = makeInviteProof(inviteSk, h.coordinate, attendeePk);

    // The attendee JOINS and SUBMITS a profile BEFORE the coordinator installs and
    // subscribes — both wraps already sit on the relay, unseen by any live sub. A relay
    // returns stored events in arbitrary (often newest-first) order, so the SUBMISSION
    // can precede its own JOIN — pushed in that order here to model the hostile case.
    const subWrap = wrapRumor(attendeeSk, inboxPk, {
      kind: KIND_PROFILE_SUBMISSION,
      content: { v: 2, rev: 0, profile: { about: "early", skills: ["a"], looking_for: "", links: [] }, media: [] },
      tags: [["a", h.coordinate]],
    });
    const joinWrap = wrapRumor(attendeeSk, inboxPk, {
      kind: KIND_JOIN_REQUEST,
      content: { v: 2, name: "early bird", message: "", rsvp_public: false },
      tags: [["a", h.coordinate], ["invite", getPublicKey(inviteSk), proof.sig]],
    });
    h.transport.published.push(subWrap as any, joinWrap as any); // relay order: submission, THEN join

    // Fresh grant install → full E_inbox backfill. It must FETCH the pre-subscription
    // history AND dispatch the join before the submission. Pre-fix there was no explicit
    // inbox backfill (the live sub was the only reader — and it never replays stored
    // wraps), so the join was never enrolled and the submission was dropped as "never
    // joined", leaving the attendee permanently unable to enroll.
    await h.coordinator.installEvent({
      coordinate: h.coordinate, inboxSkHex: bytesToHex(h.einboxSk),
      eck: [{ id: 1, key: bytesToBase64(h.eck) }], configRelays: ["wss://test"],
      gen: 1, source: "grant", backfill: "full",
    });

    // Enrolled from the backfilled join…
    expect(h.store.getAttendee(h.coordinate, attendeePk)?.status).toBe("approved");
    // …and the submission that raced ahead of it was NOT dropped — profile recorded.
    expect(h.store.getAttendee(h.coordinate, attendeePk)?.profile_rev).toBe(0);
  });

  it("refuses a new attendee beyond the 2,000 roster population cap", async () => {
    const h = await setup();
    for (let i = 0; i < 2000; i++) {
      h.store.upsertAttendee({ coordinate: h.coordinate, pubkey: "seed" + i, status: "pending", now: 1 });
    }
    expect(h.store.attendeeCount(h.coordinate)).toBe(2000);
    // A fresh join (even with a valid invite) is refused — the roster never grows
    // past what a 31604 can carry and then fail to publish.
    const sk = generateSecretKey();
    await join(h, sk, "crypto");
    expect(h.store.getAttendee(h.coordinate, getPublicKey(sk))).toBeUndefined();
    expect(h.store.attendeeCount(h.coordinate)).toBe(2000);
  });

  it("durably rate-drops a flooding sender past the per-window cap", async () => {
    const h = await setup();
    const inboxPk = getPublicKey(h.einboxSk);
    const floodSk = generateSecretKey();
    // Enroll the flooder so its submissions clear the enrollment gate; the rate gate
    // is what must bound them.
    await join(h, floodSk, "crypto");
    await h.coordinator.jobs.drain();
    const seenBefore = (h.store as any).db.prepare("SELECT COUNT(*) AS n FROM seen_rumors").get().n as number;
    // Burst well past the per-sender window cap (30). The excess is rate-dropped
    // (marked seen) rather than processed.
    let dropped = 0;
    for (let i = 0; i < 60; i++) {
      const wrap = wrapRumor(floodSk, inboxPk, {
        kind: KIND_PROFILE_SUBMISSION,
        content: { v: 2, rev: 100 + i, profile: { about: "y" + i, skills: ["a"], looking_for: "", links: [] }, media: [] },
        tags: [["a", h.coordinate]],
      });
      const before = (h.store as any).db.prepare("SELECT COUNT(*) AS n FROM seen_rumors").get().n as number;
      await h.coordinator.handleInboxWrap(h.coordinate, wrap as any);
      const after = (h.store as any).db.prepare("SELECT COUNT(*) AS n FROM seen_rumors").get().n as number;
      // A rate-dropped rumor marks itself seen without a normal handler cycle.
      if (after > before) dropped++;
    }
    void seenBefore;
    // Some of the 60 were rate-dropped (the sender cap is 30/window).
    expect(dropped).toBeGreaterThan(0);
  });
});


describe("prod 2026-07-24 — an organizer recompute must actually re-run the scoring", () => {
  /**
   * The incident: an organizer sent "recompute", the log showed every batch being
   * dispatched, and then nothing at all — no scores, no published lists, no error,
   * for the rest of the event. `clearPairs` had deleted every cached score, and the
   * scoring jobs it then enqueued collided with the PREVIOUS run's finished rows on
   * their content-addressed dedupe keys, so `INSERT OR IGNORE` discarded all of them
   * in silence. The event was left with zero pair scores and stale match lists.
   *
   * This test fails against the pre-fix code with `expect(14).toBeGreaterThan(14)`:
   * the second recompute spends nothing and publishes nothing.
   */
  it("a SECOND recompute over unchanged profiles re-scores and republishes", async () => {
    const h = await setup();
    await join(h, generateSecretKey(), "crypto");
    await join(h, generateSecretKey(), "design");
    await join(h, generateSecretKey(), "code");
    await h.coordinator.jobs.drain();

    await admin(h, "recompute", {});
    await h.coordinator.jobs.drain();
    const callsAfterFirst = h.llm.completeCalls;
    const listsAfterFirst = h.transport.published.filter((e) => e.kind === KIND_MATCH_LIST).length;

    // Second recompute, identical profiles ⇒ identical batch dedupe keys.
    await admin(h, "recompute", {});
    await h.coordinator.jobs.drain();
    expect(h.llm.completeCalls).toBeGreaterThan(callsAfterFirst);
    expect(h.transport.published.filter((e) => e.kind === KIND_MATCH_LIST).length).toBeGreaterThan(listsAfterFirst);
  });

  it("leaves the event with a full set of scored pairs after every recompute", async () => {
    const h = await setup();
    const a = await join(h, generateSecretKey(), "crypto");
    const b = await join(h, generateSecretKey(), "design");
    await h.coordinator.jobs.drain();

    for (let round = 0; round < 3; round++) {
      await admin(h, "recompute", {});
      await h.coordinator.jobs.drain();
      // Both directions scored again, every time — never the empty pair table the
      // incident left behind.
      expect(h.store.pairsFor(h.coordinate, a).map((r) => r.other)).toEqual([b]);
      expect(h.store.pairsFor(h.coordinate, b).map((r) => r.other)).toEqual([a]);
    }
  });

  it("logs a per-batch outcome line with elapsed ms, and a FAILED line when a batch throws", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    try {
      const h = await setup();
      await join(h, generateSecretKey(), "crypto");
      await join(h, generateSecretKey(), "design");
      await h.coordinator.jobs.drain();
      expect(lines.some((l) => /\[match\] forward batch \w+ ×\d+: \d+ scored, \d+ unparsed in \d+ms/.test(l))).toBe(true);

      // Now make the scoring provider fail and confirm the batch says so.
      lines.length = 0;
      h.counters.failBatchScore = true;
      await admin(h, "recompute", {});
      await h.coordinator.jobs.drain();
      expect(lines.some((l) => /\[match\] forward batch \w+ ×\d+: FAILED after \d+ms — .*venice is on fire/.test(l))).toBe(
        true,
      );
    } finally {
      spy.mockRestore();
    }
  });
});
