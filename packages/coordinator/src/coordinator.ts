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
  KIND_ATTENDEE_WITHDRAWAL,
  KIND_TALK,
  KIND_DIRECTORY_ENTRY,
  KIND_ROSTER,
  KIND_MATCH_LIST,
  KIND_MATCH_MATRIX,
  KIND_EVENT_CONFIG,
  KIND_CALENDAR_EVENT,
  KIND_DELETION,
  KIND_NOTE,
  KIND_REPOST,
  KIND_LONGFORM,
  KIND_PROFILE,
  giftwrapSince,
  unwrapRumor,
  unwrapRumorEnvelope,
  eckDecrypt,
  base64ToBytes,
  hexToBytes,
  bytesToBase64,
  blindedD,
  generateEck,
  sha256Hex,
  utf8ToBytes,
  inviteListContentSchema,
  invitePolicyOf,
  type InvitePolicy,
  joinRequestContentSchema,
  profileSubmissionContentSchema,
  coordinatorGrantContentSchema,
  adminCommandContentSchema,
  profileCorrectionContentSchema,
  talkSubmissionContentSchema,
  withdrawalContentSchema,
  rosterContentSchema,
  directoryEntryContentSchema,
  chatKeyAttestationContentSchema,
  MAX_CHAT_KEYS_PER_ACCOUNT,
  KIND_CHAT_KEY_ATTESTATION,
  isMarmotChatEnabled,
  CHAT_INTEROP_RELAYS,
  AI_PROFILE_FIELDS,
  parseEventConfig,
  parseCoordinate,
  parseEventCoordinate,
  type EckVersion,
  type EventConfig,
  type TalksMode,
  type AttendeeProfile,
  type MediaDescriptor,
  type MediaTranscript,
  type ProfileCorrectionContent,
  type TalkSubmissionContent,
  type TalkContent,
  type TalkExternalKind,
  type TalkSourceType,
  type AiProfile,
  type RosterContent,
  type MatchMatrixContent,
  type MatchListContent,
  type CoordinatorBilling,
  pickLatest,
  supersedes,
  revisionSupersedes,
  MAX_SKILLS,
} from "@nostrautica/protocol";
import type { GiftWrap, Rumor } from "@nostrautica/protocol";
import { Store, type BillingStateRow } from "./store/db.js";
import { JobRunner, ParkJobError } from "./pipeline/jobs.js";
import { InviteChecker, evaluateEntitlement } from "./pipeline/entitlement.js";
import { processAttendee } from "./pipeline/process.js";
import type { NostrPost } from "./pipeline/profile.js";
import {
  profileHash,
  hasProfileContent,
  pairInputsHash,
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
import { transcribeMedia, MediaPolicyError } from "./pipeline/transcribe.js";
import type { LlmProvider, SttProvider, ModelRef, RoleRoute, RoleRoutes } from "./providers/types.js";
import { ProviderHttpError } from "./providers/http.js";
import { MarmotAdmin } from "./chat/admin.js";
import type { ChatMls } from "./chat/mls.js";
import { discoverKeyPackages } from "./chat/key-package-discovery.js";
import { sanitizeRelayUrls, type RelayPolicy } from "./net/relay-urls.js";
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

/**
 * Per-FILE media cap (audit R17 follow-up): 250 MiB, the same bound the app's
 * client precheck and playback/download enforce (MAX_MEDIA_DOWNLOAD_BYTES in
 * app/blossom/client.ts). Without a per-file cap here, several files that each pass
 * the client's 250 MiB check (e.g. 3×250 MiB) would each be accepted individually
 * yet blow the 500 MiB aggregate budget with a confusing late, partial skip. A
 * single descriptor over this bound is rejected up front with a clear reason —
 * anything the app would have refused to upload/play is refused server-side too.
 */
const MAX_MEDIA_FILE_BYTES = 250 * 1024 * 1024;

/** Distinct talks (by talk_d) one speaker may submit per event (audit COORD-4:
 *  unbounded talk submissions each triggered their own paid STT job). Editing
 *  an already-submitted talk_d is never capped — only new ones. */
const MAX_TALKS_PER_SPEAKER = 10;

/**
 * Event-wide attendee-population cap (audit C3). The 31604 roster protocol cap is
 * 2,000, so the coordinator must never grow its attendee set (pending + approved +
 * revoked) past it and then FAIL to publish the roster. A join that would create a
 * NEW attendee beyond this is refused.
 */
const MAX_ATTENDEES_PER_EVENT = 2000;

/** Durable inbox rate accounting (audit C3): fixed 60s window. */
const INBOX_RATE_WINDOW_MS = 60_000;
/** Max inbound rumors accepted from ONE sender per window (abuse ceiling). */
const MAX_RUMORS_PER_SENDER_WINDOW = 30;
/**
 * Floor on inbound rumors accepted for ONE event per window across all senders.
 * The real ceiling scales with the event's population — see {@link eventRumorBudget}.
 */
const MAX_RUMORS_PER_EVENT_WINDOW = 600;
/**
 * Additional per-window rumor budget granted per enrolled attendee. Sized so an
 * attendee's ordinary burst (join + submission, then an intro and an edit later)
 * fits several times over without the event as a whole hitting its ceiling.
 */
const RUMORS_PER_ATTENDEE_WINDOW = 4;
/**
 * Rate-bucket key for the coordinator's OWN inbox (audit R4): anyone can publish a
 * kind-1059 wrap to the coordinator's public pubkey, so its inbox needs the same
 * per-sender / per-inbox gate the event inboxes have — applied BEFORE the durable
 * install/admin dispatch. A fixed key (not a real coordinate) shares the inbox_rate
 * table; the per-inbox bucket bounds how many rate rows a distinct-sender flood can
 * create per window (once the inbox total is over budget, per-sender rows stop).
 */
const COORD_INBOX_RATE_KEY = "coordinator-inbox";

/** Bounded inbound work queue (audit C3): global concurrent handlers + queue depth.
 *  Subscription callbacks are dispatched through this so a burst of gift wraps can't
 *  spawn unbounded concurrent handlers or pile unbounded closures in memory. */
const INBOX_MAX_CONCURRENCY = 8;
/**
 * How old a 21601 may be and still be given time for its own 21600 to land
 * ({@link Coordinator.awaitEnrollment}). A live delivery inversion is seconds
 * old; anything older is not racing a join and is dropped without waiting.
 */
const ENROLLMENT_WAIT_MAX_AGE_SEC = 5 * 60;
/**
 * Concurrent enrollment waits. Half the inbound pool, so a flood of submissions
 * from unenrolled identities can never hold every worker and starve the joins
 * those waiters are waiting for.
 */
const MAX_ENROLLMENT_WAITS = Math.floor(INBOX_MAX_CONCURRENCY / 2);
const INBOX_MAX_QUEUE = 2000;

/** Resolve the per-descriptor duration cap: 0/negative (UNLIMITED) ⇒ the built-in default. */
function effectiveMaxMediaSec(configured: number): number {
  return configured > 0 ? configured : MAX_INPUT_DURATION_SEC;
}

/**
 * The event's end time in unix seconds from its NIP-52 31923 event, the anchor the
 * retention window (NIP §6.2) counts from. Prefers the `end` tag; falls back to
 * `start` (an instant event with no distinct end). 0 when neither is a valid int —
 * the retention sweep then skips the event (it cannot know when the window opened).
 */
function parseEventEndSec(evt: NostrEvent | undefined): number {
  if (!evt) return 0;
  const read = (name: string): number => {
    const raw = evt.tags.find((t) => t[0] === name)?.[1];
    if (raw === undefined) return 0;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : 0;
  };
  return read("end") || read("start");
}

/**
 * Relays the Whitenoise Marmot/MLS client publishes key packages and group
 * traffic to (`CHAT_INTEROP_RELAYS`, shared with the app via the protocol
 * package). Ensured into every chat-enabled event's MLS routing state in
 * `ensureChat` — including groups created before this was added — because a
 * group's routing relays are baked in at creation and never re-derived from
 * config.relays afterward.
 */
function chatInteropRelays(eventRelays: string[]): string[] {
  const localOnly = eventRelays.length > 0 && eventRelays.every((relay) => {
    try {
      const host = new URL(relay).hostname;
      return host === "localhost" || host === "127.0.0.1" || host === "::1";
    } catch {
      return false;
    }
  });
  return localOnly ? [] : [...CHAT_INTEROP_RELAYS];
}

/**
 * The relays this event's CHAT reads and writes on: its configured relays plus
 * the interop set. Until 2026-07-28 the app unioned the interop relays into
 * `config.relays` itself, so `state.configRelays` happened to cover them; now
 * they live in the config's separate `chat_relay` set (which parseEventConfig
 * also migrates old configs into), and the chat-only subscriptions have to add
 * them back explicitly or the 30443 watcher silently stops seeing a Whitenoise
 * attendee's key package on the relay they publish it to.
 *
 * Chat-only on purpose: every other subscription and publish stays on
 * `configRelays`, because these relays refuse every non-chat kind.
 */
function chatRelaysFor(state: EventState): string[] {
  return [...new Set([...state.configRelays, ...chatInteropRelays(state.configRelays)])];
}

/** Marmot v2 wire kinds (MARMOT-GROUP-CHAT §1.2): addressable key package + group msg. */
const KIND_KEY_PACKAGE = 30443;
const KIND_GROUP_MESSAGE = 445;

/** Outcome of a publish (reliability tail): `replaced` is set when a relay answered
 *  a replaceable publish with "replaced/have newer", so the coordinator can fetch the
 *  competing event and reconcile via the global §3.1 comparator. */
export interface PublishOutcome {
  replaced?: boolean;
}

/** Minimal transport the coordinator needs (NostrClient satisfies it). */
export interface Transport {
  publish(event: NostrEvent, relays?: string[]): Promise<void | PublishOutcome>;
  fetch(filter: any, relays?: string[], timeoutMs?: number): Promise<NostrEvent[]>;
  /** PAGINATED full-history fetch (audit R4): walks the whole history in `until`-
   *  windowed pages so a >5000-event flood can't truncate startup recovery. Optional:
   *  a transport without it degrades to the (capped) one-shot `fetch`. */
  fetchAll?(
    filter: any,
    relays?: string[],
    opts?: { pageSize?: number; overlapSec?: number; maxTotal?: number; timeoutMs?: number },
  ): Promise<NostrEvent[]>;
  /** Prove a relay set is reachable (≥1 relay connects/EOSEs) before a relay
   *  handover promotes it (audit C9). Optional: a transport without it degrades to
   *  the old break-before-make behavior. */
  probe?(relays: string[], timeoutMs?: number): Promise<boolean>;
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
  stt: SttProvider;
  sttModel: string;
  /**
   * Resolved per-role provider routes (audit H-1, §13.5 Option A). Production
   * passes this from `resolveRoleRoutes`; each role carries its OWN provider
   * instance, so summary/match/embed/translate can flow to different providers.
   * When omitted, the legacy `llm` + `*Model` fields below build uniform routes
   * pointing every role at one instance (kept for the existing test harness).
   */
  roles?: RoleRoutes;
  /** @deprecated pass `roles`; kept so existing single-provider callers/tests work. */
  llm?: LlmProvider;
  /** @deprecated pass `roles`. */
  summaryModel?: ModelRef;
  /** @deprecated pass `roles`. */
  matchModel?: ModelRef;
  /** @deprecated pass `roles`. */
  embedModel?: ModelRef;
  /** @deprecated pass `roles`. */
  translateModel?: ModelRef;
  defaultRelays: string[];
  prefilter?: PrefilterConfig;
  topK?: number;
  /** Candidates per batched match-scoring call (spec §16.2). Default 10. */
  batchSize?: number;
  /** Injectable RNG for deterministic candidate shuffling in tests. */
  matchRng?: () => number;
  fetchBlob?: (urls: string[], sha256: string) => Promise<Uint8Array>;
  /** Override the transcription stage (tests inject to skip Blossom/ffmpeg).
   *  May return text only, or a {@link TranscriptResult} with a detected language.
   *  Receives the caller cancellation signal (audit R13) so an injected implementation
   *  can honor shutdown / per-event teardown. */
  transcribe?: (
    descriptor: MediaDescriptor,
    signal?: AbortSignal,
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
  /** Re-check delays for a 21601 that arrived before its own 21600. Default [250, 750, 1500]. */
  enrollmentWaitMs?: number[];
  /** Max simultaneously installed events (audit COORD-3). Default 50. */
  maxEvents?: number;
  /**
   * When non-empty, only install events whose E_id is listed (COORD-3).
   * Hex pubkeys.
   */
  allowedEidPubkeys?: string[];
  /**
   * Policy applied to untrusted relay URLs (audit C4): an operator host allowlist and
   * the dev-only insecure/private-relay allowance. Applied to every relay-source path
   * (grant config_relays, live 31600 relays, NIP-65 discovery). Omitted ⇒ any public
   * wss:// relay is accepted (still SSRF-guarded at connect).
   */
  relayPolicy?: RelayPolicy;
  /**
   * Billing policy evaluation (spec §9, D5). Given the billing principal (event
   * identity) and the current approved-attendee count, returns the wire billing
   * verdict. The coordinator maps it onto a persisted `evaluating→ok|grace|blocked`
   * state machine and enforces it: a `blocked` event's paid provider work is parked
   * (never revoke/detach/roster/status). Omitted ⇒ billing is always `ok`.
   */
  evaluateBilling?: (eidPubkey: string, attendeeCount: number) => CoordinatorBilling;
  /** Grace window (seconds) before a paying-over-tier event blocks (spec §9). */
  billingGracePeriodSec?: number;
  /**
   * Per-attendee / per-event usage budgets (spec §8, H-2). Exceeding one parks
   * further paid processing (same waiting-state as a billing block) and emits a
   * 21606 `budget_exceeded`. Any limit 0 ⇒ unlimited. Omitted ⇒ no budget gate.
   */
  budgets?: {
    perAttendeeBytes: number;
    perEventBytes: number;
    perAttendeeDurationSec: number;
    perEventDurationSec: number;
    perAttendeeCalls: number;
    perEventCalls: number;
  };
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
  /** Real decoded-duration limits enforced distinctly by media kind (audit H-3):
   *  intro media uses max_video_sec, talk media uses max_talk_sec (0/unset ⇒ DEFAULT). */
  maxIntroSec: number;
  maxTalkSec: number;
  /** Whether Marmot group chat is operative for this event (§1.3). */
  chat: boolean;
  scoringCtx: EventContextForScoring;
  /** Newest applied 31600 config event id + timestamp (audit H5 replaceable ordering). */
  configEventId?: string;
  configCreatedAt: number;
  /** The install generation this event was authorized at (NIP §3.5). A newest 31600
   *  that no longer names this coordinator with THIS gen triggers a durable detach. */
  gen: number;
  /** Data-retention window in days (NIP §6.2 `retention`); undefined = indefinite.
   *  The retention sweep deletes member records + parks processing once now is past
   *  `eventEndSec + retentionDays·86400`. */
  retentionDays?: number;
  /** The event's end time (unix seconds) from its 31923 `end` tag (falls back to
   *  `start`), the anchor the retention window counts from. 0 when unknown. */
  eventEndSec: number;
  /** Newest applied 31923 metadata event id + timestamp (audit P9 replaceable
   *  ordering). A live 31923 edit is applied only when it SUPERSEDES this, so a
   *  shuffled relay re-read can never regress title/eventEndSec to a stale revision. */
  metaEventId?: string;
  metaCreatedAt: number;
  /** True once the retention sweep has expired this event: paid processing is parked
   *  and member records have been deleted. A terminal state distinct from billing park. */
  retentionExpired?: boolean;
}

/** Build a uniform route from a single legacy llm + ModelRef (test/back-compat). */
function legacyRoute(llm: LlmProvider | undefined, ref: ModelRef | undefined): RoleRoute {
  if (!llm || !ref) {
    throw new Error("Coordinator: pass `roles`, or all of llm + summaryModel/matchModel/embedModel/translateModel");
  }
  return { llm, model: ref.model, provider: ref.provider, requirePrivate: true, privacy: "private" };
}

export class Coordinator {
  readonly jobs: JobRunner;
  /** Resolved per-role provider routes (audit H-1). */
  private readonly roles: RoleRoutes;
  private readonly coordPubkey: string;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly wrapRetryDelaysMs: number[];
  private readonly enrollmentWaitMs: number[];
  /** In-flight {@link awaitEnrollment} waits, bounded by MAX_ENROLLMENT_WAITS. */
  private enrollmentWaits = 0;
  private readonly maxEvents: number;
  private readonly allowedEidPubkeys: Set<string>;
  /** Untrusted-relay policy (audit C4): host allowlist + dev-only insecure allowance. */
  private readonly relayPolicy: RelayPolicy;
  private readonly prefilter: PrefilterConfig;
  private readonly topK: number;
  private readonly batchSize: number;
  private readonly matchRng: () => number;
  private readonly inviteChecker: InviteChecker;
  /** The Marmot admin bot (§4), present only when a chat MLS layer is configured. */
  private readonly marmot?: MarmotAdmin;
  private events = new Map<string, EventState>();
  /**
   * Events whose newest 31600 could not be fetched at restore/revalidation time
   * (NIP §3.5, P0-5). They are NOT resumed — no subscriptions, no processing — and
   * are retried with backoff until the config is fetchable and revalidates (resume)
   * or names another coordinator/gen (detach). An unfetchable config is never
   * treated as authorization to run NOR as a detach.
   */
  private suspended = new Map<string, { inboxSkHex: string; eck: EckVersion[]; configRelays: string[]; gen: number; retryAt: number; attempts: number; reason: string }>();
  private closers: Array<() => void> = [];
  /**
   * Rumor ids whose handler is currently in flight (audit P0-3). Subscription
   * callbacks are dispatched fire-and-forget and two gift wraps can legitimately
   * carry the SAME rumor; the durable `seen_rumors` mark lands only after the
   * handler succeeds, so without this both wraps would pass the read-only seen
   * check in `unwrapFresh` and run side effects concurrently. This claims the
   * rumor synchronously (no await between check and add, so no interleaving) and
   * `processRumorWithRetry` releases it when the handler settles. NOTE: this
   * closes the in-PROCESS race only; a durable cross-process processing lease
   * (two daemons sharing one SQLite file) remains deferred.
   */
  private readonly inFlightRumors = new Set<string>();
  /** Coordinates for which a 21606 budget_exceeded was already emitted (H-2): emit
   *  once per block, cleared on resume so a later re-exceed re-notifies. */
  private readonly budgetNotified = new Set<string>();
  /** Bounded inbound work queue (audit C3): pending handler closures + the number of
   *  handlers currently running, enforcing a global concurrency limit and a queue
   *  depth cap so a gift-wrap burst can't spawn unbounded concurrent work. */
  private readonly inboundQueue: Array<() => Promise<void>> = [];
  private inboundRunning = 0;
  private inboundDropped = 0;
  /**
   * Per-(coordinate, subject) in-process async mutex (audit R1). The inbound
   * scheduler runs up to 8 handlers concurrently, so two DISTINCT commands for the
   * same membership subject (e.g. an older revoke and a newer approve) could execute
   * concurrently and interleave — an older revoke finishing AFTER a newer approve and
   * winning, despite the durable (created_at, id) comparator. This serializes a
   * subject's whole effect chain (the watermark read/upsert PLUS the async
   * grant/roster/deletion/publish that follows), so same-subject transitions apply
   * strictly one at a time and the comparator's ordering actually holds. Belt: the
   * per-mutation ownership token ({@link stillOwnsSubject}) stops a handler that is
   * somehow past the mutex yet superseded from producing side effects.
   */
  private readonly subjectChains = new Map<string, Promise<unknown>>();
  /** Per-event cancellation (audit R3): retention/detach abort an event's in-flight
   *  job handlers and AWAIT them before purging/deleting custody, so a running
   *  STT/LLM/publish can't recreate purged derived data or publish with stale state. */
  private readonly eventAbort = new Map<string, AbortController>();
  /** In-flight event-scoped job bodies, tracked per coordinate so retention/detach can
   *  await their unwinding after aborting (audit R3). */
  private readonly activeEventHandlers = new Map<string, Set<Promise<void>>>();
  /** Coordinates whose retention expiry is currently running (audit R3): guards the
   *  boot + hourly sweeps against double-executing the same event's expiry. */
  private readonly retentionInProgress = new Set<string>();

  constructor(private readonly deps: CoordinatorDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.wrapRetryDelaysMs = deps.wrapRetryDelaysMs ?? [5_000, 30_000];
    this.enrollmentWaitMs = deps.enrollmentWaitMs ?? [250, 750, 1_500];
    this.maxEvents = deps.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.allowedEidPubkeys = new Set(deps.allowedEidPubkeys ?? []);
    this.relayPolicy = deps.relayPolicy ?? {};
    this.coordPubkey = getPublicKey(deps.coordSk);
    this.prefilter = deps.prefilter ?? DEFAULT_PREFILTER;
    this.topK = deps.topK ?? 20;
    this.batchSize = deps.batchSize ?? 10;
    this.matchRng = deps.matchRng ?? Math.random;
    this.roles = deps.roles ?? {
      summary: legacyRoute(deps.llm, deps.summaryModel),
      match: legacyRoute(deps.llm, deps.matchModel),
      embed: legacyRoute(deps.llm, deps.embedModel),
      translate: legacyRoute(deps.llm, deps.translateModel),
    };
    this.inviteChecker = new InviteChecker(deps.store);
    if (deps.chatMls) {
      this.marmot = new MarmotAdmin({
        store: deps.store,
        mls: deps.chatMls,
        now: this.now,
        coordinatorPubkey: this.coordPubkey,
        fetchKeyPackages: (coordinate, authors) => this.fetchKeyPackages(coordinate, authors),
        log,
      });
    }
    this.jobs = new JobRunner(deps.store, {
      now: this.now,
      // A poisoned job is surfaced to the organizer (audit Q12): persist a status
      // row and gift-wrap a 21606 status to E_id so it's visible without server logs.
      onPoison: (info) => void this.surfacePoison(info).catch(() => {}),
      // A depleted provider account is not a bad job. Prod 2026-07-31: two
      // attendees of a live event had `process_attendee` fail on Venice 402s and
      // ended up with a hollow ai_profile (`{"summary":"","skills":[],…}`), which
      // scoring correctly refuses to match on — so they silently had no matches
      // at all while everyone around them did. The retry tail is three days long,
      // which is generous, but running it out means the outage was long, not that
      // the work should be thrown away.
      poisonExempt: (err) =>
        err instanceof ProviderHttpError && err.payment
          ? "provider account out of credit — parked for reprocess after top-up"
          : undefined,
    });
    this.registerJobHandlers();
  }

  // ── job handlers (the pipeline, spec §9.2) ─────────────────────────────────
  private registerJobHandlers(): void {
    this.jobs.register("process_attendee", async (p, { enqueue, signal }) => {
      let committed = false;
      await this.runEventJob(p.coordinate, signal, async (sig) => {
        committed = await this.processAttendeeJob(p.coordinate, p.pubkey, sig);
      });
      // Enqueue matching ONLY when the ai_profile was actually committed (audit C2):
      // a stale run whose result was discarded (a newer submission superseded it
      // mid-flight) must not enqueue a recompute off data that was never written —
      // that would score the newer roster against a hash the DB no longer holds.
      if (!committed) return;
      // Key the recompute by the attendee's resulting profile hash: re-delivery of
      // the same submission dedupes, a CHANGED profile gets a fresh recompute.
      const hash = this.deps.store.getAttendee(p.coordinate, p.pubkey)?.profile_hash ?? "none";
      enqueue("match_recompute", `match:${p.coordinate}:${p.pubkey}:${hash}`, {
        coordinate: p.coordinate,
        pubkey: p.pubkey,
      });
    });

    this.jobs.register("match_recompute", async (p, { enqueue, signal }) => {
     await this.runEventJob(p.coordinate, signal, async (sig) => {
      // Re-check config at execution (audit H4): matching may have been turned off
      // after this job was queued — exit before any embedding/scoring provider call.
      if (this.events.get(p.coordinate)?.matching === "off") return;
      // Spend gate (spec §8/§9): billing block OR exceeded budget parks this before
      // any embed spend.
      await this.assertSpendAllowed(p.coordinate, p.pubkey);
      const pairs = await this.selectPairs(p.coordinate, p.pubkey, sig);
      if (!pairs.length) return;
      // FORWARD direction (p.pubkey → others): one target + ≤K candidates per call.
      // Group the target's pending directed pairs into ≤K-candidate batches (one
      // target + ≤K candidates per LLM call — spec §16.2). Batching is a transport
      // optimization only: each batch job is deduped by its target+candidate-set
      // hash, and results are written per directed pair keyed by inputs_hash.
      const batches = groupIntoBatches(pairs, this.batchSize);
      log(`[match] ${short(p.pubkey)} → scoring ${pairs.length} forward pair(s) in ${batches.length} batch(es)`);
      // Count what the dispatch ACTUALLY queued. "Dispatched N batches" was a lie
      // whenever a dedupe key collided with a finished row (2026-07-24): the line
      // above printed, nothing was queued, and the next log line never came.
      let queued = 0;
      for (const batch of batches) {
        const key = `batch:${p.coordinate}:${batch[0]!.a}:${batchDedupe(batch)}`;
        if (enqueue("score_batch", key, { coordinate: p.coordinate, pairs: batch }) === "enqueued") queued++;
      }
      if (queued < batches.length) {
        log(
          `[match] ${short(p.pubkey)} forward dispatch: only ${queued}/${batches.length} batch(es) queued — the rest were suppressed by existing job rows`,
        );
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
      let reverseQueued = 0;
      let reverseBatches = 0;
      for (let i = 0; i < reverse.length; i += this.batchSize) {
        const batch = reverse.slice(i, i + this.batchSize);
        reverseBatches++;
        // Dedupe by shared candidate + the target set — a re-delivery collapses.
        const key = `rbatch:${p.coordinate}:${p.pubkey}:${batchDedupe(batch.map((r) => ({ b: r.a, inputsHash: r.inputsHash })))}`;
        if (enqueue("score_reverse_batch", key, { coordinate: p.coordinate, pairs: batch }) === "enqueued") {
          reverseQueued++;
        }
      }
      if (reverse.length) {
        log(`[match] reverse: ${reverse.length} target(s) → ${short(p.pubkey)} in ${reverseBatches} batch(es)`);
        if (reverseQueued < reverseBatches) {
          log(
            `[match] ${short(p.pubkey)} reverse dispatch: only ${reverseQueued}/${reverseBatches} batch(es) queued — the rest were suppressed by existing job rows`,
          );
        }
      }
     });
    });

    this.jobs.register("score_batch", async (p, { enqueue, signal }) => {
     const inPairs = p.pairs as CandidatePair[];
     let summary = "nothing to score";
     await this.batchOutcome(`forward batch ${short(inPairs[0]?.a ?? "?")} ×${inPairs.length}`, () => summary, () =>
      this.runEventJob(p.coordinate, signal, async (sig) => {
      await this.assertSpendAllowed(p.coordinate, (p.pairs as CandidatePair[])[0]?.a);
      const pairs = p.pairs as CandidatePair[];
      const { scored, missing } = await this.scoreBatchJob(p.coordinate, pairs, sig);
      summary = `${scored.length} scored, ${missing} unparsed`;
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
     }));
    });

    this.jobs.register("score_reverse_batch", async (p, { enqueue, signal }) => {
     const inPairs = p.pairs as CandidatePair[];
     let summary = "nothing to score";
     await this.batchOutcome(`reverse batch ${short(inPairs[0]?.b ?? "?")} ×${inPairs.length}`, () => summary, () =>
      this.runEventJob(p.coordinate, signal, async (sig) => {
      await this.assertSpendAllowed(p.coordinate, (p.pairs as CandidatePair[])[0]?.b);
      const pairs = p.pairs as CandidatePair[];
      const { scored, missing } = await this.scoreReverseBatchJob(p.coordinate, pairs, sig);
      summary = `${scored.length} scored, ${missing} unparsed`;
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
     }));
    });

    this.jobs.register("publish_matches", async (p, { signal }) => {
      await this.runEventJob(p.coordinate, signal, async () => {
        await this.publishMatchesJob(p.coordinate, p.pubkey, p.allowEmpty === true);
      });
    });

    // Transcribe a submitted talk (spec F2). Reuses the intro transcription pipeline
    // unchanged (audio.ts segments long talks). The transcript is stored on the talk
    // row (published on the 31610 at talk_publish time) and folded into the speaker's
    // ai_profile so the talk feeds matching (§9.2).
    this.jobs.register("process_talk", async (p, { signal }) => {
      await this.runEventJob(p.coordinate, signal, async (sig) => {
        await this.processTalkJob(p.coordinate, p.pubkey, p.talkD as string, sig);
      });
    });

    // Marmot MLS membership changes (§4.2, audit COORD-9): add/remove run through
    // the durable runner so a transient marmot/relay failure retries instead of
    // stranding membership drift; persistent failure poisons → organizer 21606.
    this.jobs.register("chat_sync_member", async (p, { signal }) => {
      if (!this.marmot) return;
      await this.runEventJob(p.coordinate, signal, async () => {
        await this.marmot!.syncMember(p.coordinate, p.pubkey);
      });
    });
    this.jobs.register("chat_revoke_member", async (p, { signal }) => {
      if (!this.marmot) return;
      await this.runEventJob(p.coordinate, signal, async () => {
        await this.marmot!.handleRevoke(p.coordinate, p.pubkey);
      });
    });
  }

  // ── install (21603) ────────────────────────────────────────────────────────
  async installEvent(grant: {
    coordinate: string;
    inboxSkHex: string;
    eck: EckVersion[];
    configRelays: string[];
    /** Install generation (NIP §3.5). Required for a fresh grant (must match the
     *  newest 31600 and exceed the stored high-water mark); on restore it is the
     *  gen the event was previously installed at, revalidated against the config. */
    gen?: number;
    /**
     * Backfill window for the E_inbox subscription (audit H2). "full" (a fresh
     * install of a never-before-seen event) scans the entire history so join
     * requests/submissions published days before the coordinator attached are not
     * missed; "recent" (a restart of an already-installed event) keeps the 3-day
     * live-overlap window. Default "recent".
     */
    backfill?: "full" | "recent";
    /**
     * Where this install came from (audit P0-4). "grant" is a fresh 21603 grant
     * and must fail CLOSED: a valid newest 31600 must exist AND name this daemon,
     * and the grant's inbox key must derive the config's declared inbox — a
     * config that isn't fetchable yet is retryable (throw), not authorization.
     * "restore" is a startup reload of an already-authorized event and keeps the
     * lenient check (durable startup revalidation is P0-5, deferred). Default
     * "restore".
     */
    source?: "grant" | "restore";
  }): Promise<void> {
    const { pubkey: eidPubkey, identifier } = parseCoordinate(grant.coordinate);
    // Relay lists from untrusted input (grant, later the 31600) are validated:
    // wss-only, no credentials/fragments, public host, allowlist, deduped, capped
    // (audit COORD-16 + C4).
    const grantRelays = sanitizeRelayUrls(grant.configRelays, this.relayPolicy);
    const relays = grantRelays.length ? grantRelays : this.deps.defaultRelays;

    // Load public config + event details for scoring context.
    const cfgEvents = await this.deps.transport.fetch(
      { kinds: [31600, 31923], authors: [eidPubkey], "#d": [identifier] },
      relays,
    );
    // Newest config wins (audit COORD-14): relays return replaceable events in
    // arbitrary order. Pick with the shared §3.1 comparator — higher created_at,
    // then LOWEST id on a tie (NIP-01). v1 picked the highest id here, which
    // disagreed with the convention and with every other reader.
    const cfgEvent = pickLatest(cfgEvents.filter((e) => e.kind === 31600));
    // Newest 31923 wins too (audit P9): relays return replaceable events in arbitrary
    // order and this event controls the title and, critically, `eventEndSec` — the
    // anchor the retention sweep deletes member records from. v1 took the FIRST
    // returned 31923, so a shuffled relay order (or a restart) could select a stale
    // revision with an earlier end date and expire member records prematurely.
    const evtEvent = pickLatest(cfgEvents.filter((e) => e.kind === 31923));
    // A 31600 that is present but UNPARSEABLE — a pre-v2 wire config carrying
    // ["v","1"], a config whose `v` is newer than we speak, or any other malformed
    // tag parseEventConfig rejects — is treated EXACTLY like an unfetchable config:
    // never an authorization to run, never a detach. The `!config` branches below
    // already do the right thing (grant → retryable throw; restore → SUSPENDED with
    // backoff). This catch is what keeps a per-event parse failure from propagating
    // through installEvent → Coordinator.start and crash-looping the daemon — the
    // production incident where, right after the v2 deploy, startup revalidation of
    // still-installed pre-v2 events threw "unsupported v tag 1" out of start().
    let config: EventConfig | undefined;
    let configParseError: string | undefined;
    if (cfgEvent) {
      try {
        config = parseEventConfig(eidPubkey, cfgEvent.tags);
      } catch (e) {
        // Keep the reason for the SUSPENDED log below, but do NOT log here: the
        // restore path re-fetches+re-parses on every backoff cycle, so logging at
        // this site would spam once per retry. suspendEvent logs the transition once.
        configParseError = e instanceof Error ? e.message : String(e);
      }
    }

    // Install authorization (audit COORD-3, P0-4, NIP §3.5).
    const source = grant.source ?? "restore";
    let gen = grant.gen ?? 0;
    if (source === "grant") {
      // Fresh grant: fail CLOSED. Require a valid, newest 31600 that names THIS
      // daemon with the SAME gen as the grant, a gen strictly greater than the
      // highest ever installed OR detached for this coordinate (a replayed
      // historical grant can never re-install), and a grant inbox key that derives
      // the config's declared inbox.
      //
      // Replay / tombstone guards run FIRST (audit COORD-3, C1, NIP §3.5): they do
      // not depend on the fetched config, they are the security-critical TERMINAL
      // checks, and putting them ahead of the config-propagation checks means a
      // replayed historical grant is rejected outright even while the config it once
      // authorized against is momentarily unfetchable or stale — the retryable
      // propagation paths below must never keep re-attempting a genuine replay.
      //
      // A gen BELOW the highest ever installed/detached is a hard reject — a replayed
      // historical grant can never re-install. A gen EQUAL to it is normally a replay
      // of an already-consumed grant, EXCEPT when it is a RESUME of a partially
      // completed install of that same gen (audit C1): if installEvent threw after
      // recordInstalledGen bumped the high-water mark (e.g. ensureChat/billing failed
      // mid-install), the event row is still present and NOT tombstoned, and the same
      // grant redelivered must be allowed to run to completion rather than be rejected
      // as stale. A tombstoned coordinate (detached) or a missing event row at the
      // high gen is a genuine replay and stays rejected.
      const highGen = this.deps.store.installHighGen(grant.coordinate);
      if (gen < highGen) {
        log(
          `[install] REJECTED ${grant.coordinate}: grant gen ${gen} < the highest generation ever installed/detached (${highGen}) — replayed or stale`,
        );
        return;
      }
      if (gen === highGen) {
        const resumable =
          this.deps.store.getEvent(grant.coordinate) !== undefined &&
          !this.deps.store.isInstallTombstoned(grant.coordinate);
        if (!resumable) {
          log(
            `[install] REJECTED ${grant.coordinate}: grant gen ${gen} = the high-water mark (${highGen}) with no resumable install — replayed or stale`,
          );
          return;
        }
        log(`[install] ${grant.coordinate}: resuming a partially-completed install at gen ${gen}`);
      }
      if (!config) {
        // Not an authorization decision — the authoritative 31600 isn't fetchable
        // right now (relay gap, or not yet propagated after a just-created event).
        // Throw so processRumorWithRetry retries instead of installing blind.
        throw new Error(
          `install ${grant.coordinate}: no fetchable 31600 to authorize the grant yet — retryable`,
        );
      }
      if (config.coordinator !== this.coordPubkey) {
        if (!config.coordinator) {
          // The newest 31600 we can fetch names NO coordinator. A brand-new event is
          // created coordinator-LESS, and an organizer's attach publishes the
          // coordinator-naming config and the 21603 grant nearly simultaneously — so
          // an install fetch that races ahead of relay propagation reads the prior
          // coordinator-less config. This is propagation lag, NOT authorization
          // failure (the replay/tombstone guards above already caught a genuine
          // replay): throw so the grant retries with backoff until the attach's
          // config lands. If it never does, processRumorWithRetry gives up and logs
          // clearly, leaving the wrap unseen for the boot rescan — exactly the
          // !config path's contract. (A config naming a DIFFERENT, real coordinator
          // is terminal below: that grant is genuinely not for this daemon.)
          throw new Error(
            `install ${grant.coordinate}: newest 31600 names no coordinator yet — config propagation lag, retryable`,
          );
        }
        log(
          `[install] REJECTED ${grant.coordinate}: 31600 names ${short(config.coordinator)}, not this daemon (${short(this.coordPubkey)})`,
        );
        return;
      }
      // Gen mismatch with the newest fetchable config (NIP §3.7). Two cases:
      //  • grant gen > config gen — the 31600 we fetched is OLDER than the grant (the
      //    organizer's new config and 21603 don't land atomically). This is config
      //    propagation lag, NOT authorization failure: throw so the wrap retries
      //    (bounded, like the unfetchable-config path) until the config catches up.
      //  • grant gen < config gen — the config has already moved AHEAD to a newer
      //    generation this grant is not for (a stale grant for a superseded attach).
      //    Retrying can never resolve it; reject outright. (A replay at or below the
      //    high-water mark was already rejected above.)
      if (config.coordinatorGen !== gen) {
        if (gen > (config.coordinatorGen ?? 0)) {
          throw new Error(
            `install ${grant.coordinate}: grant gen ${gen} ahead of the newest 31600's gen ${config.coordinatorGen} — config propagation lag, retryable`,
          );
        }
        log(
          `[install] REJECTED ${grant.coordinate}: grant gen ${gen} < the newest 31600's gen ${config.coordinatorGen} — superseded/stale grant`,
        );
        return;
      }
      const grantInboxPub = getPublicKey(hexToBytes(grant.inboxSkHex));
      if (grantInboxPub !== config.inbox) {
        log(
          `[install] REJECTED ${grant.coordinate}: grant inbox key ${short(grantInboxPub)} does not derive the config's declared inbox ${short(config.inbox)}`,
        );
        return;
      }
    } else {
      // Restore/startup revalidation (P0-5): the newest 31600 MUST still name this
      // coordinator with the gen the event was installed at, BEFORE we resume it.
      gen = grant.gen ?? this.deps.store.getEvent(grant.coordinate)?.gen ?? 0;
      if (!config) {
        // Unfetchable config is NOT authorization to run and NOT a detach — keep the
        // event SUSPENDED (no subscriptions, no processing) and retry with backoff.
        // A present-but-unparseable config (pre-v2 `v` tag, malformed tag) lands here
        // too via configParseError, with a reason that makes the log unambiguous.
        this.suspendEvent(
          grant,
          gen,
          configParseError
            ? `newest 31600 present but unparseable (${configParseError})`
            : "newest 31600 not fetchable",
        );
        return;
      }
      if (config.coordinator !== this.coordPubkey || config.coordinatorGen !== gen) {
        // The newest config no longer names this coordinator+gen → durable detach.
        this.suspended.delete(grant.coordinate);
        await this.detachEvent(grant.coordinate, {
          gen,
          reason: `startup revalidation: newest 31600 ${config.coordinator === this.coordPubkey ? `names gen ${config.coordinatorGen}, not ${gen}` : config.coordinator ? `names ${short(config.coordinator)}` : "names no coordinator"}`,
        });
        return;
      }
      // Revalidation passed — resume; drop any prior suspension.
      this.suspended.delete(grant.coordinate);
    }

    this.deps.store.upsertEvent({
      coordinate: grant.coordinate,
      configJson: JSON.stringify(config ?? {}),
      inboxNsec: grant.inboxSkHex,
      eckJson: JSON.stringify(grant.eck),
      configRelays: JSON.stringify(relays),
      gen,
      now: this.now(),
    });
    // Record the install generation (NIP §3.5): bump the high-water mark and clear
    // any prior detach tombstone (a fresh grant with a higher gen re-installs).
    this.deps.store.recordInstalledGen(grant.coordinate, gen);

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
      maxIntroSec: effectiveMaxMediaSec(config?.maxVideoSec ?? 0),
      maxTalkSec: effectiveMaxMediaSec(config?.maxTalkSec ?? 0),
      chat: config ? isMarmotChatEnabled(config) : false,
      scoringCtx: {
        title: evtEvent?.tags.find((t) => t[0] === "title")?.[1] ?? "the event",
        summary: evtEvent?.tags.find((t) => t[0] === "summary")?.[1] ?? "",
        hashtags: (evtEvent?.tags ?? []).filter((t) => t[0] === "t").map((t) => t[1]!),
        lang: config?.lang ?? "en",
      },
      configEventId: cfgEvent?.id,
      configCreatedAt: cfgEvent?.created_at ?? 0,
      gen,
      retentionDays: config?.retentionDays,
      eventEndSec: parseEventEndSec(evtEvent),
      metaEventId: evtEvent?.id,
      metaCreatedAt: evtEvent?.created_at ?? 0,
      retentionExpired: this.deps.store.isRetentionExpired(grant.coordinate) || undefined,
    };
    this.events.set(grant.coordinate, state);
    // Persist the typed billing principal + evaluate the state machine at install
    // (spec §9, D5). Emits a 21606 if the event installs already over its tier.
    await this.reevaluateBilling(grant.coordinate);
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
    // Explicitly BACKFILL the E_inbox history from before this subscription's epoch
    // (audit H2, C3). The live subscription alone is not enough: a relay delivers a
    // subscription's stored events in arbitrary (often newest-first) order, so a
    // 21601 profile submission can arrive AHEAD of its own 21600 join request — the
    // C3 enrollment gate then drops the submission as "never joined" and, because a
    // live subscription never resends an already-delivered stored event, it is lost
    // until a restart. Worse, an attendee who joined BEFORE the daemon subscribed
    // could be missed entirely. This one-shot ordered fetch (join requests first, so
    // an enrollment row exists before any same-identity submission is evaluated)
    // closes both; the seen_rumors ledger dedupes it against the live stream, and
    // transport.fetch is capped (C3) so the backfill stays bounded.
    await this.backfillEventInbox(state, since);
    // React to live 31600 config edits (relays, matching, visibility, lang…) — audit H5.
    this.subscribeEventConfig(state);
    // Marmot group chat (§4): only chat-enabled events with a coordinator do any
    // work here — a chat-off event stays completely inert (no group, no watcher).
    if (state.chat) await this.ensureChat(state);
    // Handover bootstrap (NIP §3.7): a FRESH grant install may be a replacement
    // coordinator taking over an event that already has a published record set under
    // the previous coordinator's key. Reconstruct the approved set from the prior
    // roster (decryptable with the granted ECK) and republish under our own key, so
    // record-authority pinning never leaves members without a readable directory.
    if (source === "grant" && grant.backfill === "full") {
      await this.bootstrapHandover(state).catch((e) =>
        log(`[handover] ${state.coordinate}: bootstrap failed (non-fatal): ${e instanceof Error ? e.message : e}`),
      );
    }
  }

  /** Suspend an event whose config is unfetchable (NIP §3.5, P0-5): record it for a
   *  backoff retry and ensure it is NOT live. Idempotent. */
  private suspendEvent(
    grant: { coordinate: string; inboxSkHex: string; eck: EckVersion[]; configRelays: string[] },
    gen: number,
    reason = "newest 31600 not fetchable",
  ): void {
    // Make sure a previously-live instance stops serving while suspended.
    for (const map of [this.inboxSubs, this.configSubs, this.chatSubs]) {
      map.get(grant.coordinate)?.close();
      map.delete(grant.coordinate);
    }
    this.events.delete(grant.coordinate);
    const prev = this.suspended.get(grant.coordinate);
    const attempts = (prev?.attempts ?? 0) + 1;
    const delaysMs = this.wrapRetryDelaysMs;
    const backoff = delaysMs[Math.min(attempts - 1, delaysMs.length - 1)] ?? 30_000;
    this.suspended.set(grant.coordinate, {
      inboxSkHex: grant.inboxSkHex,
      eck: grant.eck,
      configRelays: grant.configRelays,
      gen,
      retryAt: this.now() + backoff,
      attempts,
      reason,
    });
    // Log the suspension only on a STATE CHANGE — the first time an event is
    // suspended, or when the reason differs from the prior cycle. A config that
    // stays permanently unresolvable (e.g. a pre-v2 ["v","1"] event that will never
    // become v2) is retried forever on backoff; logging every cycle would spam the
    // daemon log indefinitely, so steady-state retries stay silent.
    if (!prev || prev.reason !== reason) {
      log(`[install] SUSPENDED ${grant.coordinate}: ${reason} — not resumed, retry in ${backoff}ms (attempt ${attempts})`);
    }
  }

  /**
   * Retry revalidation of every suspended event whose backoff has elapsed (NIP §3.5).
   * A suspended event resumes when its config becomes fetchable and revalidates, or
   * detaches when the config names another coordinator/gen. Exposed for tests; in
   * production it is driven by a periodic timer started in {@link start}.
   */
  async retrySuspendedEvents(): Promise<void> {
    const now = this.now();
    for (const [coordinate, s] of [...this.suspended]) {
      if (s.retryAt > now) continue;
      await this.installEvent({
        coordinate,
        inboxSkHex: s.inboxSkHex,
        eck: s.eck,
        configRelays: s.configRelays,
        gen: s.gen,
        backfill: "recent",
        source: "restore",
      });
    }
  }

  private currentEck(state: EventState): { bytes: Uint8Array; id: number } {
    const latest = state.eck.reduce((m, v) => (v.id > m.id ? v : m));
    return { bytes: base64ToBytes(latest.key), id: latest.id };
  }

  /** Persist the event's current ECK set (audit C1: after a rotation mint). */
  private persistEck(state: EventState): void {
    const row = this.deps.store.getEvent(state.coordinate);
    if (row) {
      this.deps.store.upsertEvent({
        coordinate: state.coordinate,
        configJson: row.config_json,
        inboxNsec: row.inbox_nsec,
        eckJson: JSON.stringify(state.eck),
        configRelays: row.config_relays,
        now: this.now(),
      });
    }
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
      // R19: take the UNTOUCHED authenticated rumor (its created_at is exactly
      // what the seal author signed, so rumor.id still hashes its contents and
      // durable command ordering is not processing-time-dependent). The protocol
      // no longer clamps in place; this handler enforces the future-date bound
      // itself (below), dropping — not silently clamping — a future-dated rumor.
      rumor = unwrapRumorEnvelope(wrap, recipientSk).rumor;
    } catch {
      this.deps.store.markRumorSeen(wrap.id, this.now()); // can never decrypt — drop
      return undefined;
    }
    // Freshness (COORD-11): drop rumors future-dated > 15 min (clock-skew guard
    // against replay-with-shifted-timestamp). With R19 the rumor is unmutated, so
    // this bound now acts on the authenticated created_at.
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
    // Atomic in-process claim (P0-3): a concurrent duplicate wrap carrying this
    // same rumor is already executing it — skip rather than run side effects
    // twice. Synchronous check-and-add, so the two callbacks cannot interleave.
    if (this.inFlightRumors.has(rumor.id)) return undefined;
    this.inFlightRumors.add(rumor.id);
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
    try {
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
    } finally {
      // Release the P0-3 in-flight claim once the handler settles (success,
      // permanent drop, or give-up-for-rescan) so a later legitimate redelivery
      // — of a rumor left unseen — can be reprocessed.
      this.inFlightRumors.delete(rumor.id);
    }
  }

  /**
   * Enqueue an inbound handler on the bounded work queue (audit C3). Enforces a
   * global concurrency limit and a queue-depth cap: past the cap the task is DROPPED
   * (the rumor stays unseen, so a later backfill rescan recovers a legitimately
   * dropped one), keeping memory and concurrent handler count bounded under a burst.
   */
  private scheduleInbound(task: () => Promise<void>): void {
    if (this.inboundQueue.length >= INBOX_MAX_QUEUE) {
      this.inboundDropped++;
      if (this.inboundDropped % 100 === 1) {
        log(`[inbox] work queue full (${INBOX_MAX_QUEUE}) — dropping inbound wrap (total dropped: ${this.inboundDropped}); left unseen for rescan`);
      }
      return;
    }
    this.inboundQueue.push(task);
    this.pumpInbound();
  }

  /** Drain the inbound queue up to the global concurrency limit (audit C3). */
  private pumpInbound(): void {
    while (this.inboundRunning < INBOX_MAX_CONCURRENCY && this.inboundQueue.length > 0) {
      const task = this.inboundQueue.shift()!;
      this.inboundRunning++;
      void task()
        .catch(() => {})
        .finally(() => {
          this.inboundRunning--;
          this.pumpInbound();
        });
    }
  }

  /**
   * Serialize `fn` against every other holder of the same (coordinate, subject) —
   * the per-subject async mutex (audit R1). Runs `fn` after the prior holder settles
   * (success OR failure — one failed transition never deadlocks the next), returns
   * `fn`'s result, and prunes the chain when it is the tail so the map stays bounded.
   */
  private withSubjectLock<T>(coordinate: string, subject: string, fn: () => Promise<T>): Promise<T> {
    const key = `${coordinate}\u0000${subject}`;
    const prev = this.subjectChains.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    // Store a settle-swallowing tail so a rejection never becomes an unhandled
    // rejection and the next waiter still runs.
    const tail = run.then(
      () => {},
      () => {},
    );
    this.subjectChains.set(key, tail);
    void tail.then(() => {
      if (this.subjectChains.get(key) === tail) this.subjectChains.delete(key);
    });
    return run;
  }

  /**
   * True while `rumorId` is still the recorded owner of (coordinate, subject) — a
   * newer distinct command has NOT superseded it (audit R1 ownership token). Checked
   * before a durable mutation/publish so a superseded handler that somehow got past
   * the per-subject mutex stops producing side effects. No watermark (order-less
   * operation) ⇒ true (nothing to supersede).
   */
  private stillOwnsSubject(coordinate: string, subject: string, rumorId: string): boolean {
    const op = this.deps.store.getCommandWatermark(coordinate, subject);
    return !op || op.rumor_id === rumorId;
  }

  /** The per-event abort signal (audit R3), created lazily and reused until the event
   *  is torn down. Combined into each event-scoped job handler's signal. */
  private eventSignal(coordinate: string): AbortSignal {
    let ac = this.eventAbort.get(coordinate);
    if (!ac) {
      ac = new AbortController();
      this.eventAbort.set(coordinate, ac);
    }
    return ac.signal;
  }

  /**
   * Run an event-scoped job body under a combined (job/shutdown ∪ per-event) abort
   * signal, tracked so retention/detach can await its completion before purging
   * (audit R3). A per-event teardown (the event signal fired but NOT the shutdown/job
   * signal) is swallowed — the event is going away and its jobs are about to be
   * cancelled, so the handler stops cleanly and the runner completes the job rather
   * than retrying it toward poison. A shutdown abort or a real error propagates.
   */
  private async runEventJob(
    coordinate: string,
    jobSignal: AbortSignal,
    fn: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    const eventSig = this.eventSignal(coordinate);
    const combined = AbortSignal.any([jobSignal, eventSig]);
    const set = this.activeEventHandlers.get(coordinate) ?? new Set<Promise<void>>();
    this.activeEventHandlers.set(coordinate, set);
    const p = (async () => {
      try {
        await fn(combined);
      } catch (e) {
        if (eventSig.aborted && !jobSignal.aborted) {
          log(`[job] event ${coordinate} torn down mid-handler — stopped (will be cancelled)`);
          return;
        }
        throw e;
      }
    })();
    set.add(p);
    try {
      await p;
    } finally {
      set.delete(p);
      if (set.size === 0) this.activeEventHandlers.delete(coordinate);
    }
  }

  /**
   * Log exactly ONE outcome line per scoring batch — the missing counterpart to the
   * `[match] … → scoring N pair(s) in M batch(es)` dispatch line.
   *
   * Before this, a dispatched batch that never produced a score was
   * indistinguishable from a batch that was never queued: both looked like the
   * dispatch line followed by nothing (production incident 2026-07-24, where six
   * minutes of silence turned out to be work that had never been queued at all).
   * With the pair of lines, "dispatched but slow", "dispatched and failed" and
   * "never dispatched" are three visibly different shapes in the log.
   *
   * Wall-clock, not `this.now()`: an elapsed time must stay meaningful under an
   * injected/logical test clock. One line per batch, never per pair.
   */
  private async batchOutcome(label: string, summary: () => string, run: () => Promise<void>): Promise<void> {
    const started = Date.now();
    try {
      await run();
      log(`[match] ${label}: ${summary()} in ${Date.now() - started}ms`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const verb = e instanceof ParkJobError ? "PARKED" : "FAILED";
      log(`[match] ${label}: ${verb} after ${Date.now() - started}ms — ${msg.slice(0, 300)}`);
      throw e;
    }
  }

  /**
   * Abort every in-flight handler for an event and AWAIT their unwinding (audit R3),
   * so a subsequent purge / custody delete never races a handler that could recreate
   * purged data or publish with captured state. Resets the controller afterward so a
   * later re-install of the same coordinate runs under a fresh signal.
   */
  private async stopAndAwaitEventHandlers(coordinate: string): Promise<void> {
    this.eventAbort.get(coordinate)?.abort(new Error("event lifecycle ended"));
    const set = this.activeEventHandlers.get(coordinate);
    if (set && set.size > 0) await Promise.allSettled([...set]);
    this.eventAbort.delete(coordinate);
  }

  /**
   * The event is still live at the generation a handler captured, its retention
   * window is open, and it is not detach-tombstoned (audit R3). A job handler
   * re-checks this immediately before every durable write / publication so an aborted
   * or superseded run — one that detached or expired mid-flight — cannot recreate
   * derived rows or publish using now-stale state.
   */
  private eventStillLive(coordinate: string, gen?: number): boolean {
    const s = this.events.get(coordinate);
    if (!s) return false;
    if (s.retentionExpired || this.deps.store.isRetentionExpired(coordinate)) return false;
    if (this.deps.store.isInstallTombstoned(coordinate)) return false;
    if (gen !== undefined && s.gen !== gen) return false;
    return true;
  }

  /**
   * Durable inbox rate gate (audit C3): accept at most MAX_RUMORS_PER_SENDER_WINDOW
   * rumors from one sender, and MAX_RUMORS_PER_EVENT_WINDOW per event, per window.
   * Returns true when the rumor is WITHIN budget (process it); false when over (drop).
   */
  private inboxRateAllows(coordinate: string, senderPubkey: string): boolean {
    const now = this.now();
    const eventCount = this.deps.store.bumpInboxRate(coordinate, "", now, INBOX_RATE_WINDOW_MS);
    if (eventCount > this.eventRumorBudget(coordinate)) return false;
    const senderCount = this.deps.store.bumpInboxRate(coordinate, senderPubkey, now, INBOX_RATE_WINDOW_MS);
    return senderCount <= MAX_RUMORS_PER_SENDER_WINDOW;
  }

  /**
   * How many inbound rumors this event may produce in a window, floor plus a
   * per-enrolled-attendee allowance.
   *
   * A flat 600 was a bound on an event of unstated size, and it is the wrong
   * shape now that a whole room can be admitted from one QR: 300 people each
   * sending a join and a submission is ~600 rumors in the minute the doors open,
   * sitting exactly on the limit, and an over-budget rumor is dropped and left
   * UNSEEN — recoverable only by a daemon restart inside the gift-wrap window.
   * Turning away real joins to bound work is the wrong trade at precisely the
   * moment the event most needs them.
   *
   * Scaling with population is self-limiting rather than merely larger. The
   * per-SENDER cap is what actually stops abuse (one identity, 30 a minute), and
   * enrolling costs a join request, which is itself rate-limited — so the budget
   * can only grow as fast as genuine attendees arrive. `attendeeCount` includes
   * pending rows, which is the point: joins create them, so the budget rises
   * with the crowd during the burst instead of after it.
   */
  private eventRumorBudget(coordinate: string): number {
    if (coordinate === COORD_INBOX_RATE_KEY) return MAX_RUMORS_PER_EVENT_WINDOW;
    const enrolled = this.deps.store.attendeeCount(coordinate);
    return MAX_RUMORS_PER_EVENT_WINDOW + enrolled * RUMORS_PER_ATTENDEE_WINDOW;
  }

  /** Handle a wrap addressed to the coordinator's own pubkey (install/admin). */
  async handleCoordinatorWrap(wrap: GiftWrap): Promise<void> {
    const rumor = this.unwrapFresh(wrap, this.deps.coordSk);
    if (!rumor) return;
    // Rate-limit the coordinator's OWN inbox BEFORE any durable dispatch (audit R4):
    // the inbox is publicly addressable, so gate per-sender / per-inbox exactly like
    // an event inbox. A rate-rejected wrap is left UNSEEN (not written to the durable
    // seen ledger) so the ledger can't be grown by a flood — a legitimately-throttled
    // rumor is simply retried by a later backfill rescan once the burst subsides.
    if (!this.inboxRateAllows(COORD_INBOX_RATE_KEY, rumor.pubkey)) {
      log(`[coord-inbox] rate limit — dropping kind ${rumor.kind} from ${short(rumor.pubkey)}`);
      this.inFlightRumors.delete(rumor.id);
      return;
    }
    await this.processRumorWithRetry(wrap.id, rumor, async () => {
      if (rumor.kind === KIND_COORDINATOR_GRANT) {
        const grant = coordinatorGrantContentSchema.parse(JSON.parse(rumor.content));
        // Authenticate the install (ENCRYPTION-AND-PRIVACY.md F2): the grant must be
        // sealed by the event's E_id — rumor.pubkey is the verified seal author —
        // exactly the check 21604 admin commands already get. Otherwise anyone with
        // a plausible-looking payload could "install" an event and pick its relays.
        // The grant `a` is a canonical 31923 event coordinate (schema-enforced,
        // audit R18) — re-assert it here so a non-event alias can never install a
        // divergent namespace even if the payload reached this boundary another way.
        const eidPubkey = parseEventCoordinate(grant.a).pubkey;
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
          gen: grant.gen,
          backfill: known ? "recent" : "full",
          source: "grant",
        });
      } else if (rumor.kind === KIND_ADMIN_COMMAND) {
        const cmd = adminCommandContentSchema.parse(JSON.parse(rumor.content));
        log(`[admin] "${cmd.cmd}" from organizer ${short(rumor.pubkey)}`);
        await this.handleAdmin(rumor.pubkey, cmd.a, cmd.cmd, cmd.args, {
          createdAt: rumor.created_at ?? 0,
          rumorId: rumor.id,
          expires: cmd.expires,
        });
      } else if (rumor.kind === KIND_CHAT_KEY_ATTESTATION) {
        // Marmot chat-key attestation (§3.3). rumor.pubkey is the SEAL AUTHOR bound by
        // unwrapRumor — i.e. the attendee's own account key sealing the binding. The
        // admin authenticates it against the enrolled-attendee set before recording.
        if (!this.marmot) return;
        const content = chatKeyAttestationContentSchema.parse(JSON.parse(rumor.content));
        log(`[chat] 21607 ${content.op} from ${short(rumor.pubkey)} for ${content.a}`);
        // The rumor's created_at is part of the §10.2 proof-of-possession challenge.
        await this.marmot.handleAttestation(content.a, rumor.pubkey, content, rumor.created_at ?? 0);
      }
    });
  }

  /** Handle a wrap addressed to an event's E_inbox (join / submission). */
  async handleInboxWrap(coordinate: string, wrap: GiftWrap): Promise<void> {
    const state = this.events.get(coordinate);
    if (!state) return;
    const rumor = this.unwrapFresh(wrap, state.inboxSk);
    if (!rumor) return;
    // Durable per-sender / per-event rate accounting (audit C3). A sender or event
    // flooding the inbox is DROPPED but left UNSEEN (audit R4): marking rate-rejected
    // wraps seen permanently grew the seen ledger with attacker-chosen ids AND
    // permanently discarded a legitimately-throttled rumor. Leaving it unseen bounds
    // the ledger and lets a later backfill rescan recover a genuine rumor once the
    // burst subsides; a sustained flood is simply re-dropped by this gate each pass.
    // The in-flight claim taken by unwrapFresh is released here since we bypass
    // processRumorWithRetry (which would otherwise release it).
    if (!this.inboxRateAllows(coordinate, rumor.pubkey)) {
      // Name the budget: "the event is over its ceiling" and "this one sender is
      // flooding" are the same line otherwise, and they call for opposite
      // responses from whoever is reading the log during an event.
      log(
        `[inbox] rate limit — dropping kind ${rumor.kind} from ${short(rumor.pubkey)} for ${coordinate} ` +
          `(sender cap ${MAX_RUMORS_PER_SENDER_WINDOW}, event budget ${this.eventRumorBudget(coordinate)}/${INBOX_RATE_WINDOW_MS / 1000}s)`,
      );
      this.inFlightRumors.delete(rumor.id);
      return;
    }
    // Enrollment gate (audit C3): a profile submission from an identity with NO
    // attendee row (never sent a join request) is dropped — an unknown sender must
    // not be able to create a pending attendee row by submitting a profile. Left
    // UNSEEN (not marked) so a legitimate submission that merely raced ahead of its
    // own join request is recovered by the next backfill rescan once the join lands.
    if (
      rumor.kind === KIND_PROFILE_SUBMISSION &&
      !this.deps.store.getAttendee(coordinate, rumor.pubkey) &&
      !(await this.awaitEnrollment(coordinate, rumor))
    ) {
      log(`[submission] dropped from ${short(rumor.pubkey)}: no enrollment row (never joined) for ${coordinate}`);
      this.inFlightRumors.delete(rumor.id);
      return;
    }
    await this.processRumorWithRetry(wrap.id, rumor, async () => {
      // Retention expiry is terminal for attendee-authored event data. Consume
      // late/replayed inbox rumors without mutating private state or recreating
      // relay records that the sweep just deleted.
      if (state.retentionExpired || this.deps.store.isRetentionExpired(coordinate)) {
        log(`[retention] ignored inbox kind ${rumor.kind} for expired event ${coordinate}`);
        return;
      }
      if (rumor.kind === KIND_JOIN_REQUEST) {
        const content = joinRequestContentSchema.parse(JSON.parse(rumor.content));
        log(`[join] request from ${short(rumor.pubkey)} ("${content.name}")`);
        await this.handleJoin(state, rumor.pubkey, rumor.tags, content.name);
      } else if (rumor.kind === KIND_PROFILE_SUBMISSION) {
        const content = profileSubmissionContentSchema.parse(JSON.parse(rumor.content));
        log(`[submission] from ${short(rumor.pubkey)} — rev ${content.rev}, ${content.media.length} media, ${content.intro_text ? "text intro, " : ""}${content.profile.skills.length} skills`);
        await this.handleSubmission(state, rumor.pubkey, content.profile, content.media, content.intro_text, {
          rev: content.rev,
          createdAt: rumor.created_at ?? 0,
          rumorId: rumor.id,
        });
      } else if (rumor.kind === KIND_PROFILE_CORRECTION) {
        const content = profileCorrectionContentSchema.parse(JSON.parse(rumor.content));
        // The subject is the SEAL AUTHOR (rumor.pubkey), bound by unwrapRumor — an
        // attendee may only correct THEIR OWN profile (audit U9). There is no subject
        // field to spoof: a correction always applies to the sender's own entry.
        await this.handleCorrection(state, rumor.pubkey, content, {
          rev: content.rev,
          createdAt: rumor.created_at ?? 0,
          rumorId: rumor.id,
        });
      } else if (rumor.kind === KIND_TALK_SUBMISSION) {
        const content = talkSubmissionContentSchema.parse(JSON.parse(rumor.content));
        // The speaker is the SEAL AUTHOR (rumor.pubkey), bound by unwrapRumor.
        await this.handleTalkSubmission(state, rumor.pubkey, content);
      } else if (rumor.kind === KIND_ATTENDEE_WITHDRAWAL) {
        const content = withdrawalContentSchema.parse(JSON.parse(rumor.content));
        // The withdrawing attendee is the SEAL AUTHOR (rumor.pubkey), bound by
        // unwrapRumor — an attendee can only withdraw THEMSELVES (NIP §6.3 21610).
        await this.handleWithdrawal(state, rumor.pubkey, content, {
          createdAt: rumor.created_at ?? 0,
          rumorId: rumor.id,
        });
      }
    });
  }

  /**
   * Wait, briefly, for a 21601's own 21600 to land — the delivery inversion the
   * C3 enrollment gate cannot otherwise tell apart from a stranger's submission.
   *
   * 42a3ad7 moved the attendee row ahead of the entitlement round-trip, which
   * closed the window where the join handler was blocked for hundreds of ms with
   * no row written. What it could not close is arrival order: the app fans the
   * two wraps out concurrently, each needing its own signer round-trips (wholly
   * unordered under NIP-46, where every seal is a relay round-trip to Amber),
   * and they reach us via whichever relay answers first. When the submission
   * wins that race it is dropped, and because the live subscription never
   * re-delivers a stored event it already sent, recovery depends on the daemon
   * restarting inside the 3-day gift-wrap window. One attendee never got theirs
   * back that way.
   *
   * The inversion is a network-ordering artifact measured in milliseconds, so a
   * couple of seconds of re-checking resolves essentially all of it while
   * leaving the gate's actual purpose — a stranger cannot mint an attendee row
   * by submitting a profile — completely intact. A stranger simply waits 2.5s
   * before being dropped exactly as before.
   *
   * Two bounds keep that from becoming a cost worth paying for an attacker.
   * Only a YOUNG rumor waits: a live race is seconds old, while a replayed or
   * backfilled wrap is not racing anything (and backfill dispatches joins first
   * for this very reason), so those are dropped instantly. And at most
   * MAX_ENROLLMENT_WAITS run at once, so waiters can never occupy the whole
   * inbound worker pool and starve real work behind them.
   */
  private async awaitEnrollment(coordinate: string, rumor: Rumor): Promise<boolean> {
    const ageSec = Math.floor(this.now() / 1000) - (rumor.created_at ?? 0);
    if (ageSec > ENROLLMENT_WAIT_MAX_AGE_SEC) return false;
    if (this.enrollmentWaits >= MAX_ENROLLMENT_WAITS) return false;
    this.enrollmentWaits++;
    try {
      for (const delay of this.enrollmentWaitMs) {
        await this.sleep(delay);
        if (this.deps.store.getAttendee(coordinate, rumor.pubkey)) {
          log(`[submission] from ${short(rumor.pubkey)} outran its join request — enrolled after ${delay}ms, processing`);
          return true;
        }
      }
      return false;
    } finally {
      this.enrollmentWaits--;
    }
  }

  /**
   * Attendee-initiated withdrawal (NIP §6.3 21610). Same effect chain as an
   * organizer `revoke` (roster/directory/match removal, NIP-09 deletions, ECK
   * rotation, Marmot member removal) triggered by the attendee themselves — no
   * organizer action required. Gated by the §3.4 per-subject watermark (subject =
   * the withdrawing sender), reusing the durable command-watermark table so a
   * re-delivered old withdrawal cannot replay after a later re-approval.
   *
   * `delete_data` (default true): full deletion — the coordinator additionally
   * purges its stored per-attendee artifacts (profile/ai_profile row, transcripts,
   * nostr summary, content-addressed pipeline artifacts) so nothing derived
   * survives. `delete_data: false` retains those artifacts so a later re-approval
   * avoids reprocessing spend; only the public records are removed.
   */
  private async handleWithdrawal(
    state: EventState,
    pubkey: string,
    content: import("@nostrautica/protocol").WithdrawalContent,
    order: { createdAt: number; rumorId: string },
  ): Promise<void> {
    if (content.a !== state.coordinate) return;
    // Unified membership subject (audit R2): a withdrawal shares the `member:<pk>`
    // watermark with organizer approve/revoke, so a delayed old withdrawal orders
    // against a NEWER reapproval and is rejected — pre-fix it used an independent
    // `withdraw:<pk>` watermark and could undo a newer approval (and purge data).
    const subject = `member:${pubkey}`;
    // Serialize the whole withdrawal effect chain for this member subject (audit R1),
    // so it can't interleave with a concurrent organizer approve/revoke for the same
    // attendee.
    await this.withSubjectLock(state.coordinate, subject, async () => {
      // Per-subject ordering + durable resume (NIP §3.4 + audit C1): reject a stale
      // DISTINCT membership transition (so a re-delivered old withdrawal can't undo a
      // rejoin), but let the SAME rumor RESUME until its effect chain is durably
      // 'complete'. The operation is marked complete only AFTER the revoke — and, for
      // a delete_data withdrawal, AFTER the artifacts are actually purged — so the
      // rumor is never acknowledged while data still exists (audit C1).
      if (this.beginOrderedOperation(state.coordinate, subject, order) === "skip") {
        log(`[withdraw] skipped withdrawal from ${short(pubkey)}: stale distinct transition or already fully applied`);
        return;
      }

      const existing = this.deps.store.getAttendee(state.coordinate, pubkey);
      if (!existing) {
        log(`[withdraw] ${short(pubkey)} not enrolled — nothing to withdraw`);
        // Nothing to do — the operation is complete.
        this.deps.store.completeCommandOp(state.coordinate, subject, order.rumorId);
        return;
      }
      log(`[withdraw] ${short(pubkey)} leaving ${state.coordinate} (delete_data=${content.delete_data})`);
      // The public effect chain is identical to an organizer revoke (idempotent, and
      // its ECK rotation resumes idempotently via the same operation progress).
      await this.revokeAttendee(state, pubkey, { subject, rumorId: order.rumorId });
      if (content.delete_data) {
        // Ownership token recheck (audit R1, belt to the mutex): don't purge if a
        // newer membership command superseded this withdrawal mid-flight.
        if (!this.stillOwnsSubject(state.coordinate, subject, order.rumorId)) return;
        // Full deletion: purge the coordinator's stored derived artifacts for this
        // attendee. The public directory/roster/match records were already removed
        // by revokeAttendee; this removes the private DB copies too. If this throws,
        // the operation stays 'pending' (not completed below) so the withdrawal is
        // retried and re-purged — never acknowledged with data still present.
        this.deps.store.purgeAttendeeArtifacts(state.coordinate, pubkey);
        log(`[withdraw] purged stored artifacts for ${short(pubkey)}`);
      }
      // The full withdrawal (revoke + optional purge) completed — mark it durably done.
      this.deps.store.completeCommandOp(state.coordinate, subject, order.rumorId);
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
    // A talk's video is EITHER a Blossom `media` descriptor (recording/upload) or
    // an `external_url` (YouTube/mp4 the speaker hosts elsewhere). External talks
    // store the JSON literal 'null' for media and fingerprint on the URL.
    const isExternal = content.external_url !== undefined;
    const fingerprint = isExternal ? content.external_url! : content.media!.x;
    const applied = this.deps.store.upsertTalk({
      coordinate: state.coordinate,
      pubkey,
      talkD: content.talk_d,
      title: content.title,
      description: content.description,
      speakersJson: JSON.stringify(content.speakers),
      mediaJson: isExternal ? "null" : JSON.stringify(content.media),
      externalUrl: content.external_url ?? null,
      externalKind: content.external_kind ?? null,
      sourceType: content.source_type ?? null,
      processForMatching: content.process_for_matching,
      lang: state.lang,
      revision: content.revision,
      mediaX: fingerprint,
      now: this.now(),
    });
    if (!applied) {
      // Out-of-order lower revision (P0-2): don't reset moderation or run paid STT.
      log(`[talk] ignored stale rev ${content.revision} from ${short(pubkey)} "${content.title}": a newer revision is already stored`);
      return;
    }
    log(`[talk] "${content.title}" from ${short(pubkey)} (rev ${content.revision}) → pending moderation`);
    // Transcribe + fold into matching ONLY a Blossom talk the speaker opted in
    // (process_for_matching). External (YouTube/mp4) talks are never fetched — the
    // C3 SSRF allowlist covers Blossom origins only — so they are view-only. An
    // un-opted talk skips paid STT entirely (talks aren't matched by default).
    if (!isExternal && content.process_for_matching) {
      this.jobs.enqueue(
        "process_talk",
        `talk:${state.coordinate}:${pubkey}:${content.talk_d}:${content.media!.x}`,
        { coordinate: state.coordinate, pubkey, talkD: content.talk_d },
      );
    } else {
      log(
        `[talk] "${content.title}" not processed for matching ` +
          `(${isExternal ? `external ${content.external_kind} URL` : "process_for_matching off"})`,
      );
    }
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
    order?: { rev: number; createdAt: number; rumorId: string },
  ): Promise<void> {
    if (content.a !== state.coordinate) return; // correction for a different event
    const attendee = this.deps.store.getAttendee(state.coordinate, pubkey);
    if (!attendee || attendee.status !== "approved") {
      log(`[correction] ignored from ${short(pubkey)}: not an approved attendee`);
      return;
    }
    // Revisioned ordering (NIP §3.3): reject a correction whose (rev, created_at, id)
    // key does not strictly supersede the applied one — an out-of-order older
    // correction can never overwrite a newer one.
    if (order && attendee.correction_rev != null) {
      const current = { rev: attendee.correction_rev, created_at: attendee.correction_created_at ?? 0, id: attendee.correction_rumor_id ?? "" };
      const candidate = { rev: order.rev, created_at: order.createdAt, id: order.rumorId };
      if (!revisionSupersedes(candidate, current)) {
        log(`[correction] ignored stale correction from ${short(pubkey)}: rev ${order.rev} does not supersede stored ${current.rev}`);
        return;
      }
    }
    this.deps.store.upsertAttendee({
      coordinate: state.coordinate,
      pubkey,
      correctionJson: JSON.stringify(content),
      correctionRev: order?.rev ?? null,
      correctionCreatedAt: order?.createdAt ?? null,
      correctionRumorId: order?.rumorId ?? null,
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

    // Population cap (audit C3): a NEW attendee beyond the 2,000 roster protocol cap
    // is refused — the coordinator must never grow its attendee set past what the
    // 31604 roster can carry and then fail to publish it. Existing rows (re-delivered
    // joins) are unaffected.
    if (!existing && this.deps.store.attendeeCount(state.coordinate) >= MAX_ATTENDEES_PER_EVENT) {
      log(`[join] REJECTED ${short(attendeePubkey)}: event ${state.coordinate} at the ${MAX_ATTENDEES_PER_EVENT}-attendee cap`);
      return;
    }

    const inviteTag = tags.find((t) => t[0] === "invite");
    const invite = inviteTag && inviteTag[1] && inviteTag[2]
      ? { invitePubkey: inviteTag[1], sig: inviteTag[2] }
      : undefined;

    // Enroll BEFORE the entitlement round-trip below (production incident,
    // 2026-07-29). The app publishes a join (21600) and a profile submission
    // (21601) back to back, so both wraps are usually delivered — and dispatched
    // concurrently, they're independent inbox tasks — within the same second.
    // `fetchInviteHashes` is a relay fetch, which held this handler open for
    // hundreds of ms with NO attendee row written yet; the submission arriving in
    // that window hit the audit-C3 enrollment gate and was dropped as "never
    // joined". Three real attendees across two events lost their authored profile
    // that way, one of them permanently: the dropped wrap is left unseen for the
    // boot rescan, but recovery then depends on the daemon restarting inside the
    // 3-day gift-wrap window, and one didn't. The row goes in as `pending` — the
    // status this join would produce anyway if entitlement said no — and the
    // upsert below (COALESCE, so a profile that lands in between survives) sets
    // the real one. C3's threat model is untouched: the gate exists so an unknown
    // sender can't create a row by SUBMITTING A PROFILE, and this row is created
    // by an authenticated join request, which is exactly what does that.
    this.deps.store.upsertAttendee({
      coordinate: state.coordinate,
      pubkey: attendeePubkey,
      status: "pending",
      displayName: name.trim() || null,
      now: this.now(),
    });

    const publishedInvites = await this.fetchInviteHashes(state);
    let decision = evaluateEntitlement([this.inviteChecker], {
      coordinate: state.coordinate,
      attendeePubkey,
      invite,
      publishedInvites,
    }, this.now());

    // A code that fails validation against the CACHED hash set is not
    // necessarily invalid — the cache is populated lazily and invalidated only
    // by the config subscription delivering the new 31601 (audit COORD-29). A
    // code generated moments ago can lose this race: relay propagation +
    // subscription delivery hasn't caught up yet, or (rarer, but not
    // self-healing) the invalidating 31601 never reached this daemon's config
    // relays at all, in which case the cache would otherwise stay stale
    // forever. One bypass re-fetch, only on THIS specific failure reason (not
    // "no invite proof" or "already used", where a re-fetch changes nothing),
    // closes both without paying a relay round-trip on every join.
    if (!decision.grant && decision.reason === "invalid invite proof") {
      const freshInvites = await this.fetchInviteHashes(state, { force: true });
      decision = evaluateEntitlement([this.inviteChecker], {
        coordinate: state.coordinate,
        attendeePubkey,
        invite,
        publishedInvites: freshInvites,
      }, this.now());
      if (decision.grant) {
        log(`[join] ${short(attendeePubkey)} invite hash missing from cache — bypass re-fetch found it`);
      }
    }

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
    order?: { rev: number; createdAt: number; rumorId: string },
  ): Promise<void> {
    // Revisioned ordering (NIP §3.3): profile submissions carry a monotonic `rev`.
    // Accept only a submission whose (rev, created_at, id) key STRICTLY supersedes
    // the stored one — higher rev wins; equal rev → higher created_at; equal both →
    // lexicographically lowest id. A loser (an out-of-order older edit, or a
    // same-key re-delivery) is discarded, never applied. This replaces v1's
    // created_at-only interim guard (P0-2), closing same-key nondeterminism.
    if (order) {
      const cur = this.deps.store.getAttendee(state.coordinate, pubkey);
      if (cur?.profile_rev != null) {
        const current = { rev: cur.profile_rev, created_at: cur.profile_created_at ?? 0, id: cur.profile_rumor_id ?? "" };
        const candidate = { rev: order.rev, created_at: order.createdAt, id: order.rumorId };
        if (!revisionSupersedes(candidate, current)) {
          log(`[submission] ignored stale profile from ${short(pubkey)}: rev/created_at/id (${order.rev},${order.createdAt}) does not supersede stored (${current.rev},${current.created_at})`);
          return;
        }
      }
    }
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
      profileRev: order?.rev ?? null,
      profileCreatedAt: order?.createdAt ?? null,
      profileRumorId: order?.rumorId ?? null,
      now: this.now(),
    });
    const attendee = this.deps.store.getAttendee(state.coordinate, pubkey);
    if (attendee?.status === "approved") {
      await this.publishDirectory(state, pubkey);
      // Re-evaluate billing on a submission revision (spec §9): the enqueued paid
      // pipeline is gated at execution, but this refreshes state + emits on change.
      await this.reevaluateBilling(state.coordinate);
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
    const key = `proc:${coordinate}:${pubkey}:${version}`;
    // Coalesce superseded revisions (audit H-2): a new submission cancels this
    // attendee's still-pending/parked process_attendee jobs for OLDER revisions, so
    // the coordinator never pays to download+STT+profile a recording the attendee
    // already replaced. A running job is left alone (its stale writes are discarded
    // by the compare-and-set on source_revision / media x).
    const cancelled = this.deps.store.supersedePendingJobs(`proc:${coordinate}:${pubkey}:`, key);
    if (cancelled > 0) log(`[pipeline] ${short(pubkey)}: superseded ${cancelled} stale pending process job(s)`);
    // Carry the expected source revision in the payload (audit C2). The job's
    // conditional commit is gated on the revision it actually READS at execution
    // (the authoritative "what this run derived from"); this payload copy records
    // the revision that was current at enqueue for traceability/debugging.
    this.jobs.enqueue("process_attendee", key, {
      coordinate,
      pubkey,
      sourceRevision: attendee?.source_revision ?? null,
    });
  }

  /** Account-addressed gift wraps must reach both event-local and reader-default relays. */
  private accountRelays(state: EventState): string[] {
    return [...new Set([...state.configRelays, ...this.deps.defaultRelays])];
  }

  /** Grant the ECK and publish the directory entry + roster for a new attendee. */
  async grantAndPublish(state: EventState, attendeePubkey: string): Promise<void> {
    const grant = buildKeyGrant(this.deps.coordSk, state.coordinate, attendeePubkey, state.eck);
    await this.deps.transport.publish(grant, this.accountRelays(state));
    await this.publishDirectory(state, attendeePubkey);
    await this.publishRosterCoalesced(state);
    log(`[grant] ECK granted to ${short(attendeePubkey)}; directory + roster published`);
    // Attendee-count change (spec §9): re-evaluate billing — this new approval may
    // push the event over its free tier. Roster/grant above always run first, so
    // admission itself is never gated by billing (only paid AI work is).
    await this.reevaluateBilling(state.coordinate);
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

  /** Try to ECK-decrypt `ciphertext` with any ECK version this coordinator holds
   *  (a handover coordinator may hold both the pre- and post-rotation ECK). */
  private tryEckDecrypt(state: EventState, ciphertext: string): string | undefined {
    for (const v of state.eck) {
      try {
        return eckDecrypt(base64ToBytes(v.key), ciphertext);
      } catch {
        /* wrong version — try the next */
      }
    }
    return undefined;
  }

  /**
   * Coordinator handover bootstrap (NIP §3.7). A newly attached coordinator MUST
   * republish the event's member records under its own key so record-authority
   * pinning never leaves members without a readable directory. The previous
   * coordinator's manual-approval decisions arrived as 21604 commands addressed to
   * ITS key, so a fresh E_inbox re-scan alone cannot reconstruct who was approved.
   * This reads the previous coordinator's still-decryptable 31604 roster (ECK
   * custody was granted to us) to learn the approved set, seeds each attendee's
   * profile/ai_profile from their 31603 where available, marks them approved, and
   * republishes directory + roster + grants under THIS coordinator's key. Matches
   * are rebuilt by re-enqueuing the pipeline (the previous 31605s are per-recipient
   * and undecryptable to us — the "from reprocessing otherwise" path). Best-effort:
   * a fetch failure leaves the E_inbox backfill (invite auto-approvals) as the
   * floor, and a later organizer recompute converges the rest.
   */
  private async bootstrapHandover(state: EventState): Promise<void> {
    const { identifier } = parseCoordinate(state.coordinate);
    let rosterEvents: NostrEvent[];
    try {
      rosterEvents = await this.deps.transport.fetch(
        { kinds: [KIND_ROSTER], "#d": [identifier] },
        state.configRelays,
      );
    } catch {
      return;
    }
    // Newest roster from ANY prior author (previous coordinator or E_id) we can decrypt.
    let roster: RosterContent | undefined;
    for (const ev of [...rosterEvents].sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))) {
      if (ev.pubkey === this.coordPubkey) continue; // our own record — nothing to bootstrap from
      const json = this.tryEckDecrypt(state, ev.content);
      if (!json) continue;
      try {
        roster = rosterContentSchema.parse(JSON.parse(json));
        break;
      } catch {
        /* malformed — try an older roster */
      }
    }
    if (!roster || roster.attendees.length === 0) return;
    log(`[handover] ${state.coordinate}: bootstrapping ${roster.attendees.length} attendee(s) from the prior roster`);

    let seeded = 0;
    for (const a of roster.attendees) {
      const existing = this.deps.store.getAttendee(state.coordinate, a.pubkey);
      if (existing?.status === "approved") continue; // already reconstructed from E_inbox backfill
      // Recover profile + ai_profile from the prior 31603 (decryptable with our ECK).
      let profileJson: string | undefined;
      let aiProfileJson: string | undefined;
      let transcriptsJson: string | undefined;
      let displayName: string | undefined;
      try {
        const dirEvents = await this.deps.transport.fetch(
          { kinds: [KIND_DIRECTORY_ENTRY], "#d": [a.d] },
          state.configRelays,
        );
        for (const de of [...dirEvents].sort((x, y) => (y.created_at ?? 0) - (x.created_at ?? 0))) {
          const json = this.tryEckDecrypt(state, de.content);
          if (!json) continue;
          const entry = directoryEntryContentSchema.parse(JSON.parse(json));
          if (entry.pubkey !== a.pubkey) continue;
          profileJson = JSON.stringify({
            ...entry.profile,
            __media: entry.media,
            ...(entry.intro_text ? { __intro_text: entry.intro_text } : {}),
          });
          if (entry.ai_profile) aiProfileJson = JSON.stringify(entry.ai_profile);
          if (entry.transcripts) transcriptsJson = JSON.stringify(entry.transcripts);
          if (entry.name) displayName = entry.name;
          break;
        }
      } catch {
        /* no readable directory entry — seed approval alone; the pipeline refills it */
      }
      const srcRev = profileJson ? this.sourceRevision(profileJson) : undefined;
      this.deps.store.upsertAttendee({
        coordinate: state.coordinate,
        pubkey: a.pubkey,
        status: "approved",
        role: a.role,
        ...(displayName ? { displayName } : {}),
        ...(profileJson ? { profileJson, sourceRevision: srcRev } : {}),
        // ai_source_revision === source_revision so publishDirectory surfaces the
        // recovered ai_profile immediately (not paired with stale source text).
        ...(aiProfileJson ? { aiProfileJson, aiSourceRevision: srcRev } : {}),
        ...(transcriptsJson ? { transcriptsJson } : {}),
        now: this.now(),
      });
      seeded++;
    }

    // Republish the full record set under THIS coordinator's key.
    for (const a of this.deps.store.approvedAttendees(state.coordinate)) {
      const grant = buildKeyGrant(this.deps.coordSk, state.coordinate, a.pubkey, state.eck);
      await this.deps.transport.publish(grant, this.accountRelays(state));
      await this.publishDirectory(state, a.pubkey);
      // Rebuild matches under our authorship (the prior 31605s are undecryptable to us).
      if (state.matching === "on") this.enqueueProcess(state.coordinate, a.pubkey);
    }
    await this.publishRosterCoalesced(state);
    log(`[handover] ${state.coordinate}: seeded ${seeded}, republished directory/roster/grants under this coordinator`);
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
      // v2 (NIP §8): the publish-time re-cap must not be LOOSER than the schema —
      // aligned from 64 to MAX_SKILLS (50), the intake cap on the submission.
      skills: profile.skills.slice(0, MAX_SKILLS).map((s) => capAuthoredText(s, 200)),
      looking_for: capAuthoredText(profile.looking_for),
      links: profile.links.slice(0, 32).map((l) => capAuthoredText(l, 500)),
    };
    const entry = buildDirectoryEntry(this.publishKeys(state), state.coordinate, {
      v: 2,
      pubkey,
      ...(attendee?.display_name ? { name: capAuthoredText(attendee.display_name, MAX_NAME_CHARS) } : {}),
      profile: cappedProfile,
      media,
      ...(aiProfile ? { ai_profile: aiProfile } : {}),
      ...(edited ? { ai_profile_edited: true } : {}),
      ...(transcripts.length ? { transcripts: transcripts.map((t) => ({ ...t, text: capAuthoredText(t.text, 8000) })) } : {}),
      ...(introText ? { intro_text: capAuthoredText(introText) } : {}),
      updated_at: Math.floor(this.now() / 1000),
    }, this.nextCreatedAt);
    await this.publish(entry, state.configRelays);
  }

  /**
   * Publish the roster, collapsing a burst of approvals into as few publishes as
   * the correctness requirement allows.
   *
   * The 31604 is a full snapshot of the approved set, so N approvals in the same
   * moment do not need N publishes — the last one carries everybody. That was
   * fine while approvals trickled in through an organizer's queue, and stopped
   * being fine the moment a whole room could scan one QR: 300 auto-approvals
   * meant 300 publishes of a list growing towards 300 ECK-encrypted entries, to
   * relays already carrying the join traffic that caused them.
   *
   * A caller still awaits a publish that INCLUDES its own change, which is what
   * makes this safe to drop in behind `grantAndPublish`. A caller arriving while
   * a publish is in flight marks the roster dirty and waits on the runner; the
   * runner loops while dirty, so a snapshot taken after that caller's write is
   * guaranteed to be published before the promise it awaited settles.
   */
  private publishRosterCoalesced(state: EventState): Promise<void> {
    const key = state.coordinate;
    this.rosterDirty.add(key);
    const active = this.rosterRunners.get(key);
    if (active) return active;
    const run = (async () => {
      try {
        // `delete` returns whether the flag was set — consume it, publish the
        // snapshot that includes it, and go round again if anyone marked it
        // dirty while that publish was in flight.
        while (this.rosterDirty.delete(key)) await this.publishRoster(state);
      } finally {
        this.rosterRunners.delete(key);
      }
    })();
    this.rosterRunners.set(key, run);
    return run;
  }

  private async publishRoster(state: EventState): Promise<void> {
    const approved = this.deps.store.approvedAttendees(state.coordinate);
    const { bytes } = this.currentEck(state);
    // Advertise this event's MLS routing id (audit APPK-3) so members bind to the
    // right group instead of guessing when one coordinator serves several events.
    // Only an ACTIVE group's id is published — a frozen group is no longer the
    // room members should route to. Absent when chat is off / no group exists.
    const group = this.deps.store.getMarmotGroup(state.coordinate);
    const nostrGroupId = group?.status === "active" ? group.nostr_group_id : undefined;
    const roster: RosterContent = {
      v: 2,
      eck_current: this.currentEck(state).id,
      ...(nostrGroupId ? { nostr_group_id: nostrGroupId } : {}),
      attendees: approved.map((a) => {
        // Per-device chat keys attested to this account (NIP §6.2 / §10.1): the
        // active bindings, capped at MAX_CHAT_KEYS_PER_ACCOUNT, so clients dedupe
        // the member list by account and render per-device labels. Only emitted
        // when the attendee has attested at least one device.
        const chatKeys = this.deps.store
          .chatKeysForAccount(state.coordinate, a.pubkey)
          .filter((k) => k.status === "active")
          .slice(0, MAX_CHAT_KEYS_PER_ACCOUNT)
          .map((k) => ({
            pubkey: k.chat_pubkey,
            ...(k.label ? { label: k.label } : {}),
            // UNIX SECONDS, like every other timestamp on the wire. The store keeps
            // `updated_at` in ms (Date.now()); publishing it raw rendered every chat
            // device as "added 8/15/58545" in the device list.
            added_at: Math.floor(k.updated_at / 1000),
          }));
        return {
          pubkey: a.pubkey,
          d: blindedDFor(bytes, state.coordinate, a.pubkey),
          role: a.role === "organizer" ? "organizer" : ("attendee" as const),
          ...(chatKeys.length > 0 ? { chat_keys: chatKeys } : {}),
        };
      }),
    };
    const event = buildRoster(this.publishKeys(state), state.coordinate, roster, this.nextCreatedAt);
    await this.publish(event, state.configRelays);
  }

  // ── pipeline jobs ──────────────────────────────────────────────────────────
  /**
   * Run the AI pipeline for one attendee and CONDITIONALLY commit the result
   * (audit C2). Returns true iff the ai_profile was actually written — i.e. the
   * attendee's `source_revision` still matched the revision this run derived from.
   * A stale run (a newer submission landed mid-STT/LLM) returns false so the caller
   * skips enqueuing matching off a result that was discarded.
   */
  private async processAttendeeJob(coordinate: string, pubkey: string, signal?: AbortSignal): Promise<boolean> {
    const state = this.events.get(coordinate);
    if (!state) return false;
    // Re-check config at execution time (audit H4): a job queued while matching was
    // ON must not call any provider if matching has since been turned OFF.
    if (state.matching === "off") return false;
    // Spend gate (spec §8/§9): a blocked event OR exceeded budget parks this before
    // any STT/LLM spend.
    await this.assertSpendAllowed(coordinate, pubkey);
    const attendee = this.deps.store.getAttendee(coordinate, pubkey);
    if (!attendee) return false;
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
        summary: this.roles.summary,
        match: this.roles.match,
        translate: this.roles.translate,
        fetchBlob: this.deps.fetchBlob,
        transcribe: this.deps.transcribe,
        blossomOrigins: state.blossomOrigins,
        maxMediaBytes: this.deps.maxMediaBytes,
        // H-3: enforce the REAL intro-media duration limit + account actual bytes.
        maxDurationSec: state.maxIntroSec,
        onMediaUsage: ({ bytes, durationSec }) =>
          this.deps.store.addUsage(coordinate, pubkey, { bytes, durationSec }, this.now()),
        fetchNostrContext: (pk, n) => this.fetchNostrContext(state, pk, n),
        nostrContextN: state.nostrContextN,
        lang: state.lang,
        // Record ownership refs for the derived artifacts (audit C5).
        coordinate,
        // Shutdown cancellation (audit C11): the pipeline checks this at stage
        // boundaries so an in-flight STT/LLM run unwinds instead of writing against
        // a store the shutdown is about to close.
        signal,
        now: this.now,
        log,
      },
      { pubkey, profile, media: cappedMedia, introText, extraTranscripts },
    );

    // Lifecycle recheck before any durable write (audit R3): if the event detached or
    // its retention window expired while STT/LLM ran, do not recreate the ai_profile /
    // transcripts a purge just removed, and do not publish a directory entry for a
    // now-terminal event.
    signal?.throwIfAborted();
    if (!this.eventStillLive(coordinate, state.gen)) {
      log(`[pipeline] ${short(pubkey)}: event no longer live (detached/expired) — discarding result`);
      return false;
    }
    // Conditional commit (audit C2): write the ai_profile ONLY if the attendee's
    // source_revision is still the one this run derived from. A newer submission
    // that landed while STT/LLM ran has already advanced source_revision, so this
    // matches 0 rows and the stale result is discarded — a running job can no longer
    // overwrite a newer submission's data. The newer revision's own process job
    // (enqueued by handleSubmission) recomputes and commits against ITS revision.
    const committed = this.deps.store.commitAiProfile({
      coordinate,
      pubkey,
      aiProfileJson: JSON.stringify(aiProfile),
      profileHash: profileHash(aiProfile),
      aiSourceRevision: sourceRevision,
      // Always write the fresh set (may be "[]") so a re-record overwrites stale
      // transcripts rather than leaving old ones via COALESCE.
      transcriptsJson: JSON.stringify(transcripts),
      expectedSourceRevision: attendee.source_revision,
      now: this.now(),
    });
    if (!committed) {
      log(`[pipeline] ${short(pubkey)}: discarded stale ai_profile — a newer submission landed during processing`);
      return false;
    }
    // The pipeline succeeded: clear any previously surfaced poison status for
    // this attendee's stages (audit COORD-15) so the organizer view recovers.
    this.deps.store.clearPoisonStatuses(coordinate, pubkey);
    await this.publishDirectory(state, pubkey);
    // Nothing to match on: leaving already-cached pairs in place would keep this
    // person in other people's published lists, and any pair scored before (or,
    // historically, DESPITE) this check is exactly the fabricated kind — a
    // biography the model invented for an empty profile. Drop them and republish
    // the affected lists so the invention disappears instead of waiting for each
    // of those attendees to change their own profile.
    if (!hasProfileContent(aiProfile)) {
      const affected = this.deps.store.pairsFor(coordinate, pubkey).map((r) => r.other);
      if (affected.length) {
        this.deps.store.clearPairsInvolving(coordinate, pubkey);
        log(`[match] ${short(pubkey)} has no profile content — dropped ${affected.length} cached pair(s)`);
        for (const other of [...new Set([...affected, pubkey])]) {
          this.jobs.enqueue("publish_matches", `pub:${coordinate}:${other}:nocontent:${this.now()}`, {
            coordinate,
            pubkey: other,
            allowEmpty: true,
          });
        }
      }
      log(`[pipeline] ${short(pubkey)}: no ai_profile content to match on (no profile, intro, or public activity)`);
      return true;
    }
    log(`[pipeline] ${short(pubkey)} ai_profile ready — skills: ${aiProfile.skills.slice(0, 4).join(", ")}`);
    return true;
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
      // Per-file cap (R17 follow-up): reject a single descriptor larger than the
      // app's own 250 MiB upload/playback bound with a clear reason, instead of
      // letting it silently consume — or overflow — the aggregate budget.
      if (d.size > MAX_MEDIA_FILE_BYTES) {
        log(`[pipeline] ${short(pubkey)}: skipping ${d.size}-byte media (over the ${MAX_MEDIA_FILE_BYTES}-byte per-file cap; the app rejects it too)`);
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
  private async processTalkJob(coordinate: string, pubkey: string, talkD: string, signal?: AbortSignal): Promise<void> {
    const state = this.events.get(coordinate);
    if (!state) return;
    // Re-check config at execution time (audit COORD-28, mirroring the matching-off
    // re-check): talks may have been disabled after this job was queued — never run
    // paid STT for a talks-off event.
    if (state.talks === "off") {
      log(`[talk] process_talk skipped for ${short(pubkey)}: talks are off for this event`);
      return;
    }
    // Spend gate (spec §8/§9): billing block OR exceeded budget parks talk STT.
    await this.assertSpendAllowed(coordinate, pubkey);
    const talk = this.deps.store.getTalk(coordinate, pubkey, talkD);
    if (!talk) return;
    // External talks are never processed (no Blossom blob to fetch — SSRF
    // allowlist); defensive guard in case a stale job reaches here.
    if (talk.external_url != null) return;
    const media = JSON.parse(talk.media_json) as MediaDescriptor;
    // Duration cap (audit COORD-4): never transcribe over-length talk media.
    if (typeof media.duration === "number" && media.duration > state.maxMediaSec) {
      log(`[talk] skipping transcription of "${talk.title}" for ${short(pubkey)}: ${media.duration}s over the ${state.maxMediaSec}s cap`);
      return;
    }
    const transcribe =
      this.deps.transcribe ??
      ((d: MediaDescriptor, _sig?: AbortSignal) =>
        transcribeMedia(
          {
            store: this.deps.store,
            stt: this.deps.stt,
            sttModel: this.deps.sttModel,
            fetchBlob: this.deps.fetchBlob,
            blossomOrigins: state.blossomOrigins,
            maxMediaBytes: this.deps.maxMediaBytes,
            // H-3: enforce the REAL TALK-media duration limit + account actual bytes.
            maxDurationSec: state.maxTalkSec,
            onUsage: ({ bytes, durationSec }) =>
              this.deps.store.addUsage(coordinate, pubkey, { bytes, durationSec }, this.now()),
            // Shutdown / per-event teardown (audit R13): unwind blocked STT/ffmpeg.
            signal,
            now: this.now,
          },
          d,
        ));
    let transcript: MediaTranscript | undefined;
    // A media-policy rejection (declared-size mismatch / over-duration) rejects this
    // talk's media (no transcript) without poisoning the whole talk job (H-3).
    let r: string | import("./pipeline/transcribe.js").TranscriptResult;
    try {
      r = await transcribe(media, signal);
    } catch (e) {
      if (e instanceof MediaPolicyError) {
        log(`[talk] media rejected for "${talk.title}" (${short(pubkey)}): ${e.message}`);
        return;
      }
      throw e;
    }
    const text = typeof r === "string" ? r : r.text;
    const detected = typeof r === "string" ? undefined : r.lang;
    // Lifecycle recheck before writing the transcript / publishing (audit R3): if the
    // event detached or expired during STT, don't recreate a transcript a purge removed.
    signal?.throwIfAborted();
    if (!this.eventStillLive(coordinate, state.gen)) {
      log(`[talk] event no longer live (detached/expired) — discarding transcript for ${short(pubkey)}`);
      return;
    }
    if (text) {
      transcript = {
        x: media.x,
        text,
        lang: detected ?? (state.lang || "en").toLowerCase(),
        source: "stt",
        updated_at: this.now(),
      };
      // Compare-and-set on the media x captured before the STT await (audit P0-7):
      // if a newer talk revision re-recorded the media while STT ran, the row's
      // current media x no longer matches and this stale transcript is discarded
      // rather than attached to the wrong (newer) recording.
      const written = this.deps.store.setTalkTranscript(
        coordinate,
        pubkey,
        talkD,
        JSON.stringify(transcript),
        this.now(),
        media.x,
      );
      if (!written) {
        log(`[talk] discarded stale transcript for ${short(pubkey)} "${talk.title}": media changed since STT started`);
        return;
      }
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
    // External talks carry the JSON literal 'null' for media and a URL instead.
    const isExternal = talk.external_url != null;
    const media = isExternal ? undefined : (JSON.parse(talk.media_json) as MediaDescriptor);
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
      v: 2,
      pubkey,
      talk_d: talkD,
      title: talk.title,
      description: talk.description,
      speakers,
      ...(media
        ? { media }
        : {
            external_url: talk.external_url!,
            external_kind: talk.external_kind as TalkExternalKind,
          }),
      ...(talk.source_type ? { source_type: talk.source_type as TalkSourceType } : {}),
      ...(transcript ? { transcript } : {}),
      lang: talk.lang,
      revision: talk.revision,
      status: "published",
      published_at: publishedAt,
    };
    const event = buildTalkEntry(this.publishKeys(state), state.coordinate, content, this.nextCreatedAt);
    await this.publish(event, state.configRelays);
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

  /**
   * The attendees eligible to be matched. Presence of an ai_profile is not
   * enough — it must have CONTENT (see `hasProfileContent`): a content-free one
   * carries no signal, and scoring it makes the model invent a biography rather
   * than admit there's nothing to compare. Someone with nothing to say simply
   * isn't in the pool until they say something, at which point their commit
   * re-enters them and the recompute scores them for real.
   */
  private buildMatchingRoster(coordinate: string): AttendeeForMatching[] {
    return this.deps.store
      .approvedAttendees(coordinate)
      .filter((a) => a.profile_hash && this.hasStoredProfileContent(a.ai_profile_json))
      .map((a) => ({ pubkey: a.pubkey, profileHash: a.profile_hash! }));
  }

  /** `hasProfileContent` over a stored ai_profile_json; false when absent/malformed. */
  private hasStoredProfileContent(aiProfileJson: string | null | undefined): boolean {
    if (!aiProfileJson) return false;
    try {
      return hasProfileContent(JSON.parse(aiProfileJson) as AiProfile);
    } catch {
      return false;
    }
  }

  private async selectPairs(coordinate: string, pubkey: string, signal?: AbortSignal) {
    const roster = this.buildMatchingRoster(coordinate);
    const target = roster.find((a) => a.pubkey === pubkey);
    if (!target) return [];
    if (roster.length > this.prefilter.threshold && this.roles.embed.llm.embed) {
      await this.attachEmbeddings(coordinate, roster, signal);
    }
    return selectPairsToScore(this.deps.store, coordinate, target, roster, this.prefilter);
  }

  /**
   * Attach embeddings to the roster for the prefilter, reusing cached embeddings
   * (audit COORD-13): an attendee's embedding is content-addressed by their
   * profile_hash + the embedding model id in the artifact table, so a recompute
   * only embeds attendees whose profile CHANGED — not the full roster every time.
   */
  private async attachEmbeddings(coordinate: string, roster: AttendeeForMatching[], signal?: AbortSignal): Promise<void> {
    const provider = this.roles.embed.llm;
    if (!provider.embed) return;
    const modelKey = `${this.roles.embed.provider}:${this.roles.embed.model}`;
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
    const embeddings = await provider.embed(missing.map((m) => m.text), this.roles.embed.model, signal);
    // Lifecycle recheck before persisting derived artifacts (audit R3): the event may
    // have detached/expired during the embed call; don't recreate ownership refs +
    // roster_embedding rows a purge just removed.
    if (!this.eventStillLive(coordinate)) return;
    missing.forEach((m, i) => {
      const embedding = embeddings[i]!;
      roster[m.index]!.embedding = embedding;
      this.deps.store.putArtifact({
        stage: "roster_embedding",
        inputsHash: m.hash,
        provider: this.roles.embed.provider,
        model: this.roles.embed.model,
        output: embedding,
        now: this.now(),
        owner: { coordinate, pubkey: m.pubkey },
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
    signal?: AbortSignal,
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

    const { scores, missing, misattributed } = await scoreBatch(
      this.roles.match.llm,
      this.roles.match.model,
      state.scoringCtx,
      targetProfile,
      candidates,
      this.matchRng,
      this.loadDisplayName(coordinate, target),
      signal,
    );
    // Loud on purpose: an entry whose echoed name disagreed with its number means
    // the model handed one attendee's match text to another, which is invisible in
    // the "K scored, 0 unparsed" line and is what made the 2026-07-31 report so
    // hard to see from the logs alone.
    for (const note of misattributed ?? []) {
      log(`[match] MISATTRIBUTED ${short(target)} batch: ${note}`);
    }
    // Lifecycle recheck before any directed write (audit R3): the event may have
    // detached/expired during the scoring call; don't recreate pair rows a purge
    // just removed.
    if (!this.eventStillLive(coordinate)) return { scored: [], missing: 0 };
    const scored: CandidatePair[] = [];
    for (const [candId, ds] of scores) {
      const p = pairById.get(candId)!;
      if (!this.bothApproved(coordinate, p.a, p.b)) {
        log(`[match] discarding stale score ${short(p.a)} → ${short(p.b)}: an attendee was revoked during scoring`);
        continue;
      }
      if (!this.pairInputsCurrent(coordinate, p)) {
        log(`[match] discarding stale score ${short(p.a)} → ${short(p.b)}: a profile changed during scoring (inputs_hash moved)`);
        continue;
      }
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
    signal?: AbortSignal,
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

    const { scores, missing, misattributed } = await scoreReverseBatch(
      this.roles.match.llm,
      this.roles.match.model,
      state.scoringCtx,
      sharedProfile,
      targets,
      this.matchRng,
      this.loadDisplayName(coordinate, shared),
      signal,
    );
    for (const note of misattributed ?? []) {
      log(`[match] MISATTRIBUTED reverse batch for ${short(shared)}: ${note}`);
    }
    // Lifecycle recheck before any directed write (audit R3), as in scoreBatchJob.
    if (!this.eventStillLive(coordinate)) return { scored: [], missing: 0 };
    const scored: CandidatePair[] = [];
    for (const [targetId, ds] of scores) {
      const p = pairByTarget.get(targetId)!;
      if (!this.bothApproved(coordinate, p.a, p.b)) {
        log(`[match] discarding stale score ${short(p.a)} → ${short(p.b)}: an attendee was revoked during scoring`);
        continue;
      }
      if (!this.pairInputsCurrent(coordinate, p)) {
        log(`[match] discarding stale score ${short(p.a)} → ${short(p.b)}: a profile changed during scoring (inputs_hash moved)`);
        continue;
      }
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

  /**
   * Both endpoints of a pair are still approved (audit P0-7). Scoring captures
   * candidates, awaits the provider, then writes pairs — if either attendee was
   * revoked during that call, `revokeAttendee` already deleted their pairs, and
   * recording the returned score would recreate a pair revocation just removed.
   * Rechecked immediately before the write so a stale score is discarded instead.
   */
  private bothApproved(coordinate: string, a: string, b: string): boolean {
    return (
      this.deps.store.getAttendee(coordinate, a)?.status === "approved" &&
      this.deps.store.getAttendee(coordinate, b)?.status === "approved"
    );
  }

  /**
   * The pair's inputs_hash still matches BOTH endpoints' current profile hashes
   * (audit C2). Scoring captures a pair's inputs_hash at selection, awaits the
   * provider, then writes — if either endpoint's ai_profile was recomputed during
   * that call (a newer submission committed a different profile_hash), the score was
   * computed against inputs the DB no longer holds. Rechecked immediately before the
   * write so a score derived from stale inputs is discarded, not stored under the
   * now-current inputs_hash. Returns false if either profile hash is missing.
   */
  private pairInputsCurrent(coordinate: string, pair: CandidatePair): boolean {
    const ha = this.deps.store.getAttendee(coordinate, pair.a)?.profile_hash;
    const hb = this.deps.store.getAttendee(coordinate, pair.b)?.profile_hash;
    if (!ha || !hb) return false;
    return pairInputsHash(ha, hb) === pair.inputsHash;
  }

  /** Display name from the join request (B1), for name-aware match reasoning. */
  private loadDisplayName(coordinate: string, pubkey: string): string | undefined {
    return this.deps.store.getAttendee(coordinate, pubkey)?.display_name ?? undefined;
  }

  private async publishMatchesJob(coordinate: string, pubkey: string, allowEmpty = false): Promise<void> {
    const state = this.events.get(coordinate);
    if (!state || state.matching === "off") return; // never publish lists when matching is off (H4)
    // Lifecycle recheck before publication (audit R3): a detached/expired event must
    // not publish a match list using captured state after custody was deleted.
    if (!this.eventStillLive(coordinate, state.gen)) return;
    const list = buildMatchList(this.deps.store, coordinate, pubkey, this.topK, Math.floor(this.now() / 1000));
    // Normally an empty list means "not scored yet" and publishing it would just
    // churn a replaceable event. `allowEmpty` is for the one case where empty is a
    // RESULT and has to reach the client: pairs were deliberately dropped, so the
    // previously published list is now wrong and must be replaced, not left live.
    if (list.matches.length === 0 && !allowEmpty) return;
    const event = buildMatchListEvent(this.publishKeys(state), coordinate, pubkey, sanitizeMatchList(list), this.nextCreatedAt);
    await this.publish(event, state.configRelays);
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
    const content: MatchMatrixContent = { v: 2, computed_at: Math.floor(this.now() / 1000), pairs };
    const event = buildMatchMatrix(this.publishKeys(state), state.coordinate, content, this.nextCreatedAt);
    await this.publish(event, state.configRelays);
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
  /** The per-subject watermark key for an admin command (NIP §3.4). */
  private commandSubject(
    coordinate: string,
    cmd: "approve" | "recompute" | "reprocess" | "revoke" | "talk_publish" | "talk_reject" | "detach",
    args: Record<string, unknown>,
  ): string {
    switch (cmd) {
      case "approve":
      case "reprocess":
      case "revoke":
        // Unified membership subject (audit R2): organizer approve/revoke AND attendee
        // withdrawal all use `member:<pk>` so every membership transition orders
        // against the others under one watermark, instead of approve/revoke
        // (`pubkey:`) and withdrawal (`withdraw:`) never comparing.
        return `member:${String(args.pubkey ?? "")}`;
      case "talk_publish":
      case "talk_reject":
        return `talk:${String(args.pubkey ?? "")}:${String(args.talk_d ?? "")}`;
      case "recompute":
      case "detach":
        return `coordinate:${coordinate}`;
    }
  }

  private async handleAdmin(
    from: string,
    coordinate: string,
    cmd: "approve" | "recompute" | "reprocess" | "revoke" | "talk_publish" | "talk_reject" | "detach",
    args: Record<string, unknown>,
    order?: { createdAt: number; rumorId: string; expires: number },
  ): Promise<void> {
    const state = this.events.get(coordinate);
    if (!state) return;
    // Only the organizer (E_id) may command the coordinator.
    if (from !== state.eidPubkey) return;

    // Replay horizon (NIP §3.4): a command is void after its `expires`. Skip an
    // expired command on live delivery AND on backfill/restore, so an old
    // revoke/recompute can never re-execute after a DB loss.
    if (order && Math.floor(this.now() / 1000) > order.expires) {
      log(`[admin] skipped expired "${cmd}" (expires ${order.expires} < now)`);
      return;
    }

    // Per-subject ordering + durable resume (NIP §3.4 + audit C1): reject a DISTINCT
    // command strictly older than the last operation for this (coordinate, subject),
    // but let the SAME rumor RESUME until it has a durable 'complete' marker. The
    // operation is recorded 'pending' here and marked 'complete' only after the full
    // effect chain below succeeds — so a mid-effect crash (grant/roster/deletion
    // publish, DB write) is retried instead of being suppressed by its own watermark
    // and falsely acknowledged. Approve vs revoke interleavings still resolve
    // deterministically by (created_at, id); different subjects are independent.
    const subject = this.commandSubject(coordinate, cmd, args);
    // Serialize the WHOLE ordered operation for this subject (audit R1): the watermark
    // read/upsert AND the async effect chain that follows run under a per-subject
    // mutex, so two distinct same-subject commands (e.g. an older revoke and a newer
    // approve) can't interleave and let the older one finish last and win.
    await this.withSubjectLock(coordinate, subject, async () => {
    if (order && this.beginOrderedOperation(coordinate, subject, order) === "skip") {
      log(`[admin] skipped "${cmd}" for ${subject}: stale distinct command or already fully applied`);
      return;
    }

    if (cmd === "detach") {
      // Signed immediate detach (NIP §3.5): same effects as a config-based detach.
      await this.detachEvent(coordinate, { reason: "21604 detach command" });
    } else if (cmd === "approve") {
      // Manual approval routed through the coordinator so IT grants the ECK and
      // publishes the directory/roster (attendees discover those under the
      // coordinator's key).
      const pubkey = String(args.pubkey ?? "");
      // Ownership token recheck (audit R1, belt to the mutex): a superseded handler
      // that somehow got past the mutex must not apply its decision.
      if (order && !this.stillOwnsSubject(coordinate, subject, order.rumorId)) return;
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
      // A raise (config reload) + organizer recompute must resume parked work
      // (spec §8/§9 / H-2): re-evaluate billing so a now-ok event unblocks, and
      // explicitly resume budget-parked work (a budget raise isn't a billing
      // transition), then drop cached scores and re-run.
      await this.reevaluateBilling(coordinate);
      this.resumeParkedWork(coordinate);
      this.deps.store.clearPairs(coordinate);
      // Forgetting the scores is not enough: the job queue ALSO remembers, via the
      // content-addressed dedupe keys of the finished `score_batch`/`publish_matches`
      // rows, which are kept for 30 days. Identical profiles ⇒ identical keys ⇒ every
      // re-enqueue below is silently discarded by `INSERT OR IGNORE`. That is the
      // 2026-07-24 incident verbatim: the second recompute of an event deleted all
      // pair scores, logged its batch dispatches, created nothing, ran nothing, and
      // left the event with no matches and no error. A recompute means "redo it", so
      // the queue's memory of having already done it has to go too.
      const forgotten = this.deps.store.clearMatchJobMemo(coordinate);
      const key = `${this.now()}`;
      let enqueued = 0;
      let discarded = 0;
      for (const a of this.deps.store.approvedAttendees(coordinate)) {
        const outcome = this.jobs.enqueue("match_recompute", `match:${coordinate}:${a.pubkey}:${key}`, {
          coordinate,
          pubkey: a.pubkey,
        });
        if (outcome === "enqueued") enqueued++;
        else if (outcome === "done" || outcome === "poison") discarded++;
      }
      log(
        `[admin] recompute ${coordinate}: cleared cached pairs + ${forgotten} finished job row(s), enqueued ${enqueued} match job(s)` +
          (discarded > 0 ? `, ${discarded} DISCARDED as already-done` : ""),
      );
    } else if (cmd === "reprocess") {
      // Same as recompute: re-evaluate + resume so a raise resumes parked work.
      await this.reevaluateBilling(coordinate);
      this.resumeParkedWork(coordinate);
      const pubkey = String(args.pubkey ?? "");
      if (pubkey) {
        // Forget this attendee's finished/poisoned processing rows first, or the
        // enqueue below is silently dropped: the key is fixed (`:manual`), so
        // INSERT OR IGNORE turns every press after the first into a no-op, and a
        // POISONED row makes the attendee permanently unreprocessable — which is
        // exactly how two attendees sat without profiles for two weeks after a
        // translation bug that had already been fixed.
        const forgotten = this.deps.store.clearAttendeeJobMemo(coordinate, pubkey);
        const outcome = this.jobs.enqueue("process_attendee", `proc:${coordinate}:${pubkey}:manual`, {
          coordinate,
          pubkey,
        });
        log(
          `[admin] reprocess ${coordinate} ${short(pubkey)}: cleared ${forgotten} finished job row(s), enqueue ${outcome}`,
        );
      }
    } else if (cmd === "revoke") {
      const pubkey = String(args.pubkey ?? "");
      // Pass the operation context so the ECK rotation resumes idempotently on a
      // retry (audit C1): the intended new key is minted once and reused, never
      // re-minted, and missing grants/roster are repaired by the idempotent republish.
      if (pubkey) await this.revokeAttendee(state, pubkey, order ? { subject, rumorId: order.rumorId } : undefined);
    } else if (cmd === "talk_publish") {
      // Moderate a submitted talk: publish its 31610 (spec F2). No-op if talks are off.
      if (state.talks !== "off") {
        const pubkey = String(args.pubkey ?? "");
        const talkD = String(args.talk_d ?? "");
        if (pubkey && talkD) await this.publishTalk(state, pubkey, talkD);
      }
    } else if (cmd === "talk_reject") {
      const pubkey = String(args.pubkey ?? "");
      const talkD = String(args.talk_d ?? "");
      if (pubkey && talkD) await this.rejectTalk(state, pubkey, talkD);
    }

    // The full effect chain completed — durably mark the operation complete (audit
    // C1). The watermark now means "last FULLY applied command": a later out-of-order
    // duplicate is rejected, while a redelivery of THIS rumor before this point (a
    // crash mid-effect left it 'pending') is allowed to resume rather than suppressed.
    if (order) this.deps.store.completeCommandOp(coordinate, subject, order.rumorId);
    });
  }

  /**
   * Ordering + resume gate for a durable command operation (audit C1). Returns
   * "skip" to reject (a stale DISTINCT command, or a re-delivery of an
   * already-'complete' rumor), or "run" to proceed — in which case the operation is
   * (re-)recorded 'pending' and the caller MUST mark it complete on success. The
   * SAME rumor is always allowed to resume while its operation is still 'pending'.
   */
  private beginOrderedOperation(
    coordinate: string,
    subject: string,
    order: { createdAt: number; rumorId: string },
  ): "skip" | "run" {
    const op = this.deps.store.getCommandWatermark(coordinate, subject);
    if (op) {
      if (op.rumor_id === order.rumorId) {
        if (op.state === "complete") return "skip"; // already fully applied — idempotent
        // pending same rumor → resume
      } else if (
        !supersedes({ id: order.rumorId, created_at: order.createdAt }, { id: op.rumor_id, created_at: op.created_at })
      ) {
        return "skip"; // older/equal DISTINCT command
      }
      // a strictly-newer distinct command takes the subject over
    }
    this.deps.store.beginCommandOp(coordinate, subject, order.createdAt, order.rumorId, this.now());
    return "run";
  }

  /**
   * Revoke an attendee and rotate the ECK (spec §6.3). Rotation is forward-only:
   * old ciphertexts stay readable to old key-holders, but all FUTURE directory/
   * roster/match content is encrypted under the new ECK, which the removed
   * attendee never receives. Their directory entry is deleted (NIP-09).
   *
   * ECK authority (audit P5, maintainer decision): the current ECK version is
   * defined by the coordinator-signed grants (21602) and roster (31604), NOT by the
   * `eck` tag in the E_id-signed 31600. That tag is BOOTSTRAP-ONLY — the initial key
   * a fresh install is granted — and the coordinator never reads it as the
   * current-version authority (`config.eck` is parsed by the protocol layer but
   * never consulted here). A coordinator cannot sign the E_id's 31600, so rotation
   * advances the key purely through grants/roster and leaves NO state expecting a
   * 31600 `eck` update. See handoff for the doc impact on PROTOCOL-NIP.md.
   */
  async revokeAttendee(
    state: EventState,
    removedPubkey: string,
    opCtx?: { subject: string; rumorId: string },
  ): Promise<void> {
    // Durable idempotent ECK-rotation state machine (audit C1). The intended new key
    // is minted EXACTLY ONCE per operation and recorded in the command's progress
    // BEFORE state.eck / eck_json are touched. A retry (in-memory, or after a crash)
    // reuses the recorded key instead of minting a fresh one — pre-fix each retry
    // ran `max(id)+1` and minted ANOTHER ECK, so a rotation interrupted mid-republish
    // produced duplicate rotations and stranded grants. `prevBytes` is the
    // pre-rotation ECK, recovered from `prevId` so a resume (where state.eck already
    // holds the new key) still deletes the removed entry at the OLD blinded d.
    // Ownership token recheck (audit R1, belt to the per-subject mutex): if a NEWER
    // distinct membership command has taken this subject over, this revoke was
    // superseded — stop before ANY mutation/publication so a stale older revoke can't
    // undo a newer approval or rotate the ECK behind it.
    if (opCtx && !this.stillOwnsSubject(state.coordinate, opCtx.subject, opCtx.rumorId)) {
      log(`[revoke] ${short(removedPubkey)}: superseded by a newer membership command — skipping side effects`);
      return;
    }
    const progress = opCtx ? this.deps.store.getCommandOpProgress(state.coordinate, opCtx.subject) : {};
    const rot = progress.eckRotation as { newId: number; newKey: string; prevId: number } | undefined;
    let newId: number;
    let prevBytes: Uint8Array;
    if (rot) {
      // RESUME: reuse the already-decided rotation.
      newId = rot.newId;
      const prevVer = state.eck.find((v) => v.id === rot.prevId);
      prevBytes = prevVer ? base64ToBytes(prevVer.key) : this.currentEck(state).bytes;
      if (!state.eck.some((v) => v.id === newId)) {
        state.eck = [...state.eck, { id: newId, key: rot.newKey }];
        this.persistEck(state);
      }
    } else {
      const prev = this.currentEck(state); // capture the pre-rotation ECK
      prevBytes = prev.bytes;
      newId = state.eck.reduce((m, v) => Math.max(m, v.id), 0) + 1;
      const newKey = bytesToBase64(generateEck());
      // Record the intended rotation FIRST (durable), so a retry never re-mints.
      if (opCtx) {
        this.deps.store.setCommandOpProgress(state.coordinate, opCtx.subject, opCtx.rumorId, {
          ...progress,
          eckRotation: { newId, newKey, prevId: prev.id },
        });
      }
      state.eck = [...state.eck, { id: newId, key: newKey }];
      this.persistEck(state);
    }

    // 1. Delete the removed attendee's directory entry (addressable, NIP-09) at the
    //    PRE-rotation blinded d.
    const removedD = blindedD(prevBytes, state.coordinate, removedPubkey);
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

    // 2. Mark removed (idempotent).
    this.deps.store.upsertAttendee({ coordinate: state.coordinate, pubkey: removedPubkey, status: "revoked", now: this.now() });

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
      await this.deps.transport.publish(grant, this.accountRelays(state));
      await this.publishDirectory(state, a.pubkey);
      if (state.matching === "on") {
        const list = buildMatchList(this.deps.store, state.coordinate, a.pubkey, this.topK, Math.floor(this.now() / 1000));
        if (list.matches.length > 0) {
          const event = buildMatchListEvent(this.publishKeys(state), state.coordinate, a.pubkey, sanitizeMatchList(list), this.nextCreatedAt);
          await this.publish(event, state.configRelays);
        }
      }
    }
    await this.publishRosterCoalesced(state);
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
    // Attendee-count change (spec §9): a revocation can bring the event back under
    // its free tier — re-evaluate, which unblocks + resumes parked work if so.
    await this.reevaluateBilling(state.coordinate);
  }

  /**
   * Durably detach the coordinator from an event (NIP §3.5, decision D6). Triggered
   * by a signed 21604 `detach`, by a newest 31600 that no longer names this
   * coordinator+gen (config update / startup revalidation, commit 3), or by an
   * explicit uninstall. Effects — all idempotent, so a re-trigger is safe:
   *  - durably tombstone the installation (coordinate + last gen + detached_at),
   *    which bars any replayed historical grant from re-installing;
   *  - close the event's subscriptions (inbox / config / chat) so it stops serving;
   *  - cancel pending/running jobs for the event (stop pending paid work);
   *  - DELETE the stored E_inbox/ECK custody (decision D6 — re-attach requires a
   *    fresh grant with a new gen); the tombstone row survives for dedupe/replay bar;
   *  - freeze the event's Marmot group (the existing freeze path) — full Marmot
   *    detach semantics (key rotation, member wipe) remain Phase 2/3.
   */
  async detachEvent(coordinate: string, opts: { reason: string; gen?: number } = { reason: "detach" }): Promise<void> {
    const already = this.deps.store.isInstallTombstoned(coordinate) && !this.events.has(coordinate);
    // Tombstone at the highest gen we know about (the passed gen, else the stored
    // install high-water mark) so a replayed lower/equal-gen grant can never re-install.
    const gen = Math.max(opts.gen ?? 0, this.deps.store.installHighGen(coordinate));
    this.deps.store.tombstoneInstall(coordinate, gen, Math.floor(this.now() / 1000));
    // Close subscriptions for this coordinate.
    for (const map of [this.inboxSubs, this.configSubs, this.chatSubs]) {
      map.get(coordinate)?.close();
      map.delete(coordinate);
    }
    // Abort and AWAIT every in-flight job handler for this event BEFORE deleting its
    // custody (audit R3): otherwise a running STT/LLM/scoring/publish handler could
    // recreate derived data or publish using the captured event state after the
    // custody row is gone. THEN cancel the queued jobs.
    await this.stopAndAwaitEventHandlers(coordinate);
    const cancelled = this.deps.store.cancelJobsForEvent(coordinate);
    // Capture chat state + notify context BEFORE dropping live state, so the
    // chat-orphaned notice below can still be sent.
    const state = this.events.get(coordinate);
    const hadChat = !!state?.chat && !!this.marmot;
    // Freeze the Marmot group (existing freeze path) before dropping live state.
    // Detach leaves the MLS group FROZEN, not wiped (full Marmot detach — key
    // rotation + member removal — is Phase 3): chat administration for the event is
    // orphaned until a coordinator re-attaches and re-adopts the group.
    if (this.marmot) this.marmot.freeze(coordinate);
    // Notify the organizer (21606) that chat administration is now orphaned. Sealed
    // by this coordinator's own key to E_id — needs no ECK/inbox custody (which we
    // delete below). Best-effort: a failure here never blocks the detach.
    if (hadChat && state && !already) {
      const status = buildCoordinatorStatus(this.deps.coordSk, state.eidPubkey, {
        v: 2,
        a: coordinate,
        stage: "chat",
        state: "poison",
        attempts: 0,
        error_category: "chat_orphaned_on_detach",
        retryable: false,
        at: Math.floor(this.now() / 1000),
      });
      await this.deps.transport.publish(status, this.accountRelays(state)).catch(() => {});
      log(`[detach] ${coordinate}: Marmot group FROZEN — chat administration orphaned until a coordinator re-attaches`);
    }
    // Drop live state and DELETE key custody (D6).
    this.events.delete(coordinate);
    this.deps.store.deleteEvent(coordinate);
    this.inviteHashCache.delete(coordinate);
    if (!already) {
      log(`[detach] ${coordinate} — ${opts.reason} (gen ${gen}); custody deleted, ${cancelled} job(s) cancelled, subscriptions closed`);
    }
  }

  // ── retention sweep (NIP §6.2) ────────────────────────────────────────────
  /**
   * The unix-second deadline after which an event's member records are deleted and
   * processing ceases: `eventEndSec + retentionDays·86400`. `null` when the event
   * has no retention policy or an unknown end time (the sweep skips it).
   */
  private retentionDeadline(state: EventState): number | null {
    if (state.retentionDays === undefined || state.eventEndSec <= 0) return null;
    return state.eventEndSec + state.retentionDays * 86_400;
  }

  /**
   * Periodic retention sweep (NIP §6.2): for every installed event whose retention
   * window has elapsed and which hasn't already been swept, delete the event's
   * member records (31603/31604/31605/31606/published 31610), stop paid processing
   * (a terminal park distinct from billing/budget), and emit a 21606 to organizers.
   * Idempotent — an event already expired is skipped.
   */
  async retentionSweep(): Promise<void> {
    const nowSec = Math.floor(this.now() / 1000);
    for (const state of [...this.events.values()]) {
      // Skip only when DURABLY expired (audit R3): the in-memory flag is set at the
      // START of expiry, but the sweep must be able to RESUME an expiry that failed
      // before its durable `markRetentionExpired` (e.g. a crash mid-purge) — so the
      // resume decision keys off the persisted flag, not the in-memory one.
      if (this.deps.store.isRetentionExpired(state.coordinate)) continue;
      const deadline = this.retentionDeadline(state);
      if (deadline === null || nowSec <= deadline) continue;
      // Guard against the boot + hourly sweeps double-running one event's expiry.
      if (this.retentionInProgress.has(state.coordinate)) continue;
      this.retentionInProgress.add(state.coordinate);
      try {
        await this.expireRetention(state);
      } catch (e) {
        log(`[retention] sweep failed for ${state.coordinate}: ${e instanceof Error ? e.message : e} — will retry next sweep`);
      } finally {
        this.retentionInProgress.delete(state.coordinate);
      }
    }
  }

  /**
   * Expire one event's retention (NIP §6.2): NIP-09-delete every member record,
   * park paid processing terminally, and notify organizers via 21606. The public
   * effect is best-effort (relays may not honor NIP-09) — the wording never
   * overpromises — but the coordinator also stops authoring anything new for the
   * event, so no fresh member content appears after expiry.
   */
  private async expireRetention(state: EventState): Promise<void> {
    log(`[retention] ${state.coordinate}: window elapsed — deleting member records + parking processing`);
    const nowSec = Math.floor(this.now() / 1000);
    // Park new work + gate late inbox rumors IMMEDIATELY (audit R3): the in-memory
    // flag stops fresh handlers before we abort the running ones. It is NOT the
    // durable terminal flag — that is set LAST, after the local purge, so a crash
    // between here and there resumes the deletion on the next sweep/restart.
    state.retentionExpired = true;
    // Stop and AWAIT every in-flight job handler for this event (audit R3), THEN drop
    // its queued jobs — so no running STT/LLM/scoring can recreate the derived data /
    // relay records we are about to purge, and no queued job runs after.
    await this.stopAndAwaitEventHandlers(state.coordinate);
    this.deps.store.cancelJobsForEvent(state.coordinate);
    const deletions: string[][] = [];
    const seenAddr = new Set<string>();
    const pushAddr = (a: string, k: string) => {
      if (seenAddr.has(a)) return;
      seenAddr.add(a);
      deletions.push([a, k]);
    };
    // 31603 directory entry per (currently-approved) attendee + 31605 match list
    // (same blinded d, different kind). Blinded `d` derives from the ECK, so an
    // attendee has an entry under EACH ECK version this event ever granted (a
    // rotation republishes under the new blinded d without deleting the old one on
    // every relay). Delete across ALL historical ECK versions (audit C5) so a
    // pre-rotation directory/match record is not left readable after retention.
    for (const a of this.deps.store.approvedAttendees(state.coordinate)) {
      for (const ver of state.eck) {
        const d = blindedD(base64ToBytes(ver.key), state.coordinate, a.pubkey);
        pushAddr(`${KIND_DIRECTORY_ENTRY}:${this.coordPubkey}:${d}`, String(KIND_DIRECTORY_ENTRY));
        pushAddr(`${KIND_MATCH_LIST}:${this.coordPubkey}:${d}`, String(KIND_MATCH_LIST));
      }
    }
    // 31604 roster + 31606 matrix keyed on the event `d` (not blinded).
    pushAddr(`${KIND_ROSTER}:${this.coordPubkey}:${state.identifier}`, String(KIND_ROSTER));
    pushAddr(`${KIND_MATCH_MATRIX}:${this.coordPubkey}:${state.identifier}`, String(KIND_MATCH_MATRIX));
    // Published 31610 talks: delete under every historical ECK version (audit C5),
    // not only the one recorded on the row, so a rotated-away talk address is cleaned.
    for (const talk of this.deps.store.publishedTalksForEvent(state.coordinate)) {
      for (const ver of state.eck) {
        const d = talkBlindedD(base64ToBytes(ver.key), state.coordinate, talk.pubkey, talk.talk_d);
        pushAddr(`${KIND_TALK}:${this.coordPubkey}:${d}`, String(KIND_TALK));
      }
    }
    // One NIP-09 kind-5 carrying every address (a-tag + k-tag pairs).
    const tags: string[][] = [];
    for (const [a, k] of deletions) {
      tags.push(["a", a!]);
      tags.push(["k", k!]);
    }
    const deletion = finalizeEvent(
      { kind: KIND_DELETION, created_at: nowSec, tags, content: "retention window elapsed" },
      this.deps.coordSk,
    );
    await this.deps.transport.publish(deletion, state.configRelays);

    // Full local purge (audit C5): "delete member data after the event" must delete
    // the coordinator's OWN copies too, not just the relay records. Reference-counted,
    // so a transcript/summary/artifact another event still references survives. Note:
    // backups taken BEFORE this sweep still contain the data — the operator must rotate
    // them (disclosed in the operator guide); the coordinator can't reach external files.
    // Purge runs BEFORE the durable terminal mark (audit R3): the mark is what makes
    // future sweeps SKIP the event, so recording it before the purge (as the pre-fix
    // code did) meant a crash in between left data present forever while the event was
    // durably recorded as swept. Ordered this way, a crash resumes the purge instead.
    this.deps.store.purgeEventArtifacts(state.coordinate);

    // Terminal park, DURABLE and LAST (audit R3): only now is the event recorded as
    // fully expired, so a sweep/restart before this point re-runs the (idempotent)
    // purge to completion.
    this.deps.store.markRetentionExpired(state.coordinate);

    // Notify organizers via 21606 (billing block untouched — this is a lifecycle
    // stage). error_category is a sanitized class, never attendee text.
    const status = buildCoordinatorStatus(this.deps.coordSk, state.eidPubkey, {
      v: 2,
      a: state.coordinate,
      stage: "retention",
      state: "poison",
      attempts: 0,
      error_category: "retention_expired",
      retryable: false,
      at: nowSec,
    });
    await this.deps.transport.publish(status, this.accountRelays(state));
    log(`[retention] ${state.coordinate}: deleted ${deletions.length} member record address(es), purged local data, notified organizer`);
  }

  // ── context fetch ───────────────────────────────────────────────────────────
  /**
   * The event's published invite hashes, cached per event (audit COORD-29):
   * every join request used to re-fetch the 31601. The cache is invalidated when
   * a new 31601 arrives on the config subscription (see subscribeEventConfig).
   * `force` bypasses a stale cache hit on the one path where staleness is
   * actually costly — a join whose code doesn't validate against it
   * (handleJoin's single bypass retry) — without paying a relay fetch on the
   * common case of every other join.
   */
  private async fetchInviteHashes(
    state: EventState,
    opts: { force?: boolean } = {},
  ): Promise<Map<string, InvitePolicy>> {
    const cached = this.inviteHashCache.get(state.coordinate);
    if (cached && !opts.force) return cached;
    const events = await this.deps.transport.fetch(
      { kinds: [KIND_INVITE_LIST], authors: [state.eidPubkey], "#d": [parseCoordinate(state.coordinate).identifier] },
      state.configRelays,
    );
    const latest = pickLatest(events);
    let invites = new Map<string, InvitePolicy>();
    if (latest) {
      try {
        const parsed = inviteListContentSchema.parse(JSON.parse(latest.content));
        invites = new Map(parsed.invites.map((i) => [i.h, invitePolicyOf(i)]));
      } catch {
        invites = new Map();
      }
    }
    this.inviteHashCache.set(state.coordinate, invites);
    return invites;
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
    return discoverKeyPackages(this.deps.transport, authors, chatRelaysFor(state), this.deps.defaultRelays, this.relayPolicy);
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
    await this.marmot.ensureRelays(state.coordinate, chatInteropRelays(state.configRelays));
    await this.marmot.backfillApproved(state.coordinate);
    this.subscribeChat(state);
  }

  /** Subscribe to 30443 key packages (add/heal) and 445 group traffic (ingest). */
  private subscribeChat(state: EventState): void {
    if (!this.marmot) return;
    // Keyed re-subscribe (audit COORD-8): relay handover (or a rotated group)
    // closes the old subs and opens new ones instead of guarding forever.
    const group = this.deps.store.getMarmotGroup(state.coordinate);
    const chatRelays = chatRelaysFor(state);
    const key = `${group?.nostr_group_id ?? "nogroup"}|${relayKey(chatRelays)}`;
    this.replaceSubscription(this.chatSubs, state.coordinate, key, () => {
      const closers: Array<() => void> = [];
      // 30443 watcher: the in-handler authentication (approved attendee's authorized
      // chat identity) is the gate, so a broad kind filter on the event relays is safe
      // and needs no re-subscription as the author set changes on approve/attest.
      const kpCloser = (this.deps.transport as any).subscribe?.(
        { kinds: [KIND_KEY_PACKAGE] },
        (e: NostrEvent) => void this.marmot!.handleKeyPackageEvent(state.coordinate, e as any).catch(() => {}),
        chatRelays,
      );
      if (kpCloser) closers.push(kpCloser);
      // 445 ingest: the coordinator is a silent member; ingesting keeps its leaf
      // converged and drives self_remove auto-commits. Routed by the group's random `h`.
      if (group) {
        const msgCloser = (this.deps.transport as any).subscribe?.(
          { kinds: [KIND_GROUP_MESSAGE], "#h": [group.nostr_group_id] },
          (e: NostrEvent) => void this.marmot!.ingest(state.coordinate, [e as any]).catch(() => {}),
          chatRelays,
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

    // Restore installed events from the store. Each is REVALIDATED against its newest
    // 31600 before resuming (NIP §3.5, P0-5): a config that no longer names this
    // coordinator+gen detaches it; an unfetchable config leaves it SUSPENDED (retried
    // by retrySuspendedEvents) rather than resumed leniently. Already-known events use
    // the 3-day live-overlap window (backfill "recent").
    for (const row of this.deps.store.allEvents()) {
      // Defense in depth: one event's restore must never abort start() or block the
      // OTHER stored events from restoring. installEvent already routes a bad/pre-v2
      // config to the SUSPENDED path rather than throwing, but any unexpected
      // per-event failure is caught here so the daemon still boots and serves the
      // rest (prod incident: a single pre-v2 config threw out of start() → crash-loop).
      try {
        await this.installEvent({
          coordinate: row.coordinate,
          inboxSkHex: row.inbox_nsec,
          eck: this.eckFromStore(row.coordinate),
          configRelays: JSON.parse(row.config_relays),
          gen: row.gen,
          backfill: "recent",
          source: "restore",
        });
      } catch (e) {
        log(`[boot] restore of ${row.coordinate} failed: ${e instanceof Error ? e.message : e} — skipping, other events continue`);
      }
    }

    // One-shot FULL-history fetch of the coordinator's own inbox (audit COORD-11):
    // the live subscription below only covers the 3-day gift-wrap window, so
    // install grants/admin commands sent during a longer outage would be missed.
    // Already-handled rumors dedupe via the seen ledger.
    try {
      // Paginated so a >5000-wrap flood on the public coordinator inbox can't crowd a
      // legitimate older install grant / admin command out of recovery (audit R4).
      const wraps = await this.fetchFullHistory(
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
    // Periodically revalidate suspended events (NIP §3.5, P0-5): one whose config was
    // unfetchable at startup resumes once it's fetchable, or detaches if it now names
    // another coordinator/gen. Only scheduled when there's something to retry.
    if (this.suspended.size > 0) {
      const timer = setInterval(() => void this.retrySuspendedEvents().catch(() => {}), 60_000);
      if (typeof (timer as any).unref === "function") (timer as any).unref();
      this.closers.push(() => clearInterval(timer));
    }
    // Retention sweep (NIP §6.2): run once at boot (catches events whose window
    // elapsed while the daemon was down) and then hourly. Cheap — it only touches
    // events that carry a retention policy and are past their deadline.
    await this.retentionSweep().catch((e) => log(`[retention] boot sweep failed: ${e instanceof Error ? e.message : e}`));
    const retentionTimer = setInterval(() => void this.retentionSweep().catch(() => {}), 3_600_000);
    if (typeof (retentionTimer as any).unref === "function") (retentionTimer as any).unref();
    this.closers.push(() => clearInterval(retentionTimer));
    // Resume any relay handover left pending by a transient outage or a restart
    // (audit C9): probe the stored candidate and promote it once reachable. Run once
    // at boot, then periodically.
    await this.retryRelayHandovers().catch((e) => log(`[relay] boot handover retry failed: ${e instanceof Error ? e.message : e}`));
    const relayTimer = setInterval(() => void this.retryRelayHandovers().catch(() => {}), 60_000);
    if (typeof (relayTimer as any).unref === "function") (relayTimer as any).unref();
    this.closers.push(() => clearInterval(relayTimer));
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
  private inviteHashCache = new Map<string, Map<string, InvitePolicy>>();
  /** Coordinates whose roster changed and has not been published since (see
   *  {@link Coordinator.publishRosterCoalesced}). */
  private rosterDirty = new Set<string>();
  /** The in-flight roster publisher per coordinate, awaited by later callers. */
  private rosterRunners = new Map<string, Promise<void>>();

  /**
   * NIP §3.2 monotonic `created_at` for a (kind, `d`) address:
   * `max(now, previous_for_that_address + 1)`. Handed to every replaceable
   * publisher builder so two updates to the same address in the same wall-clock
   * second get strictly increasing timestamps instead of colliding.
   *
   * DURABLE (reliability tail): the per-address last-published `created_at` is
   * persisted in `publish_watermarks`, so a restart keeps §3.2 monotonicity even if
   * the wall clock hasn't advanced past what was published before the restart. The
   * prior in-memory map relied on the wall clock alone across restarts; the store
   * closes that gap process-wide.
   */
  private nextCreatedAt = (kind: number, d: string): number => {
    const now = Math.floor(this.now() / 1000);
    return this.deps.store.nextPublishCreatedAt(`${kind}:${d}`, now);
  };

  /**
   * Publish through the transport, reconciling a "replaced/have newer" relay answer
   * (reliability tail). All coordinator publishes route here so a replaceable event
   * a relay rejected as superseded is reconciled via the global §3.1 comparator
   * ({@link reconcileReplaceable}) instead of being silently dropped. Non-replaceable
   * publishes (gift wraps, NIP-09 deletions — no `d` tag) never trigger a reconcile.
   */
  private async publish(event: NostrEvent, relays?: string[]): Promise<void> {
    const outcome = await this.deps.transport.publish(event, relays);
    if (outcome && (outcome as PublishOutcome).replaced) {
      await this.reconcileReplaceable(event, relays ?? this.deps.defaultRelays).catch((e) =>
        log(`[reconcile] ${event.kind}:${event.id.slice(0, 8)} failed: ${e instanceof Error ? e.message : e}`),
      );
    }
  }

  /**
   * Reconcile a replaceable event a relay reported as "replaced/have newer" (NIP
   * §3.1/§3.2). Fetch the competing event at (kind, our author, `d`) and apply the
   * global comparator: if it SUPERSEDES ours, ADOPT it — advance our durable publish
   * watermark past it so the next intended update wins, and don't clobber it. If OURS
   * supersedes the relay's, REPUBLISH ours so the relay converges to our version.
   * Bounded: a single fetch + at most one republish, never a loop.
   */
  private async reconcileReplaceable(event: NostrEvent, relays: string[]): Promise<void> {
    const d = event.tags.find((t) => t[0] === "d")?.[1];
    if (d === undefined) return; // not a replaceable-with-d event (gift wrap / deletion)
    const address = `${event.kind}:${d}`;
    let competing: NostrEvent[];
    try {
      competing = await this.deps.transport.fetch(
        { kinds: [event.kind], authors: [event.pubkey], "#d": [d] },
        relays,
      );
    } catch {
      return;
    }
    const newest = pickLatest(competing.filter((e) => e.pubkey === event.pubkey));
    if (!newest || newest.id === event.id) return; // our publish is already current
    if (supersedes({ id: newest.id, created_at: newest.created_at }, { id: event.id, created_at: event.created_at })) {
      // A competing replaceable event supersedes ours — adopt it (advance the
      // watermark so a future update exceeds it; leave the relay's version in place).
      this.deps.store.nextPublishCreatedAt(address, newest.created_at);
      log(`[reconcile] ${address}: competing ${newest.id.slice(0, 8)} supersedes ours — adopted (watermark advanced)`);
    } else {
      // Ours supersedes the relay's — republish so the relay converges to our version.
      await this.deps.transport.publish(event, relays).catch(() => {});
      log(`[reconcile] ${address}: our event supersedes the relay's ${newest.id.slice(0, 8)} — republished ours`);
    }
  }

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
    // Make-before-break (audit R10): open the NEW subscription FIRST, register it,
    // and only THEN close the old one — so there is never a window with no live
    // subscription for this coordinate during a relay handover. Cross-subscription
    // dedupe (seen_rumors + in-flight claim) makes the brief overlap safe.
    let closed = false;
    const raw = open();
    const close = () => {
      if (closed) return;
      closed = true;
      raw?.();
    };
    map.set(coordinate, { key, close });
    this.closers.push(close);
    existing?.close();
  }

  private eckFromStore(coordinate: string): EckVersion[] {
    const row = this.deps.store.getEvent(coordinate);
    return row ? (JSON.parse(row.eck_json) as EckVersion[]) : [];
  }

  /**
   * Full-history fetch that PAGINATES when the transport supports it (audit R4), so a
   * >5000-event flood can't silently truncate startup recovery and crowd out a
   * legitimate older install/join. Falls back to the capped one-shot `fetch` for a
   * transport without `fetchAll`.
   */
  private async fetchFullHistory(filter: any, relays: string[]): Promise<NostrEvent[]> {
    const fetchAll = (this.deps.transport as Transport).fetchAll;
    if (fetchAll) return fetchAll.call(this.deps.transport, filter, relays);
    return this.deps.transport.fetch(filter, relays);
  }

  // ── relay handover: make-before-break (audit C9) ──────────────────────────
  /**
   * Prove a candidate relay set reachable via the transport probe (≥1 relay
   * connects/EOSEs). A transport with no `probe` degrades to "assume reachable" so
   * older/fake transports keep the previous immediate-promote behavior.
   */
  private async probeRelays(relays: string[]): Promise<boolean> {
    const probe = (this.deps.transport as { probe?: (r: string[], t?: number) => Promise<boolean> }).probe;
    if (!probe) return true;
    try {
      return await probe.call(this.deps.transport, relays);
    } catch {
      return false;
    }
  }

  /** True while `candidate` is STILL the durable pending handover target for the
   *  coordinate (audit R10 compare-and-set): a newer config that recorded a different
   *  candidate — or a completed promotion that cleared it — makes this false, so a
   *  stale handover stops before repointing subscriptions. */
  private isPendingCandidate(coordinate: string, candidate: string[]): boolean {
    const pending = this.deps.store.getPendingRelays(coordinate);
    return !!pending && relayKey(pending) === relayKey(candidate);
  }

  /**
   * Bounded catch-up on the CANDIDATE relays before a handover promotion (audit R10):
   * pull the event's E_inbox history from the new relay set and run each wrap through
   * the normal inbox path (deduped by seen_rumors), so a rumor delivered only to the
   * new relays is not lost across the swap — AND the candidate is proven to actually
   * serve the event's data, not merely EOSE a dummy filter. Errors are swallowed (the
   * handover simply defers to a later retry).
   */
  private async catchUpInboxOnRelays(state: EventState, relays: string[]): Promise<void> {
    const inboxPk = getPublicKey(state.inboxSk);
    const since = giftwrapSince(Math.floor(this.now() / 1000));
    let wraps: NostrEvent[];
    try {
      wraps = (await this.deps.transport.fetch(
        { kinds: [KIND_GIFT_WRAP], "#p": [inboxPk], since },
        relays,
      )) as unknown as NostrEvent[];
    } catch (e) {
      log(`[relay] candidate catch-up for ${state.coordinate} failed: ${e instanceof Error ? e.message : e}`);
      return;
    }
    for (const w of wraps) await this.handleInboxWrap(state.coordinate, w as unknown as GiftWrap);
  }

  /**
   * Make-before-break relay handover (audit C9 + R10). The candidate is already
   * recorded durably (under the config lock, so `pending` reflects the newest config).
   * Here: compare-and-set that this candidate is still current, prove it reachable,
   * complete a bounded catch-up on the REAL candidate relays, re-check the CAS (a newer
   * config may have superseded during the awaits), and only then promote — opening the
   * new subscriptions before retiring the old. A superseded or unreachable candidate
   * leaves the healthy old subscriptions live; the timer/restart retries the still-
   * pending one, so a typo'd or briefly-unreachable relay list never orphans an event.
   */
  private async beginRelayHandover(state: EventState, candidate: string[]): Promise<void> {
    if (!this.isPendingCandidate(state.coordinate, candidate)) return; // already superseded
    const reachable = await this.probeRelays(candidate);
    if (!reachable) {
      log(
        `[relay] handover for ${state.coordinate} DEFERRED — candidate ${candidate.join(",")} not reachable; staying on last-known-good ${state.configRelays.join(",")}`,
      );
      return;
    }
    // Re-check BEFORE the (bounded) catch-up work, and again after it, so a newer
    // config that landed during the probe/fetch wins the compare-and-set.
    if (!this.isPendingCandidate(state.coordinate, candidate)) {
      log(`[relay] handover for ${state.coordinate} candidate superseded during probe — not promoting`);
      return;
    }
    await this.catchUpInboxOnRelays(state, candidate);
    if (!this.isPendingCandidate(state.coordinate, candidate)) {
      log(`[relay] handover for ${state.coordinate} candidate superseded during catch-up — not promoting`);
      return;
    }
    this.promoteRelays(state, candidate);
  }

  /** Promote a proven candidate relay set: persist as last-known-good, clear the
   *  pending marker, and repoint the E_inbox/config/chat subscriptions (COORD-8,
   *  open-before-close). Guarded by the R10 compare-and-set: a candidate a newer
   *  config already superseded is NOT promoted (and its pending marker is left for the
   *  newer candidate). */
  private promoteRelays(state: EventState, candidate: string[]): void {
    if (!this.isPendingCandidate(state.coordinate, candidate)) {
      log(`[relay] handover for ${state.coordinate}: candidate superseded — not promoting`);
      return;
    }
    state.configRelays = candidate;
    const row = this.deps.store.getEvent(state.coordinate);
    if (row) {
      this.deps.store.upsertEvent({
        coordinate: state.coordinate,
        configJson: row.config_json,
        inboxNsec: row.inbox_nsec,
        eckJson: row.eck_json,
        configRelays: JSON.stringify(candidate),
        now: this.now(),
      });
    }
    this.deps.store.clearPendingRelays(state.coordinate);
    this.subscribeEventInbox(state, giftwrapSince(Math.floor(this.now() / 1000)));
    this.subscribeEventConfig(state);
    if (state.chat) this.subscribeChat(state);
    log(`[relay] handover for ${state.coordinate} PROMOTED to ${candidate.join(",")} (proven reachable)`);
  }

  /**
   * Retry every event with a pending relay handover (audit C9): re-probe the stored
   * candidate and promote it if it is now reachable. Driven by a periodic timer in
   * {@link start} and run once at boot so a handover deferred by a transient relay
   * outage (or interrupted by a restart) completes on its own once relays recover.
   */
  async retryRelayHandovers(): Promise<void> {
    for (const coordinate of this.deps.store.coordinatesWithPendingRelays()) {
      const state = this.events.get(coordinate);
      const candidate = this.deps.store.getPendingRelays(coordinate);
      if (!state || !candidate) {
        // Event no longer live (detached) — drop a dangling candidate.
        if (!state) this.deps.store.clearPendingRelays(coordinate);
        continue;
      }
      if (relayKey(candidate) === relayKey(state.configRelays)) {
        this.deps.store.clearPendingRelays(coordinate); // already on it
        continue;
      }
      // Route through the same probe → catch-up → compare-and-set → promote path
      // (audit R10). Promotion re-validates the durable pending marker at its
      // (synchronous) entry, so a candidate a concurrently-applied newer config just
      // superseded is not promoted even without holding the config lock here.
      await this.beginRelayHandover(state, candidate);
    }
  }

  private subscribeCoordInbox(): () => void {
    return (this.deps.transport as any).subscribe?.(
      { kinds: [KIND_GIFT_WRAP], "#p": [this.coordPubkey], since: giftwrapSince() },
      // Bounded inbound queue (audit C3): dispatch through the global-concurrency
      // scheduler instead of fire-and-forget.
      (e: NostrEvent) => this.scheduleInbound(() => this.handleCoordinatorWrap(e as unknown as GiftWrap)),
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
        // Bounded inbound queue (audit C3): global-concurrency scheduler.
        (e: NostrEvent) => this.scheduleInbound(() => this.handleInboxWrap(state.coordinate, e as unknown as GiftWrap)),
        state.configRelays,
      ),
    );
    log(
      `[sub] ${wasSubscribed ? "re-subscribed (relay/inbox change)" : "listening"} on E_inbox for ${state.scoringCtx.title} (since=${since})`,
    );
  }

  /**
   * One-shot backfill of an event's E_inbox history from `since` (audit H2, C3).
   * Mirrors the boot-time coordinator-inbox backfill (COORD-11) for the per-event
   * inbox, and additionally ORDERS the fetched wraps so that 21600 join requests are
   * dispatched before any other rumor kind. That ordering is load-bearing: the C3
   * enrollment gate drops a 21601 profile submission from an identity with no
   * attendee row, so a submission that a relay happens to return ahead of its own
   * join (stored events come back in arbitrary, often newest-first, order) would be
   * dropped and — since the live subscription never re-delivers an already-sent
   * stored event — permanently lost. Processing every join first guarantees the
   * enrollment row exists before any same-identity submission is evaluated.
   *
   * Dedupe against the live subscription is handled by the durable seen_rumors
   * ledger (a wrap seen here is skipped there and vice versa); `transport.fetch` is
   * capped (C3) so the backfill stays bounded, and each wrap runs through the same
   * `handleInboxWrap` path (rate accounting, retention, ordered ops) as live traffic.
   */
  private async backfillEventInbox(state: EventState, since: number): Promise<void> {
    const inboxPk = getPublicKey(state.inboxSk);
    let wraps: NostrEvent[];
    try {
      // Paginated full-history walk (audit R4): a >5000-wrap flood on the public
      // event inbox can't truncate recovery and crowd out an older legitimate join.
      wraps = (await this.fetchFullHistory(
        { kinds: [KIND_GIFT_WRAP], "#p": [inboxPk], since },
        state.configRelays,
      )) as unknown as NostrEvent[];
    } catch (e) {
      log(`[boot] E_inbox backfill for ${state.coordinate} failed: ${e instanceof Error ? e.message : e}`);
      return;
    }
    if (!wraps.length) return;
    // Peek at each wrap's kind (read-only decrypt, no seen/in-flight side effects) so
    // joins can be dispatched first. A wrap we cannot decrypt (addressed elsewhere, or
    // ours to publish, not consume) sorts last and is dropped by handleInboxWrap.
    const ordered = wraps
      .map((w) => {
        let joinFirst = 1;
        try {
          if (unwrapRumor(w as unknown as GiftWrap, state.inboxSk).kind === KIND_JOIN_REQUEST) joinFirst = 0;
        } catch {
          /* undecryptable — leave last; handleInboxWrap marks it seen and drops it */
        }
        return { w, joinFirst };
      })
      .sort((a, b) => a.joinFirst - b.joinFirst);
    log(`[boot] E_inbox backfill for ${state.scoringCtx.title}: ${wraps.length} historical wrap(s)`);
    for (const { w } of ordered) await this.handleInboxWrap(state.coordinate, w as unknown as GiftWrap);
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
        { kinds: [KIND_EVENT_CONFIG, KIND_INVITE_LIST, KIND_CALENDAR_EVENT], authors: [state.eidPubkey], "#d": [state.identifier] },
        (e: NostrEvent) => {
          if (e.kind === KIND_INVITE_LIST) {
            this.inviteHashCache.delete(state.coordinate);
            log(`[join] invite list updated for "${state.scoringCtx.title}" — invite cache invalidated`);
            return;
          }
          // Live 31923 metadata edit (audit P9): the title/summary and — critically —
          // the retention anchor `eventEndSec` are editable after install, so watch
          // for a superseding revision instead of only reading the 31923 once.
          if (e.kind === KIND_CALENDAR_EVENT) {
            this.handleMetaUpdate(state.coordinate, e);
            return;
          }
          void this.handleConfigUpdate(state.coordinate, e).catch(() => {});
        },
        state.configRelays,
      ),
    );
  }

  /**
   * Apply a live 31923 metadata edit (audit P9). Accepted only from this event's
   * E_id, matching its `d`, and only when it SUPERSEDES the applied metadata under
   * the global §3.1 comparator (strictly newer, or same created_at with a lower id).
   * Updates the scoring context (title/summary/hashtags) and, decisively, the
   * retention anchor `eventEndSec` — so a moved end date re-times the retention
   * sweep instead of leaving it pinned to the install-time value.
   */
  private handleMetaUpdate(coordinate: string, event: NostrEvent): void {
    const state = this.events.get(coordinate);
    if (!state) return;
    if (event.kind !== KIND_CALENDAR_EVENT) return;
    if (event.pubkey !== state.eidPubkey) return; // must be signed by E_id
    const d = event.tags.find((t) => t[0] === "d")?.[1];
    if (d !== state.identifier) return; // wrong event
    if (state.metaEventId) {
      if (!supersedes({ id: event.id, created_at: event.created_at }, { id: state.metaEventId, created_at: state.metaCreatedAt })) {
        return;
      }
    } else if (event.created_at < state.metaCreatedAt) {
      return;
    }
    state.eventEndSec = parseEventEndSec(event);
    state.scoringCtx = {
      ...state.scoringCtx,
      title: event.tags.find((t) => t[0] === "title")?.[1] ?? state.scoringCtx.title,
      summary: event.tags.find((t) => t[0] === "summary")?.[1] ?? state.scoringCtx.summary,
      hashtags: event.tags.filter((t) => t[0] === "t").map((t) => t[1]!),
    };
    state.metaEventId = event.id;
    state.metaCreatedAt = event.created_at;
    log(`[config] applied live 31923 metadata update for "${state.scoringCtx.title}" — event_end=${state.eventEndSec}`);
  }

  /**
   * Apply a live 31600 config update (audit H5). Only an event authored by this
   * event's E_id, matching its `d`, and strictly newer than the applied config is
   * accepted (replaceable-event ordering); stale/forged/wrong-`d` events are
   * ignored. Diffs drive effects: matching/visibility (H4), relay handover, and
   * language/context invalidation.
   */
  /**
   * Handle a live 31600 config update (audit H5 + R10). The APPLY runs under a
   * per-coordinate config lock so concurrent config callbacks can't interleave their
   * read-modify-write of the applied-config watermark — the newest config's relay
   * candidate is what ends up in the durable pending marker. The relay handover then
   * runs OUTSIDE the lock and promotes only via compare-and-set against that pending
   * marker, so a slow handover for an older config can never promote after a newer
   * config recorded a different candidate.
   */
  async handleConfigUpdate(coordinate: string, event: NostrEvent): Promise<void> {
    const candidate = await this.withSubjectLock(coordinate, "config", () =>
      this.applyConfigUpdate(coordinate, event),
    );
    if (candidate) {
      const state = this.events.get(coordinate);
      if (state) await this.beginRelayHandover(state, candidate);
    }
  }

  /**
   * Apply a live 31600 config (audit H5) under the config lock; returns the relay
   * candidate to hand over to when the relay set CHANGED (else undefined). See
   * {@link handleConfigUpdate} for the concurrency contract.
   */
  private async applyConfigUpdate(coordinate: string, event: NostrEvent): Promise<string[] | undefined> {
    const state = this.events.get(coordinate);
    if (!state) return undefined;
    if (event.kind !== KIND_EVENT_CONFIG) return undefined;
    if (event.pubkey !== state.eidPubkey) return undefined; // must be signed by E_id
    const d = event.tags.find((t) => t[0] === "d")?.[1];
    if (d !== state.identifier) return undefined; // wrong event
    // Replaceable ordering (§3.1): ignore a config that does not SUPERSEDE the one
    // already applied — strictly newer, or same created_at with a lower id. v1
    // rejected `id <=` (kept the HIGHER id on a tie); v2 keeps the lowest id, in
    // step with installEvent and the app.
    if (state.configEventId) {
      if (
        !supersedes(
          { id: event.id, created_at: event.created_at },
          { id: state.configEventId, created_at: state.configCreatedAt },
        )
      ) {
        return undefined;
      }
    } else if (event.created_at < state.configCreatedAt) {
      return undefined;
    }

    let config: EventConfig;
    try {
      config = parseEventConfig(state.eidPubkey, event.tags);
    } catch {
      log(`[config] ignored malformed 31600 for ${short(state.eidPubkey)}`);
      return undefined;
    }

    // Durable detach (NIP §3.5, decision D6): the newest 31600 is a detach signal
    // whenever it does not name this coordinator with the CURRENT generation —
    // including a config with no coordinator tag, a config naming another
    // coordinator, and a config naming this coordinator at a DIFFERENT gen (a
    // re-attach, whose fresh 21603 grant re-installs). detachEvent tombstones the
    // install, closes subscriptions, cancels pending work, and deletes custody.
    if (config.coordinator !== this.coordPubkey || config.coordinatorGen !== state.gen) {
      const why =
        config.coordinator === this.coordPubkey
          ? `gen changed to ${config.coordinatorGen} (installed at ${state.gen})`
          : config.coordinator
            ? `now names coordinator ${short(config.coordinator)}`
            : "no longer names a coordinator";
      log(`[config] 31600 for ${coordinate} ${why} — detaching from this daemon`);
      await this.detachEvent(coordinate, { gen: state.gen, reason: `config update: ${why}` });
      return undefined;
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
    // input — validated (wss-only, no creds, public host, allowlist, audit COORD-16 + C4).
    const configRelays = sanitizeRelayUrls(config.relays, this.relayPolicy);
    const candidateRelays = configRelays.length ? configRelays : state.configRelays;
    // Make-before-break relay handover (audit C9): a relay CHANGE does NOT
    // immediately repoint subscriptions or persist as last-known-good. We keep
    // config_relays (last-known-good) live and record the candidate SEPARATELY, then
    // prove the candidate reachable before promoting — so a typo'd relay list can
    // never cut a healthy event off from its current relays.
    const relayChanged = relayKey(state.configRelays) !== relayKey(candidateRelays);
    const persistedRelays = relayChanged ? state.configRelays : candidateRelays;
    const eventRow = this.deps.store.getEvent(coordinate);
    if (eventRow) {
      this.deps.store.upsertEvent({
        coordinate,
        configJson: JSON.stringify(config),
        inboxNsec: eventRow.inbox_nsec,
        eckJson: eventRow.eck_json,
        configRelays: JSON.stringify(persistedRelays),
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
    // Duration caps (audit C8): update ALL THREE limits atomically. maxMediaSec is
    // the declared-duration screen; maxIntroSec/maxTalkSec are the authoritative
    // ffprobe-side decoded-duration enforcement (H-3). Pre-fix only maxMediaSec was
    // refreshed here, so after a live limit change the ffprobe check kept enforcing
    // the INSTALL-time value — an understated descriptor could pass the (lowered)
    // declared screen and then be transcribed under the stale (higher) real limit.
    state.maxMediaSec = effectiveMaxMediaSec(Math.max(config.maxVideoSec, config.maxTalkSec));
    state.maxIntroSec = effectiveMaxMediaSec(config.maxVideoSec);
    state.maxTalkSec = effectiveMaxMediaSec(config.maxTalkSec);
    // state.configRelays stays the last-known-good set until a handover is PROVEN
    // (audit C9). It is advanced only in promoteRelays, below.
    state.chat = isMarmotChatEnabled(config);
    state.retentionDays = config.retentionDays;
    state.configEventId = event.id;
    state.configCreatedAt = event.created_at;
    // A config edit that extends or removes the retention policy lifts a prior
    // retention expiry (NIP §6.2): if the event is no longer past its (new) deadline,
    // clear the terminal flag and resume parked work so processing can continue.
    if (state.retentionExpired) {
      const deadline = this.retentionDeadline(state);
      if (deadline === null || Math.floor(this.now() / 1000) <= deadline) {
        state.retentionExpired = undefined;
        this.deps.store.clearRetentionExpired(coordinate);
        this.resumeParkedWork(coordinate);
        log(`[retention] ${coordinate}: policy extended/removed — retention expiry lifted, parked work resumed`);
      }
    }
    log(`[config] applied live 31600 update — matching=${state.matching}, match_visibility=${state.matchVisibility}, lang=${state.lang}`);

    // Relay handover (audit COORD-8 + C9 + R10 make-before-break): a relay change
    // records the candidate DURABLY under the config lock (so pending reflects the
    // newest config), and the actual probe/catch-up/promote runs after the lock in
    // {@link handleConfigUpdate} via compare-and-set. The healthy old subscriptions
    // stay live until the candidate is proven reachable and caught up.
    if (relayChanged) {
      this.deps.store.setPendingRelays(coordinate, candidateRelays);
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
    // The caller runs the relay handover (outside the lock) for the recorded candidate.
    return relayChanged ? candidateRelays : undefined;
  }

  // ── billing state machine (spec §9, D5, §13.4) ─────────────────────────────
  /**
   * Re-evaluate the persisted billing state for an installation and enforce it.
   * Called at install, attendee-count change, submission revision, job claim, and
   * immediately before provider spend. Persists the typed principal (kind "eid" =
   * the event identity) + the `evaluating→ok|grace|blocked` verdict, emits an
   * authenticated 21606 on a state TRANSITION, and re-enqueues any parked paid work
   * when the block clears. Returns the new state. No-op returning "ok" when no
   * billing policy is configured (the free default). Never throws — enforcement is
   * done by the paid-job gate reading the returned value.
   */
  private async reevaluateBilling(coordinate: string): Promise<BillingStateRow["state"]> {
    const state = this.events.get(coordinate);
    if (!state) return "ok";
    if (!this.deps.evaluateBilling) return "ok";
    const now = this.now();
    const count = this.deps.store.approvedAttendees(coordinate).length;
    let verdict: CoordinatorBilling;
    try {
      verdict = this.deps.evaluateBilling(state.eidPubkey, count);
    } catch (e) {
      log(`[billing] evaluation failed for ${coordinate}: ${e instanceof Error ? e.message : e}`);
      return this.deps.store.getBillingState(coordinate)?.state ?? "ok";
    }
    const prev = this.deps.store.getBillingState(coordinate);
    let next: BillingStateRow["state"] = "ok";
    let graceUntil: number | null = null;
    let reason: string | null = null;
    if (verdict.state !== "ok") {
      reason = verdict.reason ?? null;
      const graceMs = (this.deps.billingGracePeriodSec ?? 0) * 1000;
      if (graceMs > 0 && prev?.state !== "blocked") {
        // Fresh over-tier → open a grace window; continue an existing one; block once
        // it has elapsed. A previously-blocked event stays blocked (no grace reset).
        if (prev?.state === "grace" && prev.grace_until != null) {
          if (now >= prev.grace_until) next = "blocked";
          else {
            next = "grace";
            graceUntil = prev.grace_until;
          }
        } else {
          next = "grace";
          graceUntil = now + graceMs;
        }
      } else {
        next = "blocked";
      }
    }
    this.deps.store.setBillingState({
      coordinate,
      principalKind: "eid",
      principalId: state.eidPubkey,
      state: next,
      reason,
      graceUntil,
      now,
    });
    const changed = (prev?.state ?? "evaluating") !== next;
    if (changed) {
      log(`[billing] ${coordinate}: ${prev?.state ?? "evaluating"} → ${next}${reason ? ` — ${reason}` : ""}`);
      await this.emitBillingStatus(state, next, verdict, graceUntil);
      // Unblocked (→ ok/grace): re-enqueue paid work parked while blocked (H-2).
      if (next !== "blocked" && prev?.state === "blocked") {
        const resumed = this.deps.store.resumeWaitingJobs(coordinate);
        if (resumed > 0) log(`[billing] ${coordinate}: resumed ${resumed} parked job(s)`);
      }
    }
    return next;
  }

  /**
   * The paid-work gate (spec §8/§9, H-2): re-evaluate billing AND check usage
   * budgets at job execution and immediately before any provider spend. When
   * `blocked` (billing) or over a byte/duration/call budget, throw
   * {@link ParkJobError} so the runner parks the job in the `waiting` state
   * (coalesced, no retry-spin) instead of spending — resumed on unblock / a raised
   * budget (organizer recompute/reprocess). Otherwise accounts one provider spend
   * attempt (per-attendee + per-event `calls`). Revoke/detach/roster/status paths
   * never call this. `pubkey` scopes per-attendee budgets + call accounting.
   */
  private async assertSpendAllowed(coordinate: string, pubkey?: string): Promise<void> {
    // 0. Retention gate (NIP §6.2): once the retention window has expired, paid
    // processing is terminally parked — a re-enqueued job re-parks here rather than
    // spending. Distinct from billing/budget park (which resume on payment/raise);
    // retention expiry is only lifted by the organizer extending/removing the policy
    // (a config edit, which clears the flag) or detaching.
    if (this.events.get(coordinate)?.retentionExpired || this.deps.store.isRetentionExpired(coordinate)) {
      throw new ParkJobError(`retention expired for ${coordinate} — paid work parked (records deleted)`);
    }
    // 1. Billing gate.
    if (this.deps.evaluateBilling) {
      const stateNow = await this.reevaluateBilling(coordinate);
      if (stateNow === "blocked") {
        throw new ParkJobError(`billing blocked for ${coordinate} — paid work parked until payment`);
      }
    }
    // 2. Budget gate (already-exceeded → park + emit budget_exceeded once).
    const over = this.checkBudget(coordinate, pubkey);
    if (over) {
      if (!this.budgetNotified.has(coordinate)) {
        this.budgetNotified.add(coordinate);
        const state = this.events.get(coordinate);
        if (state) await this.emitBudgetStatus(state, over);
        log(`[budget] ${coordinate}: parking paid work — ${over}`);
      }
      throw new ParkJobError(`budget exceeded for ${coordinate}: ${over}`);
    }
    // 3. Account one provider spend attempt (per-attendee + per-event `calls`).
    if (this.deps.budgets) {
      const now = this.now();
      if (pubkey) this.deps.store.addUsage(coordinate, pubkey, { calls: 1 }, now);
      else this.deps.store.addUsage(coordinate, "", { calls: 1 }, now);
    }
  }

  /** Re-enqueue budget/billing-parked work for a coordinate and clear the budget
   *  notification latch (H-2), so a raised budget or resolved payment resumes it. */
  private resumeParkedWork(coordinate: string): void {
    this.budgetNotified.delete(coordinate);
    const resumed = this.deps.store.resumeWaitingJobs(coordinate);
    if (resumed > 0) log(`[budget] ${coordinate}: resumed ${resumed} parked job(s)`);
  }

  /** Return a `budget_exceeded` reason string if any budget is already exceeded, else undefined. */
  private checkBudget(coordinate: string, pubkey?: string): string | undefined {
    const b = this.deps.budgets;
    if (!b) return undefined;
    const over = (limit: number, val: number) => limit > 0 && val >= limit;
    const ev = this.deps.store.getEventUsage(coordinate);
    if (over(b.perEventBytes, ev.bytes)) return `budget_exceeded: event bytes ${ev.bytes} ≥ ${b.perEventBytes}`;
    if (over(b.perEventDurationSec, ev.durationSec))
      return `budget_exceeded: event duration ${ev.durationSec}s ≥ ${b.perEventDurationSec}s`;
    if (over(b.perEventCalls, ev.calls)) return `budget_exceeded: event calls ${ev.calls} ≥ ${b.perEventCalls}`;
    if (pubkey) {
      const at = this.deps.store.getUsage(coordinate, pubkey);
      if (over(b.perAttendeeBytes, at.bytes)) return `budget_exceeded: attendee bytes ${at.bytes} ≥ ${b.perAttendeeBytes}`;
      if (over(b.perAttendeeDurationSec, at.durationSec))
        return `budget_exceeded: attendee duration ${at.durationSec}s ≥ ${b.perAttendeeDurationSec}s`;
      if (over(b.perAttendeeCalls, at.calls)) return `budget_exceeded: attendee calls ${at.calls} ≥ ${b.perAttendeeCalls}`;
    }
    return undefined;
  }

  /** Gift-wrap a 21606 budget_exceeded status to the event identity (H-2). */
  private async emitBudgetStatus(state: EventState, reason: string): Promise<void> {
    const status = buildCoordinatorStatus(this.deps.coordSk, state.eidPubkey, {
      v: 2,
      a: state.coordinate,
      stage: "budget",
      state: "poison",
      attempts: 0,
      error_category: "budget_exceeded",
      retryable: true,
      billing: { state: "payment_required", reason: reason.slice(0, 500) },
      at: Math.floor(this.now() / 1000),
    });
    await this.deps.transport.publish(status, this.accountRelays(state));
    log(`[budget] published 21606 budget_exceeded for ${state.coordinate}`);
  }

  /** Gift-wrap a 21606 billing status to the event identity on a state transition. */
  private async emitBillingStatus(
    state: EventState,
    next: BillingStateRow["state"],
    verdict: CoordinatorBilling,
    graceUntil: number | null,
  ): Promise<void> {
    // Map the internal state onto the frozen wire `billing` block (spec §9): the
    // wire has no "blocked" — a blocked event is `payment_required` on the wire.
    const billing: CoordinatorBilling =
      next === "blocked"
        ? {
            state: "payment_required",
            ...(verdict.reason ? { reason: verdict.reason } : {}),
            ...(verdict.checkout_url ? { checkout_url: verdict.checkout_url } : {}),
            ...(verdict.currency ? { currency: verdict.currency } : {}),
          }
        : next === "grace"
          ? {
              state: "grace",
              ...(verdict.reason ? { reason: verdict.reason } : {}),
              ...(graceUntil != null ? { grace_until: Math.floor(graceUntil / 1000) } : {}),
              ...(verdict.checkout_url ? { checkout_url: verdict.checkout_url } : {}),
            }
          : { state: "ok" };
    const status = buildCoordinatorStatus(this.deps.coordSk, state.eidPubkey, {
      v: 2,
      a: state.coordinate,
      billing,
      at: Math.floor(this.now() / 1000),
    });
    await this.deps.transport.publish(status, this.accountRelays(state));
    log(`[billing] published 21606 billing=${billing.state} for ${state.coordinate}`);
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
    const content: import("@nostrautica/protocol").CoordinatorStatusContent = {
      v: 2,
      a: coordinate,
      ...(pubkey ? { pubkey } : {}),
      stage: info.type,
      state: "poison",
      attempts: info.attempts,
      error_category: category,
      retryable: true,
      at: Math.floor(this.now() / 1000),
    };
    const status = buildCoordinatorStatus(this.deps.coordSk, state.eidPubkey, content);
    await this.deps.transport.publish(status, this.accountRelays(state));
    // Attendee-scoped delivery (NIP §6.3 21606): a poison report tied to a single
    // attendee's own submission/talk pipeline is ALSO sealed to that attendee, so
    // they see "your talk failed processing — try re-recording" without waiting on
    // the organizer. Billing/budget blocks stay organizer-only (emitted elsewhere,
    // never via surfacePoison), so every poison surfaced here is safe to mirror.
    if (pubkey) {
      const attendeeStatus = buildCoordinatorStatus(this.deps.coordSk, pubkey, content);
      await this.deps.transport.publish(attendeeStatus, this.accountRelays(state));
    }
    log(`[status] surfaced poisoned ${info.type} for ${pubkey ? short(pubkey) : coordinate}${pubkey ? " to organizer + attendee" : " to organizer"}`);
  }

  stop(): void {
    for (const c of this.closers) c();
    this.closers = [];
  }

  // expose for grant version bumping
  eckOf(coordinate: string): EckVersion[] {
    return this.events.get(coordinate)?.eck ?? [];
  }

  /** Test accessor: the event's live decoded-duration limits (audit C8) — the
   *  authoritative ffprobe-side caps that must track config reloads. */
  durationLimitsOf(coordinate: string): { maxMediaSec: number; maxIntroSec: number; maxTalkSec: number } | undefined {
    const s = this.events.get(coordinate);
    return s ? { maxMediaSec: s.maxMediaSec, maxIntroSec: s.maxIntroSec, maxTalkSec: s.maxTalkSec } : undefined;
  }

  /** Test accessor: the event's retention anchor `eventEndSec` (audit P9) — driven
   *  by the newest 31923 metadata revision. */
  eventEndSecOf(coordinate: string): number | undefined {
    return this.events.get(coordinate)?.eventEndSec;
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
    matches: list.matches.map((m) => ({
      ...m,
      reasoning: sanitizeLlmText(m.reasoning),
      // Icebreakers are LLM-authored too (NIP §6.2): same publish-boundary hygiene
      // as reasoning — length cap + URL neutralization so injected text can't
      // smuggle clickable links. Capped to ≤ 3 defensively.
      ...(m.icebreakers && m.icebreakers.length > 0
        ? { icebreakers: m.icebreakers.slice(0, 3).map((s) => sanitizeLlmText(s)) }
        : {}),
    })),
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
  // A provider stall (audit H-4) is distinct from a media-fetch timeout: it may
  // have left a Cashu reservation ambiguous and warrants provider-level attention.
  if (m.includes("provider timeout")) return "provider_timeout";
  if (m.includes("hash mismatch")) return "media_integrity";
  if (m.includes("fetch") || m.includes("blossom") || m.includes("network") || m.includes("timeout")) return "media_fetch";
  if (m.includes("ffmpeg") || m.includes("audio")) return "media_processing";
  if (m.includes("no handler")) return "internal";
  return "processing_error";
}
