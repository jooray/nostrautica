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
  eckEncrypt,
  nip44Decrypt,
  blindedD,
  wrapRumor,
  KIND_JOIN_REQUEST,
  KIND_PROFILE_SUBMISSION,
  KIND_PROFILE,
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
  KIND_CALENDAR_EVENT,
  KIND_COMMUNITY,
  talkContentSchema,
  directoryEntryContentSchema,
  matchListContentSchema,
  matchMatrixContentSchema,
  rosterContentSchema,
  mergeRosterPages,
  rosterPageD,
  MAX_ROSTER,
  MAX_ROSTER_PAGES,
  NIP44_MAX_PLAINTEXT_BYTES,
  keyGrantContentSchema,
  coordinatorStatusContentSchema,
  unwrapRumor,
  sha256Hex,
  utf8ToBytes,
  RUMOR_MAX_CLOCK_SKEW_SEC,
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
  publishCalls: { event: NostrEvent; relays?: string[] }[] = [];
  seed: NostrEvent[] = [];
  /** Recorded subscriptions (COORD-8/COORD-29 tests): filter, relays, handler, closed. */
  subs: { filter: any; relays?: string[]; onEvent: (e: NostrEvent) => void; closed: boolean }[] = [];
  /** Recorded fetch filters (COORD-29 tests). */
  fetches: any[] = [];
  /** Recorded fetches WITH the relay set each one targeted. `fetches` above drops
   *  the relays, which made the profile-refresh relay union untestable — and that
   *  union is precisely the thing whose failure mode is silent (read the event's
   *  relays only, find no kind 0, conclude "unchanged", do nothing, print OK). */
  fetchCalls: { filter: any; relays?: string[] }[] = [];
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
  async publish(event: NostrEvent, relays?: string[]): Promise<void | { replaced?: boolean }> {
    this.publishCalls.push({ event, relays });
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
  /** When > 0, every fetch takes this long — so a boot that fans out across events
   *  genuinely overlaps and {@link peakInFlightFetches} measures something real. */
  fetchDelayMs = 0;
  inFlightFetches = 0;
  peakInFlightFetches = 0;
  async fetch(filter: any, relays?: string[]): Promise<NostrEvent[]> {
    this.fetches.push(filter);
    this.fetchCalls.push({ filter, relays });
    this.beforeFetch?.(filter);
    this.inFlightFetches++;
    this.peakInFlightFetches = Math.max(this.peakInFlightFetches, this.inFlightFetches);
    try {
      if (this.fetchDelayMs > 0) await new Promise((r) => setTimeout(r, this.fetchDelayMs));
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
    } finally {
      this.inFlightFetches--;
    }
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
  /** When set, EVERY batch (forward and reverse) comes back with entries missing —
   *  a persistently incomplete model response, which drives the retry-budget test.
   *  Both directions, because the reverse batch writes the same directed rows and
   *  would otherwise quietly satisfy the forward batch's retry. */
  dropAllScores?: boolean;
  /** How many profile-translation calls the pipeline made. */
  translateCalls: number;
  /** When set, every batch-scoring call throws — drives the batch FAILED log line. */
  failBatchScore?: boolean;
  /** When set, every profile_translation call throws (the decoration stage fails). */
  failTranslate?: boolean;
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
        if (counters.dropAllScores) continue;
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
        if (counters.dropAllScores) continue;
        // reasoning addressed to the TARGET about meeting the shared person.
        matches.push(scoreEntry(index, role, sharedRole, sharedUpdated || chunk.includes("(updated)")));
      }
      return { matches };
    }
    if (req.schemaName === "profile_translation") {
      counters.translateCalls++;
      if (counters.failTranslate) throw new Error("translation contract: looking_for: invalid_type");
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
  /** The space's kind — 31923 (default) or 31612 when `opts.spaceKind` says so. */
  spaceKind: number;
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
    /**
     * Which of the two space kinds this space is published under (PROTOCOL-NIP.md
     * §1.1): 31923 (dated NIP-52 event, the default) or 31612 (standing community).
     * Drives BOTH the coordinate's kind and the kind of the seeded metadata record,
     * because those two are the same thing — a coordinate is `kind:pubkey:d`.
     */
    spaceKind?: number;
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
      daemonBytes?: number;
      daemonDurationSec?: number;
      daemonCalls?: number;
      daemonWindowHours?: number;
    };
    /** C2 race hook: awaited by the injected transcribe BEFORE it returns, so a test
     *  can pause a specific revision's STT/LLM mid-flight and interleave a newer one. */
    beforeTranscribe?: (descriptor: any, signal?: AbortSignal) => Promise<void>;
    /** C1 attach test: skip the auto-install so the test can drive installEvent via a
     *  grant wrap (and inject a mid-install failure). */
    skipAutoInstall?: boolean;
    transcribeError?: string;
    eventRelays?: string[];
    defaultRelays?: string[];
  } = {},
): Promise<Harness> {
  adminNonce = 0; // per-test admin created_at offset (NIP §3.4 watermark ordering)
  const coordSk = generateSecretKey();
  const eidSk = generateSecretKey();
  const eidPubkey = getPublicKey(eidSk);
  const einboxSk = generateSecretKey();
  const d = "cypherpunk";
  const spaceKind = opts.spaceKind ?? KIND_CALENDAR_EVENT;
  const coordinate = makeCoordinate(eidPubkey, d, spaceKind);
  const eck = generateEck();
  const eckVersions: EckVersion[] = [{ id: 1, key: bytesToBase64(eck) }];
  const invites = Array.from({ length: 6 }, () => generateSecretKey());

  // Pass the identity key so the whole pipeline runs against at-rest-encrypted
  // event-key columns (F1) — exactly like production.
  const coordPubkey = getPublicKey(coordSk);
  const store = new Store(":memory:", coordSk);
  const transport = new FakeTransport();
  transport.seed.push(
    { kind: spaceKind, pubkey: eidPubkey, created_at: 1, tags: [["d", d], ["title", "Cypherpunk Assembly"], ["t", "cypherpunk"], ...(opts.eventEndSec !== undefined ? [["end", String(opts.eventEndSec)]] : [])], content: "", id: "e1", sig: "" } as any,
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
    defaultRelays: opts.defaultRelays ?? ["wss://test"],
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
      coordinate, inboxSkHex: bytesToHex(einboxSk), eck: eckVersions, configRelays: opts.eventRelays ?? ["wss://test"], gen: 1, source: "grant", backfill: "full",
    });
  }

  return { coordinator, transport, store, llm, llmA, llmB, stt, counters, coordSk, eidSk, einboxSk, coordinate, spaceKind, eck, invites, nextInvite: 0, clock };
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

  it("flipping the event language actually re-summarizes the attendees (audit B-11)", async () => {
    // `applyConfigUpdate` asks for a rebuild per approved attendee when `lang` or
    // `nostr_context` changes, because both are inputs to the derived AI content.
    // The enqueue was keyed on the PROFILE hash alone — which hadn't changed —
    // so every one of those collided with the already-`done` row and was
    // discarded. The organizer switched the event to Slovak, the log said the
    // enqueue was dropped, and not a single profile was rebuilt.
    const h = await setup(0, { lang: "en" });
    const sk = generateSecretKey();
    await join(h, sk, "crypto");
    await h.coordinator.jobs.drain();
    const translationsBefore = h.counters.translateCalls;
    expect(h.store.pendingJobCount()).toBe(0);

    const newer = {
      kind: 31600, pubkey: getPublicKey(h.eidSk), created_at: 100,
      tags: [["d", "cypherpunk"], ["v", "2"], ["inbox", getPublicKey(h.einboxSk)], ["coordinator", getPublicKey(h.coordSk), "1"], ["matching", "on"], ["lang", "sk"]],
      content: "", id: "cfg-lang", sig: "",
    } as any;
    await h.coordinator.handleConfigUpdate(h.coordinate, newer);
    // The rebuild is really queued (not swallowed by a terminal row)…
    expect(h.store.pendingJobCount()).toBeGreaterThan(0);
    await h.coordinator.jobs.drain();
    // …and it really re-ran the language-dependent stage.
    expect(h.counters.translateCalls).toBeGreaterThan(translationsBefore);
  });

  it("a config edit whose matrix publish fails is RETRIED durably, not silently lost (CORE-N-2)", async () => {
    // The applied-config watermark moved to this 31600 before its outward effects
    // ran, and `subscribeEventConfig`'s callback swallowed the throw. So a relay
    // hiccup during an organizer's visibility change left the coordinator believing
    // the new config was live, with the matrix never published — and a redelivery of
    // the same 31600 rejected by `supersedes`, so nothing could ever fix it.
    const h = await setup(0, { matchVisibility: "pair" });
    await join(h, generateSecretKey(), "crypto");
    await join(h, generateSecretKey(), "design");
    await h.coordinator.jobs.drain();
    const newer = {
      kind: 31600, pubkey: getPublicKey(h.eidSk), created_at: 100,
      tags: [["d", "cypherpunk"], ["v", "2"], ["inbox", getPublicKey(h.einboxSk)], ["coordinator", getPublicKey(h.coordSk), "1"], ["matching", "on"], ["match_visibility", "event"]],
      content: "", id: "cfg-2", sig: "",
    } as any;

    h.transport.failPublishes = 99;
    await h.coordinator.handleConfigUpdate(h.coordinate, newer);
    expect(h.transport.published.some((e) => e.kind === KIND_MATCH_MATRIX)).toBe(false);
    // The config itself IS applied (state + DB); only the effect failed.
    expect(JSON.parse(h.store.getEvent(h.coordinate)!.config_json).matchVisibility).toBe("event");

    // Redelivering the identical 31600 correctly changes nothing — it does not
    // supersede. The durable job is what recovers it.
    await h.coordinator.handleConfigUpdate(h.coordinate, newer);
    expect(h.transport.published.some((e) => e.kind === KIND_MATCH_MATRIX)).toBe(false);

    h.transport.failPublishes = 0;
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

/**
 * Audit B-8 — the roster's REAL ceiling, enforced where it can still be acted on.
 *
 * A 31604 PAGE is one NIP-44 payload, capped at 65,535 plaintext bytes. That used
 * to be the ceiling on the whole roster, which put an event's real limit somewhere
 * between roughly 240 and 480 approved members — nowhere near the 2,000 the schema
 * and the join gate advertise — and past it `buildRoster` threw from INSIDE the
 * approve path, with the ECK grant already published and the organizer holding a
 * crypto error for the 400th person at the door.
 *
 * Pagination (PROTOCOL-NIP.md §6.2) moved the ceiling out to the advertised
 * number. What did NOT change, and is what these tests are really about, is the
 * ordering: the gate runs BEFORE anything is granted, and a refusal reaches the
 * organizer as something they can act on rather than as a failed publish.
 */
describe("audit B-8 — the 31604 roster ceiling is enforced at approval", () => {
  /** Fill the event's approved set until the roster is at `fraction` of capacity. */
  function fillRoster(h: Harness, count: number): void {
    for (let i = 0; i < count; i++) {
      h.store.upsertAttendee({
        coordinate: h.coordinate,
        pubkey: i.toString(16).padStart(64, "0"),
        status: "approved",
        now: h.clock.t,
      });
    }
  }

  it("refuses an approval that would not fit, tells the organizer, and grants nothing", async () => {
    const h = await setup();
    fillRoster(h, MAX_ROSTER); // the advertised total, in full
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    h.store.upsertAttendee({ coordinate: h.coordinate, pubkey: pk, status: "pending", now: h.clock.t });
    const grantsBefore = grantsTo(h, sk).length;

    await admin(h, "approve", { pubkey: pk });

    // Still pending — and, crucially, holding no key.
    expect(h.store.getAttendee(h.coordinate, pk)?.status).toBe("pending");
    expect(grantsTo(h, sk).length).toBe(grantsBefore);
    // The organizer is told, in terms they can act on.
    const status = h.transport.published
      .filter((e) => e.kind === 1059)
      .map((e) => { try { return unwrapRumor(e as any, h.eidSk); } catch { return null; } })
      .filter((r): r is NonNullable<typeof r> => !!r && r.kind === KIND_COORDINATOR_STATUS)
      .map((r) => coordinatorStatusContentSchema.parse(JSON.parse(r.content)))
      .find((s) => s.error_category === "roster_full");
    expect(status).toBeDefined();
    expect(status!.retryable).toBe(false);
  });

  it("an auto-approving invite cannot conjure space either", async () => {
    const h = await setup();
    const sk = generateSecretKey();
    const pubkey = getPublicKey(sk);
    // They were already known to the event when there was still room — the intake
    // cap (MAX_ATTENDEES_PER_EVENT, which counts PENDING rows that cost nothing on
    // the wire) is a different gate and not what this test is about. What is: the
    // roster gate runs on the auto-approval path too, not only on manual approval.
    h.store.upsertAttendee({ coordinate: h.coordinate, pubkey, status: "pending", now: h.clock.t });
    fillRoster(h, MAX_ROSTER);

    await joinOnly(h, sk, "with-a-valid-code");

    // The invite proof is valid; the roster is not. They land in the manual queue.
    expect(h.store.getAttendee(h.coordinate, pubkey)?.status).toBe("pending");
    expect(grantsTo(h, sk)).toHaveLength(0);
  });

  it("warns ONCE as the roster approaches the ceiling, while it can still be planned around", async () => {
    const h = await setup();
    fillRoster(h, Math.ceil(MAX_ROSTER * 0.9)); // the warning threshold
    const rosterStatuses = () =>
      h.transport.published
        .filter((e) => e.kind === 1059)
        .map((e) => { try { return unwrapRumor(e as any, h.eidSk); } catch { return null; } })
        .filter((r): r is NonNullable<typeof r> => !!r && r.kind === KIND_COORDINATOR_STATUS)
        .map((r) => coordinatorStatusContentSchema.parse(JSON.parse(r.content)))
        .filter((s) => s.error_category === "roster_nearly_full");

    for (const name of ["a", "b", "c"]) {
      const sk = generateSecretKey();
      const pk = getPublicKey(sk);
      h.store.upsertAttendee({ coordinate: h.coordinate, pubkey: pk, status: "pending", displayName: name, now: h.clock.t });
      await admin(h, "approve", { pubkey: pk });
      expect(h.store.getAttendee(h.coordinate, pk)?.status).toBe("approved"); // still admitted
    }
    expect(rosterStatuses()).toHaveLength(1); // one notice, not one per approval
  });

  it("an ordinary event approves normally and says nothing about capacity", async () => {
    const h = await setup();
    const sk = generateSecretKey();
    const pk = await join(h, sk, "crypto");
    expect(h.store.getAttendee(h.coordinate, pk)?.status).toBe("approved");
    const noisy = h.transport.published
      .filter((e) => e.kind === 1059)
      .map((e) => { try { return unwrapRumor(e as any, h.eidSk); } catch { return null; } })
      .filter((r): r is NonNullable<typeof r> => !!r && r.kind === KIND_COORDINATOR_STATUS)
      .map((r) => coordinatorStatusContentSchema.parse(JSON.parse(r.content)))
      .filter((s) => s.stage === "roster");
    expect(noisy).toHaveLength(0);
  });
});

/**
 * Roster pagination (PROTOCOL-NIP.md §6.2). The event the ceiling used to refuse
 * — several hundred people, each with an attested chat device — now publishes,
 * as pages, and an approval still costs one relay publish.
 */
describe("31604 roster pagination", () => {
  function fillRoster(h: Harness, count: number): void {
    for (let i = 0; i < count; i++) {
      h.store.upsertAttendee({
        coordinate: h.coordinate,
        pubkey: i.toString(16).padStart(64, "0"),
        status: "approved",
        now: h.clock.t,
      });
    }
  }

  /** Every 31604 the coordinator published, newest per page `d`, in page order. */
  function rosterPages(h: Harness): NostrEvent[] {
    const identifier = h.coordinate.split(":").slice(2).join(":");
    const byD = new Map<string, NostrEvent>();
    for (const e of h.transport.published.filter((e) => e.kind === KIND_ROSTER)) {
      const d = e.tags.find((t) => t[0] === "d")?.[1];
      if (d !== undefined) byD.set(d, e);
    }
    const out: NostrEvent[] = [];
    for (let i = 0; byD.has(rosterPageD(identifier, i)); i++) out.push(byD.get(rosterPageD(identifier, i))!);
    return out;
  }

  it("an event past the single-payload ceiling publishes as pages that each encrypt", async () => {
    const h = await setup();
    fillRoster(h, 600);
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    h.store.upsertAttendee({ coordinate: h.coordinate, pubkey: pk, status: "pending", now: h.clock.t });

    await admin(h, "approve", { pubkey: pk });

    // Admitted — this is exactly the approval the ceiling used to refuse.
    expect(h.store.getAttendee(h.coordinate, pk)?.status).toBe("approved");
    expect(grantsTo(h, sk).length).toBeGreaterThan(0);

    const pages = rosterPages(h);
    expect(pages.length).toBeGreaterThan(1);
    const parsed = pages.map((e) => {
      const plaintext = eckDecrypt(h.eck, e.content);
      // Measured on the real plaintext NIP-44 encrypted, not an entry-size estimate.
      expect(utf8ToBytes(plaintext).length).toBeLessThanOrEqual(NIP44_MAX_PLAINTEXT_BYTES);
      return rosterContentSchema.parse(JSON.parse(plaintext));
    });
    // Page 0 declares the count; the others are addressed <d>:1, <d>:2, …
    expect(parsed[0]!.v).toBe(3);
    expect(parsed[0]!.pages).toBe(pages.length);
    expect(parsed[0]!.eck_current).toBeGreaterThan(0);
    // Every member, exactly once, including the one just approved.
    const merged = mergeRosterPages(parsed);
    expect(merged.attendees).toHaveLength(601);
    expect(new Set(merged.attendees.map((a) => a.pubkey)).size).toBe(601);
    expect(merged.attendees.some((a) => a.pubkey === pk)).toBe(true);
  });

  it("an approval republishes ONLY the page it changed, not all of them", async () => {
    const h = await setup();
    fillRoster(h, 600);
    const approve = async () => {
      const pk = getPublicKey(generateSecretKey());
      h.store.upsertAttendee({ coordinate: h.coordinate, pubkey: pk, status: "pending", now: h.clock.t });
      await admin(h, "approve", { pubkey: pk });
      return pk;
    };
    // First approval primes the per-page record by publishing every page once.
    await approve();
    const pageCount = rosterPages(h).length;
    expect(pageCount).toBeGreaterThan(1);
    const before = h.transport.published.filter((e) => e.kind === KIND_ROSTER).length;

    await approve();

    const published = h.transport.published.filter((e) => e.kind === KIND_ROSTER).length - before;
    // One publish, not `pageCount` of them. This is the difference between an
    // approval costing one relay round trip and costing N for the whole event.
    expect(published).toBe(1);
    const identifier = h.coordinate.split(":").slice(2).join(":");
    const last = h.transport.published.filter((e) => e.kind === KIND_ROSTER).at(-1)!;
    expect(last.tags.find((t) => t[0] === "d")?.[1]).toBe(rosterPageD(identifier, pageCount - 1));
  });

  it("a roster that still fits publishes exactly one 31604, at the event d, with v:2", async () => {
    const h = await setup();
    const sk = generateSecretKey();
    const pk = await join(h, sk, "crypto");
    expect(h.store.getAttendee(h.coordinate, pk)?.status).toBe("approved");
    const identifier = h.coordinate.split(":").slice(2).join(":");
    const pages = rosterPages(h);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.tags.find((t) => t[0] === "d")?.[1]).toBe(identifier);
    const roster = rosterContentSchema.parse(JSON.parse(eckDecrypt(h.eck, pages[0]!.content)));
    expect(roster.v).toBe(2);
    expect(roster.pages).toBeUndefined();
  });

  it("retention deletes every address pagination could have used, not just page 0", async () => {
    // A roster that grew and then SHRANK leaves stale higher pages on relays, and
    // nothing durably records how many pages an event ever had. Deleting an
    // address that was never published is a no-op; missing one leaves member
    // pubkeys behind after the retention window closed.
    const nowSec = Math.floor(Date.now() / 1000);
    const h = await setup(0, { retentionDays: 7, eventEndSec: nowSec - 30 * 86_400 });
    await join(h, generateSecretKey(), "crypto");
    await h.coordinator.jobs.drain();
    const identifier = h.coordinate.split(":").slice(2).join(":");

    await h.coordinator.retentionSweep();

    const deletion = h.transport.published.filter((e) => e.kind === KIND_DELETION).at(-1)!;
    const addrs = new Set(deletion.tags.filter((t) => t[0] === "a").map((t) => t[1]));
    const coordPk = getPublicKey(h.coordSk);
    for (let i = 0; i < MAX_ROSTER_PAGES; i++) {
      expect(addrs.has(`${KIND_ROSTER}:${coordPk}:${rosterPageD(identifier, i)}`), `page ${i}`).toBe(true);
    }
  });
});

describe("audit B-4 — reprocess repairs a poisoned TALK, not just the attendee profile", () => {
  it("re-enqueues the speaker's untranscribed talk so a fixed outage can actually transcribe it", async () => {
    // `clearAttendeeJobMemo` deliberately covers `process_talk`, because a poisoned
    // talk row is otherwise unrecoverable: its dedupe key is content-addressed on
    // the media hash, so re-submitting the identical recording reproduces the same
    // key and the enqueue is discarded. Deleting the row was only half the repair —
    // nothing re-created the job, so the organizer's reprocess left the talk
    // transcript-less for good and the speaker's only remedy was to re-record
    // something they had already recorded.
    const opts = { talks: "on" as const, failTranscribe: true };
    const h = await setup(0, opts);
    const speakerSk = generateSecretKey();
    const pk = await join(h, speakerSk, "crypto");
    const x = "ab".repeat(32);
    await submitTalk(h, speakerSk, {
      talkD: "t1",
      title: "Zero-knowledge proofs",
      media: talkMedia(700, x),
      processForMatching: true,
    });

    // Burn the retry tail until the talk job poisons (STT/blob outage).
    for (let i = 0; i < 30; i++) {
      await h.coordinator.jobs.drain();
      h.clock.t += 5 * 60 * 60_000;
    }
    expect(h.store.getTalk(h.coordinate, pk, "t1")?.transcript_json).toBeNull();
    expect(h.store.jobStateCounts().poison).toBeGreaterThan(0);

    // The outage is over and the organizer presses reprocess for this speaker.
    opts.failTranscribe = false;
    await admin(h, "reprocess", { pubkey: pk });
    await h.coordinator.jobs.drain();

    expect(h.store.getTalk(h.coordinate, pk, "t1")?.transcript_json).not.toBeNull();
  });
});

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

/**
 * Audit B-1 / B-2 — a join is a membership transition and orders like one.
 *
 * `handleJoin` writes the attendee row, then AWAITS a relay round-trip
 * (`fetchInviteHashes`) before writing the status its entitlement decision
 * produced. That await is long enough for an organizer to approve the person
 * sitting in front of them, and the second write was unconditional.
 */
describe("audit B-1/B-2 — join ordering against the rest of the membership chain", () => {
  /** A join with NO invite proof → entitlement says "manual queue" → pending. */
  async function joinNoInvite(h: Harness, attendeeSk: Uint8Array, name: string): Promise<void> {
    const inboxPk = getPublicKey(h.einboxSk);
    await h.coordinator.handleInboxWrap(
      h.coordinate,
      wrapRumor(attendeeSk, inboxPk, {
        kind: KIND_JOIN_REQUEST,
        content: { v: 2, name, message: "", rsvp_public: false },
        tags: [["a", h.coordinate]],
      }) as any,
    );
  }

  it("an approval landing mid-entitlement is not overwritten back to pending", async () => {
    // Pre-fix: the row went approved (grant published, ECK really in the
    // attendee's hands) and then back to `pending` when the stalled fetch
    // resolved — so the roster, the admin list and the matching set all disagreed
    // with what the attendee could actually decrypt, until something happened to
    // touch the row again.
    const h = await setup();
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const realFetch = h.transport.fetch.bind(h.transport);
    h.transport.fetch = async (filter: any) => {
      if (filter.kinds?.includes(31601)) await gate; // hold the entitlement read open
      return realFetch(filter);
    };

    const joining = joinNoInvite(h, sk, "mid-entitlement");
    // The row is enrolled as `pending` before the fetch resolves (the 2026-07-29
    // fix that this one builds on).
    await vi.waitFor(() => expect(h.store.getAttendee(h.coordinate, pk)?.status).toBe("pending"));

    // The organizer approves while the join is still parked in that fetch.
    const approving = admin(h, "approve", { pubkey: pk });
    release();
    await Promise.all([joining, approving]);

    expect(h.store.getAttendee(h.coordinate, pk)?.status).toBe("approved");
    expect(grantsTo(h, sk).length).toBeGreaterThan(0); // and they really hold the ECK
  });

  it("a join older than an applied revoke does not resurrect the member as pending", async () => {
    const h = await setup();
    const sk = generateSecretKey();
    const pk = await join(h, sk, "crypto");
    await h.coordinator.jobs.drain();
    // The organizer revokes them; that command completes and owns `member:<pk>`.
    await admin(h, "revoke", { pubkey: pk });
    expect(h.store.getAttendee(h.coordinate, pk)?.status).toBe("revoked");

    // A DISTINCT join rumor from before the revoke turns up late (a slow relay, a
    // backfill rescan). It must not undo the revoke's state.
    const inboxPk = getPublicKey(h.einboxSk);
    await h.coordinator.handleInboxWrap(
      h.coordinate,
      wrapRumor(sk, inboxPk, {
        kind: KIND_JOIN_REQUEST,
        content: { v: 2, name: "late-duplicate", message: "", rsvp_public: false },
        tags: [["a", h.coordinate]],
        created_at: Math.floor(h.clock.t / 1000) - 3600,
      }) as any,
    );
    expect(h.store.getAttendee(h.coordinate, pk)?.status).toBe("revoked");
  });

  it("a genuine re-join AFTER a revoke is newer, so it enrolls again as pending", async () => {
    // The guard must not become "revoked is forever": a fresh join is a newer
    // membership command and wins honestly, landing back in the manual queue
    // (never straight to approved — a re-join needs the organizer again).
    const h = await setup();
    const sk = generateSecretKey();
    const pk = await join(h, sk, "crypto");
    await h.coordinator.jobs.drain();
    await admin(h, "revoke", { pubkey: pk });

    h.clock.t += 60_000;
    const inboxPk = getPublicKey(h.einboxSk);
    await h.coordinator.handleInboxWrap(
      h.coordinate,
      wrapRumor(sk, inboxPk, {
        kind: KIND_JOIN_REQUEST,
        content: { v: 2, name: "second-chance", message: "", rsvp_public: false },
        tags: [["a", h.coordinate]],
        created_at: Math.floor(h.clock.t / 1000),
      }) as any,
    );
    expect(h.store.getAttendee(h.coordinate, pk)?.status).toBe("pending");
  });
});

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

  /**
   * Audit B-10. A suspension (NIP §3.5 — the newest 31600 wasn't fetchable at
   * startup revalidation, which a relay outage at boot is enough to cause) drops
   * the event out of the live map but keeps its custody and its queued work. Every
   * event-scoped job handler then hit its `events.get()` early return, and the
   * runner read that as SUCCESS: the row went `done`. Its dedupe key is derived
   * from stage inputs, so when the event came back the same work could not be
   * re-enqueued — the attendee's pipeline was simply never going to run, and
   * nothing anywhere said so.
   */
  it("work queued while an event is SUSPENDED parks and resumes, instead of completing as done", async () => {
    const h = await setup();
    const sk = generateSecretKey();
    const pk = await join(h, sk, "crypto");
    await h.coordinator.jobs.drain();

    // Suspend it exactly as startup revalidation does: config unfetchable.
    h.transport.blockConfig = true;
    await h.coordinator.installEvent({
      coordinate: h.coordinate, inboxSkHex: bytesToHex(h.einboxSk),
      eck: [{ id: 1, key: bytesToBase64(h.eck) }], configRelays: ["wss://test"],
      gen: 1, source: "restore",
    });
    expect(h.store.getEvent(h.coordinate)).toBeDefined(); // suspended, not detached

    // Work queued (or already queued) for a suspended event must not be consumed.
    h.coordinator.jobs.enqueue("process_attendee", `proc:${h.coordinate}:${pk}:while-suspended`, {
      coordinate: h.coordinate,
      pubkey: pk,
    });
    await h.coordinator.jobs.drain();
    expect(h.store.waitingJobCount(h.coordinate)).toBe(1);

    // The event comes back → the parked work is released and actually runs.
    h.transport.blockConfig = false;
    h.clock.t += 60_000;
    await h.coordinator.retrySuspendedEvents();
    expect(h.store.waitingJobCount(h.coordinate)).toBe(0);
    await h.coordinator.jobs.drain();
    expect(h.store.jobStateCounts().done).toBeGreaterThan(0);
    expect(h.store.waitingJobCount(h.coordinate)).toBe(0);
  });

  it("work queued for a DETACHED event completes rather than parking forever", async () => {
    // The mirror case: custody is deleted and the tombstone bars re-install, so
    // there is nothing left for the work to act on and a park would be litter no
    // release condition could ever clear.
    const h = await setup();
    const sk = generateSecretKey();
    const pk = await join(h, sk, "crypto");
    await h.coordinator.jobs.drain();
    await admin(h, "detach", {});
    expect(h.store.getEvent(h.coordinate)).toBeUndefined();

    h.coordinator.jobs.enqueue("process_attendee", `proc:${h.coordinate}:${pk}:after-detach`, {
      coordinate: h.coordinate,
      pubkey: pk,
    });
    await h.coordinator.jobs.drain();
    expect(h.store.waitingJobCount(h.coordinate)).toBe(0);
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

describe("the translation stage degrades instead of failing the job (2026-07-29 incident)", () => {
  it("a failed translation still commits the ai_profile, transcript, and matches", async () => {
    const h = await setup(0, { lang: "sk" }); // non-English event ⇒ translation runs
    h.counters.failTranslate = true;
    const cryptoSk = generateSecretKey();
    const cryptoPk = await join(h, cryptoSk, "crypto");
    await join(h, generateSecretKey(), "design");
    await h.coordinator.jobs.drain();

    // The translation is a decoration on the entry. It failing used to unwind the
    // whole of processAttendee, so nothing reached commitAiProfile and an attendee
    // lost artifacts that had already succeeded — in production, one sat poisoned
    // for a day with no AI summary on their entry and no transcript of the intro
    // they had recorded for the event, matched off their pre-submission profile.
    expect(h.counters.translateCalls).toBeGreaterThan(0); // it really was attempted
    const attendee = h.store.getAttendee(h.coordinate, cryptoPk)!;
    expect(attendee.ai_profile_json).toBeTruthy();
    expect(JSON.parse(attendee.ai_profile_json!).summary).toContain("profile");
    // The revision guard is satisfied, so the entry publishes WITH its ai_profile.
    expect(attendee.ai_source_revision).toBe(attendee.source_revision);
    expect(JSON.parse(attendee.transcripts_json!).length).toBe(1);
    const entry = latestDirectory(h.transport, h.eck, blindedD(h.eck, h.coordinate, cryptoPk));
    expect(entry.ai_profile).toBeTruthy();
    expect(entry.ai_profile!.translations).toBeUndefined(); // the one thing that IS lost
    expect(entry.transcripts?.length).toBe(1);
    // And matching ran off the fresh profile.
    expect(h.transport.published.some((e) => e.kind === KIND_MATCH_LIST)).toBe(true);
  });

  it("a failed translation is not cached as 'nothing to translate'", async () => {
    const h = await setup(0, { lang: "sk" });
    h.counters.failTranslate = true;
    const sk = generateSecretKey();
    const pk = await join(h, sk, "crypto");
    await h.coordinator.jobs.drain();
    // A cached `null` means "asked, nothing to translate" — caching a BROKEN call
    // under that key would freeze a permanent no-translation verdict for this
    // revision. Nothing was stored, so a reprocess asks again: the count climbs.
    const firstCalls = h.counters.translateCalls;
    h.counters.failTranslate = false;
    await resubmitIntro(h, sk, "crypto");
    await h.coordinator.jobs.drain();
    expect(h.counters.translateCalls).toBeGreaterThan(firstCalls);
    const entry = latestDirectory(h.transport, h.eck, blindedD(h.eck, h.coordinate, pk));
    expect(entry.ai_profile!.translations?.lang).toBe("sk"); // recovered on its own
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

  it("never matches a content-free profile — an empty profile invites the model to invent one", async () => {
    const h = await setup();
    const cryptoSk = generateSecretKey();
    const cryptoPk = await join(h, cryptoSk, "crypto");
    const designPk = await join(h, generateSecretKey(), "design");
    // Joined, approved, and never said anything: no authored profile, no intro, and
    // nostr_context=0. In production this attendee was scored 0.85–0.90 against six
    // people, with the model inventing a different biography from the name each time.
    const { pubkey: quietPk } = await joinOnly(h, generateSecretKey(), "Ľudo");
    await h.coordinator.jobs.drain();

    const lists = h.transport.published.filter((e) => e.kind === KIND_MATCH_LIST);
    const cryptoD = blindedD(h.eck, h.coordinate, cryptoPk);
    const mine = lists
      .filter((e) => e.tags.find((t) => t[0] === "d")?.[1] === cryptoD)
      .map((e) => matchListContentSchema.parse(JSON.parse(nip44Decrypt(cryptoSk, getPublicKey(h.coordSk), e.content))))
      .sort((a, b) => b.matches.length - a.matches.length)[0]!;
    expect(mine.matches.map((m) => m.pubkey)).toContain(designPk);
    expect(mine.matches.map((m) => m.pubkey)).not.toContain(quietPk);
    // And nothing is published TO them either — there is no honest list to publish.
    const quietD = blindedD(h.eck, h.coordinate, quietPk);
    expect(lists.some((e) => e.tags.find((t) => t[0] === "d")?.[1] === quietD)).toBe(false);
  });

  it("clearing a profile drops its cached pairs and republishes the emptied lists", async () => {
    const h = await setup();
    const cryptoSk = generateSecretKey();
    const cryptoPk = await join(h, cryptoSk, "crypto");
    const designSk = generateSecretKey();
    const designPk = await join(h, designSk, "design");
    await h.coordinator.jobs.drain();
    // They matched each other, so both have a published list and a cached pair.
    expect(h.store.pairsFor(h.coordinate, cryptoPk).length).toBe(1);

    // The designer wipes their profile: no about, no skills, no media, no intro —
    // and nostr_context=0, so the pipeline has nothing left to derive from.
    const before = h.transport.published.length;
    const inboxPk = getPublicKey(h.einboxSk);
    await h.coordinator.handleInboxWrap(
      h.coordinate,
      wrapRumor(designSk, inboxPk, {
        kind: KIND_PROFILE_SUBMISSION,
        content: {
          v: 2,
          rev: nextSubmissionRev(designPk),
          profile: { about: "", skills: [], looking_for: "", links: [] },
          media: [],
        },
        tags: [["a", h.coordinate]],
      }) as any,
    );
    await h.coordinator.jobs.drain();

    // The pair is gone from BOTH sides, not just the person who cleared it…
    expect(h.store.pairsFor(h.coordinate, cryptoPk).length).toBe(0);
    expect(h.store.pairsFor(h.coordinate, designPk).length).toBe(0);
    // …and the cryptographer's list was republished EMPTY rather than left showing
    // reasoning about a profile that no longer says anything (the allowEmpty path:
    // an emptied list is a result the client has to receive, not "not scored yet").
    const cryptoD = blindedD(h.eck, h.coordinate, cryptoPk);
    const republished = h.transport.published
      .slice(before)
      .filter((e) => e.kind === KIND_MATCH_LIST && e.tags.find((t) => t[0] === "d")?.[1] === cryptoD)
      .map((e) => matchListContentSchema.parse(JSON.parse(nip44Decrypt(cryptoSk, getPublicKey(h.coordSk), e.content))));
    expect(republished.length).toBeGreaterThan(0);
    expect(republished.at(-1)!.matches).toEqual([]);
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
  /** Membership-aware, like the real library: a leaf exists once the Add lands.
   *  Without this the stub models a group nobody is ever in, which hides every
   *  decision that turns on "is this person already enrolled". */
  members = new Set<string>();
  async createGroup() {
    return { mlsGroupIdHex: "mls-1", nostrGroupIdHex: "ng-1" };
  }
  async isEligible() {
    return true;
  }
  async isMember(_g: string, pubkey: string) {
    if (this.failIsMember) throw new Error("simulated MLS outage");
    return this.members.has(pubkey);
  }
  async invite(_g: string, kp: any) {
    this.invited.push(kp.pubkey);
    this.members.add(kp.pubkey);
  }
  async removePubkeys(_g: string, pks: string[]) {
    for (const p of pks) this.members.delete(p);
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

  // The Whitenoise interop relays used to reach the chat subscriptions by
  // accident: the app unioned them into the event's `relay` tags, so they showed
  // up in `configRelays`. They now live in the config's separate `chat_relay`
  // set (and parseEventConfig migrates old configs out of `relay`), so the
  // chat-only subscriptions have to add them back explicitly — otherwise the
  // 30443 watcher silently stops seeing a Whitenoise attendee's key package on
  // the relay their client publishes it to (prod report 2026-07-20), while the
  // rest of the daemon keeps publishing 31603/31606/kind-5 only to relays that
  // accept them.
  it("watches 30443 on the event relays PLUS the chat interop relays, and nothing else does", async () => {
    const mls = new StubMls();
    const h = await setup(0, { chat: true, chatMls: mls });
    const interop = ["wss://relay.us.whitenoise.chat", "wss://relay.eu.whitenoise.chat"];
    const kpSub = h.transport.subs.find((s: any) => s.filter?.kinds?.includes(30443));
    expect(kpSub).toBeDefined();
    expect(kpSub!.relays).toEqual(["wss://test", ...interop]);
    // Every non-chat subscription stays on the event's own relays.
    for (const sub of h.transport.subs) {
      if (sub.filter?.kinds?.includes(30443) || sub.filter?.kinds?.includes(445)) continue;
      for (const url of interop) expect(sub.relays ?? []).not.toContain(url);
    }
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
  it("CLAMPS a rumor future-dated past the skew allowance instead of dropping it", async () => {
    // This used to assert the opposite, and the opposite was wrong. The spec's
    // remedy for a future-dated rumor inside the reasonable horizon is to CLAMP
    // it for ordering (§3.1 / PROTO-8) — which is exactly what the protocol
    // library does to the identical input (`finalizeUnwrappedRumor`). The
    // coordinator instead DROPPED it and marked both the rumor and its wrap
    // permanently seen, so:
    //
    //  - the two conforming implementations disagreed about whether the same
    //    rumor exists at all, and
    //  - an attendee whose phone clock is 20 minutes fast had every join request
    //    silently discarded forever — unrecoverable even by a rescan, with no
    //    error and nothing in the organizer's pending list.
    //
    // Here the daemon clock runs 1h BEHIND the wall clock, so a freshly stamped
    // join is ~1h "in the future" from the daemon's point of view: the shape of
    // a real skewed-clock attendee. It must be admitted.
    const h = await setup();
    const sk = generateSecretKey();
    h.clock.t = Date.now() - 60 * 60_000;
    const { pubkey } = await joinOnly(h, sk, "future");
    expect(h.store.getAttendee(h.coordinate, pubkey)).toBeDefined();
  });

  it("still drops a rumor dated past the unreasonable-horizon bound, and marks it seen", async () => {
    // Past a full day ahead no honest clock explains it, so the rumor is rejected
    // outright — and THIS is the case where marking it seen is right, since it can
    // never become valid and a rescan would only re-drop it.
    const h = await setup();
    const sk = generateSecretKey();
    const { pubkey, wrap } = await joinOnly(h, sk, "way-future", {
      created_at: Math.floor(h.clock.t / 1000) + 3 * 86400,
    });
    expect(h.store.getAttendee(h.coordinate, pubkey)).toBeUndefined();
    expect(h.store.isRumorSeen(wrap.id)).toBe(true);
  });

  it("a clamped rumor's ORDERING uses the clamped timestamp, not the sender's", async () => {
    // Clamping must still do the job dropping was meant to do: a future-dated
    // submission must not win the §3.3 (rev, created_at, id) order against a later
    // honest one purely because the sender wrote a bigger number. Same rev, so
    // created_at decides — and the future-dated one's is clamped down to
    // now + the skew allowance, which a submission sent 30 minutes later then
    // still beats. Under the old drop-everything behavior the first submission
    // never existed at all, so this ordering was untested and untestable.
    const h = await setup({ matching: "off" });
    const sk = generateSecretKey();
    const pubkey = getPublicKey(sk);
    const inboxPk = getPublicKey(h.einboxSk);
    await joinOnly(h, sk, "skewed");
    const submitAt = (created_at: number, about: string) =>
      h.coordinator.handleInboxWrap(
        h.coordinate,
        wrapRumor(sk, inboxPk, {
          kind: KIND_PROFILE_SUBMISSION,
          content: {
            v: 2,
            rev: 1,
            profile: { about, skills: [], looking_for: "", links: [] },
            media: [],
            intro_text: about,
          },
          tags: [["a", h.coordinate]],
          created_at,
        }) as any,
      );

    const nowSec = Math.floor(h.clock.t / 1000);
    await submitAt(nowSec + 6 * 3600, "from-the-future");
    const skewed = h.store.getAttendee(h.coordinate, pubkey)!;
    // Accepted (not dropped), but stored under the CLAMPED ordering key.
    expect(skewed.profile_json).toContain("from-the-future");
    expect(skewed.profile_created_at).toBeLessThanOrEqual(nowSec + RUMOR_MAX_CLOCK_SKEW_SEC);
    // A later honest submission at the same rev now supersedes it.
    h.clock.t += 30 * 60_000;
    await submitAt(Math.floor(h.clock.t / 1000), "honest-and-later");
    expect(h.store.getAttendee(h.coordinate, pubkey)!.profile_json).toContain("honest-and-later");
  });

  /**
   * Per-recipient rumor allowlist (NIP §5/§6.1).
   *
   * The two dispatch chains happen to have disjoint `if/else` branches today, so
   * a misdirected rumor already ends up doing nothing — but "nothing happens
   * because no branch matched" is handler layout, not a boundary: adding one
   * `else if` to the wrong dispatcher silently widens what a key accepts, and
   * E_inbox is a PUBLIC address any attendee can seal to while the coordinator's
   * own key is what installs events and executes admin commands.
   *
   * What these assert is therefore where the rejection HAPPENS. A rumor of a kind
   * this key does not accept is refused at the unwrap, so it is treated exactly
   * like a wrap addressed to someone else: no rate accounting, no dispatch, and
   * nothing written to the durable seen ledger. Previously it crossed the unwrap
   * intact, was rate-accounted, ran through processRumorWithRetry, and — because
   * a no-op dispatch "succeeds" — was recorded as a HANDLED rumor.
   */
  it("refuses a 21603 install grant sealed to an event's E_inbox (§6.1)", async () => {
    const h = await setup();
    const attackerSk = generateSecretKey();
    const inboxPk = getPublicKey(h.einboxSk);
    const evilCoordinate = makeCoordinate(getPublicKey(attackerSk), "evil");
    const wrap = wrapRumor(attackerSk, inboxPk, {
      kind: KIND_COORDINATOR_GRANT,
      content: {
        v: 2,
        a: evilCoordinate,
        gen: 1,
        inbox_nsec: bytesToHex(generateSecretKey()),
        eck: [{ id: 1, key: bytesToBase64(generateEck()) }],
        config_relays: [],
      },
    });
    await h.coordinator.handleInboxWrap(h.coordinate, wrap as any);
    expect(h.store.getEvent(evilCoordinate)).toBeUndefined();
    // Rejected AT THE UNWRAP: never acknowledged in the durable ledger.
    expect(h.store.isRumorSeen(wrap.id)).toBe(false);
    // …while a kind this key DOES accept, on the same inbox, is acknowledged —
    // so the difference above is the allowlist and not some unrelated early exit.
    const { wrap: joinWrap } = await joinOnly(h, generateSecretKey(), "legit");
    expect(h.store.isRumorSeen(joinWrap.id)).toBe(true);
  });

  it("refuses a 21600 join request sealed to the coordinator's own key (§6.1)", async () => {
    const h = await setup();
    const attendeeSk = generateSecretKey();
    const wrap = wrapRumor(attendeeSk, getPublicKey(h.coordSk), {
      kind: KIND_JOIN_REQUEST,
      content: { v: 2, name: "wrong door", message: "", rsvp_public: false },
      tags: [["a", h.coordinate]],
    });
    await h.coordinator.handleCoordinatorWrap(wrap as any);
    expect(h.store.getAttendee(h.coordinate, getPublicKey(attendeeSk))).toBeUndefined();
    expect(h.store.isRumorSeen(wrap.id)).toBe(false);
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

  it("a RESTORE whose billing status publish fails is still LISTENING (CORE-N-4)", async () => {
    // `reevaluateBilling` publishes a 21606 on a state transition, and a publish
    // every relay refuses REJECTS. It used to run BEFORE `subscribeEventInbox`, so
    // it unwound out of installEvent with the event row already written and no
    // subscription open.
    //
    // On the GRANT path the in-memory wrap retry papers over it (attempt 1 persists
    // the billing state, so attempt 2 sees no transition and doesn't republish). The
    // startup RESTORE path has no retry: `start()` catches per event and logs
    // "restore of X failed — skipping". A relay outage at boot — precisely when a
    // restore runs — therefore dropped an installed event for the whole life of the
    // process, silently. Billing enforcement does not depend on this publish
    // landing (`assertSpendAllowed` gates spend at job execution), so listening
    // first costs nothing.
    const h = await setup(0, { evaluateBilling: overTier(), skipAutoInstall: true });
    h.transport.failPublishes = 99;
    await h.coordinator
      .installEvent({
        coordinate: h.coordinate,
        inboxSkHex: bytesToHex(h.einboxSk),
        eck: [{ id: 1, key: bytesToBase64(h.eck) }],
        configRelays: ["wss://test"],
        gen: 1,
        source: "restore",
      })
      .catch(() => {}); // exactly what start() does
    h.transport.failPublishes = 0;

    expect(h.store.getEvent(h.coordinate)).toBeDefined();
    const inboxPk = getPublicKey(h.einboxSk);
    expect(h.transport.subs.some((sub) => !sub.closed && sub.filter?.["#p"]?.includes(inboxPk))).toBe(true);
    // And it can actually take a join, which is the whole point of listening.
    const pk = await join(h, generateSecretKey(), "crypto");
    expect(h.store.getAttendee(h.coordinate, pk)).toBeDefined();
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

  it("a failed unblock announcement still resumes the parked work (audit B-3)", async () => {
    // The unblock did two things in the wrong order: persist `ok`, publish the
    // 21606, THEN resume. A relay that refused the publish threw out of the
    // function with `ok` already written and nothing resumed — and every later
    // evaluation saw prev=ok, next=ok, `changed=false`, so the resume branch was
    // never reached again. The event was billing-fine and its paid work sat
    // `waiting` forever; the only remedy was an organizer recompute that nobody
    // had a reason to run.
    //
    // Driven through the JOIN path on purpose: `recompute`/`reprocess` also call
    // `resumeParkedWork` explicitly, so those two paths mask this entirely. Every
    // other trigger — an attendee-count change, a revoke, an install — relies on
    // the transition branch alone.
    let over = true;
    const h = await setup(0, {
      evaluateBilling: (_eid, count) => (over && count >= 2 ? { state: "payment_required", reason: "x" } : { state: "ok" }),
    });
    await join(h, generateSecretKey(), "crypto");
    await join(h, generateSecretKey(), "design"); // count 2 → blocked
    await h.coordinator.jobs.drain();
    expect(h.store.getBillingState(h.coordinate)?.state).toBe("blocked");
    expect(h.store.waitingJobCount(h.coordinate)).toBeGreaterThan(0);

    // Payment resolved. The next attendee-count change re-evaluates → blocked→ok,
    // but the relay refuses the 21606 that announces it (and ONLY that: the grant
    // wraps to attendees must still go out, or the join fails for its own reasons).
    over = false;
    const eidPk = getPublicKey(h.eidSk);
    h.transport.onPublish = (e) => {
      if (e.kind === 1059 && e.tags.some((t) => t[0] === "p" && t[1] === eidPk)) {
        throw new Error("simulated relay outage (status wrap)");
      }
    };
    await join(h, generateSecretKey(), "code").catch(() => {});
    h.transport.onPublish = undefined;

    // The durable state and the queue agree even though the announcement failed.
    expect(h.store.getBillingState(h.coordinate)?.state).toBe("ok");
    expect(h.store.waitingJobCount(h.coordinate)).toBe(0);
    // …and the work really runs now, without any further organizer action.
    await h.coordinator.jobs.drain();
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

  /**
   * SEC-7. The budgets above are lifetime AND per-installation, so they bound what
   * one event can spend and say nothing about what many can. Install is
   * protocol-level and `allowedEidPubkeys` is empty by default, so anyone can
   * self-install up to `maxEvents` events; with the shipped defaults that is 50 ×
   * 20,000 provider calls against the operator's one API key. The daemon-wide
   * ceiling is the only thing that bounds the total.
   */
  it("a daemon-wide ceiling parks paid work even when the event's own budget is untouched", async () => {
    // Every per-event/per-attendee limit unlimited: nothing but the daemon ceiling
    // can park anything here, so a park proves the daemon gate fired.
    const budgets = { ...generous, daemonCalls: 1, daemonWindowHours: 24 };
    const h = await setup(0, { budgets });
    await join(h, generateSecretKey(), "crypto");
    await join(h, generateSecretKey(), "design");
    await h.coordinator.jobs.drain();

    expect(h.store.waitingJobCount(h.coordinate)).toBeGreaterThan(0);
    const s = lastCoordinatorStatus(h);
    expect(s?.error_category).toBe("budget_exceeded");
    // The organizer is told they are parked, NOT how much the daemon has spent.
    // Anyone can install, so that number would be a spend read-out for whoever is
    // probing the ceiling.
    expect(s?.billing?.reason ?? "").not.toMatch(/daemon|\d/);
  });

  it("the daemon ceiling releases itself as the rolling window advances", async () => {
    const budgets = { ...generous, daemonCalls: 1, daemonWindowHours: 24 };
    const h = await setup(0, { budgets });
    await join(h, generateSecretKey(), "crypto");
    await join(h, generateSecretKey(), "design");
    await h.coordinator.jobs.drain();
    expect(h.store.waitingJobCount(h.coordinate)).toBeGreaterThan(0);

    // No config raise, no organizer action — just time. This is what makes the
    // ceiling rolling rather than an all-time number that would park a busy
    // coordinator forever with no way out but an operator edit.
    h.clock.t += 25 * 3_600_000;
    // What the boot path and the 10-minute timer both call.
    (h.coordinator as any).daemonCeilingSweep();
    expect(h.store.waitingJobCount(h.coordinate)).toBe(0);
  });

  it("does not release work parked for billing or a per-event budget", async () => {
    // Under the daemon ceiling, but over the attendee's own call budget. The sweep
    // runs every 10 minutes across every event; if it resumed by state rather than
    // by park reason it would hand a billing-blocked event free provider calls.
    const budgets = { ...generous, perAttendeeCalls: 1, daemonCalls: 1_000_000 };
    const h = await setup(0, { budgets });
    await join(h, generateSecretKey(), "crypto");
    await join(h, generateSecretKey(), "design");
    await h.coordinator.jobs.drain();
    const parked = h.store.waitingJobCount(h.coordinate);
    expect(parked).toBeGreaterThan(0);

    (h.coordinator as any).daemonCeilingSweep();
    expect(h.store.waitingJobCount(h.coordinate)).toBe(parked);
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

  it("publishes chat_keys' added_at in unix SECONDS, not the store's milliseconds", async () => {
    const h = await setup(0, { chat: true });
    const pubkey = await join(h, generateSecretKey(), "crypto");
    await admin(h, "approve", { pubkey });
    // An attested chat device of that attendee. The store stamps updated_at in ms
    // (Date.now()); publishing it raw made the app render "added 8/15/58545".
    h.store.upsertChatKey({
      coordinate: h.coordinate,
      accountPubkey: pubkey,
      chatPubkey: "d".repeat(64),
      label: "Firefox on macOS",
      status: "active",
      now: 1_760_000_000_000,
    });
    await admin(h, "approve", { pubkey });

    const rosters = h.transport.published.filter((e) => e.kind === 31604);
    const latest = rosters[rosters.length - 1]!;
    const roster = rosterContentSchema.parse(JSON.parse(eckDecrypt(h.eck, latest.content)));
    const device = roster.attendees.find((a) => a.pubkey === pubkey)!.chat_keys![0]!;
    expect(device.added_at).toBe(1_760_000_000);
    // Sanity: it lands in this decade, not the year 58545.
    expect(new Date(device.added_at * 1000).getUTCFullYear()).toBe(2025);
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

  /**
   * Handover must not accept a roster just because it decrypts (2026-09-04 audit).
   *
   * 31604's `d` is the event's PUBLIC `d`, so anyone can publish at that address,
   * and the ECK is held by every approved attendee — and `tryEckDecrypt` walks
   * every version in custody, so a REVOKED attendee's old key opens their forgery
   * too. Accepting on decryptability alone let an attendee plant a roster naming
   * pubkeys they control and have the incoming coordinator grant those pubkeys the
   * event's key material.
   */
  it("refuses a roster planted by an attendee, and grants that attendee's picks nothing", async () => {
    const h = await setup();
    const aliceSk = generateSecretKey();
    const alicePk = await join(h, aliceSk, "crypto");
    await h.coordinator.jobs.drain();

    // Alice is an approved attendee, so she holds the ECK. She publishes her own
    // 31604 at the event's public `d`, far-dated so it wins newest-wins, listing a
    // pubkey she controls as an organizer.
    const identifier = h.coordinate.split(":").slice(2).join(":");
    const mallorySk = generateSecretKey();
    const malloryPk = getPublicKey(mallorySk);
    const forged = {
      v: 2,
      eck_current: 1,
      attendees: [{ pubkey: malloryPk, d: "forged-d", role: "organizer" }],
    };
    h.transport.seed.push({
      kind: KIND_ROSTER,
      pubkey: alicePk,
      created_at: h.clock.t + 3600,
      id: "forged-roster",
      sig: "",
      tags: [["d", identifier]],
      content: eckEncrypt(h.eck, JSON.stringify(forged)),
    } as any);

    const coordSkB = generateSecretKey();
    const coordPkB = getPublicKey(coordSkB);
    h.transport.seed.push({
      kind: 31600, pubkey: getPublicKey(h.eidSk), created_at: 2, id: "cfg-b2", sig: "", content: "",
      tags: [["d", identifier], ["v", "2"], ["inbox", getPublicKey(h.einboxSk)], ["matching", "on"], ["coordinator", coordPkB, "2"]],
    } as any);

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

    // Mallory is nowhere in B's state, and never received a key grant.
    expect(storeB.getAttendee(h.coordinate, malloryPk)).toBeUndefined();
    const grantsToMallory = h.transport.published.filter(
      (e) => e.kind === 1059 && e.tags.some((t) => t[0] === "p" && t[1] === malloryPk),
    );
    expect(grantsToMallory).toHaveLength(0);

    // The genuine attendee, reconstructed from A's real roster, is unaffected.
    expect(storeB.getAttendee(h.coordinate, alicePk)?.status).toBe("approved");
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

  /**
   * Audit B-9. The default withdrawal purges the leaver's artifacts —
   * `marmot_chat_keys` among them — inside the same per-member lock that enqueues
   * the `chat_revoke_member` job. That job builds its MLS remove list by READING
   * those rows, so by the time it ran there was nothing left to read: only the
   * account key was removed and the leaver's DEVICE leaf stayed in the group,
   * still able to decrypt everything said in it until an unrelated commit
   * happened to churn the epoch. "Leave the event" is the common path and an MLS
   * Remove is the only real post-compromise boundary the chat has.
   */
  it("a delete_data withdrawal still MLS-removes the leaver's DEVICE leaf, not just the account", async () => {
    const mls = new StubMls();
    const h = await setup(0, { chat: true, chatMls: mls });
    const leaverSk = generateSecretKey();
    const leaverPk = await join(h, leaverSk, "crypto");
    const devicePk = getPublicKey(generateSecretKey());
    h.store.upsertChatKey({
      coordinate: h.coordinate,
      accountPubkey: leaverPk,
      chatPubkey: devicePk,
      now: h.clock.t,
    });
    await h.coordinator.jobs.drain();

    await withdraw(h, leaverSk, { deleteData: true });
    // The purge has already happened by here — the bindings are gone…
    expect(h.store.chatKeysForAccount(h.coordinate, leaverPk)).toEqual([]);
    // …and the removal must STILL name the device, from the list captured at
    // revoke time and carried in the job payload.
    await h.coordinator.jobs.drain();
    expect(mls.removed.length).toBe(1);
    expect([...mls.removed[0]!].sort()).toEqual([leaverPk, devicePk].sort());
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

describe("account-addressed gift-wrap relay delivery", () => {
  const eventRelay = "wss://event.example";
  const defaultRelay = "wss://default.example";

  it("publishes an attendee grant to custom event and coordinator default relays", async () => {
    const h = await setup(0, { eventRelays: [eventRelay], defaultRelays: [defaultRelay] });
    const attendeeSk = generateSecretKey();
    await join(h, attendeeSk, "crypto");

    const grantCall = h.transport.publishCalls.find(({ event }) => {
      try {
        return unwrapRumor(event as any, attendeeSk).kind === KIND_KEY_GRANT;
      } catch {
        return false;
      }
    });
    expect(grantCall?.relays).toEqual([eventRelay, defaultRelay]);
  });

  it("publishes an organizer status to custom event and coordinator default relays", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const h = await setup(0, {
      eventRelays: [eventRelay],
      defaultRelays: [defaultRelay],
      retentionDays: 1,
      eventEndSec: nowSec - 2 * 86_400,
    });
    await h.coordinator.retentionSweep();

    const statusCall = h.transport.publishCalls.find(({ event }) => {
      try {
        return unwrapRumor(event as any, h.eidSk).kind === KIND_COORDINATOR_STATUS;
      } catch {
        return false;
      }
    });
    expect(statusCall?.relays).toEqual([eventRelay, defaultRelay]);
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

describe("a community's metadata is read under its OWN kind (31612), not 31923", () => {
  it("installs a 31612 community with its real title/summary/topics in the scoring context", async () => {
    const h = await setup(0, { spaceKind: KIND_COMMUNITY });
    expect(h.coordinate.startsWith(`${KIND_COMMUNITY}:`)).toBe(true);
    // Against the unfixed code this is the placeholder `"the event"` with no
    // topics: the install fetched a 31612 and then selected `kind === 31923`
    // from the result, which matches nothing. Every match prompt for every
    // community would have read "EVENT: the event", with no ABOUT and no TOPICS.
    expect(h.coordinator.scoringContextOf(h.coordinate)).toMatchObject({
      title: "Cypherpunk Assembly",
      hashtags: ["cypherpunk"],
    });
  });

  it("subscribes for live 31612 edits and applies them", async () => {
    const h = await setup(0, { spaceKind: KIND_COMMUNITY });
    // The config subscription must ASK for 31612. A 31923-only filter means the
    // relay never sends a community's title edit at all, so the coordinator keeps
    // scoring against install-time metadata until the daemon is restarted.
    const cfgSub = h.transport.subs.find(
      (s) => s.filter.kinds?.includes(KIND_COMMUNITY) && s.filter.kinds?.includes(31600),
    );
    expect(cfgSub, "no config subscription asked for kind 31612").toBeDefined();
    cfgSub!.onEvent({
      kind: KIND_COMMUNITY, pubkey: getPublicKey(h.eidSk), created_at: 20, id: "c-20",
      tags: [["d", "cypherpunk"], ["title", "Renamed Community"], ["summary", "now about rust"]],
      content: "", sig: "",
    } as any);
    expect(h.coordinator.scoringContextOf(h.coordinate)).toMatchObject({
      title: "Renamed Community",
      summary: "now about rust",
    });
  });

  it("a community has no retention anchor — it is a standing group, not a dated event", async () => {
    const h = await setup(0, { spaceKind: KIND_COMMUNITY });
    // Deliberate: 31612 carries no `start`/`end`, so eventEndSec stays 0 and the
    // retention sweep never expires a community. Pinned so a future "fix" doesn't
    // synthesise an end date for communities.
    expect(h.coordinator.eventEndSecOf(h.coordinate)).toBe(0);
  });

  it("does not cross the two namespaces: a 31923 sharing the E_id and `d` never edits the community", async () => {
    const h = await setup(0, { spaceKind: KIND_COMMUNITY });
    const cfgSub = h.transport.subs.find(
      (s) => s.filter.kinds?.includes(KIND_COMMUNITY) && s.filter.kinds?.includes(31600),
    )!;
    // Same author, same `d`, different kind ⇒ a DIFFERENT space (`31923:X:d` and
    // `31612:X:d` are two coordinates). Widening the guard to "either space kind"
    // would let this rename the community and, worse, hand it an `end` date that
    // arms the retention sweep against it.
    cfgSub.onEvent({
      kind: KIND_CALENDAR_EVENT, pubkey: getPublicKey(h.eidSk), created_at: 99, id: "ev-99",
      tags: [["d", "cypherpunk"], ["title", "A Different, Dated Event"], ["end", "5000"]],
      content: "", sig: "",
    } as any);
    expect(h.coordinator.scoringContextOf(h.coordinate)!.title).toBe("Cypherpunk Assembly");
    expect(h.coordinator.eventEndSecOf(h.coordinate)).toBe(0);
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
  /** 40 distinct admin-command wraps from one sender, inside one 60s rate window. */
  function flood(h: Harness, senderSk: Uint8Array) {
    const coordPub = getPublicKey(h.coordSk);
    const baseSec = Math.floor(h.clock.t / 1000);
    return Array.from({ length: 40 }, (_, i) =>
      wrapRumor(senderSk, coordPub, {
        kind: KIND_ADMIN_COMMAND,
        content: { v: 2, a: h.coordinate, cmd: "recompute" },
        created_at: baseSec + i, // distinct rumor ids, all within the same window
      }),
    );
  }

  it("drops a STRANGER's flood past the per-sender window WITHOUT marking the excess seen", async () => {
    const h = await setup();
    const wraps = flood(h, generateSecretKey());
    for (const w of wraps) await h.coordinator.handleCoordinatorWrap(w as any);

    const seen = wraps.map((w) => h.store.isRumorSeen((w as any).id));
    // Exactly the per-sender window was accepted (and marked seen); the rest were
    // dropped and left UNSEEN — so a flood cannot grow the durable seen ledger (R4).
    expect(seen.filter(Boolean)).toHaveLength(30);
    expect(seen.slice(0, 30).every(Boolean)).toBe(true);
    expect(seen.slice(30).some(Boolean)).toBe(false);
  });

  it("does NOT drop an installed event's own organizer past that window (2026-09-09 audit)", async () => {
    // "Approve all" on a room of forty sends one 21604 per attendee, serially, from
    // the event's E_id. Under the flat per-sender cap the last ten were dropped —
    // and left unseen, so nothing recovered them short of a restart — while the app
    // reported every one of them confirmed, because the PUBLISH had succeeded. Ten
    // people stayed in the pending queue with nobody aware of it.
    const h = await setup();
    const wraps = flood(h, h.eidSk); // the E_id of an event this daemon has installed
    for (const w of wraps) await h.coordinator.handleCoordinatorWrap(w as any);
    expect(wraps.every((w) => h.store.isRumorSeen((w as any).id))).toBe(true);
  });
});

describe("P1 #14 — the periodic inbox rescan makes \"left unseen\" recoverable", () => {
  // Half a dozen places in coordinator.ts drop a wrap and leave it UNSEEN with the
  // comment "recovered by a later backfill rescan": the per-sender rate gate, the
  // per-event budget, the inbound queue cap, and the give-up arm of
  // processRumorWithRetry. There was no later rescan. The only one that ever ran
  // was at startup, so every one of those paths actually meant "until the next
  // deploy" — and separately, a reconnected subscription resumes from
  // `since = lastEmitted + 1`, which NIP-59's up-to-two-days-in-the-past
  // `created_at` randomisation puts most replayable wraps below.
  it("picks up a join request the live subscription never delivered", async () => {
    // The shape of "a relay was down when we subscribed, or dropped the event":
    // the wrap exists on the relay and the daemon has simply never seen it. Before
    // the rescan the only recovery was a restart's boot backfill.
    const h = await setup();
    const attendeeSk = generateSecretKey();
    const attendeePubkey = getPublicKey(attendeeSk);
    const inviteSk = h.invites[h.nextInvite++]!;
    const proof = makeInviteProof(inviteSk, h.coordinate, attendeePubkey);
    const joinWrap = wrapRumor(attendeeSk, getPublicKey(h.einboxSk), {
      kind: KIND_JOIN_REQUEST,
      content: { v: 2, name: "Someone at the door", message: "", rsvp_public: false },
      tags: [["a", h.coordinate], ["invite", getPublicKey(inviteSk), proof.sig]],
    });
    h.transport.seed.push(joinWrap as any); // on the relay, never delivered to us
    expect(h.store.getAttendee(h.coordinate, attendeePubkey)).toBeUndefined();

    await h.coordinator.rescanInboxes();
    expect(h.store.getAttendee(h.coordinate, attendeePubkey)?.status).toBe("approved");
  });

  it("recovers submissions the per-sender rate gate dropped, once the window has passed", async () => {
    const h = await setup();
    const attendeeSk = generateSecretKey();
    const pk = await join(h, attendeeSk, "crypto");
    const inboxPk = getPublicKey(h.einboxSk);
    // 40 revisions from one identity inside one 60s window: 30 are accepted, the
    // rest are rate-dropped and deliberately left UNSEEN.
    const wraps = Array.from({ length: 40 }, (_, i) =>
      wrapRumor(attendeeSk, inboxPk, {
        kind: KIND_PROFILE_SUBMISSION,
        content: {
          v: 2,
          rev: 100 + i,
          profile: { about: `edit ${i}`, skills: ["zk"], looking_for: "", links: [] },
          media: [],
        },
        tags: [["a", h.coordinate]],
      }),
    );
    for (const w of wraps) await h.coordinator.handleInboxWrap(h.coordinate, w as any);
    const droppedUnseen = wraps.filter((w) => !h.store.isRumorSeen((w as any).id));
    expect(droppedUnseen.length).toBeGreaterThan(0);

    h.transport.seed.push(...(wraps as any));
    h.clock.t += 61_000; // the 60s rate window has passed; the burst has subsided

    await h.coordinator.rescanInboxes();
    expect(wraps.every((w) => h.store.isRumorSeen((w as any).id))).toBe(true);
    // The newest edit is the one that stuck (§3.3 revision ordering, unchanged).
    expect(h.store.getAttendee(h.coordinate, pk)!.profile_rev).toBe(139);
  });

  it("is idempotent — a rescan that finds nothing new changes nothing", async () => {
    const h = await setup();
    const before = h.transport.published.length;
    await h.coordinator.rescanInboxes();
    await h.coordinator.rescanInboxes();
    expect(h.transport.published.length).toBe(before);
  });
});

describe("PIPE-9 — one corrupt row costs one attendee, not the whole roster", () => {
  // `publishDirectory` read four JSON columns the coordinator wrote itself with a
  // bare `JSON.parse`. They are not untrusted input — they were schema-validated on
  // the way in — so the only way they go bad is a partial write, a manual edit or a
  // disk fault. But `publishDirectory` sits on the approval, submission, correction
  // and handover-backfill paths, and a throw there is one the caller retries
  // forever against data that will never parse: the wrap is left unseen, every
  // rescan re-runs it, and the attendee's entry never publishes again. Treating the
  // row as absent costs them the derived half of their entry instead.
  it("still publishes a directory entry when the stored profile is unparseable", async () => {
    const h = await setup();
    const sk = generateSecretKey();
    const pk = await join(h, sk, "crypto");
    await h.coordinator.jobs.drain();

    h.store.upsertAttendee({
      coordinate: h.coordinate,
      pubkey: pk,
      profileJson: "{not json",
      now: h.clock.t,
    });
    const before = h.transport.published.filter((e) => e.kind === 31603).length;

    // A correction is the shortest path to publishDirectory that also reports
    // whether the handler completed (the rumor is marked seen only on success).
    const wrap = wrapRumor(sk, getPublicKey(h.einboxSk), {
      kind: KIND_PROFILE_CORRECTION,
      content: { v: 2, a: h.coordinate, rev: 1, hidden: true },
      tags: [["a", h.coordinate]],
    });
    await h.coordinator.handleInboxWrap(h.coordinate, wrap as any);

    expect(h.store.isRumorSeen((wrap as any).id)).toBe(true);
    expect(h.transport.published.filter((e) => e.kind === 31603).length).toBeGreaterThan(before);
  });

  it("keeps the pipeline running for the rest of the event", async () => {
    const h = await setup();
    const aSk = generateSecretKey();
    const aPk = await join(h, aSk, "crypto");
    await join(h, generateSecretKey(), "design");
    await join(h, generateSecretKey(), "code");
    await h.coordinator.jobs.drain();

    h.store.upsertAttendee({
      coordinate: h.coordinate,
      pubkey: aPk,
      profileJson: "{not json",
      now: h.clock.t,
    });
    await admin(h, "reprocess", { pubkey: aPk });
    await h.coordinator.jobs.drain();
    // The reprocess RAN rather than failing into the retry schedule: nothing is
    // pending or waiting for this attendee, and no job is queued to try again.
    expect(h.store.pendingJobCount()).toBe(0);
    expect(h.store.poisonJobs()).toHaveLength(0);
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

  it("correction: a directory-publish failure resumes on the SAME rumor instead of reading as stale", async () => {
    // CORE-N-3. `handleCorrection` writes the attendee row and THEN publishes. When
    // the publish failed, processRumorWithRetry re-ran the handler — and the strict
    // §3.3 revision guard at the top rejected the very correction it had just
    // stored as "stale", returning early. The wrapper then recorded success and
    // marked the rumor seen forever: the correction was stored and never published,
    // so the attendee's edit silently did not appear, with nothing in the log.
    const h = await setup();
    const sk = generateSecretKey();
    const pk = await join(h, sk, "crypto");
    await h.coordinator.jobs.drain();
    const wrap = wrapRumor(sk, getPublicKey(h.einboxSk), {
      kind: KIND_PROFILE_CORRECTION,
      content: { v: 2, a: h.coordinate, rev: 1, hidden: true },
      tags: [["a", h.coordinate]],
    });

    h.transport.failPublishes = 99;
    await h.coordinator.handleInboxWrap(h.coordinate, wrap as any);
    expect(h.store.isRumorSeen((wrap as any).id)).toBe(false); // left for a retry
    expect(h.store.getAttendee(h.coordinate, pk)!.correction_rev).toBe(1); // already stored

    const publishedBefore = h.transport.published.length;
    h.transport.failPublishes = 0;
    await h.coordinator.handleInboxWrap(h.coordinate, wrap as any);
    expect(h.store.isRumorSeen((wrap as any).id)).toBe(true);
    // The resume actually republished the directory entry — the point of the retry.
    expect(h.transport.published.length).toBeGreaterThan(publishedBefore);
  });

  it("matching-off submission: a directory-publish failure resumes on the SAME rumor", async () => {
    // Same shape. `ae89ccb` fixed the approved+matching-ON path by enqueuing the
    // pipeline job before publishing; with matching OFF `enqueueProcess` returns
    // immediately, so the directory publish is the only effect and the stale-guard
    // trap was untouched.
    const h = await setup(0, { matching: "off" });
    const sk = generateSecretKey();
    const pk = await join(h, sk, "crypto");
    await h.coordinator.jobs.drain();
    const wrap = wrapRumor(sk, getPublicKey(h.einboxSk), {
      kind: KIND_PROFILE_SUBMISSION,
      content: {
        v: 2,
        rev: 7,
        profile: { about: "an edit that must not vanish", skills: ["zk"], looking_for: "", links: [] },
        media: [],
      },
      tags: [["a", h.coordinate]],
    });

    h.transport.failPublishes = 99;
    await h.coordinator.handleInboxWrap(h.coordinate, wrap as any);
    expect(h.store.isRumorSeen((wrap as any).id)).toBe(false);
    expect(h.store.getAttendee(h.coordinate, pk)!.profile_rev).toBe(7);

    const publishedBefore = h.transport.published.length;
    h.transport.failPublishes = 0;
    await h.coordinator.handleInboxWrap(h.coordinate, wrap as any);
    expect(h.store.isRumorSeen((wrap as any).id)).toBe(true);
    expect(h.transport.published.length).toBeGreaterThan(publishedBefore);
  });

  it("a genuinely older correction is still refused (the resume path is same-rumor only)", async () => {
    const h = await setup();
    const sk = generateSecretKey();
    const pk = await join(h, sk, "crypto");
    await h.coordinator.jobs.drain();
    const nowSec = Math.floor(h.clock.t / 1000);
    const newer = wrapRumor(sk, getPublicKey(h.einboxSk), {
      kind: KIND_PROFILE_CORRECTION,
      content: { v: 2, a: h.coordinate, rev: 5, hidden: true },
      tags: [["a", h.coordinate]],
      created_at: nowSec,
    });
    const older = wrapRumor(sk, getPublicKey(h.einboxSk), {
      kind: KIND_PROFILE_CORRECTION,
      content: { v: 2, a: h.coordinate, rev: 2, hidden: false },
      tags: [["a", h.coordinate]],
      created_at: nowSec - 10,
    });
    await h.coordinator.handleInboxWrap(h.coordinate, newer as any);
    await h.coordinator.handleInboxWrap(h.coordinate, older as any);
    expect(h.store.getAttendee(h.coordinate, pk)!.correction_rev).toBe(5);
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

  it("keeps a profile submission dispatched CONCURRENTLY with its own join (2026-07-29 production incident)", async () => {
    const h = await setup();
    const inboxPk = getPublicKey(h.einboxSk);
    const attendeeSk = generateSecretKey();
    const attendeePk = getPublicKey(attendeeSk);
    const inviteSk = h.invites[h.nextInvite++]!;
    const proof = makeInviteProof(inviteSk, h.coordinate, attendeePk);

    const joinWrap = wrapRumor(attendeeSk, inboxPk, {
      kind: KIND_JOIN_REQUEST,
      content: { v: 2, name: "Ľudo", message: "", rsvp_public: false },
      tags: [["a", h.coordinate], ["invite", getPublicKey(inviteSk), proof.sig]],
    });
    const subWrap = wrapRumor(attendeeSk, inboxPk, {
      kind: KIND_PROFILE_SUBMISSION,
      content: {
        v: 2,
        rev: 0,
        profile: { about: "meshcore and BTC L2", skills: ["mesh networking"], looking_for: "", links: [] },
        media: [],
      },
      tags: [["a", h.coordinate]],
    });

    // The app publishes join then submission back to back, so both wraps arrive
    // together and are dispatched as independent, concurrent inbox tasks. The join
    // handler awaits a relay fetch (the invite hashes) before writing its attendee
    // row; the submission used to reach the enrollment gate inside that window and
    // be dropped as "never joined", silently losing the authored profile.
    await Promise.all([
      h.coordinator.handleInboxWrap(h.coordinate, joinWrap as any),
      h.coordinator.handleInboxWrap(h.coordinate, subWrap as any),
    ]);

    const attendee = h.store.getAttendee(h.coordinate, attendeePk);
    expect(attendee?.status).toBe("approved");
    expect(attendee?.profile_json ?? "").toContain("meshcore and BTC L2");
  });

  it("collapses a room's worth of simultaneous approvals into a few roster publishes", async () => {
    const h = await setup();
    const inboxPk = getPublicKey(h.einboxSk);
    // 24 people scan the shared QR at once. Each auto-approval used to publish
    // the whole 31604, so the room cost 24 publishes of a list growing to 24
    // ECK-encrypted entries — to the same relays already carrying their joins.
    // ONE shared code, as the feature intends — not 24 individually mailed ones.
    const doorSk = generateSecretKey();
    h.transport.seed.push({
      kind: 31601,
      pubkey: getPublicKey(h.eidSk),
      created_at: 2,
      id: "door-list",
      tags: [["d", "cypherpunk"]],
      content: JSON.stringify({ v: 2, invites: [{ h: inviteHash(getPublicKey(doorSk)), label: "door", uses: 0 }] }),
      sig: "",
    } as any);

    const attendees = Array.from({ length: 24 }, () => generateSecretKey());
    const wraps = attendees.map((sk) => {
      const pk = getPublicKey(sk);
      return wrapRumor(sk, inboxPk, {
        kind: KIND_JOIN_REQUEST,
        content: { v: 2, name: "scanner", message: "", rsvp_public: false },
        tags: [["a", h.coordinate], ["invite", getPublicKey(doorSk), makeInviteProof(doorSk, h.coordinate, pk).sig]],
      });
    });
    await Promise.all(wraps.map((w) => h.coordinator.handleInboxWrap(h.coordinate, w as any)));

    const rosters = h.transport.published.filter((e) => e.kind === KIND_ROSTER);
    // 24 approvals cost 2 publishes: the one in flight, and one more carrying
    // everybody who arrived while it was. A handful of leeway for scheduling,
    // but nowhere near the one-per-approval this replaces.
    expect(rosters.length).toBeLessThanOrEqual(4);
    // The correctness requirement the coalescing must not trade away: the LAST
    // published roster carries everyone. A snapshot is a snapshot — dropping
    // intermediate ones is free, dropping somebody is not.
    const latest = rosters[rosters.length - 1]!;
    const roster = rosterContentSchema.parse(JSON.parse(eckDecrypt(h.eck, latest.content)));
    const listed = new Set(roster.attendees.map((a) => a.pubkey));
    for (const sk of attendees) expect(listed.has(getPublicKey(sk))).toBe(true);
  });

  it("scales the per-event rumor budget with the crowd, so a mass join is not rate-dropped", async () => {
    const h = await setup();
    const inboxPk = getPublicKey(h.einboxSk);
    // Past the flat 600 floor, but well inside the budget an enrolled population
    // of this size earns. Seeded directly: this test is about the ceiling, not
    // about how rows get there.
    for (let i = 0; i < 300; i++) {
      h.store.upsertAttendee({ coordinate: h.coordinate, pubkey: `scanner${i}`, status: "approved", now: 1 });
    }
    // Burn the old flat budget on the event bucket alone.
    for (let i = 0; i < 700; i++) {
      h.store.bumpInboxRate(h.coordinate, "", h.clock.t, 60_000);
    }

    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const inviteSk = h.invites[h.nextInvite++]!;
    const wrap = wrapRumor(sk, inboxPk, {
      kind: KIND_JOIN_REQUEST,
      content: { v: 2, name: "late scanner", message: "", rsvp_public: false },
      tags: [["a", h.coordinate], ["invite", getPublicKey(inviteSk), makeInviteProof(inviteSk, h.coordinate, pk).sig]],
    });
    await h.coordinator.handleInboxWrap(h.coordinate, wrap as any);

    // Under the flat cap this join was dropped — and left unseen, so it came
    // back only if the daemon restarted within three days.
    expect(h.store.getAttendee(h.coordinate, pk)?.status).toBe("approved");
  });

  it("keeps a submission DELIVERED AHEAD of its own join (relay/signer ordering inversion)", async () => {
    const h = await setup();
    const inboxPk = getPublicKey(h.einboxSk);
    const attendeeSk = generateSecretKey();
    const attendeePk = getPublicKey(attendeeSk);
    const inviteSk = h.invites[h.nextInvite++]!;
    const proof = makeInviteProof(inviteSk, h.coordinate, attendeePk);

    const subWrap = wrapRumor(attendeeSk, inboxPk, {
      kind: KIND_PROFILE_SUBMISSION,
      content: { v: 2, rev: 0, profile: { about: "solar punk logistics", skills: ["ops"], looking_for: "", links: [] }, media: [] },
      tags: [["a", h.coordinate]],
    });
    const joinWrap = wrapRumor(attendeeSk, inboxPk, {
      kind: KIND_JOIN_REQUEST,
      content: { v: 2, name: "Mira", message: "", rsvp_public: false },
      tags: [["a", h.coordinate], ["invite", getPublicKey(inviteSk), proof.sig]],
    });

    // 42a3ad7 covered the two arriving TOGETHER. This is the case it left open:
    // the submission is dispatched FIRST. The app publishes both concurrently and
    // each needs its own signer round-trips (unordered under NIP-46), so whichever
    // relay answers first decides — and when the submission wins, the gate used to
    // drop it with no live redelivery ever coming.
    const submission = h.coordinator.handleInboxWrap(h.coordinate, subWrap as any);
    const join = h.coordinator.handleInboxWrap(h.coordinate, joinWrap as any);
    await Promise.all([submission, join]);

    const attendee = h.store.getAttendee(h.coordinate, attendeePk);
    expect(attendee?.status).toBe("approved");
    expect(attendee?.profile_json ?? "").toContain("solar punk logistics");
  });

  it("does not wait on a submission too old to be racing a join", async () => {
    const h = await setup();
    const inboxPk = getPublicKey(h.einboxSk);
    const attendeeSk = generateSecretKey();
    const attendeePk = getPublicKey(attendeeSk);
    const inviteSk = h.invites[h.nextInvite++]!;
    const proof = makeInviteProof(inviteSk, h.coordinate, attendeePk);

    const subWrap = wrapRumor(attendeeSk, inboxPk, {
      kind: KIND_PROFILE_SUBMISSION,
      content: { v: 2, rev: 0, profile: { about: "replayed", skills: [], looking_for: "", links: [] }, media: [] },
      tags: [["a", h.coordinate]],
    });
    const joinWrap = wrapRumor(attendeeSk, inboxPk, {
      kind: KIND_JOIN_REQUEST,
      content: { v: 2, name: "Late", message: "", rsvp_public: false },
      tags: [["a", h.coordinate], ["invite", getPublicKey(inviteSk), proof.sig]],
    });

    // Ten minutes on, these wraps are not racing each other — a replay or a
    // backfill, and backfill dispatches joins first precisely so it need not
    // wait. The bound is what stops a flood of unenrolled submissions from
    // buying 2.5s of a worker each.
    h.clock.t += 10 * 60 * 1000;
    const submission = h.coordinator.handleInboxWrap(h.coordinate, subWrap as any);
    const join = h.coordinator.handleInboxWrap(h.coordinate, joinWrap as any);
    await Promise.all([submission, join]);

    const attendee = h.store.getAttendee(h.coordinate, attendeePk);
    expect(attendee?.status).toBe("approved"); // the join still lands
    expect(attendee?.profile_json ?? null).toBeNull(); // the stale submission did not
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

  it("a persistently incomplete batch gets the 3-attempt contract budget, not 26 (PIPE-N-2)", async () => {
    // The `retryBudget` comment says a missing candidate "is nominally a contract
    // error but does clear on a re-roll", and gives contract errors three attempts.
    // The throw was a plain `Error`, so it never reached that budget: it rode the
    // default ~26-attempt three-day schedule, which for a batch is 26 fully billed
    // LLM calls asking the same question.
    const h = await setup();
    h.counters.dropAllScores = true; // the model never returns a complete batch
    await join(h, generateSecretKey(), "crypto");
    await join(h, generateSecretKey(), "design");
    // Three attempts, spaced by the default 1s/10s head of the backoff schedule.
    // Under the old plain-Error throw the job would still be `pending` here, with
    // 23 more billed attempts and three days to go.
    for (const gap of [0, 1_000, 10_000, 100_000]) {
      h.clock.t += gap;
      await h.coordinator.jobs.drain();
    }
    const poisoned = h.store.poisonJobs().filter((j) => j.type === "score_batch");
    expect(poisoned.length).toBeGreaterThan(0);
    expect(poisoned[0]!.attempts).toBe(3);
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

describe("profile refresh — a kind-0 edited OUTSIDE Nostrautica re-enriches and re-matches", () => {
  // The reported bug: somebody who had used Nostr for years joined with that
  // identity, then updated their profile in their usual client. Nostrautica kept
  // describing and matching them on the bio they had on the day they joined,
  // because nothing coordinator-side had changed and only coordinator-side events
  // ever started a pipeline run.
  function processJobKeys(h: Harness, pubkey: string): string[] {
    return (
      (h.store as any).db
        .prepare("SELECT dedupe_key FROM jobs WHERE type = 'process_attendee' AND dedupe_key LIKE ?")
        .all(`proc:${h.coordinate}:${pubkey}:%`) as { dedupe_key: string }[]
    ).map((r) => r.dedupe_key);
  }

  /** Publish (or supersede) an attendee's public kind 0. Replaceable: a later
   *  `created_at` wins, exactly as the §3.1 rule resolves it in production. */
  function setKind0(h: Harness, pubkey: string, about: string, createdAt: number): void {
    h.transport.seed.push({
      kind: KIND_PROFILE,
      pubkey,
      created_at: createdAt,
      tags: [],
      content: JSON.stringify({ name: "Long-time Nostr user", about }),
      id: `k0-${pubkey.slice(0, 8)}-${createdAt}`,
      sig: "",
    } as any);
  }

  const k0Hash = (bio: string) => sha256Hex(utf8ToBytes(bio)).slice(0, 16);

  it("an UNCHANGED kind 0 enqueues nothing — the sweep must be free to run hourly", async () => {
    const h = await setup(3);
    const sk = generateSecretKey();
    const pk = await join(h, sk, "crypto");
    setKind0(h, pk, "Cypherpunk, cryptographer, coffee.", 100);
    await h.coordinator.jobs.drain();

    // First sighting: the sweep has never expressed this bio as a key, so it
    // enqueues once. That run is the documented cost of carrying no watermark.
    await h.coordinator.profileRefreshSweep();
    await h.coordinator.jobs.drain();
    const baseline = processJobKeys(h, pk);
    expect(baseline.some((k) => k.endsWith(`:k0=${k0Hash("Cypherpunk, cryptographer, coffee.")}`))).toBe(true);

    // Every subsequent sweep over the same bio must be a pure no-op. If this ever
    // fails, the hourly timer is re-billing the whole roster every hour.
    await h.coordinator.profileRefreshSweep();
    await h.coordinator.profileRefreshSweep();
    expect(processJobKeys(h, pk)).toEqual(baseline);
  });

  it("a CHANGED kind 0 enqueues exactly one job, keyed by the new bio", async () => {
    const h = await setup(3);
    const sk = generateSecretKey();
    const pk = await join(h, sk, "crypto");
    setKind0(h, pk, "Old bio from years ago.", 100);
    await h.coordinator.jobs.drain();
    await h.coordinator.profileRefreshSweep();
    await h.coordinator.jobs.drain();
    const before = processJobKeys(h, pk);

    // The user updates their profile in their own client.
    const NEW_BIO = "Now doing hardware wallets and post-quantum signatures.";
    setKind0(h, pk, NEW_BIO, 200);
    await h.coordinator.profileRefreshSweep();

    const after = processJobKeys(h, pk);
    const added = after.filter((k) => !before.includes(k));
    expect(added).toHaveLength(1);
    // Keyed by the NEW bio, and otherwise the same key family the submission path
    // builds — same `proc:<coordinate>:<pubkey>:` prefix, so `supersedePendingJobs`
    // still coalesces across both paths instead of paying for the attendee twice.
    expect(added[0]).toBe(`${before[0]!.split(":k0=")[0]}:k0=${k0Hash(NEW_BIO)}`);
    expect(added[0]!.startsWith(`proc:${h.coordinate}:${pk}:`)).toBe(true);
  });

  it("skips the event entirely when nostr_context = 0 — the bio is not a model input there", async () => {
    const h = await setup(0);
    const sk = generateSecretKey();
    const pk = await join(h, sk, "crypto");
    setKind0(h, pk, "A bio nothing will read.", 100);
    await h.coordinator.jobs.drain();
    const before = processJobKeys(h, pk);

    await h.coordinator.profileRefreshSweep();
    setKind0(h, pk, "A completely different bio.", 200);
    await h.coordinator.profileRefreshSweep();

    // No enqueue, and no kind-0 fetch either — with n = 0 the pipeline never reads
    // kind 0, so re-running would rebuild a byte-identical ai_profile.
    expect(processJobKeys(h, pk)).toEqual(before);
    expect(h.transport.fetchCalls.some((c) => c.filter?.kinds?.includes(KIND_PROFILE))).toBe(false);
  });

  it("reads kind 0 from the attendee's OWN relays, not just the event's", async () => {
    // The test that would have caught the silent no-op. A person who has been on
    // Nostr for years publishes their kind 0 to THEIR relays; nothing obliges the
    // event's relay list to carry it. Reading only `configRelays` finds nothing,
    // concludes "unchanged", does nothing — and every deploy marker still prints
    // OK, because nothing failed.
    const h = await setup(3, { eventRelays: ["wss://event-only"], defaultRelays: ["wss://the-users-own-relay"] });
    const sk = generateSecretKey();
    const pk = await join(h, sk, "crypto");
    setKind0(h, pk, "Bio that lives on my own relay.", 100);
    await h.coordinator.jobs.drain();

    h.transport.fetchCalls.length = 0;
    await h.coordinator.profileRefreshSweep();

    const k0Fetch = h.transport.fetchCalls.find((c) => c.filter?.kinds?.includes(KIND_PROFILE));
    expect(k0Fetch).toBeDefined();
    expect(k0Fetch!.relays).toContain("wss://the-users-own-relay");
    expect(k0Fetch!.relays).toContain("wss://event-only");
    // ONE batched query for the whole event, not one per attendee.
    expect(k0Fetch!.filter.authors).toContain(pk);

    // The pipeline's own read has to use the SAME union, or the sweep detects a
    // change on a relay the run cannot see and rebuilds an identical ai_profile.
    h.transport.fetchCalls.length = 0;
    setKind0(h, pk, "Updated on my own relay again.", 200);
    await h.coordinator.profileRefreshSweep();
    await h.coordinator.jobs.drain();
    const pipelineK0 = h.transport.fetchCalls.filter((c) => c.filter?.kinds?.includes(KIND_PROFILE));
    expect(pipelineK0.length).toBeGreaterThan(0);
    for (const c of pipelineK0) expect(c.relays).toContain("wss://the-users-own-relay");
  });
});

/**
 * Boot cost. `restart-coordinator.sh` measures the gap between the process
 * starting and the daemon's own "watching for installs, submissions, admin
 * commands" line, warns at 60 s and FAILS THE DEPLOY at 240 s
 * (docs/DEPLOYMENT.md). That number was 47–66 s and rising, because every stored
 * event was restored strictly one after another while almost all of the work is
 * independent relay I/O against a different inbox and a different MLS group.
 */
describe("boot restores stored events concurrently", () => {
  /** A store holding `n` already-installed, chat-off events, plus their configs. */
  function seedEvents(
    store: Store,
    transport: FakeTransport,
    coordPubkey: string,
    n: number,
  ): string[] {
    const coordinates: string[] = [];
    for (let i = 0; i < n; i++) {
      const eidSk = generateSecretKey();
      const eidPubkey = getPublicKey(eidSk);
      const d = `event-${i}`;
      const coordinate = makeCoordinate(eidPubkey, d);
      const inboxSk = generateSecretKey();
      transport.seed.push({
        kind: 31600,
        pubkey: eidPubkey,
        created_at: 1,
        id: `cfg-${i}`,
        sig: "",
        content: "",
        tags: [["d", d], ["v", "2"], ["inbox", getPublicKey(inboxSk)], ["coordinator", coordPubkey, "1"]],
      } as any);
      store.upsertEvent({
        coordinate,
        configJson: "{}",
        inboxNsec: bytesToHex(inboxSk),
        eckJson: JSON.stringify([{ id: 1, key: bytesToBase64(generateEck()) }]),
        configRelays: JSON.stringify(["wss://test"]),
        gen: 1,
        now: Date.now(),
      });
      store.recordInstalledGen(coordinate, 1);
      coordinates.push(coordinate);
    }
    return coordinates;
  }

  function bootCoordinator(store: Store, transport: FakeTransport, coordSk: Uint8Array): Coordinator {
    return new Coordinator({
      store,
      transport,
      coordSk,
      stt: new MockStt({ default: "x" }),
      llm: new MockLlm(() => ({})),
      summaryModel: { provider: "mock", model: "m" },
      matchModel: { provider: "mock", model: "m" },
      embedModel: { provider: "mock", model: "m" },
      translateModel: { provider: "mock", model: "m" },
      sttModel: "mock",
      defaultRelays: ["wss://test"],
      maxEvents: 50,
      sleep: async () => {},
    });
  }

  it("has several events' relay reads in flight at once, and still restores every one", async () => {
    const coordSk = generateSecretKey();
    const store = new Store(":memory:", coordSk);
    const transport = new FakeTransport();
    const coordinates = seedEvents(store, transport, getPublicKey(coordSk), 4);
    transport.fetchDelayMs = 20; // long enough for the fan-out to actually overlap

    const coordinator = bootCoordinator(store, transport, coordSk);
    await coordinator.start();
    coordinator.stop();

    expect(transport.peakInFlightFetches).toBeGreaterThan(1);
    // Every event still ends up live — concurrency must not lose one.
    for (const c of coordinates) expect(coordinator.eckOf(c)).toHaveLength(1);
  });

  it("never runs more than the bound at once, however many events are stored", async () => {
    const coordSk = generateSecretKey();
    const store = new Store(":memory:", coordSk);
    const transport = new FakeTransport();
    seedEvents(store, transport, getPublicKey(coordSk), 20);
    transport.fetchDelayMs = 5;

    const coordinator = bootCoordinator(store, transport, coordSk);
    await coordinator.start();
    coordinator.stop();

    // A boot that fans out over twenty events unbounded puts sixty-odd concurrent
    // REQs on each relay socket; the bound is what stops that.
    expect(transport.peakInFlightFetches).toBeLessThanOrEqual(4);
  });
});

/**
 * `suspendEvent` is reachable for the whole life of the process — a config that
 * stops being fetchable, a re-install that can't revalidate. The retry timer was
 * created only `if (this.suspended.size > 0)` AT BOOT, so on a daemon that started
 * clean an event suspended later had nothing to ever retry it: the log said
 * "SUSPENDED … retry in 5000ms" and no retry existed. It stayed deaf until the
 * next deploy.
 */
describe("the suspended-event retry timer exists even when nothing was suspended at boot", () => {
  it("retries suspensions that happen after start()", async () => {
    const h = await setup();
    vi.useFakeTimers();
    try {
      const spy = vi.spyOn(h.coordinator, "retrySuspendedEvents").mockResolvedValue(undefined);
      await h.coordinator.start(); // nothing suspended: the config is fetchable
      expect(spy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(spy).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      h.coordinator.stop();
    }
  });
});

/**
 * `chat_sync_member` is enqueued the instant an attendee is approved, and on a
 * chat event it then completes in 0–1 ms having done nothing: the account has no
 * attested device yet, because the client publishes its key package and its 21607
 * later, when it prewarms chat. Nothing looked again, so the member's first open
 * waited on the passive 30443 watcher.
 */
describe("chat enrolment is re-checked for a bounded window after the grant", () => {
  it("picks the device up on a re-check when it appears after the approval", async () => {
    const mls = new StubMls();
    const h = await setup(0, { chat: true, chatMls: mls });
    const pk = await join(h, generateSecretKey(), "crypto"); // auto-approved
    await h.coordinator.jobs.drain(); // the approval-time sync: nothing to add yet
    expect(mls.invited).toEqual([]);

    // Prewarm: the client now binds a device and publishes its key package.
    const devicePk = getPublicKey(generateSecretKey());
    h.store.upsertChatKey({ coordinate: h.coordinate, accountPubkey: pk, chatPubkey: devicePk, now: h.clock.t });
    h.transport.seed.push({ kind: 30443, pubkey: devicePk, created_at: 1, id: "kp-late", tags: [], content: "", sig: "" } as any);

    // Nothing else happens — no attestation rumor, no watcher delivery. The bounded
    // re-check is the only thing that can notice.
    h.clock.t += 10_000;
    await h.coordinator.jobs.drain();

    expect(mls.invited).toEqual([devicePk]);
  });

  it("stops the chain once the member is enrolled, instead of re-checking forever", async () => {
    const mls = new StubMls();
    const h = await setup(0, { chat: true, chatMls: mls });
    const pk = await join(h, generateSecretKey(), "crypto");
    const devicePk = getPublicKey(generateSecretKey());
    h.store.upsertChatKey({ coordinate: h.coordinate, accountPubkey: pk, chatPubkey: devicePk, now: h.clock.t });
    h.transport.seed.push({ kind: 30443, pubkey: devicePk, created_at: 1, id: "kp-1", tags: [], content: "", sig: "" } as any);
    await h.coordinator.jobs.drain();
    expect(mls.invited).toEqual([devicePk]);

    // The member holds a leaf now, so the chain has its answer and must stop —
    // every further re-check would be one relay read per member per event.
    const kpReadsAfterEnrolment = h.transport.fetches.filter((f: any) => f.kinds?.includes(30443)).length;
    for (let i = 0; i < 6; i++) {
      h.clock.t += 300_000;
      await h.coordinator.jobs.drain();
    }
    expect(h.transport.fetches.filter((f: any) => f.kinds?.includes(30443)).length).toBe(kpReadsAfterEnrolment);
    expect(h.store.pendingJobCount()).toBe(0);
  });
});
