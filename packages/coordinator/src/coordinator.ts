/**
 * The coordinator orchestrator (spec §9). A headless Nostr client: it subscribes
 * to its own gift-wrap inbox (installs + admin commands) and to each installed
 * event's E_inbox (join requests + submissions), runs the idempotent pipeline,
 * and publishes directory/roster/match events.
 *
 * The Nostr transport is injected (structural interface) so the whole thing is
 * unit-testable with an in-memory fake client and mock providers.
 */
import { getPublicKey, finalizeEvent } from "nostr-tools/pure";
import type { Event as NostrEvent } from "nostr-tools/core";
import { ZodError } from "zod";
import {
  KIND_GIFT_WRAP,
  KIND_INVITE_LIST,
  KIND_JOIN_REQUEST,
  KIND_PROFILE_SUBMISSION,
  KIND_COORDINATOR_GRANT,
  KIND_ADMIN_COMMAND,
  KIND_PROFILE_CORRECTION,
  KIND_TALK_SUBMISSION,
  KIND_TALK,
  KIND_DIRECTORY_ENTRY,
  KIND_MATCH_MATRIX,
  KIND_EVENT_CONFIG,
  KIND_DELETION,
  KIND_NOTE,
  KIND_REPOST,
  KIND_LONGFORM,
  KIND_PROFILE,
  giftwrapSince,
  unwrapRumor,
  base64ToBytes,
  hexToBytes,
  bytesToBase64,
  blindedD,
  generateEck,
  sha256Hex,
  utf8ToBytes,
  inviteListContentSchema,
  joinRequestContentSchema,
  profileSubmissionContentSchema,
  coordinatorGrantContentSchema,
  adminCommandContentSchema,
  profileCorrectionContentSchema,
  talkSubmissionContentSchema,
  chatKeyAttestationContentSchema,
  KIND_CHAT_KEY_ATTESTATION,
  isMarmotChatEnabled,
  AI_PROFILE_FIELDS,
  parseEventConfig,
  parseCoordinate,
  type EckVersion,
  type EventConfig,
  type TalksMode,
  type AttendeeProfile,
  type MediaDescriptor,
  type MediaTranscript,
  type ProfileCorrectionContent,
  type TalkSubmissionContent,
  type TalkContent,
  type AiProfile,
  type RosterContent,
  type MatchMatrixContent,
  type MatchListContent,
} from "@nostrautica/protocol";
import type { GiftWrap, Rumor } from "@nostrautica/protocol";
import { Store } from "./store/db.js";
import { JobRunner } from "./pipeline/jobs.js";
import { InviteChecker, evaluateEntitlement } from "./pipeline/entitlement.js";
import { processAttendee } from "./pipeline/process.js";
import type { NostrPost } from "./pipeline/profile.js";
import {
  profileHash,
  scoreBatch,
  scoreReverseBatch,
  type BatchCandidate,
  type EventContextForScoring,
} from "./matching/scoring.js";
import {
  selectPairsToScore,
  groupIntoBatches,
  recordDirectedScore,
  buildMatchList,
  type AttendeeForMatching,
  type CandidatePair,
} from "./matching/matcher.js";
import { DEFAULT_PREFILTER, type PrefilterConfig } from "./matching/prefilter.js";
import {
  buildDirectoryEntry,
  buildRoster,
  buildMatchListEvent,
  buildMatchMatrix,
  buildKeyGrant,
  buildCoordinatorStatus,
  buildTalkEntry,
  talkBlindedD,
  type PublishKeys,
} from "./nostr/publisher.js";
import { transcribeMedia } from "./pipeline/transcribe.js";
import type { LlmProvider, SttProvider, ModelRef } from "./providers/types.js";
import { MarmotAdmin } from "./chat/admin.js";
import type { ChatMls } from "./chat/mls.js";
import { discoverKeyPackages } from "./chat/key-package-discovery.js";
import { sanitizeRelayUrls } from "./net/relay-urls.js";
import {
  sanitizeLlmText,
  sanitizeAiProfile,
  capAuthoredText,
  MAX_NAME_CHARS,
} from "./nostr/hygiene.js";
import { MAX_INPUT_DURATION_SEC } from "./pipeline/audio.js";

/** Default cap on simultaneously installed events (audit COORD-3). */
const DEFAULT_MAX_EVENTS = 50;

/** Media descriptors processed per submission (audit COORD-4); extras are skipped. */
const MAX_MEDIA_PER_SUBMISSION = 4;

/** Total media bytes downloaded per submission (audit COORD-4). */
const MAX_SUBMISSION_MEDIA_BYTES = 500 * 1024 * 1024;

/** Distinct talks (by talk_d) one speaker may submit per event (audit COORD-4:
 *  unbounded talk submissions each triggered their own paid STT job). Editing
 *  an already-submitted talk_d is never capped — only new ones. */
const MAX_TALKS_PER_SPEAKER = 10;

/** Resolve the per-descriptor duration cap: 0/negative (UNLIMITED) ⇒ the built-in default. */
function effectiveMaxMediaSec(configured: number): number {
  return configured > 0 ? configured : MAX_INPUT_DURATION_SEC;
}

/**
 * Relays the Whitenoise Marmot/MLS client publishes key packages and group
 * traffic to (confirmed via its own "seen on relays" key-package screen,
 * 2026-07-20; mirrors the app-side constant in
 * packages/app/src/lib/nostr/relays.ts). Ensured into every chat-enabled
 * event's MLS routing state in `ensureChat` — including groups created
 * before this was added — because a group's routing relays are baked in at
 * creation and never re-derived from config.relays afterward.
 */
const WHITENOISE_RELAYS = ["wss://relay.us.whitenoise.chat", "wss://relay.eu.whitenoise.chat"];

/** Marmot v2 wire kinds (MARMOT-GROUP-CHAT §1.2): addressable key package + group msg. */
const KIND_KEY_PACKAGE = 30443;
const KIND_GROUP_MESSAGE = 445;

/** Minimal transport the coordinator needs (NostrClient satisfies it). */
export interface Transport {
  publish(event: NostrEvent, relays?: string[]): Promise<void>;
  fetch(filter: any, relays?: string[], timeoutMs?: number): Promise<NostrEvent[]>;
}

const short = (pk: string) => pk.slice(0, 8);
function log(msg: string): void {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`[${t}] ${msg}`);
}

/** Stable identity of a relay set for subscription re-keying (audit COORD-8). */
function relayKey(relays: string[]): string {
  return [...relays].sort().join(" ");
}

/**
 * Stable dedupe fragment for a batch job: a hash of the sorted candidate
 * `b:inputsHash` pairs. Two enqueues covering the same target+candidate set (same
 * inputs) collapse to one job, so a restart mid-recompute never double-bills.
 */
function batchDedupe(batch: { b: string; inputsHash: string }[]): string {
  const canonical = batch
    .map((p) => `${p.b}:${p.inputsHash}`)
    .sort()
    .join(",");
  return sha256Hex(utf8ToBytes(canonical)).slice(0, 24);
}

export interface CoordinatorDeps {
  store: Store;
  transport: Transport;
  coordSk: Uint8Array;
  llm: LlmProvider;
  stt: SttProvider;
  sttModel: string;
  summaryModel: ModelRef;
  matchModel: ModelRef;
  embedModel: ModelRef;
  translateModel: ModelRef;
  defaultRelays: string[];
  prefilter?: PrefilterConfig;
  topK?: number;
  /** Candidates per batched match-scoring call (spec §16.2). Default 10. */
  batchSize?: number;
  /** Injectable RNG for deterministic candidate shuffling in tests. */
  matchRng?: () => number;
  fetchBlob?: (urls: string[], sha256: string) => Promise<Uint8Array>;
  /** Override the transcription stage (tests inject to skip Blossom/ffmpeg).
   *  May return text only, or a {@link TranscriptResult} with a detected language. */
  transcribe?: (
    descriptor: MediaDescriptor,
  ) => Promise<string | import("./pipeline/transcribe.js").TranscriptResult>;
  /** Max media bytes to download per blob (audit C3). */
  maxMediaBytes?: number;
  /**
   * The MLS layer for the Marmot group-chat admin bot (§4). When provided, the
   * coordinator runs as the group's admin: it creates a group per chat-enabled
   * event, adds approved attendees' chat identities, and removes them on revoke.
   * Omitted ⇒ chat is entirely inert (the pre-Marmot behavior).
   */
  chatMls?: ChatMls;
  now?: () => number;
  /** Injectable sleep for the live-wrap retry backoff (audit COORD-2). */
  sleep?: (ms: number) => Promise<void>;
  /** Backoff delays between live-wrap retries (COORD-2). Default [5s, 30s]. */
  wrapRetryDelaysMs?: number[];
  /** Max simultaneously installed events (audit COORD-3). Default 50. */
  maxEvents?: number;
  /**
   * When non-empty, only install events whose E_id is listed (COORD-3).
   * Hex pubkeys.
   */
  allowedEidPubkeys?: string[];
  /**
   * Billing policy evaluation (Part 3, COORD-3). Invoked at install time and its
   * verdict logged — payment itself is not enforced by this daemon yet.
   */
  evaluateBilling?: (organizerPubkey: string, attendeeCount: number) => { state: string; reason?: string };
}

interface EventState {
  coordinate: string;
  identifier: string;
  eidPubkey: string;
  inboxSk: Uint8Array;
  eck: EckVersion[];
  configRelays: string[];
  nostrContextN: number;
  /** Whether AI matching runs for this event (audit H4). "off" disables all AI stages. */
  matching: "on" | "off";
  matchVisibility: "pair" | "event";
  /** Prerecorded-talks journey mode (spec F2). "off" ⇒ talk submissions are ignored. */
  talks: TalksMode;
  /** Blossom origins media may be fetched from (audit C3 allowlist). Empty = derive from media urls, IP-guarded. */
  blossomOrigins: string[];
  lang: string;
  /** Per-descriptor duration cap in seconds (audit COORD-4): the event's
   *  max(max_video_sec, max_talk_sec); 0/unset ⇒ the built-in DEFAULT cap. */
  maxMediaSec: number;
  /** Whether Marmot group chat is operative for this event (§1.3). */
  chat: boolean;
  scoringCtx: EventContextForScoring;
  /** Newest applied 31600 config event id + timestamp (audit H5 replaceable ordering). */
  configEventId?: string;
  configCreatedAt: number;
}

export class Coordinator {
  readonly jobs: JobRunner;
  private readonly coordPubkey: string;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly wrapRetryDelaysMs: number[];
  private readonly maxEvents: number;
  private readonly allowedEidPubkeys: Set<string>;
  private readonly prefilter: PrefilterConfig;
  private readonly topK: number;
  private readonly batchSize: number;
  private readonly matchRng: () => number;
  private readonly inviteChecker: InviteChecker;
  /** The Marmot admin bot (§4), present only when a chat MLS layer is configured. */
  private readonly marmot?: MarmotAdmin;
  private events = new Map<string, EventState>();
  private closers: Array<() => void> = [];

  constructor(private readonly deps: CoordinatorDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.wrapRetryDelaysMs = deps.wrapRetryDelaysMs ?? [5_000, 30_000];
    this.maxEvents = deps.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.allowedEidPubkeys = new Set(deps.allowedEidPubkeys ?? []);
    this.coordPubkey = getPublicKey(deps.coordSk);
    this.prefilter = deps.prefilter ?? DEFAULT_PREFILTER;
    this.topK = deps.topK ?? 20;
    this.batchSize = deps.batchSize ?? 10;
    this.matchRng = deps.matchRng ?? Math.random;
    this.inviteChecker = new InviteChecker(deps.store);
    if (deps.chatMls) {
      this.marmot = new MarmotAdmin({
        store: deps.store,
        mls: deps.chatMls,
        now: this.now,
        fetchKeyPackages: (coordinate, authors) => this.fetchKeyPackages(coordinate, authors),
        log,
      });
    }
    this.jobs = new JobRunner(deps.store, {
      now: this.now,
      // A poisoned job is surfaced to the organizer (audit Q12): persist a status
      // row and gift-wrap a 21606 status to E_id so it's visible without server logs.
      onPoison: (info) => void this.surfacePoison(info).catch(() => {}),
    });
    this.registerJobHandlers();
  }

  // ── job handlers (the pipeline, spec §9.2) ─────────────────────────────────
  private registerJobHandlers(): void {
    this.jobs.register("process_attendee", async (p, { enqueue }) => {
      await this.processAttendeeJob(p.coordinate, p.pubkey);
      // Key the recompute by the attendee's resulting profile hash: re-delivery of
      // the same submission dedupes, a CHANGED profile gets a fresh recompute.
      const hash = this.deps.store.getAttendee(p.coordinate, p.pubkey)?.profile_hash ?? "none";
      enqueue("match_recompute", `match:${p.coordinate}:${p.pubkey}:${hash}`, {
        coordinate: p.coordinate,
        pubkey: p.pubkey,
      });
    });

    this.jobs.register("match_recompute", async (p, { enqueue }) => {
      // Re-check config at execution (audit H4): matching may have been turned off
      // after this job was queued — exit before any embedding/scoring provider call.
      if (this.events.get(p.coordinate)?.matching === "off") return;
      const pairs = await this.selectPairs(p.coordinate, p.pubkey);
      if (!pairs.length) return;
      // FORWARD direction (p.pubkey → others): one target + ≤K candidates per call.
      // Group the target's pending directed pairs into ≤K-candidate batches (one
      // target + ≤K candidates per LLM call — spec §16.2). Batching is a transport
      // optimization only: each batch job is deduped by its target+candidate-set
      // hash, and results are written per directed pair keyed by inputs_hash.
      const batches = groupIntoBatches(pairs, this.batchSize);
      log(`[match] ${short(p.pubkey)} → scoring ${pairs.length} forward pair(s) in ${batches.length} batch(es)`);
      for (const batch of batches) {
        const key = `batch:${p.coordinate}:${batch[0]!.a}:${batchDedupe(batch)}`;
        enqueue("score_batch", key, { coordinate: p.coordinate, pairs: batch });
      }

      // REVERSE direction (others → p.pubkey): each other is a distinct TARGET with
      // exactly ONE pending candidate (p.pubkey). Enqueuing a per-other recompute
      // would degrade to N−1 single-candidate calls. Instead we batch by the SHARED
      // candidate: one call scores ≤K targets against p.pubkey (spec §16.2 reverse
      // variant). Reverse pairs are `{a: other, b: p.pubkey}` — same inputs_hash, so
      // idempotency and content-addressed publish keys are unchanged.
      const reverse: CandidatePair[] = [];
      for (const pair of pairs) {
        const rev = this.deps.store.getPairDirection(p.coordinate, pair.b, pair.a);
        if (!rev || rev.inputs_hash !== pair.inputsHash || !rev.scored) {
          reverse.push({ a: pair.b, b: pair.a, inputsHash: pair.inputsHash });
        }
      }
      for (let i = 0; i < reverse.length; i += this.batchSize) {
        const batch = reverse.slice(i, i + this.batchSize);
        // Dedupe by shared candidate + the target set — a re-delivery collapses.
        const key = `rbatch:${p.coordinate}:${p.pubkey}:${batchDedupe(batch.map((r) => ({ b: r.a, inputsHash: r.inputsHash })))}`;
        enqueue("score_reverse_batch", key, { coordinate: p.coordinate, pairs: batch });
      }
      if (reverse.length) {
        log(`[match] reverse: ${reverse.length} target(s) → ${short(p.pubkey)} in ${Math.ceil(reverse.length / this.batchSize)} batch(es)`);
      }
    });

    this.jobs.register("score_batch", async (p, { enqueue }) => {
      const pairs = p.pairs as CandidatePair[];
      const { scored, missing } = await this.scoreBatchJob(p.coordinate, pairs);
      // A directed write only changes the TARGET's list (the candidate's own view
      // comes from their own batch), so only the target republishes. The key
      // carries the scored set's content hash so new scores trigger a fresh
      // publish while identical re-deliveries dedupe.
      if (scored.length) {
        const target = pairs[0]!.a;
        enqueue("publish_matches", `pub:${p.coordinate}:${target}:${batchDedupe(scored)}`, {
          coordinate: p.coordinate,
          pubkey: target,
        });
      }
      // Partial failure: the good candidates are already persisted (and their
      // publish enqueued above — enqueues survive a handler throw). Throwing makes
      // the runner retry THIS job with backoff; the retry re-selects only the
      // still-unscored candidates, so finished pairs are never re-billed and one
      // bad candidate never poisons its batch-mates.
      if (missing > 0) {
        throw new Error(`batch response missing ${missing} candidate(s); retrying unscored remainder`);
      }
    });

    this.jobs.register("score_reverse_batch", async (p, { enqueue }) => {
      const pairs = p.pairs as CandidatePair[];
      const { scored, missing } = await this.scoreReverseBatchJob(p.coordinate, pairs);
      // Each reverse pair {a: other, b: shared} writes the OTHER's directed row, so
      // every distinct target republishes its own list. Group scored pairs by target.
      const byTarget = new Map<string, CandidatePair[]>();
      for (const pr of scored) {
        const list = byTarget.get(pr.a) ?? [];
        list.push(pr);
        byTarget.set(pr.a, list);
      }
      for (const [target, list] of byTarget) {
        enqueue("publish_matches", `pub:${p.coordinate}:${target}:${batchDedupe(list.map((r) => ({ b: r.b, inputsHash: r.inputsHash })))}`, {
          coordinate: p.coordinate,
          pubkey: target,
        });
      }
      if (missing > 0) {
        throw new Error(`reverse batch missing ${missing} target(s); retrying unscored remainder`);
      }
    });

    this.jobs.register("publish_matches", async (p) => {
      await this.publishMatchesJob(p.coordinate, p.pubkey);
    });

    // Transcribe a submitted talk (spec F2). Reuses the intro transcription pipeline
    // unchanged (audio.ts segments long talks). The transcript is stored on the talk
    // row (published on the 31610 at talk_publish time) and folded into the speaker's
    // ai_profile so the talk feeds matching (§9.2).
    this.jobs.register("process_talk", async (p) => {
      await this.processTalkJob(p.coordinate, p.pubkey, p.talkD as string);
    });

    // Marmot MLS membership changes (§4.2, audit COORD-9): add/remove run through
    // the durable runner so a transient marmot/relay failure retries instead of
    // stranding membership drift; persistent failure poisons → organizer 21606.
    this.jobs.register("chat_sync_member", async (p) => {
      if (!this.marmot) return;
      await this.marmot.syncMember(p.coordinate, p.pubkey);
    });
    this.jobs.register("chat_revoke_member", async (p) => {
      if (!this.marmot) return;
      await this.marmot.handleRevoke(p.coordinate, p.pubkey);
    });
  }

  // ── install (21603) ────────────────────────────────────────────────────────
  async installEvent(grant: {
    coordinate: string;
    inboxSkHex: string;
    eck: EckVersion[];
    configRelays: string[];
    /**
     * Backfill window for the E_inbox subscription (audit H2). "full" (a fresh
     * install of a never-before-seen event) scans the entire history so join
     * requests/submissions published days before the coordinator attached are not
     * missed; "recent" (a restart of an already-installed event) keeps the 3-day
     * live-overlap window. Default "recent".
     */
    backfill?: "full" | "recent";
  }): Promise<void> {
    const { pubkey: eidPubkey, identifier } = parseCoordinate(grant.coordinate);
    // Relay lists from untrusted input (grant, later the 31600) are validated:
    // wss-only, well-formed, deduped, capped (audit COORD-16).
    const grantRelays = sanitizeRelayUrls(grant.configRelays);
    const relays = grantRelays.length ? grantRelays : this.deps.defaultRelays;

    // Load public config + event details for scoring context.
    const cfgEvents = await this.deps.transport.fetch(
      { kinds: [31600, 31923], authors: [eidPubkey], "#d": [identifier] },
      relays,
    );
    // Newest config wins (audit COORD-14): relays return replaceable events in
    // arbitrary order, so pick by created_at (id tiebreak) rather than first-found.
    const cfgEvent = cfgEvents
      .filter((e) => e.kind === 31600)
      .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1))[0];
    const evtEvent = cfgEvents.find((e) => e.kind === 31923);
    const config = cfgEvent ? parseEventConfig(eidPubkey, cfgEvent.tags) : undefined;

    // Install authorization (audit COORD-3): a 31600 that names a coordinator
    // must name THIS one — otherwise the grant is for someone else's daemon and
    // the event is rejected (also enforced on live config updates).
    if (config?.coordinator && config.coordinator !== this.coordPubkey) {
      log(
        `[install] REJECTED ${grant.coordinate}: 31600 coordinator tag names ${short(config.coordinator)}, not this daemon (${short(this.coordPubkey)})`,
      );
      return;
    }

    // Billing policy signal (Part 3, COORD-3): not a gate yet — the verdict is
    // logged so an operator sees when an event exceeds the configured free tier.
    if (this.deps.evaluateBilling) {
      try {
        const verdict = this.deps.evaluateBilling(
          eidPubkey,
          this.deps.store.approvedAttendees(grant.coordinate).length,
        );
        if (verdict.state !== "ok") {
          log(`[install] billing=${verdict.state} for ${grant.coordinate}${verdict.reason ? ` — ${verdict.reason}` : ""}`);
        }
      } catch (e) {
        log(`[install] billing evaluation failed: ${e instanceof Error ? e.message : e}`);
      }
    }

    this.deps.store.upsertEvent({
      coordinate: grant.coordinate,
      configJson: JSON.stringify(config ?? {}),
      inboxNsec: grant.inboxSkHex,
      eckJson: JSON.stringify(grant.eck),
      configRelays: JSON.stringify(relays),
      now: this.now(),
    });

    const state: EventState = {
      coordinate: grant.coordinate,
      identifier,
      eidPubkey,
      inboxSk: hexToBytes(grant.inboxSkHex),
      eck: grant.eck,
      configRelays: relays,
      nostrContextN: config?.nostrContext ?? 0,
      matching: config?.matching ?? "off",
      matchVisibility: config?.matchVisibility ?? "pair",
      talks: config?.talks ?? "off",
      blossomOrigins: config?.blossom ?? [],
      lang: config?.lang ?? "en",
      maxMediaSec: effectiveMaxMediaSec(Math.max(config?.maxVideoSec ?? 0, config?.maxTalkSec ?? 0)),
      chat: config ? isMarmotChatEnabled(config) : false,
      scoringCtx: {
        title: evtEvent?.tags.find((t) => t[0] === "title")?.[1] ?? "the event",
        summary: evtEvent?.tags.find((t) => t[0] === "summary")?.[1] ?? "",
        hashtags: (evtEvent?.tags ?? []).filter((t) => t[0] === "t").map((t) => t[1]!),
        lang: config?.lang ?? "en",
      },
      configEventId: cfgEvent?.id,
      configCreatedAt: cfgEvent?.created_at ?? 0,
    };
    this.events.set(grant.coordinate, state);
    log(
      `[install] event "${state.scoringCtx.title}" installed — matching=${state.matching}, nostr_context=${state.nostrContextN}, match_visibility=${state.matchVisibility}, lang=${state.lang}, talks=${state.talks}`,
    );
    log(`          coordinate ${grant.coordinate}`);
    // Subscribe to this event's E_inbox NOW (not only at startup), so an install
    // received while the daemon is already running starts receiving join requests
    // + submissions immediately. A FRESH install backfills the full history (since=0)
    // so requests/submissions older than the 3-day live window are still recovered
    // (audit H2); a restart of a known event keeps the 3-day overlap.
    const since = grant.backfill === "full" ? 0 : giftwrapSince(Math.floor(this.now() / 1000));
    this.subscribeEventInbox(state, since);
    // React to live 31600 config edits (relays, matching, visibility, lang…) — audit H5.
    this.subscribeEventConfig(state);
    // Marmot group chat (§4): only chat-enabled events with a coordinator do any
    // work here — a chat-off event stays completely inert (no group, no watcher).
    if (state.chat) await this.ensureChat(state);
  }

  private currentEck(state: EventState): { bytes: Uint8Array; id: number } {
    const latest = state.eck.reduce((m, v) => (v.id > m.id ? v : m));
    return { bytes: base64ToBytes(latest.key), id: latest.id };
  }

  private publishKeys(state: EventState): PublishKeys {
    const { bytes, id } = this.currentEck(state);
    return { coordSk: this.deps.coordSk, eck: bytes, eckId: id };
  }

  // ── inbound gift-wrap dispatch ─────────────────────────────────────────────
  /**
   * Decrypt-check a wrap and return its rumor, or undefined when there is no new
   * work (audit COORD-2/COORD-11). Dedupe is read-only here — a rumor is marked
   * seen only AFTER it is handled successfully ({@link processRumorWithRetry}),
   * so a transient mid-handler failure is retried rather than permanently lost.
   * Deterministic failures (undecryptable wrap, future-dated rumor, duplicate)
   * ARE marked seen immediately so they don't loop on every startup rescan.
   */
  private unwrapFresh(wrap: GiftWrap, recipientSk: Uint8Array): Rumor | undefined {
    if (this.deps.store.isRumorSeen(wrap.id)) return undefined;
    let rumor: Rumor;
    try {
      rumor = unwrapRumor(wrap, recipientSk);
    } catch {
      this.deps.store.markRumorSeen(wrap.id, this.now()); // can never decrypt — drop
      return undefined;
    }
    // Freshness (COORD-11): drop rumors future-dated > 15 min (clock-skew guard
    // against replay-with-shifted-timestamp; the protocol layer clamps too —
    // defense in depth here).
    if (typeof rumor.created_at === "number" && rumor.created_at > Math.floor(this.now() / 1000) + 15 * 60) {
      log(`[wrap] dropped future-dated rumor ${rumor.id.slice(0, 8)} (kind ${rumor.kind}, created_at ${rumor.created_at})`);
      this.deps.store.markRumorSeen(rumor.id, this.now());
      this.deps.store.markRumorSeen(wrap.id, this.now());
      return undefined;
    }
    if (this.deps.store.isRumorSeen(rumor.id)) {
      this.deps.store.markRumorSeen(wrap.id, this.now()); // same rumor, new wrap
      return undefined;
    }
    return rumor;
  }

  /**
   * Run a rumor's handler, marking wrap+rumor seen only on SUCCESS (audit
   * COORD-2). On failure the error is logged and the rumor retried in-memory
   * with a bounded backoff (default 5s/30s, so a transient blip doesn't wait
   * for a restart); if it still fails, the rumor stays UNSEEN so the next
   * startup/backfill rescan picks it up. Permanent failures (schema/JSON — the
   * payload can never parse) are marked seen instead of looping forever.
   */
  private async processRumorWithRetry(
    wrapId: string,
    rumor: { id: string; kind: number },
    dispatch: () => Promise<void>,
  ): Promise<void> {
    const delays = this.wrapRetryDelaysMs;
    const maxAttempts = 1 + delays.length;
    for (let attempt = 1; ; attempt++) {
      try {
        await dispatch();
        this.deps.store.markRumorSeen(rumor.id, this.now());
        this.deps.store.markRumorSeen(wrapId, this.now());
        return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Permanent failures — the payload can never parse (schema) or is not
        // JSON at all — are marked seen instead of looping on every rescan.
        if (e instanceof ZodError || e instanceof SyntaxError) {
          log(`[wrap] rumor ${rumor.id.slice(0, 8)} (kind ${rumor.kind}) is permanently unprocessable — dropped: ${msg.slice(0, 120)}`);
          this.deps.store.markRumorSeen(rumor.id, this.now());
          this.deps.store.markRumorSeen(wrapId, this.now());
          return;
        }
        if (attempt >= maxAttempts) {
          log(
            `[wrap] rumor ${rumor.id.slice(0, 8)} (kind ${rumor.kind}) FAILED after ${attempt} attempt(s) — left unseen for the startup rescan: ${msg.slice(0, 160)}`,
          );
          return;
        }
        const delay = delays[attempt - 1]!;
        log(`[wrap] rumor ${rumor.id.slice(0, 8)} (kind ${rumor.kind}) attempt ${attempt}/${maxAttempts} failed: ${msg.slice(0, 120)} — retrying in ${delay}ms`);
        await this.sleep(delay);
      }
    }
  }

  /** Handle a wrap addressed to the coordinator's own pubkey (install/admin). */
  async handleCoordinatorWrap(wrap: GiftWrap): Promise<void> {
    const rumor = this.unwrapFresh(wrap, this.deps.coordSk);
    if (!rumor) return;
    await this.processRumorWithRetry(wrap.id, rumor, async () => {
      if (rumor.kind === KIND_COORDINATOR_GRANT) {
        const grant = coordinatorGrantContentSchema.parse(JSON.parse(rumor.content));
        // Authenticate the install (ENCRYPTION-AND-PRIVACY.md F2): the grant must be
        // sealed by the event's E_id — rumor.pubkey is the verified seal author —
        // exactly the check 21604 admin commands already get. Otherwise anyone with
        // a plausible-looking payload could "install" an event and pick its relays.
        const eidPubkey = parseCoordinate(grant.a).pubkey;
        if (rumor.pubkey !== eidPubkey) {
          log(`[install] REJECTED 21603 for ${grant.a}: seal author ${short(rumor.pubkey)} is not E_id ${short(eidPubkey)}`);
          return;
        }
        // Install caps (audit COORD-3): an operator allowlist (when configured)
        // and a hard cap on simultaneously installed events bound the work an
        // unsolicited install can create on this daemon.
        if (this.allowedEidPubkeys.size > 0 && !this.allowedEidPubkeys.has(eidPubkey)) {
          log(`[install] REJECTED 21603 for ${grant.a}: E_id ${short(eidPubkey)} not in security.allowed_eid_pubkeys`);
          return;
        }
        if (this.deps.store.getEvent(grant.a) === undefined && this.deps.store.allEvents().length >= this.maxEvents) {
          log(`[install] REJECTED 21603 for ${grant.a}: at the ${this.maxEvents}-event install cap (security.max_events)`);
          return;
        }
        // Fresh install (event unknown to the store) → full-history backfill so
        // join requests/submissions older than 3 days are not missed (audit H2).
        const known = this.deps.store.getEvent(grant.a) !== undefined;
        await this.installEvent({
          coordinate: grant.a,
          inboxSkHex: grant.inbox_nsec,
          eck: grant.eck,
          configRelays: grant.config_relays,
          backfill: known ? "recent" : "full",
        });
      } else if (rumor.kind === KIND_ADMIN_COMMAND) {
        const cmd = adminCommandContentSchema.parse(JSON.parse(rumor.content));
        log(`[admin] "${cmd.cmd}" from organizer ${short(rumor.pubkey)}`);
        await this.handleAdmin(rumor.pubkey, cmd.a, cmd.cmd, cmd.args);
      } else if (rumor.kind === KIND_CHAT_KEY_ATTESTATION) {
        // Marmot chat-key attestation (§3.3). rumor.pubkey is the SEAL AUTHOR bound by
        // unwrapRumor — i.e. the attendee's own account key sealing the binding. The
        // admin authenticates it against the enrolled-attendee set before recording.
        if (!this.marmot) return;
        const content = chatKeyAttestationContentSchema.parse(JSON.parse(rumor.content));
        log(`[chat] 21607 ${content.op} from ${short(rumor.pubkey)} for ${content.a}`);
        await this.marmot.handleAttestation(content.a, rumor.pubkey, content);
      }
    });
  }

  /** Handle a wrap addressed to an event's E_inbox (join / submission). */
  async handleInboxWrap(coordinate: string, wrap: GiftWrap): Promise<void> {
    const state = this.events.get(coordinate);
    if (!state) return;
    const rumor = this.unwrapFresh(wrap, state.inboxSk);
    if (!rumor) return;
    await this.processRumorWithRetry(wrap.id, rumor, async () => {
      if (rumor.kind === KIND_JOIN_REQUEST) {
        const content = joinRequestContentSchema.parse(JSON.parse(rumor.content));
        log(`[join] request from ${short(rumor.pubkey)} ("${content.name}")`);
        await this.handleJoin(state, rumor.pubkey, rumor.tags, content.name);
      } else if (rumor.kind === KIND_PROFILE_SUBMISSION) {
        const content = profileSubmissionContentSchema.parse(JSON.parse(rumor.content));
        log(`[submission] from ${short(rumor.pubkey)} — ${content.media.length} media, ${content.intro_text ? "text intro, " : ""}${content.profile.skills.length} skills`);
        await this.handleSubmission(state, rumor.pubkey, content.profile, content.media, content.intro_text);
      } else if (rumor.kind === KIND_PROFILE_CORRECTION) {
        const content = profileCorrectionContentSchema.parse(JSON.parse(rumor.content));
        // The subject is the SEAL AUTHOR (rumor.pubkey), bound by unwrapRumor — an
        // attendee may only correct THEIR OWN profile (audit U9). There is no subject
        // field to spoof: a correction always applies to the sender's own entry.
        await this.handleCorrection(state, rumor.pubkey, content);
      } else if (rumor.kind === KIND_TALK_SUBMISSION) {
        const content = talkSubmissionContentSchema.parse(JSON.parse(rumor.content));
        // The speaker is the SEAL AUTHOR (rumor.pubkey), bound by unwrapRumor.
        await this.handleTalkSubmission(state, rumor.pubkey, content);
      }
    });
  }

  /**
   * Store a submitted (or edited) talk (spec F2). Ignored entirely when talks are
   * off for this event, or when the sender isn't an approved member — talks are a
   * members-only surface. The talk lands as 'pending' (needs organizer moderation);
   * a process_talk job transcribes it in the background. The previously published
   * 31610 (if any) stays live until the organizer publishes the new revision.
   */
  private async handleTalkSubmission(
    state: EventState,
    pubkey: string,
    content: TalkSubmissionContent,
  ): Promise<void> {
    if (content.a !== state.coordinate) return;
    if (state.talks === "off") {
      log(`[talk] ignored from ${short(pubkey)}: talks are off for this event`);
      return;
    }
    const attendee = this.deps.store.getAttendee(state.coordinate, pubkey);
    if (!attendee || attendee.status !== "approved") {
      log(`[talk] ignored from ${short(pubkey)}: not an approved attendee`);
      return;
    }
    const isNewTalk = !this.deps.store.getTalk(state.coordinate, pubkey, content.talk_d);
    if (isNewTalk && this.deps.store.countTalksBySpeaker(state.coordinate, pubkey) >= MAX_TALKS_PER_SPEAKER) {
      log(
        `[talk] ${short(pubkey)}: ${MAX_TALKS_PER_SPEAKER}-talk cap reached — new submission "${content.title}" ignored (edits to existing talks are unaffected)`,
      );
      return;
    }
    this.deps.store.upsertTalk({
      coordinate: state.coordinate,
      pubkey,
      talkD: content.talk_d,
      title: content.title,
      description: content.description,
      speakersJson: JSON.stringify(content.speakers),
      mediaJson: JSON.stringify(content.media),
      lang: state.lang,
      revision: content.revision,
      mediaX: content.media.x,
      now: this.now(),
    });
    log(`[talk] "${content.title}" from ${short(pubkey)} (rev ${content.revision}) → pending moderation`);
    // Transcribe in the background (keyed by media x so a re-delivery dedupes).
    this.jobs.enqueue(
      "process_talk",
      `talk:${state.coordinate}:${pubkey}:${content.talk_d}:${content.media.x}`,
      { coordinate: state.coordinate, pubkey, talkD: content.talk_d },
    );
  }

  /**
   * Store and apply an attendee's ai_profile correction/hide (F3, audit U9). Only
   * an approved member may correct their own already-published entry. The correction
   * is persisted in `attendees.correction_json` (NOT the content-addressed artifact
   * cache) so it survives reprocessing — `publishDirectory` re-applies it on every
   * publish, including after a fresh ai_profile is generated.
   */
  private async handleCorrection(
    state: EventState,
    pubkey: string,
    content: ProfileCorrectionContent,
  ): Promise<void> {
    if (content.a !== state.coordinate) return; // correction for a different event
    const attendee = this.deps.store.getAttendee(state.coordinate, pubkey);
    if (!attendee || attendee.status !== "approved") {
      log(`[correction] ignored from ${short(pubkey)}: not an approved attendee`);
      return;
    }
    this.deps.store.upsertAttendee({
      coordinate: state.coordinate,
      pubkey,
      correctionJson: JSON.stringify(content),
      now: this.now(),
    });
    const kind = content.hidden
      ? "hide"
      : content.overrides || content.hidden_fields
        ? "override"
        : "reset";
    // The report field is minimally carried (owner deferred a full report flow):
    // just note it, no moderation queue.
    if (content.report) log(`[correction] ${short(pubkey)} attached an inaccuracy report`);
    log(`[correction] ${kind} applied for ${short(pubkey)}`);
    await this.publishDirectory(state, pubkey);
  }

  private async handleJoin(
    state: EventState,
    attendeePubkey: string,
    tags: string[][],
    name: string,
  ): Promise<void> {
    // Already approved: this is a re-delivery after a mid-grant failure (the
    // rumor was left unseen, COORD-2) — grantAndPublish is idempotent
    // (replaceable events + deduped grants), so re-running repairs a lost grant.
    const existing = this.deps.store.getAttendee(state.coordinate, attendeePubkey);
    if (existing?.status === "approved") {
      await this.grantAndPublish(state, attendeePubkey);
      return;
    }

    const inviteTag = tags.find((t) => t[0] === "invite");
    const invite = inviteTag && inviteTag[1] && inviteTag[2]
      ? { invitePubkey: inviteTag[1], sig: inviteTag[2] }
      : undefined;

    const publishedInviteHashes = await this.fetchInviteHashes(state);
    const decision = evaluateEntitlement([this.inviteChecker], {
      coordinate: state.coordinate,
      attendeePubkey,
      invite,
      publishedInviteHashes,
    }, this.now());

    this.deps.store.upsertAttendee({
      coordinate: state.coordinate,
      pubkey: attendeePubkey,
      status: decision.grant ? "approved" : "pending",
      // B1: keep the display name — match reasoning addresses people by name.
      displayName: name.trim() || null,
      now: this.now(),
    });

    log(
      `[join] ${short(attendeePubkey)} invite=${invite ? "yes" : "no"} → ${decision.grant ? "AUTO-APPROVED" : "manual queue (" + decision.reason + ")"}`,
    );
    if (decision.grant) await this.grantAndPublish(state, attendeePubkey);
  }

  private async handleSubmission(
    state: EventState,
    pubkey: string,
    profile: AttendeeProfile,
    media: MediaDescriptor[],
    introText?: string,
  ): Promise<void> {
    // Cap media descriptors per submission (audit COORD-4): extras are skipped
    // (and logged) so a hostile submission can't fan out downloads/STT billing.
    let cappedMedia = media;
    if (media.length > MAX_MEDIA_PER_SUBMISSION) {
      log(`[submission] ${short(pubkey)}: ${media.length} media exceeds the ${MAX_MEDIA_PER_SUBMISSION}-descriptor cap — extras skipped`);
      cappedMedia = media.slice(0, MAX_MEDIA_PER_SUBMISSION);
    }
    // Store the profile with its media descriptors + text intro stashed for the
    // pipeline, and record the source revision (hash of the authored submission,
    // audit Q10) so a directory entry never surfaces a stale ai_profile beside
    // changed fields. `__intro_text` carries a text intro (F1) with no blob.
    const profileJson = JSON.stringify({ ...profile, __media: cappedMedia, __intro_text: introText });
    this.deps.store.upsertAttendee({
      coordinate: state.coordinate,
      pubkey,
      profileJson,
      sourceRevision: this.sourceRevision(profileJson),
      now: this.now(),
    });
    const attendee = this.deps.store.getAttendee(state.coordinate, pubkey);
    if (attendee?.status === "approved") {
      await this.publishDirectory(state, pubkey);
      this.enqueueProcess(state.coordinate, pubkey);
    }
  }

  /** Stable revision id for an authored submission (audit Q10). */
  private sourceRevision(profileJson: string): string {
    return sha256Hex(utf8ToBytes(profileJson)).slice(0, 16);
  }

  /**
   * Enqueue the AI pipeline for an attendee, keyed by a hash of their current
   * profile+media so a changed submission reprocesses while re-delivery of the
   * same submission is deduped (never re-billed). Skipped when matching is OFF
   * (audit H4): no transcript/summary/profile/embedding/scoring work — and thus
   * no provider billing — for an event that disabled AI matching.
   */
  private enqueueProcess(coordinate: string, pubkey: string): void {
    if (this.events.get(coordinate)?.matching === "off") return;
    const attendee = this.deps.store.getAttendee(coordinate, pubkey);
    const version = sha256Hex(utf8ToBytes(attendee?.profile_json ?? "")).slice(0, 16);
    this.jobs.enqueue("process_attendee", `proc:${coordinate}:${pubkey}:${version}`, {
      coordinate,
      pubkey,
    });
  }

  /** Grant the ECK and publish the directory entry + roster for a new attendee. */
  async grantAndPublish(state: EventState, attendeePubkey: string): Promise<void> {
    const grant = buildKeyGrant(this.deps.coordSk, state.coordinate, attendeePubkey, state.eck);
    await this.deps.transport.publish(grant, state.configRelays);
    await this.publishDirectory(state, attendeePubkey);
    await this.publishRoster(state);
    log(`[grant] ECK granted to ${short(attendeePubkey)}; directory + roster published`);
    // Profile-first matching (user feedback 2026-07-16): a Nostr-native attendee
    // brings a kind-0 bio and posts — start the AI pipeline at approval time so
    // matching runs from profile + nostr-context immediately, no intro required.
    // The job is keyed by the submission hash, so when an intro lands later the
    // changed key re-processes and the scoped recompute re-matches them.
    this.enqueueProcess(state.coordinate, attendeePubkey);
    // The AI pipeline is kicked off when a profile submission arrives (there is
    // nothing to transcribe/profile until then). Directory text is already visible.
    if (this.deps.store.getAttendee(state.coordinate, attendeePubkey)?.profile_json) {
      this.enqueueProcess(state.coordinate, attendeePubkey);
    }
    // Marmot (§4.2): add the newly-approved attendee's chat identities to the
    // group. Routed through the durable job runner (audit COORD-9): a transient
    // MLS/relay failure is retried with backoff and surfaces via the poison/21606
    // path rather than leaving the member out of the group forever.
    if (state.chat && this.marmot) {
      this.marmot.invalidateEligibility(state.coordinate);
      this.jobs.enqueue(
        "chat_sync_member",
        `chat-sync:${state.coordinate}:${attendeePubkey}:${this.now()}`,
        { coordinate: state.coordinate, pubkey: attendeePubkey },
      );
    }
  }

  private parseStoredProfile(
    attendee: import("./store/db.js").AttendeeRow | undefined,
  ): { profile: AttendeeProfile; media: MediaDescriptor[]; introText?: string } {
    const raw = attendee?.profile_json ? JSON.parse(attendee.profile_json) : {};
    const media = (raw.__media ?? []) as MediaDescriptor[];
    const profile: AttendeeProfile = {
      about: raw.about ?? "",
      skills: raw.skills ?? [],
      looking_for: raw.looking_for ?? "",
      links: raw.links ?? [],
    };
    const introText = typeof raw.__intro_text === "string" && raw.__intro_text ? raw.__intro_text : undefined;
    return { profile, media, introText };
  }

  private async publishDirectory(state: EventState, pubkey: string): Promise<void> {
    const attendee = this.deps.store.getAttendee(state.coordinate, pubkey);
    const { profile, media, introText } = this.parseStoredProfile(attendee);
    // Revision guard (audit Q10): only surface ai_profile when it was derived from
    // the CURRENT authored submission. After a resubmission the entry publishes the
    // fresh authored fields immediately but omits the now-stale AI profile until the
    // pipeline re-derives it — never pairing new source text with old AI output.
    const aiFresh =
      attendee?.ai_profile_json &&
      (!attendee.source_revision || attendee.ai_source_revision === attendee.source_revision);
    const generatedAi: AiProfile | undefined = aiFresh ? JSON.parse(attendee!.ai_profile_json!) : undefined;
    // Apply the attendee's correction/hide (F3) on top of the freshly generated
    // ai_profile. The correction lives in correction_json (not the artifact cache),
    // so it is re-applied here on EVERY publish — it survives a reprocess/recompute.
    const correction: ProfileCorrectionContent | undefined = attendee?.correction_json
      ? JSON.parse(attendee.correction_json)
      : undefined;
    const { aiProfile: correctedAi, edited } = applyCorrection(generatedAi, correction);
    // Output hygiene at the publish boundary (audit COORD-12): LLM-authored text
    // is length-capped and URLs neutralized so injected content can't smuggle
    // clickable links into clients.
    const aiProfile = correctedAi ? sanitizeAiProfile(correctedAi) : undefined;
    // Published transcripts (audit A1): the nonvisual consumption path. Keep only
    // transcripts whose media is still present — a re-record changes `x`, so an old
    // transcript is silently dropped (also enforced by the 31603 schema refine).
    const liveHashes = new Set(media.map((m) => m.x));
    const storedTranscripts = attendee?.transcripts_json
      ? (JSON.parse(attendee.transcripts_json) as MediaTranscript[])
      : [];
    const transcripts = storedTranscripts.filter((tr) => liveHashes.has(tr.x));
    // Defensive size guard (audit COORD-18): NIP-44 caps plaintext at 65,535
    // bytes — bound user-authored fields so one giant field can't fail the
    // whole entry inside eckEncrypt (schema caps are the primary control).
    const cappedProfile: AttendeeProfile = {
      about: capAuthoredText(profile.about),
      skills: profile.skills.slice(0, 64).map((s) => capAuthoredText(s, 200)),
      looking_for: capAuthoredText(profile.looking_for),
      links: profile.links.slice(0, 32).map((l) => capAuthoredText(l, 500)),
    };
    const entry = buildDirectoryEntry(this.publishKeys(state), state.coordinate, {
      v: 1,
      pubkey,
      ...(attendee?.display_name ? { name: capAuthoredText(attendee.display_name, MAX_NAME_CHARS) } : {}),
      profile: cappedProfile,
      media,
      ...(aiProfile ? { ai_profile: aiProfile } : {}),
      ...(edited ? { ai_profile_edited: true } : {}),
      ...(transcripts.length ? { transcripts: transcripts.map((t) => ({ ...t, text: capAuthoredText(t.text, 8000) })) } : {}),
      ...(introText ? { intro_text: capAuthoredText(introText) } : {}),
      updated_at: Math.floor(this.now() / 1000),
    });
    await this.deps.transport.publish(entry, state.configRelays);
  }

  private async publishRoster(state: EventState): Promise<void> {
    const approved = this.deps.store.approvedAttendees(state.coordinate);
    const { bytes } = this.currentEck(state);
    const roster: RosterContent = {
      v: 1,
      eck_current: this.currentEck(state).id,
      attendees: approved.map((a) => ({
        pubkey: a.pubkey,
        d: blindedDFor(bytes, state.coordinate, a.pubkey),
        role: a.role === "organizer" ? "organizer" : "attendee",
      })),
    };
    const event = buildRoster(this.publishKeys(state), state.coordinate, roster);
    await this.deps.transport.publish(event, state.configRelays);
  }

  // ── pipeline jobs ──────────────────────────────────────────────────────────
  private async processAttendeeJob(coordinate: string, pubkey: string): Promise<void> {
    const state = this.events.get(coordinate);
    if (!state) return;
    // Re-check config at execution time (audit H4): a job queued while matching was
    // ON must not call any provider if matching has since been turned OFF.
    if (state.matching === "off") return;
    const attendee = this.deps.store.getAttendee(coordinate, pubkey);
    if (!attendee) return;
    const { profile, media, introText } = this.parseStoredProfile(attendee);
    // Server-side media caps (audit COORD-4): per-descriptor duration cap (the
    // event's configured max) and a total-download budget per submission —
    // over-cap media is skipped with a log, never transcribed.
    const cappedMedia = this.capMedia(state, pubkey, media);
    // Capture the source revision this AI run is derived from (audit Q10).
    const sourceRevision = attendee.source_revision ?? this.sourceRevision(attendee.profile_json ?? "");
    // Fold the speaker's talk transcripts into their ai_profile (spec §9.2, F2) so a
    // prerecorded talk feeds matching "as today". Only when talks are enabled.
    const extraTranscripts =
      state.talks !== "off" ? this.deps.store.talkTranscriptsForSpeaker(coordinate, pubkey) : [];
    log(`[pipeline] ${short(pubkey)}: transcribe ${cappedMedia.length} media${introText ? " + text intro" : ""}${extraTranscripts.length ? ` + ${extraTranscripts.length} talk transcript(s)` : ""} → nostr-context → ai_profile…`);

    const { aiProfile, transcripts } = await processAttendee(
      {
        store: this.deps.store,
        stt: this.deps.stt,
        sttModel: this.deps.sttModel,
        llm: this.deps.llm,
        summaryModel: this.deps.summaryModel,
        matchModel: this.deps.matchModel,
        translateModel: this.deps.translateModel,
        fetchBlob: this.deps.fetchBlob,
        transcribe: this.deps.transcribe,
        blossomOrigins: state.blossomOrigins,
        maxMediaBytes: this.deps.maxMediaBytes,
        fetchNostrContext: (pk, n) => this.fetchNostrContext(state, pk, n),
        nostrContextN: state.nostrContextN,
        lang: state.lang,
        now: this.now,
      },
      { pubkey, profile, media: cappedMedia, introText, extraTranscripts },
    );

    this.deps.store.upsertAttendee({
      coordinate,
      pubkey,
      aiProfileJson: JSON.stringify(aiProfile),
      profileHash: profileHash(aiProfile),
      aiSourceRevision: sourceRevision,
      // Always write the fresh set (may be "[]") so a re-record overwrites stale
      // transcripts rather than leaving old ones via COALESCE.
      transcriptsJson: JSON.stringify(transcripts),
      now: this.now(),
    });
    // The pipeline succeeded: clear any previously surfaced poison status for
    // this attendee's stages (audit COORD-15) so the organizer view recovers.
    this.deps.store.clearPoisonStatuses(coordinate, pubkey);
    await this.publishDirectory(state, pubkey);
    log(`[pipeline] ${short(pubkey)} ai_profile ready — skills: ${aiProfile.skills.slice(0, 4).join(", ")}`);
  }

  /**
   * Apply the server-side media caps (audit COORD-4): drop descriptors whose
   * declared duration exceeds the event's cap or that push the submission past
   * the total-download budget. Skips are logged; processing continues with the
   * rest (no protocol fields invented — the media simply isn't transcribed).
   */
  private capMedia(state: EventState, pubkey: string, media: MediaDescriptor[]): MediaDescriptor[] {
    const out: MediaDescriptor[] = [];
    let totalBytes = 0;
    for (const d of media) {
      if (typeof d.duration === "number" && d.duration > state.maxMediaSec) {
        log(`[pipeline] ${short(pubkey)}: skipping ${d.duration}s media (over the ${state.maxMediaSec}s cap)`);
        continue;
      }
      if (totalBytes + d.size > MAX_SUBMISSION_MEDIA_BYTES) {
        log(`[pipeline] ${short(pubkey)}: skipping media past the ${MAX_SUBMISSION_MEDIA_BYTES}-byte submission budget`);
        continue;
      }
      totalBytes += d.size;
      out.push(d);
    }
    return out;
  }

  /**
   * Transcribe a submitted talk (spec F2). Reuses the intro transcription pipeline
   * (audio.ts segments long talks). The transcript is stored on the talk row for
   * publication on the 31610 and — when matching is on — folded into the speaker's
   * ai_profile via a reprocess so the talk feeds matching (§9.2). If the talk is
   * already published, re-publish it with the fresh transcript.
   */
  private async processTalkJob(coordinate: string, pubkey: string, talkD: string): Promise<void> {
    const state = this.events.get(coordinate);
    if (!state) return;
    // Re-check config at execution time (audit COORD-28, mirroring the matching-off
    // re-check): talks may have been disabled after this job was queued — never run
    // paid STT for a talks-off event.
    if (state.talks === "off") {
      log(`[talk] process_talk skipped for ${short(pubkey)}: talks are off for this event`);
      return;
    }
    const talk = this.deps.store.getTalk(coordinate, pubkey, talkD);
    if (!talk) return;
    const media = JSON.parse(talk.media_json) as MediaDescriptor;
    // Duration cap (audit COORD-4): never transcribe over-length talk media.
    if (typeof media.duration === "number" && media.duration > state.maxMediaSec) {
      log(`[talk] skipping transcription of "${talk.title}" for ${short(pubkey)}: ${media.duration}s over the ${state.maxMediaSec}s cap`);
      return;
    }
    const transcribe =
      this.deps.transcribe ??
      ((d: MediaDescriptor) =>
        transcribeMedia(
          {
            store: this.deps.store,
            stt: this.deps.stt,
            sttModel: this.deps.sttModel,
            fetchBlob: this.deps.fetchBlob,
            blossomOrigins: state.blossomOrigins,
            maxMediaBytes: this.deps.maxMediaBytes,
            now: this.now,
          },
          d,
        ));
    let transcript: MediaTranscript | undefined;
    const r = await transcribe(media);
    const text = typeof r === "string" ? r : r.text;
    const detected = typeof r === "string" ? undefined : r.lang;
    if (text) {
      transcript = {
        x: media.x,
        text,
        lang: detected ?? (state.lang || "en").toLowerCase(),
        source: "stt",
        updated_at: this.now(),
      };
      this.deps.store.setTalkTranscript(coordinate, pubkey, talkD, JSON.stringify(transcript), this.now());
      log(`[talk] transcribed "${talk.title}" for ${short(pubkey)}`);
    }
    // If this talk is already published, refresh its 31610 with the new transcript.
    if (talk.status === "published") await this.publishTalk(state, pubkey, talkD);
    // Feed matching (§9.2): reprocess the speaker so the talk contributes to their
    // ai_profile. Keyed by the talk media x so re-delivery dedupes but a new
    // recording re-runs. Only when matching is on and they have a submitted profile.
    if (state.matching === "on" && this.deps.store.getAttendee(coordinate, pubkey)?.profile_json) {
      this.jobs.enqueue("process_attendee", `proc:${coordinate}:${pubkey}:talk:${media.x}`, {
        coordinate,
        pubkey,
      });
    }
  }

  /**
   * Publish (or refresh) a talk's 31610 entry under the ECK (spec F2). Sets status
   * 'published'. The blinded `d` is stable per (speaker, talk_d), so a new revision
   * replaces the previous entry in place — the last published talk stays watchable
   * until this succeeds.
   */
  private async publishTalk(state: EventState, pubkey: string, talkD: string): Promise<void> {
    const talk = this.deps.store.getTalk(state.coordinate, pubkey, talkD);
    if (!talk) return;
    const media = JSON.parse(talk.media_json) as MediaDescriptor;
    const transcript = talk.transcript_json
      ? (JSON.parse(talk.transcript_json) as MediaTranscript)
      : undefined;
    const speakers = (() => {
      try {
        return JSON.parse(talk.speakers_json) as string[];
      } catch {
        return [];
      }
    })();
    const publishedAt =
      talk.published_at > 0 ? talk.published_at : Math.floor(this.now() / 1000);
    const content: TalkContent = {
      v: 1,
      pubkey,
      talk_d: talkD,
      title: talk.title,
      description: talk.description,
      speakers,
      media,
      ...(transcript ? { transcript } : {}),
      lang: talk.lang,
      revision: talk.revision,
      status: "published",
      published_at: publishedAt,
    };
    const event = buildTalkEntry(this.publishKeys(state), state.coordinate, content);
    await this.deps.transport.publish(event, state.configRelays);
    // Record the publish-time ECK id (audit COORD-7): post-rotation deletion must
    // address the entry under the ECK it was published with, not the current one.
    this.deps.store.setTalkStatus(state.coordinate, pubkey, talkD, "published", publishedAt, this.now(), this.currentEck(state).id);
    log(`[talk] published 31610 "${talk.title}" for ${short(pubkey)} (rev ${talk.revision})`);
  }

  /** The ECK bytes for a version id, falling back to the current version. */
  private eckById(state: EventState, id: number | null | undefined): Uint8Array {
    const v = id != null ? state.eck.find((e) => e.id === id) : undefined;
    return v ? base64ToBytes(v.key) : this.currentEck(state).bytes;
  }

  /** NIP-09 deletion of a talk's 31610 at the blinded d under `eck` (COORD-7). */
  private async deleteTalkEntry(state: EventState, eck: Uint8Array, pubkey: string, talkD: string, reason: string): Promise<void> {
    const d = talkBlindedD(eck, state.coordinate, pubkey, talkD);
    const deletion = finalizeEvent(
      {
        kind: KIND_DELETION,
        created_at: Math.floor(this.now() / 1000),
        tags: [["a", `${KIND_TALK}:${this.coordPubkey}:${d}`], ["k", String(KIND_TALK)]],
        content: reason,
      },
      this.deps.coordSk,
    );
    await this.deps.transport.publish(deletion, state.configRelays);
  }

  /**
   * Reject a talk (spec F2): mark it rejected and delete any published 31610 so it
   * stops being watchable. NIP-09 addressable deletion at the talk's blinded d,
   * derived from the ECK it was PUBLISHED under (audit COORD-7) — after a rotation
   * the current ECK yields a different (wrong) address.
   */
  private async rejectTalk(state: EventState, pubkey: string, talkD: string): Promise<void> {
    const talk = this.deps.store.getTalk(state.coordinate, pubkey, talkD);
    if (!talk) return;
    if (talk.status === "published") {
      await this.deleteTalkEntry(state, this.eckById(state, talk.published_eck_id), pubkey, talkD, "talk rejected");
    }
    this.deps.store.setTalkStatus(state.coordinate, pubkey, talkD, "rejected", 0, this.now());
    log(`[talk] rejected "${talk.title}" for ${short(pubkey)}`);
  }

  private buildMatchingRoster(coordinate: string): AttendeeForMatching[] {
    return this.deps.store
      .approvedAttendees(coordinate)
      .filter((a) => a.ai_profile_json && a.profile_hash)
      .map((a) => ({ pubkey: a.pubkey, profileHash: a.profile_hash! }));
  }

  private async selectPairs(coordinate: string, pubkey: string) {
    const roster = this.buildMatchingRoster(coordinate);
    const target = roster.find((a) => a.pubkey === pubkey);
    if (!target) return [];
    if (roster.length > this.prefilter.threshold && this.deps.llm.embed) {
      await this.attachEmbeddings(coordinate, roster);
    }
    return selectPairsToScore(this.deps.store, coordinate, target, roster, this.prefilter);
  }

  /**
   * Attach embeddings to the roster for the prefilter, reusing cached embeddings
   * (audit COORD-13): an attendee's embedding is content-addressed by their
   * profile_hash + the embedding model id in the artifact table, so a recompute
   * only embeds attendees whose profile CHANGED — not the full roster every time.
   */
  private async attachEmbeddings(coordinate: string, roster: AttendeeForMatching[]): Promise<void> {
    if (!this.deps.llm.embed) return;
    const modelKey = `${this.deps.embedModel.provider}:${this.deps.embedModel.model}`;
    const textFor = (pubkey: string): string => {
      const attendee = this.deps.store.getAttendee(coordinate, pubkey);
      const ai = attendee?.ai_profile_json ? JSON.parse(attendee.ai_profile_json) : {};
      return `${ai.summary ?? ""} ${(ai.skills ?? []).join(" ")} ${(ai.interests ?? []).join(" ")}`;
    };
    // Resolve cached embeddings; embed only the misses in one batched call.
    const missing: { index: number; pubkey: string; hash: string; text: string }[] = [];
    roster.forEach((a, index) => {
      const hash = sha256Hex(utf8ToBytes(`${modelKey}:${a.profileHash}`));
      const cached = this.deps.store.getArtifact("roster_embedding", hash) as number[] | undefined;
      if (cached) a.embedding = cached;
      else missing.push({ index, pubkey: a.pubkey, hash, text: textFor(a.pubkey) });
    });
    if (missing.length === 0) return;
    const embeddings = await this.deps.llm.embed(missing.map((m) => m.text), this.deps.embedModel.model);
    missing.forEach((m, i) => {
      const embedding = embeddings[i]!;
      roster[m.index]!.embedding = embedding;
      this.deps.store.putArtifact({
        stage: "roster_embedding",
        inputsHash: m.hash,
        provider: this.deps.embedModel.provider,
        model: this.deps.embedModel.model,
        output: embedding,
        now: this.now(),
      });
    });
  }

  /**
   * Score one batch (one target + ≤K candidates) in a single LLM call, writing each
   * directed result per-pair. Returns the pairs actually scored this attempt plus
   * how many candidates the model failed to return (missing/malformed entries).
   *
   * Idempotency: pairs already scored for their current inputs_hash are skipped, so
   * a retried or re-delivered batch never re-bills a finished pair — the retry call
   * contains only the unscored remainder.
   */
  private async scoreBatchJob(
    coordinate: string,
    pairs: CandidatePair[],
  ): Promise<{ scored: CandidatePair[]; missing: number }> {
    const state = this.events.get(coordinate);
    if (!state || state.matching === "off" || pairs.length === 0) return { scored: [], missing: 0 };
    const target = pairs[0]!.a;
    const targetProfile = this.loadAiProfile(coordinate, target);
    if (!targetProfile) return { scored: [], missing: 0 };

    // Score only pairs still pending for their current inputs_hash.
    const todo = pairs.filter((p) => {
      const dir = this.deps.store.getPairDirection(coordinate, p.a, p.b);
      return !dir || dir.inputs_hash !== p.inputsHash || !dir.scored;
    });

    const candidates: BatchCandidate[] = [];
    const pairById = new Map<string, CandidatePair>();
    for (const p of todo) {
      const profile = this.loadAiProfile(coordinate, p.b);
      if (!profile) continue;
      candidates.push({ id: p.b, profile, name: this.loadDisplayName(coordinate, p.b) });
      pairById.set(p.b, p);
    }
    if (candidates.length === 0) return { scored: [], missing: 0 };

    const { scores, missing } = await scoreBatch(
      this.deps.llm,
      this.deps.matchModel.model,
      state.scoringCtx,
      targetProfile,
      candidates,
      this.matchRng,
      this.loadDisplayName(coordinate, target),
    );
    const scored: CandidatePair[] = [];
    for (const [candId, ds] of scores) {
      const p = pairById.get(candId)!;
      recordDirectedScore(this.deps.store, coordinate, p, ds, this.now());
      scored.push(p);
      log(
        `[match] ${short(target)} → ${short(candId)} = ${ds.score.toFixed(2)} (sim ${ds.similarity.toFixed(2)}, comp ${ds.complementarity.toFixed(2)})`,
      );
    }
    if (missing.length) {
      log(`[match] ${short(target)} batch: ${missing.length} candidate(s) unparsed`);
    }
    return { scored, missing: missing.length };
  }

  /**
   * Reverse batch: score ≤K targets against ONE shared candidate in a single call
   * (spec §16.2 reverse variant). Each pair is `{a: target, b: shared}`; the shared
   * candidate is the same for every pair in the batch. Same per-pair idempotency,
   * same directed-row writes — only the call shape differs from the forward batch.
   */
  private async scoreReverseBatchJob(
    coordinate: string,
    pairs: CandidatePair[],
  ): Promise<{ scored: CandidatePair[]; missing: number }> {
    const state = this.events.get(coordinate);
    if (!state || state.matching === "off" || pairs.length === 0) return { scored: [], missing: 0 };
    const shared = pairs[0]!.b; // shared candidate for every pair in this batch
    const sharedProfile = this.loadAiProfile(coordinate, shared);
    if (!sharedProfile) return { scored: [], missing: 0 };

    // Score only pairs still pending for their current inputs_hash.
    const todo = pairs.filter((p) => {
      const dir = this.deps.store.getPairDirection(coordinate, p.a, p.b);
      return !dir || dir.inputs_hash !== p.inputsHash || !dir.scored;
    });

    const targets: BatchCandidate[] = [];
    const pairByTarget = new Map<string, CandidatePair>();
    for (const p of todo) {
      const profile = this.loadAiProfile(coordinate, p.a);
      if (!profile) continue;
      targets.push({ id: p.a, profile, name: this.loadDisplayName(coordinate, p.a) });
      pairByTarget.set(p.a, p);
    }
    if (targets.length === 0) return { scored: [], missing: 0 };

    const { scores, missing } = await scoreReverseBatch(
      this.deps.llm,
      this.deps.matchModel.model,
      state.scoringCtx,
      sharedProfile,
      targets,
      this.matchRng,
      this.loadDisplayName(coordinate, shared),
    );
    const scored: CandidatePair[] = [];
    for (const [targetId, ds] of scores) {
      const p = pairByTarget.get(targetId)!;
      recordDirectedScore(this.deps.store, coordinate, p, ds, this.now());
      scored.push(p);
      log(
        `[match] ${short(targetId)} → ${short(shared)} = ${ds.score.toFixed(2)} (reverse batch)`,
      );
    }
    if (missing.length) {
      log(`[match] reverse batch for ${short(shared)}: ${missing.length} target(s) unparsed`);
    }
    return { scored, missing: missing.length };
  }

  private loadAiProfile(coordinate: string, pubkey: string) {
    const attendee = this.deps.store.getAttendee(coordinate, pubkey);
    return attendee?.ai_profile_json ? JSON.parse(attendee.ai_profile_json) : undefined;
  }

  /** Display name from the join request (B1), for name-aware match reasoning. */
  private loadDisplayName(coordinate: string, pubkey: string): string | undefined {
    return this.deps.store.getAttendee(coordinate, pubkey)?.display_name ?? undefined;
  }

  private async publishMatchesJob(coordinate: string, pubkey: string): Promise<void> {
    const state = this.events.get(coordinate);
    if (!state || state.matching === "off") return; // never publish lists when matching is off (H4)
    const list = buildMatchList(this.deps.store, coordinate, pubkey, this.topK, Math.floor(this.now() / 1000));
    if (list.matches.length === 0) return;
    const event = buildMatchListEvent(this.publishKeys(state), coordinate, pubkey, sanitizeMatchList(list));
    await this.deps.transport.publish(event, state.configRelays);
    log(`[match] published list for ${short(pubkey)} — ${list.matches.length} match(es)`);
    // Publish the event-wide matrix (31606) only when visibility is "event" (H4).
    if (state.matchVisibility === "event") await this.publishMatrix(state);
  }

  /**
   * Publish/refresh the kind 31606 match matrix (audit H4). Scores only, under the
   * ECK, for events whose visibility is "event". Built from cached pair scores —
   * no provider calls — so a rotation or a visibility flip re-publishes cheaply.
   * `exclude` drops a revoked attendee's pairs before encryption.
   */
  private async publishMatrix(state: EventState, exclude?: string): Promise<void> {
    const approved = new Set(this.deps.store.approvedAttendees(state.coordinate).map((a) => a.pubkey));
    if (exclude) approved.delete(exclude);
    const seen = new Set<string>();
    const pairs: MatchMatrixContent["pairs"] = [];
    for (const pk of approved) {
      for (const row of this.deps.store.pairsFor(state.coordinate, pk)) {
        if (!approved.has(row.other)) continue;
        const key = pk < row.other ? `${pk}|${row.other}` : `${row.other}|${pk}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const [a, b] = pk < row.other ? [pk, row.other] : [row.other, pk];
        pairs.push({ a, b, score: row.score });
      }
    }
    const content: MatchMatrixContent = { v: 1, computed_at: Math.floor(this.now() / 1000), pairs };
    const event = buildMatchMatrix(this.publishKeys(state), state.coordinate, content);
    await this.deps.transport.publish(event, state.configRelays);
    log(`[match] published 31606 matrix — ${pairs.length} pair(s)`);
  }

  /** Delete the published 31606 matrix (visibility changed away from "event", H4/H5). */
  private async deleteMatrix(state: EventState): Promise<void> {
    const deletion = finalizeEvent(
      {
        kind: KIND_DELETION,
        created_at: Math.floor(this.now() / 1000),
        tags: [["a", `${KIND_MATCH_MATRIX}:${this.coordPubkey}:${state.identifier}`], ["k", String(KIND_MATCH_MATRIX)]],
        content: "match_visibility changed",
      },
      this.deps.coordSk,
    );
    await this.deps.transport.publish(deletion, state.configRelays);
  }

  // ── admin commands (21604) ─────────────────────────────────────────────────
  private async handleAdmin(
    from: string,
    coordinate: string,
    cmd: "approve" | "recompute" | "reprocess" | "revoke" | "talk_publish" | "talk_reject",
    args: Record<string, unknown>,
  ): Promise<void> {
    const state = this.events.get(coordinate);
    if (!state) return;
    // Only the organizer (E_id) may command the coordinator.
    if (from !== state.eidPubkey) return;

    if (cmd === "approve") {
      // Manual approval routed through the coordinator so IT grants the ECK and
      // publishes the directory/roster (attendees discover those under the
      // coordinator's key).
      const pubkey = String(args.pubkey ?? "");
      const attendee = pubkey ? this.deps.store.getAttendee(coordinate, pubkey) : undefined;
      if (attendee) {
        if (attendee.status !== "approved") {
          this.deps.store.upsertAttendee({ coordinate, pubkey, status: "approved", now: this.now() });
          log(`[approve] organizer approved ${short(pubkey)}`);
        }
        // Always (re-)grant (COORD-2): a retried 21604 whose first attempt died
        // mid-grant must still get the ECK out; grantAndPublish is idempotent.
        await this.grantAndPublish(state, pubkey);
      }
    } else if (cmd === "recompute") {
      // Full recompute: drop cached pair scores so every pair is re-scored.
      this.deps.store.clearPairs(coordinate);
      const key = `${this.now()}`;
      for (const a of this.deps.store.approvedAttendees(coordinate)) {
        this.jobs.enqueue("match_recompute", `match:${coordinate}:${a.pubkey}:${key}`, {
          coordinate,
          pubkey: a.pubkey,
        });
      }
    } else if (cmd === "reprocess") {
      const pubkey = String(args.pubkey ?? "");
      if (pubkey) {
        this.jobs.enqueue("process_attendee", `proc:${coordinate}:${pubkey}:manual`, { coordinate, pubkey });
      }
    } else if (cmd === "revoke") {
      const pubkey = String(args.pubkey ?? "");
      if (pubkey) await this.revokeAttendee(state, pubkey);
    } else if (cmd === "talk_publish") {
      // Moderate a submitted talk: publish its 31610 (spec F2). No-op if talks are off.
      if (state.talks === "off") return;
      const pubkey = String(args.pubkey ?? "");
      const talkD = String(args.talk_d ?? "");
      if (pubkey && talkD) await this.publishTalk(state, pubkey, talkD);
    } else if (cmd === "talk_reject") {
      const pubkey = String(args.pubkey ?? "");
      const talkD = String(args.talk_d ?? "");
      if (pubkey && talkD) await this.rejectTalk(state, pubkey, talkD);
    }
  }

  /**
   * Revoke an attendee and rotate the ECK (spec §6.3). Rotation is forward-only:
   * old ciphertexts stay readable to old key-holders, but all FUTURE directory/
   * roster/match content is encrypted under the new ECK, which the removed
   * attendee never receives. Their directory entry is deleted (NIP-09).
   */
  async revokeAttendee(state: EventState, removedPubkey: string): Promise<void> {
    const prev = this.currentEck(state); // capture the pre-rotation ECK

    // 1. Delete the removed attendee's directory entry (addressable, NIP-09).
    const removedD = blindedD(prev.bytes, state.coordinate, removedPubkey);
    const deletion = finalizeEvent(
      {
        kind: KIND_DELETION,
        created_at: Math.floor(this.now() / 1000),
        tags: [["a", `${KIND_DIRECTORY_ENTRY}:${this.coordPubkey}:${removedD}`], ["k", String(KIND_DIRECTORY_ENTRY)]],
        content: "revoked",
      },
      this.deps.coordSk,
    );
    await this.deps.transport.publish(deletion, state.configRelays);

    // 2. Mark removed, then mint the new ECK version.
    this.deps.store.upsertAttendee({ coordinate: state.coordinate, pubkey: removedPubkey, status: "revoked", now: this.now() });
    const newId = state.eck.reduce((m, v) => Math.max(m, v.id), 0) + 1;
    state.eck = [...state.eck, { id: newId, key: bytesToBase64(generateEck()) }];
    const row = this.deps.store.getEvent(state.coordinate);
    if (row) {
      this.deps.store.upsertEvent({
        coordinate: state.coordinate, configJson: row.config_json, inboxNsec: row.inbox_nsec,
        eckJson: JSON.stringify(state.eck), configRelays: row.config_relays, now: this.now(),
      });
    }

    // 3. Drop every cached pair that involves the removed attendee so remaining
    //    lists/matrix don't reference them after rotation (audit H3).
    this.deps.store.clearPairsInvolving(state.coordinate, removedPubkey);

    // 4. Re-grant the new ECK to every remaining attendee and republish content:
    //    directory + roster AND their match list under the new blinded `d`. The
    //    blinded `d` derives from the rotated ECK, so without this republish every
    //    remaining attendee would compute a new address with no match list there
    //    and their matches would vanish (audit H3). Rebuilt from cached scores —
    //    zero embedding/LLM provider calls.
    for (const a of this.deps.store.approvedAttendees(state.coordinate)) {
      const grant = buildKeyGrant(this.deps.coordSk, state.coordinate, a.pubkey, state.eck);
      await this.deps.transport.publish(grant, state.configRelays);
      await this.publishDirectory(state, a.pubkey);
      if (state.matching === "on") {
        const list = buildMatchList(this.deps.store, state.coordinate, a.pubkey, this.topK, Math.floor(this.now() / 1000));
        if (list.matches.length > 0) {
          const event = buildMatchListEvent(this.publishKeys(state), state.coordinate, a.pubkey, sanitizeMatchList(list));
          await this.deps.transport.publish(event, state.configRelays);
        }
      }
    }
    await this.publishRoster(state);
    // 5. Republish the event matrix under the new ECK (visibility=event), excluding
    //    the removed attendee; otherwise it stays encrypted under the old ECK.
    if (state.matching === "on" && state.matchVisibility === "event") {
      await this.publishMatrix(state, removedPubkey);
    }
    // 5b. Republish every published talk under the NEW ECK (audit COORD-7): their
    //     blinded `d` derives from the ECK, so without this the 31610s stay under
    //     the old ECK — readable by the revoked attendee, invisible to new-ECK
    //     members, and undeletable. The old-ECK copies are deleted (we know the
    //     publish-time ECK id from the talk row).
    for (const talk of this.deps.store.publishedTalksForEvent(state.coordinate)) {
      await this.publishTalk(state, talk.pubkey, talk.talk_d);
      if (talk.published_eck_id != null && talk.published_eck_id !== this.currentEck(state).id) {
        await this.deleteTalkEntry(state, this.eckById(state, talk.published_eck_id), talk.pubkey, talk.talk_d, "ECK rotated");
      }
    }
    // 6. Marmot (§4.2): MLS-Remove the attendee's account key + every attested chat
    //    key. An MLS Remove is real PCS for the chat — stronger than the ECK
    //    rotation. Routed through the durable job runner (audit COORD-9): a
    //    transient marmot failure retries with backoff and surfaces via the
    //    poison/21606 path rather than leaving the member in the group forever.
    if (state.chat && this.marmot) {
      this.marmot.invalidateEligibility(state.coordinate);
      this.jobs.enqueue(
        "chat_revoke_member",
        `chat-revoke:${state.coordinate}:${removedPubkey}:${this.now()}`,
        { coordinate: state.coordinate, pubkey: removedPubkey },
      );
    }
  }

  // ── context fetch ───────────────────────────────────────────────────────────
  /**
   * The event's published invite hashes, cached per event (audit COORD-29):
   * every join request used to re-fetch the 31601. The cache is invalidated when
   * a new 31601 arrives on the config subscription (see subscribeEventConfig).
   */
  private async fetchInviteHashes(state: EventState): Promise<Set<string>> {
    const cached = this.inviteHashCache.get(state.coordinate);
    if (cached) return cached;
    const events = await this.deps.transport.fetch(
      { kinds: [KIND_INVITE_LIST], authors: [state.eidPubkey], "#d": [parseCoordinate(state.coordinate).identifier] },
      state.configRelays,
    );
    const latest = events.sort((a, b) => b.created_at - a.created_at)[0];
    let hashes = new Set<string>();
    if (latest) {
      try {
        const parsed = inviteListContentSchema.parse(JSON.parse(latest.content));
        hashes = new Set(parsed.invites.map((i) => i.h));
      } catch {
        hashes = new Set();
      }
    }
    this.inviteHashCache.set(state.coordinate, hashes);
    return hashes;
  }

  /**
   * Fetch kind-0 + last N public posts (kinds 1, 6, 30023; reposts resolved).
   * Kind-0 is fetched with its own uncapped query (it's a single replaceable
   * event) so an active poster's note volume never crowds their profile bio
   * out of a shared `limit` — it's prepended without consuming one of the N
   * post slots. summarizeNostr() gives it special (labeled) treatment.
   */
  async fetchNostrContext(state: EventState, pubkey: string, n: number): Promise<NostrPost[]> {
    if (n <= 0) return [];
    const [profileEvents, postEvents] = await Promise.all([
      this.deps.transport.fetch({ kinds: [KIND_PROFILE], authors: [pubkey], limit: 1 }, state.configRelays),
      this.deps.transport.fetch(
        { kinds: [KIND_NOTE, KIND_REPOST, KIND_LONGFORM], authors: [pubkey], limit: n },
        state.configRelays,
      ),
    ]);
    const profile = profileEvents.sort((a, b) => b.created_at - a.created_at)[0];
    const posts = postEvents
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, n)
      .map((e) => ({ kind: e.kind, content: e.content, created_at: e.created_at }));
    return profile
      ? [{ kind: profile.kind, content: profile.content, created_at: profile.created_at }, ...posts]
      : posts;
  }

  // ── Marmot group chat (§4) ─────────────────────────────────────────────────

  /**
   * Fetch kind-30443 key packages authored by the given chat identities
   * (§4.2): first on the event's own relays (fast path — our own app's chat
   * clients publish there), then, for anyone still missing one, on their own
   * kind-10002 NIP-65 relays per the Marmot spec (key-package-discovery.ts) —
   * a third-party Marmot client (e.g. Whitenoise) publishes ONLY there.
   */
  private async fetchKeyPackages(coordinate: string, authors: string[]): Promise<NostrEvent[]> {
    const state = this.events.get(coordinate);
    if (!state || authors.length === 0) return [];
    return discoverKeyPackages(this.deps.transport, authors, state.configRelays, this.deps.defaultRelays);
  }

  /**
   * Bring up the group + its subscriptions for a chat-enabled event: create (or
   * reuse) the MLS group, backfill all currently-approved attendees, and start the
   * 30443 key-package watcher + 445 ingest loop. Idempotent.
   */
  private async ensureChat(state: EventState): Promise<void> {
    if (!this.marmot) return;
    await this.marmot.ensureGroup({
      coordinate: state.coordinate,
      name: state.scoringCtx.title,
      description: state.scoringCtx.summary,
      relays: state.configRelays,
    });
    // Self-heal: additively fold the Whitenoise relays into the group's own
    // routing state, even for a group that already existed before this was
    // added — a no-op once they're present, so safe to run on every install.
    await this.marmot.ensureRelays(state.coordinate, WHITENOISE_RELAYS);
    await this.marmot.backfillApproved(state.coordinate);
    this.subscribeChat(state);
  }

  /** Subscribe to 30443 key packages (add/heal) and 445 group traffic (ingest). */
  private subscribeChat(state: EventState): void {
    if (!this.marmot) return;
    // Keyed re-subscribe (audit COORD-8): relay handover (or a rotated group)
    // closes the old subs and opens new ones instead of guarding forever.
    const group = this.deps.store.getMarmotGroup(state.coordinate);
    const key = `${group?.nostr_group_id ?? "nogroup"}|${relayKey(state.configRelays)}`;
    this.replaceSubscription(this.chatSubs, state.coordinate, key, () => {
      const closers: Array<() => void> = [];
      // 30443 watcher: the in-handler authentication (approved attendee's authorized
      // chat identity) is the gate, so a broad kind filter on the event relays is safe
      // and needs no re-subscription as the author set changes on approve/attest.
      const kpCloser = (this.deps.transport as any).subscribe?.(
        { kinds: [KIND_KEY_PACKAGE] },
        (e: NostrEvent) => void this.marmot!.handleKeyPackageEvent(state.coordinate, e as any).catch(() => {}),
        state.configRelays,
      );
      if (kpCloser) closers.push(kpCloser);
      // 445 ingest: the coordinator is a silent member; ingesting keeps its leaf
      // converged and drives self_remove auto-commits. Routed by the group's random `h`.
      if (group) {
        const msgCloser = (this.deps.transport as any).subscribe?.(
          { kinds: [KIND_GROUP_MESSAGE], "#h": [group.nostr_group_id] },
          (e: NostrEvent) => void this.marmot!.ingest(state.coordinate, [e as any]).catch(() => {}),
          state.configRelays,
        );
        if (msgCloser) closers.push(msgCloser);
      }
      return () => {
        for (const c of closers) c();
      };
    });
    log(`[chat] watching 30443 + 445 for "${state.scoringCtx.title}"`);
  }

  // ── event loop ──────────────────────────────────────────────────────────────
  /** Subscribe to the coordinator inbox and all installed events; run jobs. */
  async start(): Promise<void> {
    // Recover any job stranded `running` by a previous crash (audit H1): its lease
    // is expired, so reset it to claimable before the loop begins.
    const reclaimed = this.jobs.recoverStrandedJobs();
    if (reclaimed > 0) log(`[jobs] recovered ${reclaimed} stranded job(s) from a previous run`);

    // Restore installed events from the store. Already-known events use the 3-day
    // live-overlap window (backfill "recent"); H2's full backfill is for fresh installs.
    for (const row of this.deps.store.allEvents()) {
      await this.installEvent({
        coordinate: row.coordinate,
        inboxSkHex: row.inbox_nsec,
        eck: this.eckFromStore(row.coordinate),
        configRelays: JSON.parse(row.config_relays),
        backfill: "recent",
      });
    }

    // One-shot FULL-history fetch of the coordinator's own inbox (audit COORD-11):
    // the live subscription below only covers the 3-day gift-wrap window, so
    // install grants/admin commands sent during a longer outage would be missed.
    // Already-handled rumors dedupe via the seen ledger.
    try {
      const wraps = await this.deps.transport.fetch(
        { kinds: [KIND_GIFT_WRAP], "#p": [this.coordPubkey], since: 0 },
        this.deps.defaultRelays,
      );
      if (wraps.length) log(`[boot] coordinator-inbox backfill: ${wraps.length} historical wrap(s)`);
      for (const w of wraps) await this.handleCoordinatorWrap(w as unknown as GiftWrap);
    } catch (e) {
      log(`[boot] coordinator-inbox backfill failed: ${e instanceof Error ? e.message : e}`);
    }

    const coordCloser = this.subscribeCoordInbox();
    this.closers.push(coordCloser);
    // Note: installEvent() already subscribes each event's inbox (idempotently),
    // so restored events are covered by the loop above.
  }

  // Live subscriptions keyed by (inbox pubkey + sorted relay set) — audit COORD-8:
  // a relay handover or a rotated E_inbox re-creates the sub instead of the old
  // coordinate-only guard pinning the daemon to stale relays forever.
  private inboxSubs = new Map<string, { key: string; close: () => void }>();
  private configSubs = new Map<string, { key: string; close: () => void }>();
  private chatSubs = new Map<string, { key: string; close: () => void }>();
  /** Per-event invite-hash cache (audit COORD-29); invalidated on a new 31601. */
  private inviteHashCache = new Map<string, Set<string>>();

  /**
   * Open a subscription for `coordinate`, closing the previous one when its key
   * (inbox/group + relay set) changed (COORD-8 relay handover). The closer is
   * once-guarded and registered for stop().
   */
  private replaceSubscription(
    map: Map<string, { key: string; close: () => void }>,
    coordinate: string,
    key: string,
    open: () => (() => void) | undefined,
  ): void {
    const existing = map.get(coordinate);
    if (existing?.key === key) return; // idempotent
    existing?.close();
    let closed = false;
    const raw = open();
    const close = () => {
      if (closed) return;
      closed = true;
      raw?.();
    };
    map.set(coordinate, { key, close });
    this.closers.push(close);
  }

  private eckFromStore(coordinate: string): EckVersion[] {
    const row = this.deps.store.getEvent(coordinate);
    return row ? (JSON.parse(row.eck_json) as EckVersion[]) : [];
  }

  private subscribeCoordInbox(): () => void {
    return (this.deps.transport as any).subscribe?.(
      { kinds: [KIND_GIFT_WRAP], "#p": [this.coordPubkey], since: giftwrapSince() },
      (e: NostrEvent) => void this.handleCoordinatorWrap(e as unknown as GiftWrap).catch(() => {}),
      this.deps.defaultRelays,
    ) ?? (() => {});
  }

  private subscribeEventInbox(state: EventState, since: number): void {
    const inboxPk = getPublicKey(state.inboxSk);
    const key = `${inboxPk}|${relayKey(state.configRelays)}`;
    const wasSubscribed = this.inboxSubs.has(state.coordinate);
    this.replaceSubscription(this.inboxSubs, state.coordinate, key, () =>
      (this.deps.transport as any).subscribe?.(
        { kinds: [KIND_GIFT_WRAP], "#p": [inboxPk], since },
        (e: NostrEvent) => void this.handleInboxWrap(state.coordinate, e as unknown as GiftWrap).catch(() => {}),
        state.configRelays,
      ),
    );
    log(
      `[sub] ${wasSubscribed ? "re-subscribed (relay/inbox change)" : "listening"} on E_inbox for ${state.scoringCtx.title} (since=${since})`,
    );
  }

  /**
   * Subscribe to the event's live 31600 config (audit H5), so relay/matching/
   * visibility/language changes take effect without a restart or reinstall.
   * Also watches 31601 invite lists (audit COORD-29): a new invite list
   * invalidates the per-event invite-hash cache.
   */
  private subscribeEventConfig(state: EventState): void {
    const key = `${state.eidPubkey}:${state.identifier}|${relayKey(state.configRelays)}`;
    this.replaceSubscription(this.configSubs, state.coordinate, key, () =>
      (this.deps.transport as any).subscribe?.(
        { kinds: [KIND_EVENT_CONFIG, KIND_INVITE_LIST], authors: [state.eidPubkey], "#d": [state.identifier] },
        (e: NostrEvent) => {
          if (e.kind === KIND_INVITE_LIST) {
            this.inviteHashCache.delete(state.coordinate);
            log(`[join] invite list updated for "${state.scoringCtx.title}" — invite cache invalidated`);
            return;
          }
          void this.handleConfigUpdate(state.coordinate, e).catch(() => {});
        },
        state.configRelays,
      ),
    );
  }

  /**
   * Apply a live 31600 config update (audit H5). Only an event authored by this
   * event's E_id, matching its `d`, and strictly newer than the applied config is
   * accepted (replaceable-event ordering); stale/forged/wrong-`d` events are
   * ignored. Diffs drive effects: matching/visibility (H4), relay handover, and
   * language/context invalidation.
   */
  async handleConfigUpdate(coordinate: string, event: NostrEvent): Promise<void> {
    const state = this.events.get(coordinate);
    if (!state) return;
    if (event.kind !== KIND_EVENT_CONFIG) return;
    if (event.pubkey !== state.eidPubkey) return; // must be signed by E_id
    const d = event.tags.find((t) => t[0] === "d")?.[1];
    if (d !== state.identifier) return; // wrong event
    // Replaceable ordering: ignore an older-or-equal config than the one applied.
    if (event.created_at < state.configCreatedAt) return;
    if (event.created_at === state.configCreatedAt && state.configEventId && event.id <= state.configEventId) return;

    let config: EventConfig;
    try {
      config = parseEventConfig(state.eidPubkey, event.tags);
    } catch {
      log(`[config] ignored malformed 31600 for ${short(state.eidPubkey)}`);
      return;
    }

    // De-installation (audit COORD-3): a config that re-points the event at a
    // DIFFERENT coordinator uninstalls it here — stop serving the event (its
    // subscriptions become inert no-ops) and drop its live state.
    if (config.coordinator && config.coordinator !== this.coordPubkey) {
      log(
        `[config] 31600 for ${coordinate} now names coordinator ${short(config.coordinator)} — uninstalling from this daemon`,
      );
      this.events.delete(coordinate);
      return;
    }

    const prev = {
      matching: state.matching,
      matchVisibility: state.matchVisibility,
      lang: state.lang,
      nostrContextN: state.nostrContextN,
      relays: state.configRelays,
      chat: state.chat,
    };

    // Apply to persisted config + in-memory state. Relay tags are untrusted
    // input — validated (wss-only, deduped, capped, audit COORD-16).
    const configRelays = sanitizeRelayUrls(config.relays);
    const relays = configRelays.length ? configRelays : state.configRelays;
    const eventRow = this.deps.store.getEvent(coordinate);
    if (eventRow) {
      this.deps.store.upsertEvent({
        coordinate,
        configJson: JSON.stringify(config),
        inboxNsec: eventRow.inbox_nsec,
        eckJson: eventRow.eck_json,
        configRelays: JSON.stringify(relays),
        now: this.now(),
      });
    }
    state.matching = config.matching;
    state.matchVisibility = config.matchVisibility;
    state.talks = config.talks;
    state.lang = config.lang;
    state.scoringCtx = { ...state.scoringCtx, lang: config.lang };
    state.nostrContextN = config.nostrContext;
    state.blossomOrigins = config.blossom;
    state.maxMediaSec = effectiveMaxMediaSec(Math.max(config.maxVideoSec, config.maxTalkSec));
    state.configRelays = relays;
    state.chat = isMarmotChatEnabled(config);
    state.configEventId = event.id;
    state.configCreatedAt = event.created_at;
    log(`[config] applied live 31600 update — matching=${state.matching}, match_visibility=${state.matchVisibility}, lang=${state.lang}`);

    // Relay handover (audit COORD-8): the E_inbox / config / chat subscriptions
    // are keyed by their relay set, so a relay change re-creates them on the new
    // relays instead of staying pinned to the old ones.
    if (relayKey(prev.relays) !== relayKey(state.configRelays)) {
      this.subscribeEventInbox(state, giftwrapSince(Math.floor(this.now() / 1000)));
      this.subscribeEventConfig(state);
      if (state.chat) this.subscribeChat(state);
    }

    // Effects.
    // Language/context change invalidates derived AI content → recompute (if on).
    const derivedChanged = prev.lang !== state.lang || prev.nostrContextN !== state.nostrContextN;
    // Matching turned on (from off): enqueue processing for approved attendees.
    const matchingTurnedOn = prev.matching === "off" && state.matching === "on";
    if (state.matching === "on" && (matchingTurnedOn || derivedChanged)) {
      for (const a of this.deps.store.approvedAttendees(coordinate)) {
        if (a.role !== "organizer" && this.deps.store.getAttendee(coordinate, a.pubkey)?.profile_json) {
          this.enqueueProcess(coordinate, a.pubkey);
        }
      }
    }
    // Visibility changed to/from "event": publish or delete the 31606 matrix (H4).
    if (prev.matchVisibility !== state.matchVisibility) {
      if (state.matching === "on" && state.matchVisibility === "event") await this.publishMatrix(state);
      else if (prev.matchVisibility === "event") await this.deleteMatrix(state);
    }
    // Marmot chat toggled (§4.1, §9 Q4): turned on ⇒ create group + backfill all
    // approved attendees + watch; turned off ⇒ freeze (stop adds; group lives on).
    if (this.marmot && prev.chat !== state.chat) {
      if (state.chat) await this.ensureChat(state);
      else this.marmot.freeze(coordinate);
    }
  }

  /**
   * Surface a poisoned job to the organizer (audit Q12): persist a status row and
   * gift-wrap a 21606 status to E_id so it's visible from the Admin UI (app-side)
   * without server logs. `error_category` is a sanitized class, never attendee text.
   */
  private async surfacePoison(info: import("./pipeline/jobs.js").PoisonInfo): Promise<void> {
    const coordinate = typeof info.payload?.coordinate === "string" ? info.payload.coordinate : undefined;
    if (!coordinate) return;
    const state = this.events.get(coordinate);
    if (!state) return;
    const pubkey = typeof info.payload?.pubkey === "string" ? info.payload.pubkey : null;
    const category = errorCategory(info.error);
    this.deps.store.recordJobStatus({
      coordinate,
      stage: info.type,
      pubkey,
      state: "poison",
      attempts: info.attempts,
      error_category: category,
      retryable: 1,
      updated_at: this.now(),
    });
    const status = buildCoordinatorStatus(this.deps.coordSk, state.eidPubkey, {
      v: 1,
      a: coordinate,
      ...(pubkey ? { pubkey } : {}),
      stage: info.type,
      state: "poison",
      attempts: info.attempts,
      error_category: category,
      retryable: true,
      at: Math.floor(this.now() / 1000),
    });
    await this.deps.transport.publish(status, state.configRelays);
    log(`[status] surfaced poisoned ${info.type} for ${pubkey ? short(pubkey) : coordinate} to organizer`);
  }

  stop(): void {
    for (const c of this.closers) c();
    this.closers = [];
  }

  // expose for grant version bumping
  eckOf(coordinate: string): EckVersion[] {
    return this.events.get(coordinate)?.eck ?? [];
  }

  /** Grant a fresh key backup shape for a coordinator-issued grant. */
  eckB64(eck: Uint8Array): string {
    return bytesToBase64(eck);
  }
}

function blindedDFor(eck: Uint8Array, coordinate: string, pubkey: string): string {
  return blindedD(eck, coordinate, pubkey);
}

/**
 * Publish-boundary hygiene for a match list (audit COORD-12): LLM-authored
 * `reasoning` is length-capped (word boundary) and URLs neutralized so injected
 * text can't smuggle clickable links into clients.
 */
function sanitizeMatchList(list: MatchListContent): MatchListContent {
  return {
    ...list,
    matches: list.matches.map((m) => ({ ...m, reasoning: sanitizeLlmText(m.reasoning) })),
  };
}

/**
 * Apply an attendee's ai_profile correction (F3, audit U9) to the freshly
 * generated profile at publish time. Pure — the generated profile and the stored
 * correction are inputs; the returned `aiProfile` is what goes on the 31603.
 *
 *  - `hidden: true` → publish NO ai_profile (the entry falls back to the authored
 *    profile); NOT flagged as edited, so hiding is not advertised to viewers.
 *  - `overrides` → replace named fields with the attendee's own text/lists.
 *  - `hidden_fields` → blank named fields (summary→"", arrays→[]).
 * Authored identity fields (about/skills/looking_for/links) are never touched.
 */
function applyCorrection(
  generated: AiProfile | undefined,
  correction: ProfileCorrectionContent | undefined,
): { aiProfile: AiProfile | undefined; edited: boolean } {
  if (!generated || !correction) return { aiProfile: generated, edited: false };
  if (correction.hidden) return { aiProfile: undefined, edited: false };
  let aiProfile: AiProfile = generated;
  let edited = false;
  if (correction.overrides && Object.keys(correction.overrides).length > 0) {
    aiProfile = { ...aiProfile, ...correction.overrides };
    edited = true;
  }
  if (correction.hidden_fields && correction.hidden_fields.length > 0) {
    aiProfile = { ...aiProfile };
    for (const f of correction.hidden_fields) {
      if (!AI_PROFILE_FIELDS.includes(f)) continue;
      (aiProfile as any)[f] = f === "summary" ? "" : [];
    }
    edited = true;
  }
  return { aiProfile, edited };
}

/**
 * Map a job's error message to a coarse, sanitized category for organizer-visible
 * status (audit Q12). Never returns attendee text or prompts — only a class.
 */
function errorCategory(msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes("billing") || m.includes("insufficient balance") || m.includes("insufficient credit")) {
    return "provider_billing";
  }
  if (m.includes("contract")) return "provider_contract";
  if (m.includes("hash mismatch")) return "media_integrity";
  if (m.includes("fetch") || m.includes("blossom") || m.includes("network") || m.includes("timeout")) return "media_fetch";
  if (m.includes("ffmpeg") || m.includes("audio")) return "media_processing";
  if (m.includes("no handler")) return "internal";
  return "processing_error";
}
