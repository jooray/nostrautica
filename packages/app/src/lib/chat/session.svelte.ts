/**
 * One shared, event-scoped Marmot session for the whole app shell.
 *
 * Why this exists: enrolment used to start only when the Chat tab mounted. The
 * coordinator adds a member by consuming the kind-30443 key package they
 * advertise (`chat/client.ts` → coordinator `chat/admin.ts` syncMember /
 * handleKeyPackageEvent), so "publish the key package on first Chat open" means
 * the MLS Add happens *at first open*. MLS is forward-secret: everything said
 * before that Add is unreadable, and the new member watches "Setting up your
 * secure chat…" while the coordinator catches up — so the first thing an
 * attendee sees in chat is an empty room, and any announcement posted between
 * their approval and their first click is lost to them for good.
 *
 * So the session is hoisted out of the page: the layout prewarms it as soon as
 * the shell resolves an approved member on a chat-enabled event (see
 * `shouldPrewarmChat` in gate.ts), from whichever event page they happen to be
 * on. The key package goes out then, the coordinator's Add and the welcome land
 * while they browse People/Talks, live 445 traffic is ingested into the durable
 * history in the background, and opening Chat paints a populated room.
 *
 * The page (EventChat.svelte) binds to this store rather than owning a client,
 * so navigating in and out of Chat no longer tears the session down and rebuilds
 * it. Lifetime is the event: leaving the event's routes (or logging out)
 * disposes it; group state and message history stay in IndexedDB.
 */
import type { EventContext } from "$lib/events/event-context.js";
import type { AppSigner } from "$lib/signer/types.js";
import type { ChatMessage } from "./messages.js";
import type { MarmotChat } from "./client.js";
import {
  ChatTabCoordinator,
  type ChatAction,
  type LeaderStatus,
  type TabRole,
  type TabCoordinatorOptions,
} from "./tab-leader.js";
import { foldChatTimeline, type ChatTimelineItem } from "./timeline.js";
import { warmChatTab } from "./warm.js";

/** Test-only override; production always constructs the real coordinator. */
let coordinatorFactory: ((opts: TabCoordinatorOptions) => ChatTabCoordinator) | undefined;
const makeCoordinator = (opts: TabCoordinatorOptions): ChatTabCoordinator =>
  coordinatorFactory ? coordinatorFactory(opts) : new ChatTabCoordinator(opts);

/**
 * `setup` — client is up, no group yet (waiting on the coordinator's Add +
 * welcome). `ready` — joined; the room is usable. `error` — the handshake threw.
 */
/**
 * `evicted` is the state MLS makes possible and nothing in the UI could express:
 * a Remove strips our leaf but leaves our local group state — and its decrypted
 * history — exactly where it was. So "do we hold a group?" still answers yes, the
 * room rendered `ready` with its old messages on screen, and the only symptoms
 * were that nothing new ever decrypted and a send failed. A reader who does not
 * send sees a quiet room and no explanation at all.
 */
/**
 * `unreachable` (audit U-1) is "we cannot tell yet": the roster did not arrive or
 * would not decrypt, a group failed to load, or routing refuses a binding it
 * cannot confirm. It is NOT eviction. Its remedy is to retry the read (which
 * never attests while membership is unknown), and it never offers Rejoin:
 * every Rejoin is a guaranteed visible kick (audit K-6).
 */
export type ChatSessionPhase = "idle" | "setup" | "unreachable" | "ready" | "evicted" | "error";

/** What a Rejoin press did (audit K-6). */
export type RejoinOutcome =
  /** Revoke + fresh key package + re-attest sent (or a waiting re-add joined). */
  | "requested"
  /** Membership is not positively lost, so nothing was sent (only `force` overrides). */
  | "skipped"
  /** Pressed again inside the cooldown; nothing was sent. */
  | "rate-limited";

/** Minimum gap between two Rejoin requests (audit K-6): each one burns a key package and kicks. */
export const REJOIN_COOLDOWN_MS = 60_000;
/** How often an unreachable or damaged session re-checks on its own. */
const RECHECK_INTERVAL_MS = 30_000;
/**
 * How many times a session positively waiting for its Add re-publishes its key
 * package on its own (audit KIMIK31 W-5): ~5 minutes at the interval above.
 * Bounded so a coordinator that never adds this device is not polled forever.
 */
const MAX_SETUP_RECHECKS = 10;

/**
 * This device is POSITIVELY not in the event's room (audit K-6): its leaf is gone
 * from the room it holds, or the room the roster names is one it holds no state
 * for. Distinct from a send that failed on the wire, and from a membership we
 * merely could not confirm: only this one is fixed by Rejoin (which revokes the
 * device, rotates its key package and re-attests: an MLS epoch change and a
 * roster republish, quite the wrong price for a dropped socket).
 */
export class ChatUnroutableError extends Error {
  constructor() {
    super("this device is not in the event's chat group");
    this.name = "ChatUnroutableError";
  }
}

/**
 * A proxied failure keeps its type across tabs (audit KIMIK31 W-4): the leader
 * acks a ChatUnroutableError with code "unroutable", and the follower rebuilds
 * it, so the UI offers Rejoin rather than a transport retry.
 */
function rethrowTyped(err: unknown): never {
  if ((err as { code?: string } | null)?.code === "unroutable") throw new ChatUnroutableError();
  throw err;
}

class ChatSessionStore {
  /** The event this session belongs to (undefined when idle). */
  naddr = $state<string | undefined>(undefined);
  #phase = $state<ChatSessionPhase>("idle");
  /**
   * The room's phase. A setter so that EVERY change on the leader tab reaches
   * the follower tabs (audit KIMIK31 W-4), whichever of the many paths made it.
   */
  get phase(): ChatSessionPhase {
    return this.#phase;
  }
  set phase(next: ChatSessionPhase) {
    if (next === this.#phase) return;
    this.#phase = next;
    this.announceStatus();
  }
  /** A follower has received the leader's status, which is then authoritative (W-4). */
  private leaderStatusSeen = false;
  error = $state<unknown>(null);
  /** Every decoded message, de-duped by rumor id and chronologically sorted. */
  messages = $state<ChatMessage[]>([]);
  /**
   * Device pubkeys that actually hold a leaf in this event's MLS group, or
   * `undefined` while that is genuinely unknown (no group yet; a follower tab
   * before the leader's first broadcast).
   *
   * The member list was derived purely from the roster's `chat_keys` — from who
   * ATTESTED — which lists devices whose Add never landed and keeps listing
   * members whose leaf has been removed. This is the group's own answer. Only the
   * leader tab can compute it (it owns the client); followers receive it over the
   * same BroadcastChannel that carries messages.
   */
  memberDevices = $state<string[] | undefined>(undefined);
  /** Our own chat identity pubkey (marks "my" bubbles); set once the client exists. */
  chatPubkey = $state<string | undefined>(undefined);
  /**
   * What the room shows: one line per kind 9 with its reactions, edit and
   * deletion folded in (timeline.ts). `messages` stays the raw list, because
   * that is what follower tabs are sent and a modifier can land before its
   * target.
   */
  timeline: ChatTimelineItem[] = $derived(foldChatTimeline(this.messages, this.chatPubkey));
  /** Reactive by reference only — never deep-proxy the marmot client. */
  chat = $state.raw<MarmotChat | undefined>(undefined);
  /** This tab's multi-tab role (H-7). Only the leader owns a live client. */
  tabRole = $state<TabRole>("pending");
  /**
   * True when this tab is a follower that cannot send — either Web Locks is
   * unavailable (no single-writer guarantee) or the leader tab is on a different
   * event. The UI shows a read-only "chat is active in another tab" notice.
   */
  readOnly = $state(false);
  /** A re-enrolment ({@link rejoin}) is in flight — the UI disables its button. */
  rejoining = $state(false);
  /** Wall-clock ms before which another Rejoin press is refused (audit K-6). */
  rejoinBlockedUntil = $state(0);
  /**
   * A group this device holds on disk failed to load (audit K-3). It is kept and
   * re-tried, never discarded; meanwhile membership cannot be judged.
   */
  #damaged = $state(false);
  get damaged(): boolean {
    return this.#damaged;
  }
  set damaged(next: boolean) {
    if (next === this.#damaged) return;
    this.#damaged = next;
    this.announceStatus();
  }

  /** Leader: mirror phase + damage to follower tabs (W-4). */
  private announceStatus(): void {
    if (this.tabRole !== "leader" || !this.ctx) return;
    this.coordinator?.broadcastStatus(this.ctx.coordinate, this.leaderStatus());
  }

  private leaderStatus(): LeaderStatus {
    return { phase: this.#phase, damaged: this.#damaged };
  }

  /** Follower: adopt the leader's status for this event (W-4). */
  private adoptLeaderStatus(status: LeaderStatus): void {
    const phases: ChatSessionPhase[] = ["setup", "unreachable", "ready", "evicted"];
    if (!phases.includes(status.phase as ChatSessionPhase)) return;
    this.leaderStatusSeen = true;
    this.#phase = status.phase as ChatSessionPhase;
    this.#damaged = status.damaged;
  }
  /**
   * Events of this room that could not be decrypted or applied yet (audit R-9):
   * "re-syncing, some messages may be missing". A fork or stall, never a reason
   * to offer Rejoin.
   */
  resyncing = $state(0);
  private recheckTimer?: ReturnType<typeof setTimeout>;
  /** Setup re-publishes made since this session began (W-5). */
  private setupRechecks = 0;
  /** The multi-tab coordinator (leader election + follower proxy). */
  private coordinator?: ChatTabCoordinator;
  /**
   * The coordinator this session currently holds. Test-visible so a test can
   * assert the one property that broke in production: a promotion from follower
   * to leader must KEEP this object, because disposing it releases the Web Lock
   * and two tabs then trade leadership forever.
   */
  get __coordinatorForTests(): ChatTabCoordinator | undefined {
    return this.coordinator;
  }

  /** Guards against a superseded start (event switch / logout) writing state. */
  private token = 0;
  /** In-flight startup, so concurrent `ensure` callers share one handshake. */
  private starting?: Promise<void>;
  /** Kept for `retry()`. */
  private ctx?: EventContext;
  private signer?: AppSigner;
  private owner?: string | null;

  /**
   * Start (or adopt) the session for `naddr`. Idempotent and safe to call from
   * both the layout prewarm and the Chat page: concurrent calls for the same
   * event + account share the single in-flight handshake, and a call for an
   * already-running session is a no-op.
   */
  async ensure(
    naddr: string,
    ctx: EventContext,
    signer: AppSigner,
    owner: string | null,
  ): Promise<void> {
    if (this.naddr === naddr && this.owner === owner && (this.chat || this.coordinator || this.starting)) {
      await this.starting;
      return;
    }
    this.dispose();
    this.naddr = naddr;
    this.ctx = ctx;
    this.signer = signer;
    this.owner = owner;
    await this.begin();
  }

  private async begin(): Promise<void> {
    const tok = ++this.token;
    // Retire any coordinator from a prior begin() (retry) before electing afresh.
    this.coordinator?.dispose();
    this.coordinator = undefined;
    this.tabRole = "pending";
    this.readOnly = false;
    this.leaderStatusSeen = false;
    this.setupRechecks = 0;
    const ctx = this.ctx;
    const signer = this.signer;
    if (!ctx || !signer) return;
    // Warm the Chat screen's DISPLAY data (sender/member kind-0s) now, from the
    // event page the prewarm fires on — not when the page mounts. Without it the
    // room's first paint is a wall of truncated pubkeys that become names one
    // relay round-trip later. Detached and self-deduping: it must never delay or
    // fail the handshake below (see warm.ts).
    warmChatTab(ctx);
    this.phase = "setup";
    this.error = null;
    const run = (async () => {
      // Multi-tab leadership (H-7): exactly one tab per account owns the live client
      // and all MLS mutation; other tabs proxy through a BroadcastChannel. Scope the
      // election to the account so two tabs never mutate the shared per-identity
      // IndexedDB MLS state concurrently.
      const scope = this.owner ?? (await signer.getPublicKey());
      if (tok !== this.token) return;
      const coordinator = makeCoordinator({
        scope,
        onRoleChange: (role) => {
          if (tok !== this.token) return;
          const wasFollower = this.tabRole === "follower";
          this.tabRole = role;
          this.recomputeReadOnly();
          // Promotion needs a CLIENT, not just a role. The follower branch of
          // begin() returns having constructed none, so when the leader tab closed
          // and this one inherited the lock, nothing re-ran it: the composer was
          // re-enabled and phase stayed "ready", `send()` threw "no chat session",
          // and — worse than the visible error — no live client existed anywhere in
          // this browser profile, so no 445 traffic was ingested and no Welcome was
          // joined until a manual reload.
          //
          // Build it IN PLACE on the coordinator we already hold. Calling begin()
          // here instead — which the first version of this fix did — disposes that
          // coordinator, and disposing releases the Web Lock we were just promoted
          // into. With two tabs open both doing it, they trade the lock back and
          // forth forever: each release promotes the other, each promotion tears
          // down and re-elects, and the room flickers between "setting up" and
          // "ready" several times a second. Reported from a real two-tab session.
          if (role === "leader" && wasFollower && !this.chat) {
            void this.promote(tok, coordinator, ctx, signer);
          }
        },
        onLeaderState: (coordinate, messages) => {
          if (tok !== this.token) return;
          // BEFORE the coordinate filter (audit R-31): a leader that moved to
          // another event announces it with exactly the broadcast filtered out
          // below, and returning first left this follower interactive, proxying
          // its sends into the other event's group.
          this.recomputeReadOnly();
          // Follower render: adopt the leader's de-duped, sorted list wholesale.
          if (coordinate !== ctx.coordinate) return;
          this.messages = messages;
          // A leader that reports its status is the authority on the phase; a
          // message list says nothing about whether this device is still in the
          // room (W-4). Only a leader on the previous build, which sends no
          // status, still promotes the room from its messages.
          if (this.phase !== "ready" && !this.leaderStatusSeen) this.phase = "ready";
        },
        onLeaderStatus: (coordinate, status) => {
          if (tok !== this.token) return;
          if (coordinate !== ctx.coordinate) return;
          this.adoptLeaderStatus(status);
        },
        onLeaderMembers: (coordinate, members) => {
          if (tok !== this.token) return;
          this.recomputeReadOnly(); // same reason as onLeaderState (R-31)
          // Real MLS membership, computed by the tab that holds the client. A
          // follower has no group state of its own, so without this its member
          // list would silently fall back to the roster — the very thing this
          // whole path replaces.
          if (coordinate !== ctx.coordinate) return;
          this.memberDevices = members;
        },
        onSendRequest: async (text, coordinate) => {
          // Leader executes a follower's proxied send on the real client — only
          // for the event that client serves (R-31). A request with no coordinate
          // comes from a tab on the previous build and keeps the old behaviour.
          if (!this.chat) throw new Error("no chat session");
          if (coordinate && coordinate !== this.ctx?.coordinate) {
            throw new Error("the active tab is in a different event's chat");
          }
          // Through the leader's own send path (W-4), so a failure is reconciled
          // the same way and a positive eviction comes back as ChatUnroutableError.
          await this.send(text);
        },
        onActionRequest: async (action, coordinate) => {
          if (!this.chat) throw new Error("no chat session");
          if (coordinate && coordinate !== this.ctx?.coordinate) {
            throw new Error("the active tab is in a different event's chat");
          }
          await this.act(action); // reconciled like a local action (W-4)
        },
        onRejoinRequest: async (force, coordinate) => {
          // Leader performs a follower's rejoin: MLS state has a single writer, so
          // the tab that owns the client is the only one that may re-enrol.
          if (!this.chat) throw new Error("no chat session");
          if (coordinate && coordinate !== this.ctx?.coordinate) {
            throw new Error("the active tab is in a different event's chat");
          }
          await this.rejoin({ force });
        },
        onSyncRequest: () => {
          if (tok !== this.token) return;
          coordinator.broadcastState(ctx.coordinate, this.messages);
          // A freshly-joined follower asks for a snapshot; membership is part of
          // that snapshot, or the new tab renders an empty/roster-only member list
          // until the next MLS state change (which may be minutes away in a quiet
          // room).
          if (this.memberDevices) coordinator.broadcastMembers(ctx.coordinate, this.memberDevices);
          // …and so is the room's status (W-4): a new follower must not assume "ready".
          if (this.chat) coordinator.broadcastStatus(ctx.coordinate, this.leaderStatus());
        },
      });
      this.coordinator = coordinator;
      await coordinator.whenSettled;
      if (tok !== this.token) {
        coordinator.dispose();
        return;
      }

      if (coordinator.role !== "leader") {
        // Follower: construct NO client. Resolve our own chat pubkey (a cheap
        // IndexedDB read, no MLS client) so "my" bubbles still highlight, and render
        // from the leader's broadcasts. The room is "ready" — it shows the leader's
        // messages, or the active-in-another-tab notice when read-only.
        const { resolveChatIdentity } = await import("./identity.js");
        const id = await resolveChatIdentity(signer).catch(() => undefined);
        if (tok !== this.token) return;
        this.chatPubkey = id?.pubkey;
        this.recomputeReadOnly();
        // The leader's status, if it already arrived, outranks this default (W-4).
        if (!this.leaderStatusSeen) this.phase = "ready";
        return;
      }

      await this.becomeLeaderClient(tok, coordinator, ctx, signer);
    })();
    this.starting = run
      .catch((e) => {
        if (tok !== this.token) return;
        this.error = e;
        this.phase = "error";
      })
      .finally(() => {
        if (tok === this.token) this.starting = undefined;
      });
    await this.starting;
  }

  /**
   * Build and start the live client for a tab that owns the leader lock.
   *
   * Called from `begin()` when this tab wins the election outright, and from the
   * role-change handler when it is promoted later. Deliberately takes the
   * coordinator it should use rather than reading `this.coordinator`: the
   * promotion path must keep the coordinator (and therefore the LOCK) it was
   * promoted into, and must never tear it down to re-elect.
   */
  private async becomeLeaderClient(
    tok: number,
    coordinator: ChatTabCoordinator,
    ctx: EventContext,
    signer: AppSigner,
  ): Promise<void> {
    if (tok !== this.token || this.chat) return;
    // A promotion arrives while the room is already rendering "ready" off the
    // departed leader's last broadcast. Do not drop it back to "setup" — the
    // messages on screen are still the right ones, and flipping the phase for the
    // duration of a client build is exactly the flicker this path is fixing.
    const { MarmotChat } = await import("./client.js");
    const chat = await MarmotChat.create({ accountSigner: signer, ctx });
    if (tok !== this.token || this.chat) {
      chat.dispose();
      return;
    }
    this.chat = chat;
    this.chatPubkey = chat.identity.pubkey;
    this.recomputeReadOnly();
    // Coalesced per microtask (audit DS41-054). Opening a room replays its whole
    // history synchronously through onMessage, and each message used to cost a
    // full copy + sort of the list AND a structured clone of it to every follower
    // tab: quadratic in the room's size, on the screen attendees use most. One
    // burst is now one merge and one broadcast; a lone live message is unchanged.
    let pending: ChatMessage[] = [];
    chat.onMessage = (m) => {
      if (tok !== this.token) return;
      pending.push(m);
      if (pending.length > 1) return; // a flush is already scheduled
      queueMicrotask(() => {
        const batch = pending;
        pending = [];
        if (tok !== this.token) return;
        // Mirror the fresh list to follower tabs.
        if (this.ingest(batch)) coordinator.broadcastState(ctx.coordinate, this.messages);
      });
    };
    chat.onStateChange = () => {
      if (tok !== this.token) return;
      void this.syncPhase(tok);
      // Membership changes ARE state changes — an Add, a Remove, or our own
      // eviction all arrive here as a new epoch. Re-read the group rather than
      // trusting the roster, which the coordinator republishes on its own schedule.
      void this.syncMembers(tok, coordinator, ctx.coordinate);
    };
    this.coordinatorForRecheck = coordinator;
    // First v2 chat session: best-effort retire the account's legacy 31602
    // chat-device-key backup (NIP §7.5). Leader-only + once-per-account gated, so
    // followers don't duplicate it. Fire-and-forget — never blocks the handshake.
    void import("./legacy-cleanup.js")
      .then(({ deleteLegacyChatDeviceKeyBackup }) =>
        deleteLegacyChatDeviceKeyBackup(signer, ctx.config.relays),
      )
      .catch(() => {});
    // Bind the room first (audit S-5): a member's room is usable as soon as its
    // group is confirmed, and its history replays in the background. Then decide
    // whether this device needs enrolling at all — ensurePublished publishes and
    // attests only on a positive "not a member" (audit K-2) — and listen for the
    // welcome that follows. A welcome arriving in between is joined by the
    // listener start() installed.
    //
    // Liveness is re-checked after every await (audit KIMIK31 W-2): a logout that
    // lands while start() waits on the relays disposes this session, and
    // ensurePublished must not then publish and attest as the account just signed
    // out of.
    await chat.start();
    if (tok !== this.token) return;
    await this.syncPhase(tok);
    await this.syncMembers(tok, coordinator, ctx.coordinate);
    if (tok !== this.token) return;
    await chat.ensurePublished();
    if (tok !== this.token) return;
    await this.syncPhase(tok);
  }

  /** Retry timer for a failed follower → leader promotion (W-6). */
  private promoteTimer?: ReturnType<typeof setTimeout>;

  /**
   * Build the client for a promoted tab, and recover if that fails (audit
   * KIMIK31 W-6). The promotion used to be fire-and-forget: a rejected dynamic
   * import, locked identity, `create`, `start` or `ensurePublished` escaped as
   * an unhandled rejection and left the room "ready" with no client, so no
   * traffic was ingested anywhere in the profile and `send()` threw "no chat
   * session" until a reload. Now a failure drops any half-built client, shows
   * the retryable "can't reach the room" state (never an eviction), and tries
   * again on the SAME coordinator, so the Web Lock this tab was promoted into is
   * kept rather than traded away by a re-election.
   */
  private async promote(
    tok: number,
    coordinator: ChatTabCoordinator,
    ctx: EventContext,
    signer: AppSigner,
  ): Promise<void> {
    try {
      await this.becomeLeaderClient(tok, coordinator, ctx, signer);
    } catch (err) {
      if (tok !== this.token) return;
      console.warn("chat: taking over as the active tab failed; retrying", err);
      this.chat?.dispose();
      this.chat = undefined;
      this.error = err;
      this.phase = "unreachable";
      clearTimeout(this.promoteTimer);
      this.promoteTimer = setTimeout(() => {
        this.promoteTimer = undefined;
        if (tok !== this.token || this.chat || coordinator.role !== "leader") return;
        void this.promote(tok, coordinator, ctx, signer);
      }, RECHECK_INTERVAL_MS);
    }
  }

  /** The coordinator a recheck broadcasts membership on (the leader's). */
  private coordinatorForRecheck?: ChatTabCoordinator;

  /**
   * Re-read what could not be read (audit U-1 "Retry", and the automatic retry
   * while unreachable or damaged): re-try loading damaged groups, re-run the
   * membership verdict, re-sync phase and members. It never attests on an
   * unknown verdict: ensurePublished publishes only on a positive not-member,
   * which is exactly the case where enrolling is the right thing to do.
   */
  async recheck(): Promise<void> {
    const chat = this.chat;
    if (!chat) {
      await this.retry();
      return;
    }
    const tok = this.token;
    await Promise.resolve()
      .then(() => chat.recheckDamaged())
      .catch(() => undefined);
    if (tok !== this.token) return;
    await chat.ensurePublished().catch((err: unknown) => console.warn("chat: recheck failed", err));
    if (tok !== this.token) return;
    await this.syncPhase(tok);
    const coordinator = this.coordinatorForRecheck;
    if (coordinator && this.ctx) await this.syncMembers(tok, coordinator, this.ctx.coordinate);
  }

  /**
   * Keep re-checking on our own while the room is unreachable or damaged, and
   * (bounded) while positively waiting for our Add (W-5). Only a POSITIVE
   * not-member counts: an unknown verdict never leads to a publish here.
   */
  private scheduleRecheck(tok: number): void {
    const verdict = this.chat?.lastVerdict;
    const awaitingAdd =
      this.phase === "setup" &&
      verdict?.kind === "not-member" &&
      !verdict.evicted &&
      this.setupRechecks < MAX_SETUP_RECHECKS;
    const needed = this.phase === "unreachable" || this.damaged || awaitingAdd;
    if (!needed) {
      clearTimeout(this.recheckTimer);
      this.recheckTimer = undefined;
      return;
    }
    if (this.recheckTimer) return;
    this.recheckTimer = setTimeout(() => {
      this.recheckTimer = undefined;
      if (tok !== this.token) return;
      if (awaitingAdd && this.phase === "setup") void this.recheckSetup(tok);
      else void this.recheck();
    }, RECHECK_INTERVAL_MS);
  }

  /**
   * Setup has been waiting on the coordinator's Add (W-5). Enrolment publishes
   * the key package once, ignoring relay outcomes, so an outage could leave it
   * on no relay while the attestation sat in the outbox; when connectivity came
   * back the attestation drained but nothing republished the package, and the
   * room stayed "Setting up…" until a reload. Re-verify it (republishing if it
   * is missing), without a fresh attestation, then re-read the phase.
   */
  private async recheckSetup(tok: number): Promise<void> {
    const chat = this.chat;
    if (!chat) return;
    this.setupRechecks++;
    await chat
      .ensurePublished({ attest: false })
      .catch((err: unknown) => console.warn("chat: setup recheck failed", err));
    if (tok !== this.token) return;
    await this.syncPhase(tok);
  }

  /**
   * Leader: re-read who actually holds a leaf in this event's group and mirror it
   * to follower tabs. `undefined` (no group state, or a state we can't walk) is
   * left as-is rather than published as "nobody" — an empty room is a claim, and
   * the wrong one during setup.
   */
  private async syncMembers(
    tok: number,
    coordinator: ChatTabCoordinator,
    coordinate: string,
  ): Promise<void> {
    // Wrapped rather than `?.groupMemberPubkeys().catch(…)`: a client that throws
    // SYNCHRONOUSLY (an older/partial double, a torn-down client) would otherwise
    // escape as an unhandled rejection out of a listener nobody awaits. Membership
    // is decoration; it must never be able to take the session down.
    const devices = await Promise.resolve()
      .then(() => this.chat?.groupMemberPubkeys())
      .catch(() => undefined);
    if (tok !== this.token || !devices) return;
    this.memberDevices = devices;
    coordinator.broadcastMembers(coordinate, devices);
  }

  /** De-dupe by inner rumor id, keep chronological order (Bug 4 echo-safe).
   *  Returns whether anything new was added. The sort is stable, so messages with
   *  the same `createdAt` keep their arrival order, as when they came one by one. */
  private ingest(batch: ChatMessage[]): boolean {
    const ids = new Set(this.messages.map((x) => x.id));
    const fresh: ChatMessage[] = [];
    for (const m of batch) {
      if (ids.has(m.id)) continue;
      ids.add(m.id);
      fresh.push(m);
    }
    if (fresh.length === 0) return false;
    this.messages = [...this.messages, ...fresh].sort((a, b) => a.createdAt - b.createdAt);
    return true;
  }

  /** A follower is read-only unless the Web Locks leader is serving THIS event. */
  private recomputeReadOnly(): void {
    const c = this.coordinator;
    if (!c || c.role === "leader") {
      this.readOnly = false;
      return;
    }
    this.readOnly = !(c.usingWebLocks && c.leaderCoordinate === this.ctx?.coordinate);
  }

  /**
   * MEMBERSHIP, not merely state, decides whether the room is usable.
   *
   * This used to be `nostrGroupId()` alone — "do I hold a group for this event?" —
   * which a removed member answers yes to forever, because MLS leaves their local
   * state and decrypted history untouched when their leaf goes. They got a `ready`
   * room full of old messages where nothing new ever arrived.
   *
   * An unreadable member list is left alone deliberately: `undefined` means "we
   * could not tell", and demoting a working room on a state shape we failed to
   * walk would be the same mistake in the other direction.
   */
  private async syncPhase(tok: number): Promise<void> {
    const chat = this.chat;
    if (!chat) return;
    this.damaged = (chat.damagedGroupIds?.() ?? []).length > 0;
    this.resyncing = chat.syncIssueCount?.() ?? 0;
    const gid = await chat.nostrGroupId().catch(() => undefined);
    if (tok !== this.token) return;
    if (!gid) {
      // Not routable. Which of "connecting" and "can't reach the room" this is
      // depends on whether we KNOW we are not in it yet (audit U-1): a positive
      // not-member is waiting on the coordinator's Add, which is Connecting; a
      // verdict we could not reach (roster unreadable, a damaged group, a
      // binding routing will not confirm) is Unreachable, and is retried.
      const verdict = chat.lastVerdict;
      if (verdict?.kind === "not-member" && verdict.evicted) this.phase = "evicted";
      else if (this.damaged || verdict?.kind === "unknown" || verdict?.kind === "member") this.phase = "unreachable";
      else if (this.phase !== "evicted") this.phase = "setup";
      this.scheduleRecheck(tok);
      return;
    }
    const members = await Promise.resolve()
      .then(() => chat.groupMemberPubkeys())
      .catch(() => undefined);
    if (tok !== this.token) return;
    const me = chat.identity.pubkey;
    this.phase = members && me && !members.includes(me) ? "evicted" : "ready";
    this.scheduleRecheck(tok);
  }

  /** Re-run the handshake from scratch (the page's "Try again"). */
  async retry(): Promise<void> {
    if (!this.ctx || !this.signer) return;
    clearTimeout(this.recheckTimer);
    this.recheckTimer = undefined;
    this.chat?.dispose();
    this.chat = undefined;
    this.chatPubkey = undefined;
    this.messages = [];
    this.memberDevices = undefined;
    await this.begin();
  }

  async send(text: string): Promise<void> {
    // Leader owns the client and sends directly.
    if (this.chat) {
      try {
        await this.chat.send(text);
      } catch (err) {
        // Two different failures used to arrive here as one. A send fails either
        // because this session no longer holds a routable group for the event
        // (removed, evicted, or a binding the roster contradicts) or because the
        // publish did not reach a relay. `phase` had latched `ready` and never
        // moved back, leaving an enabled composer over a session that cannot send
        // — demote it when the group really is gone, so the room reads as "setting
        // up" again and the rejoin affordance applies.
        //
        // The distinction is worth carrying to the caller: the remedy offered for a
        // failed send is Rejoin, which revokes this device, rotates its key package
        // and re-attests — an MLS epoch change and a roster republish. That is the
        // right price for a lost membership and quite the wrong one for a dropped
        // socket.
        if (await this.demoteIfUnroutable()) throw new ChatUnroutableError();
        throw err;
      }
      return;
    }
    // Interactive follower proxies the send to the leader tab (Web Locks path only).
    const c = this.coordinator;
    if (c && c.role === "follower" && !this.readOnly) {
      await c.proxySend(text, this.ctx?.coordinate).catch(rethrowTyped);
      return;
    }
    throw new Error("no chat session");
  }

  /**
   * Toggle this device's `emoji` on a message: retract it when we already
   * reacted with it, add it otherwise. Per emoji, so a second emoji is added
   * alongside the first, as MDK allows; Android's own toggle reaches the same
   * wire events.
   */
  async toggleReaction(messageId: string, emoji: string): Promise<void> {
    const item = this.timeline.find((m) => m.id === messageId);
    if (!item || item.deleted) return;
    const own = item.reactions.find((r) => r.emoji === emoji && r.ownIds.length > 0);
    await this.act(own ? { type: "retract", ids: [...own.ownIds] } : { type: "react", target: messageId, emoji });
  }

  /** Edit one of this device's own messages. Others' messages are refused here,
   *  as every receiving client would refuse the edit anyway. */
  async editMessage(messageId: string, content: string): Promise<void> {
    const item = this.ownLiveMessage(messageId);
    const text = content.trim();
    if (!text || text === item.content) return;
    await this.act({ type: "edit", target: messageId, content: text });
  }

  /** Delete one of this device's own messages (kind 5). */
  async deleteMessage(messageId: string): Promise<void> {
    this.ownLiveMessage(messageId);
    await this.act({ type: "retract", ids: [messageId] });
  }

  private ownLiveMessage(messageId: string): ChatTimelineItem {
    const item = this.timeline.find((m) => m.id === messageId);
    if (!item || item.deleted || !this.chatPubkey || item.pubkey !== this.chatPubkey) {
      throw new Error("only your own messages can be changed");
    }
    return item;
  }

  /** Same routing as {@link send}: the leader's client, or a proxy to it. */
  private async act(action: ChatAction): Promise<void> {
    if (this.chat) {
      try {
        await this.runAction(action);
      } catch (err) {
        if (await this.demoteIfUnroutable()) throw new ChatUnroutableError();
        throw err;
      }
      return;
    }
    const c = this.coordinator;
    if (c && c.role === "follower" && !this.readOnly) {
      await c.proxyAction(action, this.ctx?.coordinate).catch(rethrowTyped);
      return;
    }
    throw new Error("no chat session");
  }

  private async runAction(action: ChatAction): Promise<void> {
    const chat = this.chat;
    if (!chat) throw new Error("no chat session");
    if (action.type === "react") await chat.react(action.target, action.emoji);
    else if (action.type === "edit") await chat.edit(action.target, action.content);
    else await chat.retract(action.ids);
  }

  /** Leader, after a failed send: RECONCILE before concluding anything (audit
   *  K-6). Returns whether this device is positively out of the room (the
   *  membership problem Rejoin exists for), as opposed to a transport failure or
   *  a membership we could not confirm.
   *
   *  "Unroutable" used to mean `nostrGroupId()` was undefined, which a slow
   *  roster read or a damaged group also produces, and the remedy then offered
   *  was Rejoin: a guaranteed kick for a member who was never out. Now a missing
   *  route asks the full membership verdict; only a positive not-member counts,
   *  and anything we could not tell becomes `unreachable` (retried, no Rejoin). */
  private async demoteIfUnroutable(): Promise<boolean> {
    const chat = this.chat;
    if (!chat) return false;
    const tok = this.token;
    const gid = await chat.nostrGroupId().catch(() => undefined);
    if (tok !== this.token) return false;
    if (!gid) {
      const verdict = await Promise.resolve()
        .then(() => chat.membershipVerdict())
        .catch(() => ({ kind: "unknown", reason: "roster-unavailable" }) as const);
      if (tok !== this.token) return false;
      chat.lastVerdict = verdict;
      if (verdict.kind === "not-member") {
        if (verdict.evicted) this.phase = "evicted";
        else if (this.phase === "ready") this.phase = "setup";
        // Positively not in: the ordinary bootstrap is the heal (it attests).
        void chat.ensurePublished().catch(() => undefined);
        return true;
      }
      this.phase = "unreachable";
      this.scheduleRecheck(tok);
      return false;
    }
    // Holding a group is not being in it (audit DS41-052): a removed member keeps
    // the group state, so `gid` resolves while every send fails. Ask about the
    // LEAF, as syncPhase does — and, like it, leave an unreadable member list
    // (undefined) alone rather than demote a room we could not inspect.
    const members = await Promise.resolve()
      .then(() => this.chat?.groupMemberPubkeys())
      .catch(() => undefined);
    const me = this.chat?.identity.pubkey;
    if (!members || !me || members.includes(me)) return false;
    if (this.phase === "ready") this.phase = "evicted";
    return true;
  }

  /**
   * Re-enrol this device into the event's chat (the UI's "Rejoin" action) — see
   * `MarmotChat.rejoin`. Idempotent-ish: a session that can still route is left
   * alone, so pressing it on a healthy room does nothing.
   *
   * A follower tab cannot do this itself (only the leader owns MLS state), so it
   * asks the leader over the same BroadcastChannel that carries proxied sends. A
   * read-only follower has no leader to ask and throws, exactly like `send`.
   */
  async rejoin(opts?: { force?: boolean }): Promise<RejoinOutcome> {
    if (this.rejoining) return "rate-limited";
    // Rate-limited (audit K-6): every request revokes this device, burns a key
    // package and makes the coordinator remove + re-add it — two visible
    // membership changes for everyone in the room. Repeated presses only repeat
    // that, and can race their own revokes.
    if (Date.now() < this.rejoinBlockedUntil) return "rate-limited";
    this.rejoining = true;
    try {
      if (this.chat) {
        const tok = this.token;
        const before = this.phase;
        this.phase = "setup";
        const outcome = await this.chat.rejoin(opts);
        if (outcome === "requested") this.rejoinBlockedUntil = Date.now() + REJOIN_COOLDOWN_MS;
        else if (tok === this.token) this.phase = before;
        await this.syncPhase(tok);
        return outcome;
      }
      const c = this.coordinator;
      if (c && c.role === "follower" && !this.readOnly) {
        await c.proxyRejoin(opts?.force ?? false, this.ctx?.coordinate);
        this.rejoinBlockedUntil = Date.now() + REJOIN_COOLDOWN_MS;
        return "requested";
      }
      throw new Error("no chat session");
    } finally {
      this.rejoining = false;
    }
  }

  /**
   * Tear the session down unless it is already the one for `naddr` — called by
   * the layout on every route change, so the session survives navigation within
   * the event and dies when the user leaves it (or switches account/logs out).
   */
  releaseUnless(naddr: string | undefined, owner: string | null): void {
    if (this.naddr === undefined) return;
    if (naddr !== undefined && this.naddr === naddr && this.owner === owner) return;
    this.dispose();
  }

  /** Drop live resources and reset to idle. Persisted state is untouched. */
  dispose(): void {
    this.token++;
    this.starting = undefined;
    clearTimeout(this.recheckTimer);
    this.recheckTimer = undefined;
    clearTimeout(this.promoteTimer);
    this.promoteTimer = undefined;
    this.coordinatorForRecheck = undefined;
    this.damaged = false;
    this.resyncing = 0;
    // Release leadership so another tab can take over immediately.
    this.coordinator?.dispose();
    this.coordinator = undefined;
    this.tabRole = "pending";
    this.readOnly = false;
    this.chat?.dispose();
    this.chat = undefined;
    this.chatPubkey = undefined;
    this.messages = [];
    this.memberDevices = undefined;
    this.phase = "idle";
    this.error = null;
    this.naddr = undefined;
    this.ctx = undefined;
    this.signer = undefined;
    this.owner = undefined;
  }
}

export const chatSession = new ChatSessionStore();

/**
 * Swap the multi-tab coordinator factory (tests only), the same seam
 * `__setMarmotKvBackendForTests` and `__setPersistBackend` give their modules.
 *
 * Leader election is the thing worth testing here and it is unreachable
 * otherwise: `ChatTabCoordinator` falls back to a single-tab ping election when
 * `navigator.locks` is absent, which it always is under the node test
 * environment — so without this, every test tab is trivially the leader and the
 * promotion path cannot be exercised at all.
 */
export function __setChatCoordinatorFactoryForTests(
  factory: ((opts: TabCoordinatorOptions) => ChatTabCoordinator) | null,
): void {
  coordinatorFactory = factory ?? undefined;
}
