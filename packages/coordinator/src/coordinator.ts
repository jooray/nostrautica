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
import {
  KIND_GIFT_WRAP,
  KIND_INVITE_LIST,
  KIND_JOIN_REQUEST,
  KIND_PROFILE_SUBMISSION,
  KIND_COORDINATOR_GRANT,
  KIND_ADMIN_COMMAND,
  KIND_DIRECTORY_ENTRY,
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
  parseEventConfig,
  parseCoordinate,
  type EckVersion,
  type AttendeeProfile,
  type MediaDescriptor,
  type RosterContent,
} from "@nostrautica/protocol";
import type { GiftWrap } from "@nostrautica/protocol";
import { Store } from "./store/db.js";
import { JobRunner } from "./pipeline/jobs.js";
import { InviteChecker, evaluateEntitlement } from "./pipeline/entitlement.js";
import { processAttendee } from "./pipeline/process.js";
import type { NostrPost } from "./pipeline/profile.js";
import {
  profileHash,
  scoreBatch,
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
  buildKeyGrant,
  type PublishKeys,
} from "./nostr/publisher.js";
import type { LlmProvider, SttProvider, ModelRef } from "./providers/types.js";

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
  defaultRelays: string[];
  prefilter?: PrefilterConfig;
  topK?: number;
  /** Candidates per batched match-scoring call (spec §16.2). Default 10. */
  batchSize?: number;
  /** Injectable RNG for deterministic candidate shuffling in tests. */
  matchRng?: () => number;
  fetchBlob?: (urls: string[], sha256: string) => Promise<Uint8Array>;
  /** Override the transcription stage (tests inject to skip Blossom/ffmpeg). */
  transcribe?: (descriptor: import("@nostrautica/protocol").MediaDescriptor) => Promise<string>;
  now?: () => number;
}

interface EventState {
  coordinate: string;
  eidPubkey: string;
  inboxSk: Uint8Array;
  eck: EckVersion[];
  configRelays: string[];
  nostrContextN: number;
  matchVisibility: "pair" | "event";
  scoringCtx: EventContextForScoring;
}

export class Coordinator {
  readonly jobs: JobRunner;
  private readonly coordPubkey: string;
  private readonly now: () => number;
  private readonly prefilter: PrefilterConfig;
  private readonly topK: number;
  private readonly batchSize: number;
  private readonly matchRng: () => number;
  private readonly inviteChecker: InviteChecker;
  private events = new Map<string, EventState>();
  private closers: Array<() => void> = [];

  constructor(private readonly deps: CoordinatorDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.coordPubkey = getPublicKey(deps.coordSk);
    this.prefilter = deps.prefilter ?? DEFAULT_PREFILTER;
    this.topK = deps.topK ?? 20;
    this.batchSize = deps.batchSize ?? 10;
    this.matchRng = deps.matchRng ?? Math.random;
    this.inviteChecker = new InviteChecker(deps.store);
    this.jobs = new JobRunner(deps.store, { now: this.now });
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
      const pairs = await this.selectPairs(p.coordinate, p.pubkey);
      if (!pairs.length) return;
      // Directions are scored from the target's side only (the host-voice reasoning
      // is addressed to the batch target). Each candidate therefore needs its own
      // candidate→target scoring: trigger a recompute for candidates whose reverse
      // direction is still unscored. Keys are content-addressed by the pair's
      // inputs_hash, so re-delivery dedupes and nothing loops (each pubkey gets at
      // most one recompute job per pair-inputs version).
      for (const pair of pairs) {
        const rev = this.deps.store.getPairDirection(p.coordinate, pair.b, pair.a);
        if (!rev || rev.inputs_hash !== pair.inputsHash || !rev.scored) {
          enqueue("match_recompute", `match:${p.coordinate}:${pair.b}:${pair.inputsHash}`, {
            coordinate: p.coordinate,
            pubkey: pair.b,
          });
        }
      }
      // Group the target's pending directed pairs into ≤K-candidate batches (one
      // target + ≤K candidates per LLM call — spec §16.2). Batching is a transport
      // optimization only: each batch job is deduped by its target+candidate-set
      // hash, and results are written per directed pair keyed by inputs_hash.
      const batches = groupIntoBatches(pairs, this.batchSize);
      log(`[match] ${short(p.pubkey)} → scoring ${pairs.length} directed pair(s) in ${batches.length} batch(es)`);
      for (const batch of batches) {
        const key = `batch:${p.coordinate}:${batch[0]!.a}:${batchDedupe(batch)}`;
        enqueue("score_batch", key, { coordinate: p.coordinate, pairs: batch });
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

    this.jobs.register("publish_matches", async (p) => {
      await this.publishMatchesJob(p.coordinate, p.pubkey);
    });
  }

  // ── install (21603) ────────────────────────────────────────────────────────
  async installEvent(grant: {
    coordinate: string;
    inboxSkHex: string;
    eck: EckVersion[];
    configRelays: string[];
  }): Promise<void> {
    const { pubkey: eidPubkey } = parseCoordinate(grant.coordinate);
    const relays = grant.configRelays.length ? grant.configRelays : this.deps.defaultRelays;

    // Load public config + event details for scoring context.
    const cfgEvents = await this.deps.transport.fetch(
      { kinds: [31600, 31923], authors: [eidPubkey], "#d": [parseCoordinate(grant.coordinate).identifier] },
      relays,
    );
    const cfgEvent = cfgEvents.find((e) => e.kind === 31600);
    const evtEvent = cfgEvents.find((e) => e.kind === 31923);
    const config = cfgEvent ? parseEventConfig(eidPubkey, cfgEvent.tags) : undefined;

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
      eidPubkey,
      inboxSk: hexToBytes(grant.inboxSkHex),
      eck: grant.eck,
      configRelays: relays,
      nostrContextN: config?.nostrContext ?? 0,
      matchVisibility: config?.matchVisibility ?? "pair",
      scoringCtx: {
        title: evtEvent?.tags.find((t) => t[0] === "title")?.[1] ?? "the event",
        summary: evtEvent?.tags.find((t) => t[0] === "summary")?.[1] ?? "",
        hashtags: (evtEvent?.tags ?? []).filter((t) => t[0] === "t").map((t) => t[1]!),
      },
    };
    this.events.set(grant.coordinate, state);
    log(
      `[install] event "${state.scoringCtx.title}" installed — nostr_context=${state.nostrContextN}, match_visibility=${state.matchVisibility}`,
    );
    log(`          coordinate ${grant.coordinate}`);
    // Subscribe to this event's E_inbox NOW (not only at startup), so an install
    // received while the daemon is already running starts receiving join requests
    // + submissions immediately — including any published before it was attached
    // (the subscription backfills with since = now − 3d).
    this.subscribeEventInbox(state);
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
  /** Handle a wrap addressed to the coordinator's own pubkey (install/admin). */
  async handleCoordinatorWrap(wrap: GiftWrap): Promise<void> {
    if (!this.deps.store.markRumorSeen(wrap.id, this.now())) return;
    let rumor;
    try {
      rumor = unwrapRumor(wrap, this.deps.coordSk);
    } catch {
      return;
    }
    if (!this.deps.store.markRumorSeen(rumor.id, this.now())) return;

    if (rumor.kind === KIND_COORDINATOR_GRANT) {
      const grant = coordinatorGrantContentSchema.parse(JSON.parse(rumor.content));
      await this.installEvent({
        coordinate: grant.a,
        inboxSkHex: grant.inbox_nsec,
        eck: grant.eck,
        configRelays: grant.config_relays,
      });
    } else if (rumor.kind === KIND_ADMIN_COMMAND) {
      const cmd = adminCommandContentSchema.parse(JSON.parse(rumor.content));
      log(`[admin] "${cmd.cmd}" from organizer ${short(rumor.pubkey)}`);
      await this.handleAdmin(rumor.pubkey, cmd.a, cmd.cmd, cmd.args);
    }
  }

  /** Handle a wrap addressed to an event's E_inbox (join / submission). */
  async handleInboxWrap(coordinate: string, wrap: GiftWrap): Promise<void> {
    const state = this.events.get(coordinate);
    if (!state) return;
    if (!this.deps.store.markRumorSeen(wrap.id, this.now())) return;
    let rumor;
    try {
      rumor = unwrapRumor(wrap, state.inboxSk);
    } catch {
      return;
    }
    if (!this.deps.store.markRumorSeen(rumor.id, this.now())) return;

    if (rumor.kind === KIND_JOIN_REQUEST) {
      const content = joinRequestContentSchema.parse(JSON.parse(rumor.content));
      log(`[join] request from ${short(rumor.pubkey)} ("${content.name}")`);
      await this.handleJoin(state, rumor.pubkey, rumor.tags, content.name);
    } else if (rumor.kind === KIND_PROFILE_SUBMISSION) {
      const content = profileSubmissionContentSchema.parse(JSON.parse(rumor.content));
      log(`[submission] from ${short(rumor.pubkey)} — ${content.media.length} media, ${content.profile.skills.length} skills`);
      await this.handleSubmission(state, rumor.pubkey, content.profile, content.media);
    }
  }

  private async handleJoin(
    state: EventState,
    attendeePubkey: string,
    tags: string[][],
    _name: string,
  ): Promise<void> {
    // Already approved (re-delivered join): nothing to do.
    const existing = this.deps.store.getAttendee(state.coordinate, attendeePubkey);
    if (existing?.status === "approved") return;

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
  ): Promise<void> {
    // Store the profile with its media descriptors stashed for the pipeline.
    this.deps.store.upsertAttendee({
      coordinate: state.coordinate,
      pubkey,
      profileJson: JSON.stringify({ ...profile, __media: media }),
      now: this.now(),
    });
    const attendee = this.deps.store.getAttendee(state.coordinate, pubkey);
    if (attendee?.status === "approved") {
      await this.publishDirectory(state, pubkey);
      this.enqueueProcess(state.coordinate, pubkey);
    }
  }

  /**
   * Enqueue the AI pipeline for an attendee, keyed by a hash of their current
   * profile+media so a changed submission reprocesses while re-delivery of the
   * same submission is deduped (never re-billed).
   */
  private enqueueProcess(coordinate: string, pubkey: string): void {
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
    // The AI pipeline is kicked off when a profile submission arrives (there is
    // nothing to transcribe/profile until then). Directory text is already visible.
    if (this.deps.store.getAttendee(state.coordinate, attendeePubkey)?.profile_json) {
      this.enqueueProcess(state.coordinate, attendeePubkey);
    }
  }

  private parseStoredProfile(attendee: any): { profile: AttendeeProfile; media: MediaDescriptor[] } {
    const raw = attendee?.profile_json ? JSON.parse(attendee.profile_json) : {};
    const media = (raw.__media ?? []) as MediaDescriptor[];
    const profile: AttendeeProfile = {
      about: raw.about ?? "",
      skills: raw.skills ?? [],
      looking_for: raw.looking_for ?? "",
      links: raw.links ?? [],
    };
    return { profile, media };
  }

  private async publishDirectory(state: EventState, pubkey: string): Promise<void> {
    const attendee = this.deps.store.getAttendee(state.coordinate, pubkey);
    const { profile, media } = this.parseStoredProfile(attendee);
    const aiProfile = attendee?.ai_profile_json ? JSON.parse(attendee.ai_profile_json) : undefined;
    const entry = buildDirectoryEntry(this.publishKeys(state), state.coordinate, {
      v: 1,
      pubkey,
      profile,
      media,
      ...(aiProfile ? { ai_profile: aiProfile } : {}),
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
    const attendee = this.deps.store.getAttendee(coordinate, pubkey);
    if (!attendee) return;
    const { profile, media } = this.parseStoredProfile(attendee);
    log(`[pipeline] ${short(pubkey)}: transcribe ${media.length} media → nostr-context → ai_profile…`);

    const aiProfile = await processAttendee(
      {
        store: this.deps.store,
        stt: this.deps.stt,
        sttModel: this.deps.sttModel,
        llm: this.deps.llm,
        summaryModel: this.deps.summaryModel,
        matchModel: this.deps.matchModel,
        fetchBlob: this.deps.fetchBlob,
        transcribe: this.deps.transcribe,
        fetchNostrContext: (pk, n) => this.fetchNostrContext(state, pk, n),
        nostrContextN: state.nostrContextN,
        now: this.now,
      },
      { pubkey, profile, media },
    );

    this.deps.store.upsertAttendee({
      coordinate,
      pubkey,
      aiProfileJson: JSON.stringify(aiProfile),
      profileHash: profileHash(aiProfile),
      now: this.now(),
    });
    await this.publishDirectory(state, pubkey);
    log(`[pipeline] ${short(pubkey)} ai_profile ready — skills: ${aiProfile.skills.slice(0, 4).join(", ")}`);
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

  private async attachEmbeddings(coordinate: string, roster: AttendeeForMatching[]): Promise<void> {
    if (!this.deps.llm.embed) return;
    const texts = roster.map((a) => {
      const attendee = this.deps.store.getAttendee(coordinate, a.pubkey);
      const ai = attendee?.ai_profile_json ? JSON.parse(attendee.ai_profile_json) : {};
      return `${ai.summary ?? ""} ${(ai.skills ?? []).join(" ")} ${(ai.interests ?? []).join(" ")}`;
    });
    const embeddings = await this.deps.llm.embed(texts, this.deps.embedModel.model);
    roster.forEach((a, i) => (a.embedding = embeddings[i]));
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
    if (!state || pairs.length === 0) return { scored: [], missing: 0 };
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
      candidates.push({ id: p.b, profile });
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

  private loadAiProfile(coordinate: string, pubkey: string) {
    const attendee = this.deps.store.getAttendee(coordinate, pubkey);
    return attendee?.ai_profile_json ? JSON.parse(attendee.ai_profile_json) : undefined;
  }

  private async publishMatchesJob(coordinate: string, pubkey: string): Promise<void> {
    const state = this.events.get(coordinate);
    if (!state) return;
    const list = buildMatchList(this.deps.store, coordinate, pubkey, this.topK, Math.floor(this.now() / 1000));
    if (list.matches.length === 0) return;
    const event = buildMatchListEvent(this.publishKeys(state), coordinate, pubkey, list);
    await this.deps.transport.publish(event, state.configRelays);
    log(`[match] published list for ${short(pubkey)} — ${list.matches.length} match(es)`);
  }

  // ── admin commands (21604) ─────────────────────────────────────────────────
  private async handleAdmin(
    from: string,
    coordinate: string,
    cmd: "approve" | "recompute" | "reprocess" | "revoke",
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
      if (attendee && attendee.status !== "approved") {
        this.deps.store.upsertAttendee({ coordinate, pubkey, status: "approved", now: this.now() });
        log(`[approve] organizer approved ${short(pubkey)}`);
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

    // 3. Re-grant the new ECK to every remaining attendee and republish content.
    for (const a of this.deps.store.approvedAttendees(state.coordinate)) {
      const grant = buildKeyGrant(this.deps.coordSk, state.coordinate, a.pubkey, state.eck);
      await this.deps.transport.publish(grant, state.configRelays);
      await this.publishDirectory(state, a.pubkey);
    }
    await this.publishRoster(state);
  }

  // ── context fetch ───────────────────────────────────────────────────────────
  private async fetchInviteHashes(state: EventState): Promise<Set<string>> {
    const events = await this.deps.transport.fetch(
      { kinds: [KIND_INVITE_LIST], authors: [state.eidPubkey], "#d": [parseCoordinate(state.coordinate).identifier] },
      state.configRelays,
    );
    const latest = events.sort((a, b) => b.created_at - a.created_at)[0];
    if (!latest) return new Set();
    try {
      const parsed = inviteListContentSchema.parse(JSON.parse(latest.content));
      return new Set(parsed.invites.map((i) => i.h));
    } catch {
      return new Set();
    }
  }

  /** Fetch kind-0 + last N public posts (kinds 1, 6, 30023; reposts resolved). */
  async fetchNostrContext(state: EventState, pubkey: string, n: number): Promise<NostrPost[]> {
    if (n <= 0) return [];
    const events = await this.deps.transport.fetch(
      { kinds: [KIND_NOTE, KIND_REPOST, KIND_LONGFORM, KIND_PROFILE], authors: [pubkey], limit: n },
      state.configRelays,
    );
    return events
      .filter((e) => e.kind !== KIND_PROFILE)
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, n)
      .map((e) => ({ kind: e.kind, content: e.content, created_at: e.created_at }));
  }

  // ── event loop ──────────────────────────────────────────────────────────────
  /** Subscribe to the coordinator inbox and all installed events; run jobs. */
  async start(): Promise<void> {
    // Restore installed events from the store.
    for (const row of this.deps.store.allEvents()) {
      await this.installEvent({
        coordinate: row.coordinate,
        inboxSkHex: row.inbox_nsec,
        eck: this.eckFromStore(row.coordinate),
        configRelays: JSON.parse(row.config_relays),
      });
    }

    const coordCloser = this.subscribeCoordInbox();
    this.closers.push(coordCloser);
    // Note: installEvent() already subscribes each event's inbox (idempotently),
    // so restored events are covered by the loop above.
  }

  private subscribedInboxes = new Set<string>();

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

  private subscribeEventInbox(state: EventState): void {
    if (this.subscribedInboxes.has(state.coordinate)) return; // idempotent
    this.subscribedInboxes.add(state.coordinate);
    const closer = (this.deps.transport as any).subscribe?.(
      { kinds: [KIND_GIFT_WRAP], "#p": [getPublicKey(state.inboxSk)], since: giftwrapSince() },
      (e: NostrEvent) => void this.handleInboxWrap(state.coordinate, e as unknown as GiftWrap).catch(() => {}),
      state.configRelays,
    );
    if (closer) this.closers.push(closer);
    log(`[sub] listening on E_inbox for ${state.scoringCtx.title}`);
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
