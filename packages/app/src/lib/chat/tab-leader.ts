/**
 * Multi-tab leader election + follower proxy for Marmot chat (H-7, MULTIDEVICE-CHAT §8).
 *
 * Two tabs in ONE browser profile are one device sharing one IndexedDB MLS state
 * store (`stores.ts`, namespaced per chat identity). If both constructed a
 * `MarmotClient` they'd mutate that shared store concurrently — the classic MLS
 * concurrent-commit hazard (two ingests/commits forking the same epoch), which
 * corrupts group state for every joined group of that identity, not just the event
 * on screen. So exactly ONE tab per account may own a live client.
 *
 * This coordinator elects that leader with the Web Locks API (a held exclusive
 * lock per account): the tab holding the lock is the leader and constructs the
 * client; the rest are followers that construct NO client and instead render from,
 * and proxy sends through, a `BroadcastChannel`. When the leader tab closes or
 * crashes the browser releases its lock and a waiting follower is promoted (it then
 * builds a fresh client from the shared IndexedDB state).
 *
 * Fallbacks, in order:
 *  - No Web Locks, but `BroadcastChannel`: ping election — a tab that hears an
 *    existing leader becomes a follower; otherwise it leads. Two tabs that ping at
 *    the same moment can both settle as leader, so leaders keep resolving it after
 *    settlement (audit KIMIK31 W-7): every leader says `leader-hello` on election
 *    and as a periodic heartbeat, carrying its tab id and start time, and a leader
 *    that hears a higher-ranked one demotes itself (see {@link outranks}). The
 *    session tears its client down on that demotion. Followers proxy sends as on
 *    the Web Locks path, addressed to the leader they last heard, so a request
 *    that reaches two leaders during the conflict window still runs only once.
 *    A follower whose leader misses three heartbeats re-runs the election, so a
 *    closed leader tab is replaced as the lock would replace it.
 *  - Neither: single leader (legacy single-tab behaviour).
 *
 * The Web Locks manager and channel are injected so the election/proxy logic is
 * unit-testable without a real browser; production defaults to the globals. Real
 * dual-context (two actual tabs / crash-takeover) behaviour needs the e2e phase.
 */
import type { ChatMessage } from "./messages.js";

/** The subset of `LockManager` (navigator.locks) this coordinator uses. */
export interface LockManagerLike {
  request(
    name: string,
    options: { mode?: "exclusive" | "shared"; ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: unknown | null) => Promise<unknown>,
  ): Promise<unknown>;
}

/** The subset of `BroadcastChannel` this coordinator uses. */
export interface BroadcastChannelLike {
  postMessage(msg: unknown): void;
  addEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
  close(): void;
}

export type TabRole = "pending" | "leader" | "follower";

/**
 * A modifier sent on an existing message (timeline.ts folds them). Proxied to the
 * leader like a send, since only the leader owns MLS state. `retract` names
 * event ids (a message, or the reactions an un-react withdraws).
 */
export type ChatAction =
  | { type: "react"; target: string; emoji: string }
  | { type: "edit"; target: string; content: string }
  | { type: "retract"; ids: string[] };

/**
 * The leader's room status, mirrored to followers (audit KIMIK31 W-4). Without
 * it a follower adopted "ready" from the first message broadcast and kept it,
 * so when the coordinator removed this device the leader tab showed Rejoin and
 * the follower, where the user actually was, stayed "ready" and offered a
 * transport retry for every failed send.
 */
export interface LeaderStatus {
  /** The leader session's phase (a `ChatSessionPhase`). */
  phase: string;
  damaged: boolean;
}

/** Broadcast wire protocol — {send request, ack, message list update, membership update} + election pings. */
type Wire =
  // `id`/`since`/`locked`: who is speaking, for post-settlement conflict resolution
  // (W-7). Sent on election, in answer to `who-leads`, and as a heartbeat. Absent
  // from a tab on a build before W-7, which never yields and is never yielded to.
  | { t: "leader-hello"; scope: string; id?: string; since?: number; locked?: boolean }
  | { t: "who-leads"; scope: string }
  | { t: "sync"; scope: string }
  | { t: "state"; scope: string; coordinate: string; messages: ChatMessage[] }
  | { t: "members"; scope: string; coordinate: string; members: string[] }
  | { t: "status"; scope: string; coordinate: string; status: LeaderStatus }
  // `coordinate`: the event the FOLLOWER is in (audit R-31). Optional so a tab
  // still running the previous build interoperates until it reloads.
  // `to`: the leader tab the request is for (W-7, ping path only), so that while two
  // tabs both believe they lead, one request is not run twice. Absent: any leader.
  | { t: "send"; scope: string; reqId: string; text: string; coordinate?: string; to?: string }
  | { t: "rejoin"; scope: string; reqId: string; force?: boolean; coordinate?: string; to?: string }
  | { t: "action"; scope: string; reqId: string; action: ChatAction; coordinate?: string; to?: string }
  // `code`: a machine-readable failure kind (W-4), so a follower can rebuild the
  // leader's typed error ("unroutable" → ChatUnroutableError) rather than show a
  // generic transport failure. Absent from a tab on the previous build.
  | { t: "ack"; scope: string; reqId: string; ok: boolean; error?: string; code?: string };

export interface TabCoordinatorOptions {
  /** Election scope — the account (chat identity) pubkey. One leader per scope. */
  scope: string;
  /** Injected Web Locks manager; defaults to `navigator.locks`. `null` disables it. */
  locks?: LockManagerLike | null;
  /** Injected channel factory; defaults to `new BroadcastChannel(name)`. Return `null` if unavailable. */
  createChannel?: (name: string) => BroadcastChannelLike | null;
  /** Role transitions (pending→leader/follower, follower→leader on takeover). */
  onRoleChange(role: TabRole): void;
  /** Follower: the leader broadcast a fresh message list for `coordinate`. */
  onLeaderState?(coordinate: string, messages: ChatMessage[]): void;
  /** Follower: the leader broadcast a fresh membership set for `coordinate`. */
  onLeaderMembers?(coordinate: string, members: string[]): void;
  /** Follower: the leader broadcast its room status for `coordinate` (W-4). */
  onLeaderStatus?(coordinate: string, status: LeaderStatus): void;
  /** Leader: a follower proxied a send; resolve to ack ok, throw to ack error. */
  onSendRequest?(text: string, coordinate?: string): Promise<void>;
  /** Leader: a follower proxied a reaction/edit/delete; resolve/throw to ack. */
  onActionRequest?(action: ChatAction, coordinate?: string): Promise<void>;
  /** Leader: a follower asked for a chat re-enrolment; resolve/throw to ack. */
  onRejoinRequest?(force: boolean, coordinate?: string): Promise<void>;
  /** Leader: a freshly-joined follower asked for the current state — re-broadcast it. */
  onSyncRequest?(): void;
  /** Election ping window (ms) when Web Locks is unavailable. */
  pingWindowMs?: number;
  /** Ack timeout (ms) for a proxied send. */
  ackTimeoutMs?: number;
  /** Ack timeout (ms) for a proxied rejoin — a multi-publish handshake, not one send. */
  rejoinTimeoutMs?: number;
  /** Leader heartbeat interval (ms), the bound on detecting a second leader (W-7). */
  heartbeatMs?: number;
  /** This tab's id (tests); defaults to a random one. */
  tabId?: string;
  /** This tab's start time in ms (tests); defaults to `Date.now()`. */
  startedAt?: number;
}

/** A leader's identity on the wire, for ranking two leaders (W-7). */
export interface LeaderRank {
  id: string;
  since: number;
  locked: boolean;
}

/**
 * Whether leader `a` keeps leadership over leader `b` (W-7). A Web Locks holder
 * always wins: its leadership is guaranteed and it never demotes. Otherwise the
 * tab that started first wins, and equal start times fall to the smaller id.
 * Every tab computes the same answer from the same two hellos, whatever order
 * they arrive in.
 */
export function outranks(a: LeaderRank, b: LeaderRank): boolean {
  if (a.locked !== b.locked) return a.locked;
  if (a.since !== b.since) return a.since < b.since;
  return a.id < b.id;
}

/**
 * Ping-election window per round, and how many silent rounds it takes to lead
 * (audit R-10). It was one 300 ms window: a leader that was merely busy for
 * 300 ms lost its followers to a second leader. 2 × 1.5 s only delays the
 * fallback path (no Web Locks, or a rejected lock request).
 */
const DEFAULT_PING_WINDOW_MS = 1500;
const PING_ROUNDS = 2;
/**
 * Leader heartbeat (W-7): one small `leader-hello` per leader tab per interval;
 * followers only listen. It bounds how long two ping-path leaders that missed
 * each other's election hello can coexist. On the Web Locks path it is inert.
 */
const DEFAULT_HEARTBEAT_MS = 4000;
/**
 * Heartbeats a ping-path follower lets its leader miss before it re-runs the
 * election (W-7 follow-up): ~12 s at the default. One missed beat is a busy or
 * throttled tab, not a dead one; it must not be usurped for that.
 */
const MISSED_BEATS_BEFORE_TAKEOVER = 3;

function randomTabId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function defaultLocks(): LockManagerLike | null {
  if (typeof navigator !== "undefined" && "locks" in navigator) {
    return (navigator as unknown as { locks: LockManagerLike }).locks;
  }
  return null;
}
function defaultChannel(name: string): BroadcastChannelLike | null {
  if (typeof BroadcastChannel !== "undefined") return new BroadcastChannel(name);
  return null;
}

/**
 * Strip Svelte `$state` (and any other) Proxies down to plain structured-clone-
 * able `ChatMessage` values. Nested `tags` arrays are re-spread too — a Proxy
 * tag row is enough to make the whole `postMessage` throw.
 */
export function plainChatMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map((m) => ({
    id: m.id,
    pubkey: m.pubkey,
    kind: m.kind,
    content: m.content,
    createdAt: m.createdAt,
    tags: (m.tags ?? []).map((row) => [...row]),
  }));
}

export class ChatTabCoordinator {
  role: TabRole = "pending";
  /** Whether leadership is guaranteed single-writer (Web Locks path). Off it, followers are read-only. */
  get usingWebLocks(): boolean {
    return !!this.locks && !this.lockRequestFailed;
  }
  /**
   * The Web Locks request itself rejected, so this tab fell back to the ping
   * election (SB-102). From then on it behaves exactly like a tab that never had
   * Web Locks: no single-writer guarantee, read-only as a follower.
   */
  private lockRequestFailed = false;
  /** The coordinate the leader is currently serving, as seen by a follower (for read-only detection). */
  leaderCoordinate: string | undefined;
  /** This tab's identity in the election (W-7). */
  readonly tabId: string;
  readonly startedAt: number;
  /** Follower, ping path: the leader tab proxied requests are addressed to (W-7). */
  private leaderId: string | undefined;
  private heartbeat?: ReturnType<typeof setInterval>;
  private readonly heartbeatMs: number;

  private readonly scope: string;
  private readonly locks: LockManagerLike | null;
  private readonly channel: BroadcastChannelLike | null;
  private readonly opts: TabCoordinatorOptions;
  private readonly pingWindowMs: number;
  private readonly ackTimeoutMs: number;
  private readonly rejoinTimeoutMs: number;

  /** Resolves once the role first settles (leader or follower) — awaited by the session. */
  readonly whenSettled: Promise<void>;
  private settle!: () => void;
  private settled = false;

  private stopHolding?: () => void; // resolve the held-lock promise to release leadership
  private takeoverAbort?: AbortController;
  private readonly pending = new Map<string, { resolve: () => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
  private reqSeq = 0;
  private disposed = false;
  private readonly onMessage = (ev: { data: unknown }) => this.handleWire(ev.data as Wire);

  constructor(opts: TabCoordinatorOptions) {
    this.opts = opts;
    this.scope = opts.scope;
    this.locks = opts.locks !== undefined ? opts.locks : defaultLocks();
    const makeChannel = opts.createChannel ?? defaultChannel;
    this.channel = makeChannel(`nostrautica-chat:${opts.scope}`);
    this.pingWindowMs = opts.pingWindowMs ?? DEFAULT_PING_WINDOW_MS;
    this.ackTimeoutMs = opts.ackTimeoutMs ?? 8000;
    // A rejoin is revoke-publish → key-package rotate+publish → attest-publish →
    // join, i.e. several relay round-trips; the send timeout would fire mid-way and
    // report a failure over work that is still running (and will succeed).
    this.rejoinTimeoutMs = opts.rejoinTimeoutMs ?? 45_000;
    this.heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.tabId = opts.tabId ?? randomTabId();
    this.startedAt = opts.startedAt ?? Date.now();
    this.whenSettled = new Promise<void>((res) => (this.settle = res));
    this.channel?.addEventListener("message", this.onMessage);
    void this.elect();
  }

  // ── election ────────────────────────────────────────────────────────────────
  private async elect(): Promise<void> {
    if (this.locks) return this.electWithLocks();
    return this.electWithPing();
  }

  /** Web Locks: hold an exclusive lock; holding it == being the leader. */
  private electWithLocks(): Promise<void> {
    const name = `nostrautica-chat-leader:${this.scope}`;
    // ifAvailable probe that ALSO holds on success: lock===null ⇒ contended ⇒
    // follower (and we queue a blocking request to take over when the leader dies);
    // a non-null lock ⇒ we won it ⇒ leader, held until we release.
    void this.locks!
      .request(name, { mode: "exclusive", ifAvailable: true }, async (lock) => {
        // `dispose()` may already have run while this request was queued — the
        // callback is async and fires whenever the browser gets to it. Without this
        // guard the lock was held for the LIFETIME OF THE TAB with no leader behind
        // it: `becomeLeader()` returns early when disposed, but the hold below is
        // unconditional, and `dispose()` had already called (and cleared)
        // `stopHolding`, so nothing was left to resolve it. Every later coordinator
        // in that tab then probed `ifAvailable`, got null, became a follower, and
        // its `queueTakeover` blocked forever — chat went permanently leaderless in
        // the whole browser profile until the tab was closed. Reachable from
        // `chatSession.retry()`, which disposes and rebuilds, and from a route
        // change that disposes before this callback fires.
        //
        // `queueTakeover`'s own callback has always had this check; this one did not.
        if (this.disposed) return;
        if (lock === null) {
          this.becomeFollower();
          this.queueTakeover(name);
          return;
        }
        this.becomeLeader();
        await new Promise<void>((res) => (this.stopHolding = res));
      })
      .catch(() => {
        // A locks failure shouldn't strand chat, but it is not evidence that no
        // other tab holds the lock either: leading unconditionally here could put
        // a second MarmotClient on the shared MLS store next to a live leader
        // (audit SB-102). Ask the other tabs instead, as a tab without Web Locks
        // would — a leader answers the ping, and only silence makes us lead.
        if (this.settled || this.disposed) return;
        this.lockRequestFailed = true;
        void this.electWithPing();
      });
    return Promise.resolve();
  }

  /** Block on the lock; the callback fires only once a prior leader releases it. */
  private queueTakeover(name: string): void {
    this.takeoverAbort = new AbortController();
    void this.locks!
      .request(name, { mode: "exclusive", signal: this.takeoverAbort.signal }, async () => {
        if (this.disposed) return;
        this.becomeLeader();
        await new Promise<void>((res) => (this.stopHolding = res));
      })
      .catch(() => {
        /* aborted on dispose (or an inheritor won) — no takeover */
      });
  }

  /** No Web Locks: ask if anyone leads; lead if nobody answers within the window. */
  private async electWithPing(): Promise<void> {
    if (!this.channel) {
      // Nothing to coordinate with — assume a single tab and lead.
      this.becomeLeader();
      return;
    }
    // Two pings, each with its own window, before concluding nobody leads (audit
    // R-10). A leader busy in a long synchronous stretch (a history replay, an MLS
    // commit) can miss one short window, and a wrong "nobody leads" puts a second
    // MarmotClient on the shared IndexedDB MLS store: a local fork. A leader-hello
    // in either window settles this tab as a follower (handleWire).
    for (let round = 0; round < PING_ROUNDS; round++) {
      this.channel.postMessage({ t: "who-leads", scope: this.scope } satisfies Wire);
      await new Promise<void>((res) => setTimeout(res, this.pingWindowMs));
      if (this.disposed || this.settled) return;
    }
    // Heard no leader-hello in any window → lead.
    this.becomeLeader();
  }

  private becomeLeader(): void {
    if (this.disposed || this.role === "leader") return;
    this.role = "leader";
    this.opts.onRoleChange("leader");
    this.sayHello();
    this.startHeartbeat();
    this.markSettled();
  }

  /** This tab's rank as a leader (W-7). */
  private rank(): LeaderRank {
    return { id: this.tabId, since: this.startedAt, locked: this.usingWebLocks };
  }

  private sayHello(): void {
    const { id, since, locked } = this.rank();
    this.channel?.postMessage({ t: "leader-hello", scope: this.scope, id, since, locked } satisfies Wire);
  }

  private startHeartbeat(): void {
    if (!this.channel || this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      if (this.role === "leader" && !this.disposed) this.sayHello();
    }, this.heartbeatMs);
  }

  private stopHeartbeat(): void {
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  /**
   * A settled leader heard a higher-ranked leader (W-7): step down. Ping path
   * only, where nothing else guarantees a single writer; a Web Locks holder never
   * gets here. The session sees `follower` and tears its client down.
   */
  private demote(winner: string): void {
    if (this.disposed || this.role !== "leader") return;
    this.stopHeartbeat();
    this.role = "follower";
    this.leaderId = winner;
    this.opts.onRoleChange("follower");
    // Re-snapshot from the winner: its messages, members and status replace ours.
    this.channel?.postMessage({ t: "sync", scope: this.scope } satisfies Wire);
    this.startWatchdog();
  }

  /** A leader-hello heard once settled (W-7). */
  private onPeerLeader(msg: Extract<Wire, { t: "leader-hello" }>): void {
    if (msg.id === undefined || msg.since === undefined || msg.id === this.tabId) return;
    const peer: LeaderRank = { id: msg.id, since: msg.since, locked: !!msg.locked };
    if (this.role === "follower") {
      this.leaderAlive();
      // Address proxied requests to the leader heard last. In a conflict the
      // loser's hellos stop when it demotes and the winner answers it, so this
      // settles on the winner.
      this.leaderId = peer.id;
      return;
    }
    if (this.role !== "leader" || this.usingWebLocks) return;
    if (outranks(peer, this.rank())) {
      this.demote(peer.id);
    } else {
      // We win. Say so now rather than at our next heartbeat, so the peer demotes
      // on this message even if it never saw our election hello.
      this.sayHello();
    }
  }

  private becomeFollower(): void {
    if (this.disposed || this.role === "follower") return;
    this.role = "follower";
    this.opts.onRoleChange("follower");
    // Ask the current leader for a snapshot so we render immediately, not only from
    // the next live message onward.
    this.channel?.postMessage({ t: "sync", scope: this.scope } satisfies Wire);
    this.startWatchdog();
    this.markSettled();
  }

  /** When this follower last heard from a leader (any leader-hello or broadcast). */
  private lastLeaderSeen = 0;
  private watchdog?: ReturnType<typeof setInterval>;
  private reelecting = false;

  /**
   * Ping path only: notice a leader that has gone silent and re-run the election
   * (W-7 follow-up). On the Web Locks path the browser hands the lock to a waiting
   * follower when the leader's tab dies; off it nothing did, so a closed or
   * crashed leader left every other tab a follower of nobody until a reload.
   *
   * Only a leader known to heartbeat is watched: one that announced an id. A
   * leader on a build before W-7 never heartbeats and never yields, so taking
   * over from it would make a second leader that the conflict rule cannot fix.
   */
  private startWatchdog(): void {
    if (this.usingWebLocks || !this.channel || this.watchdog) return;
    this.lastLeaderSeen = Date.now();
    this.watchdog = setInterval(() => {
      if (this.disposed || this.role !== "follower" || this.leaderId === undefined) return;
      if (Date.now() - this.lastLeaderSeen <= this.heartbeatMs * MISSED_BEATS_BEFORE_TAKEOVER) return;
      void this.reelect();
    }, this.heartbeatMs);
  }

  private stopWatchdog(): void {
    clearInterval(this.watchdog);
    this.watchdog = undefined;
  }

  /**
   * The leader went silent: ask again, exactly as a new tab does, and lead only
   * if nobody answers. Two followers that notice together can both get here and
   * both lead; the leader-hello conflict rule (`outranks`) then demotes one of
   * them, as for any two ping-path leaders.
   */
  private async reelect(): Promise<void> {
    if (this.reelecting) return;
    this.reelecting = true;
    const heardAt = this.lastLeaderSeen;
    try {
      for (let round = 0; round < PING_ROUNDS; round++) {
        this.channel?.postMessage({ t: "who-leads", scope: this.scope } satisfies Wire);
        await new Promise<void>((res) => setTimeout(res, this.pingWindowMs));
        if (this.disposed || this.role !== "follower") return;
        // A leader spoke after all (merely slow, or another follower took over).
        if (this.lastLeaderSeen !== heardAt) return;
      }
      this.stopWatchdog();
      this.becomeLeader();
    } finally {
      this.reelecting = false;
    }
  }

  /** Follower: a leader is alive (W-7 follow-up). */
  private leaderAlive(): void {
    this.lastLeaderSeen = Date.now();
  }

  private markSettled(): void {
    if (this.settled) return;
    this.settled = true;
    this.settle();
  }

  // ── wire handling ─────────────────────────────────────────────────────────
  private handleWire(msg: Wire): void {
    if (!msg || typeof msg !== "object" || (msg as Wire).scope !== this.scope) return;
    switch (msg.t) {
      case "who-leads":
        // A ping-election tab is probing — answer if we lead.
        if (this.role === "leader") this.sayHello();
        return;
      case "leader-hello":
        // Someone leads. In the ping fallback (not yet settled), become a follower.
        if (!this.usingWebLocks && !this.settled) {
          if (msg.id !== undefined) this.leaderId = msg.id;
          this.becomeFollower();
          return;
        }
        // Settled: a second leader is a conflict to resolve, not to ignore (W-7).
        this.onPeerLeader(msg);
        return;
      case "sync":
        // A freshly-joined follower wants the current snapshot — the session
        // re-broadcasts its live state/membership.
        if (this.role === "leader") this.opts.onSyncRequest?.();
        return;
      case "state":
        if (this.role === "follower") {
          this.leaderAlive();
          this.leaderCoordinate = msg.coordinate;
          this.opts.onLeaderState?.(msg.coordinate, msg.messages);
        }
        return;
      case "members":
        if (this.role === "follower") {
          this.leaderAlive();
          this.leaderCoordinate = msg.coordinate;
          this.opts.onLeaderMembers?.(msg.coordinate, msg.members);
        }
        return;
      case "status":
        if (this.role === "follower") {
          this.leaderAlive();
          this.leaderCoordinate = msg.coordinate;
          this.opts.onLeaderStatus?.(msg.coordinate, msg.status);
        }
        return;
      case "send":
        if (this.isAddressedLeader(msg.to)) void this.handleSendRequest(msg.reqId, msg.text, msg.coordinate);
        return;
      case "action":
        if (this.isAddressedLeader(msg.to)) {
          void this.runForFollower(msg.reqId, () => this.opts.onActionRequest?.(msg.action, msg.coordinate));
        }
        return;
      case "rejoin":
        if (this.isAddressedLeader(msg.to)) {
          void this.runForFollower(msg.reqId, () => this.opts.onRejoinRequest?.(msg.force ?? false, msg.coordinate));
        }
        return;
      case "ack": {
        const p = this.pending.get(msg.reqId);
        if (!p) return;
        this.pending.delete(msg.reqId);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve();
        else p.reject(Object.assign(new Error(msg.error ?? "proxied send failed"), msg.code ? { code: msg.code } : {}));
        return;
      }
    }
  }

  /** Leader: is a follower request (addressed to `to`, or to any leader) ours to run? */
  private isAddressedLeader(to: string | undefined): boolean {
    return this.role === "leader" && (to === undefined || to === this.tabId);
  }

  private handleSendRequest(reqId: string, text: string, coordinate?: string): Promise<void> {
    return this.runForFollower(reqId, () => this.opts.onSendRequest?.(text, coordinate));
  }

  /** Leader: run one follower-proxied operation and ack its outcome. */
  private async runForFollower(reqId: string, run: () => Promise<void> | undefined): Promise<void> {
    let ok = true;
    let error: string | undefined;
    let code: string | undefined;
    try {
      await run();
    } catch (e) {
      ok = false;
      error = e instanceof Error ? e.message : String(e);
      // By name, not instanceof: tab-leader must not import the session (W-4).
      if (e instanceof Error && e.name === "ChatUnroutableError") code = "unroutable";
    }
    this.channel?.postMessage({ t: "ack", scope: this.scope, reqId, ok, error, code } satisfies Wire);
  }

  // ── leader → follower broadcasts ───────────────────────────────────────────
  /** Leader: publish the current message list for `coordinate` to followers. */
  broadcastState(coordinate: string, messages: ChatMessage[]): void {
    if (this.role !== "leader" || !this.channel) return;
    // Callers pass `chatSession.messages` straight off Svelte `$state` — that's a
    // deep reactive Proxy. BroadcastChannel uses the structured-clone algorithm,
    // which cannot clone Proxies (DataCloneError: "[object Array] could not be
    // cloned"). The throw used to escape into `onMessage` and get mis-logged as
    // "malformed history rumor" / "local echo failed", aborting the rest of that
    // path's callers' try/catch framing. Snapshot to plain data first (same class
    // of bug as publish-queue.ts queuing `$state` relay lists into IndexedDB).
    const plain = plainChatMessages(messages);
    try {
      this.channel.postMessage({
        t: "state",
        scope: this.scope,
        coordinate,
        messages: plain,
      } satisfies Wire);
    } catch (err) {
      console.warn("marmot: tab state broadcast failed", err);
    }
  }
  /** Leader: publish the current membership set for `coordinate` to followers. */
  broadcastMembers(coordinate: string, members: string[]): void {
    if (this.role !== "leader" || !this.channel) return;
    const plain = [...members];
    try {
      this.channel.postMessage({
        t: "members",
        scope: this.scope,
        coordinate,
        members: plain,
      } satisfies Wire);
    } catch (err) {
      console.warn("marmot: tab members broadcast failed", err);
    }
  }

  /** Leader: publish the room's phase and damage flag for `coordinate` (W-4). */
  broadcastStatus(coordinate: string, status: LeaderStatus): void {
    if (this.role !== "leader" || !this.channel) return;
    try {
      this.channel.postMessage({
        t: "status",
        scope: this.scope,
        coordinate,
        status: { phase: status.phase, damaged: status.damaged },
      } satisfies Wire);
    } catch (err) {
      console.warn("marmot: tab status broadcast failed", err);
    }
  }

  // ── follower → leader proxy ────────────────────────────────────────────────
  /**
   * Follower: proxy a send to the leader, resolving when it acks. On the ping path
   * it is addressed to the leader heard last (W-7), so two momentary leaders never
   * both run it.
   */
  proxySend(text: string, coordinate?: string): Promise<void> {
    return this.proxy(
      (reqId) => ({ t: "send", scope: this.scope, reqId, text, coordinate, to: this.target() }),
      this.ackTimeoutMs,
      "timed out waiting for the active tab to send",
    );
  }

  /** Follower: proxy a reaction/edit/delete to the leader, like {@link proxySend}. */
  proxyAction(action: ChatAction, coordinate?: string): Promise<void> {
    return this.proxy(
      (reqId) => ({ t: "action", scope: this.scope, reqId, action, coordinate, to: this.target() }),
      this.ackTimeoutMs,
      "timed out waiting for the active tab to send",
    );
  }

  /**
   * Follower: ask the leader to re-enrol this device into the event's chat. Only
   * the leader owns MLS state, so it is the one that re-enrols.
   */
  proxyRejoin(force = false, coordinate?: string): Promise<void> {
    return this.proxy(
      (reqId) => ({ t: "rejoin", scope: this.scope, reqId, force, coordinate, to: this.target() }),
      this.rejoinTimeoutMs,
      "timed out waiting for the active tab to rejoin",
    );
  }

  /**
   * The leader a request is addressed to: none on the Web Locks path (exactly one
   * leader exists; unchanged behaviour), the last-heard leader on the ping path.
   */
  private target(): string | undefined {
    return this.usingWebLocks ? undefined : this.leaderId;
  }

  /**
   * Whether this follower can proxy to a leader. On the Web Locks path, always.
   * On the ping path (W-7), once it knows which leader to address: an unaddressed
   * request could run on both tabs of a conflict not yet resolved. A leader on a
   * build before W-7 announces no id, so its followers stay read-only, as before.
   */
  get canProxy(): boolean {
    if (!this.channel) return false;
    return this.usingWebLocks || this.leaderId !== undefined;
  }

  /** Post one request to the leader and resolve/reject on its ack (or timeout). */
  private proxy(build: (reqId: string) => Wire, timeoutMs: number, timeoutMessage: string): Promise<void> {
    if (!this.canProxy) {
      return Promise.reject(new Error("send proxy unavailable in this tab"));
    }
    const reqId = `${this.scope}:${Date.now()}:${this.reqSeq++}`;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(timeoutMessage));
      }, timeoutMs);
      this.pending.set(reqId, { resolve, reject, timer });
      this.channel!.postMessage(build(reqId) satisfies Wire);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopHeartbeat();
    this.stopWatchdog();
    this.channel?.removeEventListener("message", this.onMessage);
    // Release leadership so a follower can take over immediately.
    this.stopHolding?.();
    this.stopHolding = undefined;
    this.takeoverAbort?.abort();
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("chat tab coordinator disposed"));
    }
    this.pending.clear();
    this.channel?.close();
    if (!this.settled) this.markSettled();
  }
}
