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
 *  - No Web Locks, but `BroadcastChannel`: best-effort ping election — a tab that
 *    hears an existing leader becomes a READ-ONLY follower (send-proxy is disabled
 *    off the Web Locks path, since we can't guarantee single-writer); otherwise it
 *    leads. `usingWebLocks` is false, so the session shows the read-only notice.
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

/** Broadcast wire protocol — {send request, ack, message list update, membership update} + election pings. */
type Wire =
  | { t: "leader-hello"; scope: string }
  | { t: "who-leads"; scope: string }
  | { t: "sync"; scope: string }
  | { t: "state"; scope: string; coordinate: string; messages: ChatMessage[] }
  | { t: "members"; scope: string; coordinate: string; members: string[] }
  | { t: "send"; scope: string; reqId: string; text: string }
  | { t: "ack"; scope: string; reqId: string; ok: boolean; error?: string };

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
  /** Leader: a follower proxied a send; resolve to ack ok, throw to ack error. */
  onSendRequest?(text: string): Promise<void>;
  /** Leader: a freshly-joined follower asked for the current state — re-broadcast it. */
  onSyncRequest?(): void;
  /** Election ping window (ms) when Web Locks is unavailable. */
  pingWindowMs?: number;
  /** Ack timeout (ms) for a proxied send. */
  ackTimeoutMs?: number;
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

export class ChatTabCoordinator {
  role: TabRole = "pending";
  /** Whether leadership is guaranteed single-writer (Web Locks path). Off it, followers are read-only. */
  readonly usingWebLocks: boolean;
  /** The coordinate the leader is currently serving, as seen by a follower (for read-only detection). */
  leaderCoordinate: string | undefined;

  private readonly scope: string;
  private readonly locks: LockManagerLike | null;
  private readonly channel: BroadcastChannelLike | null;
  private readonly opts: TabCoordinatorOptions;
  private readonly pingWindowMs: number;
  private readonly ackTimeoutMs: number;

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
    this.usingWebLocks = !!this.locks;
    this.pingWindowMs = opts.pingWindowMs ?? 300;
    this.ackTimeoutMs = opts.ackTimeoutMs ?? 8000;
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
        if (lock === null) {
          this.becomeFollower();
          this.queueTakeover(name);
          return;
        }
        this.becomeLeader();
        await new Promise<void>((res) => (this.stopHolding = res));
      })
      .catch(() => {
        // A locks failure shouldn't strand chat — fall back to leading.
        if (!this.settled) this.becomeLeader();
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
    this.channel.postMessage({ t: "who-leads", scope: this.scope } satisfies Wire);
    await new Promise<void>((res) => setTimeout(res, this.pingWindowMs));
    if (this.disposed || this.settled) return;
    // Heard no leader-hello within the window → lead.
    this.becomeLeader();
  }

  private becomeLeader(): void {
    if (this.disposed || this.role === "leader") return;
    this.role = "leader";
    this.opts.onRoleChange("leader");
    this.channel?.postMessage({ t: "leader-hello", scope: this.scope } satisfies Wire);
    this.markSettled();
  }

  private becomeFollower(): void {
    if (this.disposed || this.role === "follower") return;
    this.role = "follower";
    this.opts.onRoleChange("follower");
    // Ask the current leader for a snapshot so we render immediately, not only from
    // the next live message onward.
    this.channel?.postMessage({ t: "sync", scope: this.scope } satisfies Wire);
    this.markSettled();
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
        if (this.role === "leader") {
          this.channel?.postMessage({ t: "leader-hello", scope: this.scope } satisfies Wire);
        }
        return;
      case "leader-hello":
        // Someone leads. In the ping fallback (not yet settled), become a follower.
        if (!this.locks && !this.settled) this.becomeFollower();
        return;
      case "sync":
        // A freshly-joined follower wants the current snapshot — the session
        // re-broadcasts its live state/membership.
        if (this.role === "leader") this.opts.onSyncRequest?.();
        return;
      case "state":
        if (this.role === "follower") {
          this.leaderCoordinate = msg.coordinate;
          this.opts.onLeaderState?.(msg.coordinate, msg.messages);
        }
        return;
      case "members":
        if (this.role === "follower") {
          this.leaderCoordinate = msg.coordinate;
          this.opts.onLeaderMembers?.(msg.coordinate, msg.members);
        }
        return;
      case "send":
        if (this.role === "leader") void this.handleSendRequest(msg.reqId, msg.text);
        return;
      case "ack": {
        const p = this.pending.get(msg.reqId);
        if (!p) return;
        this.pending.delete(msg.reqId);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve();
        else p.reject(new Error(msg.error ?? "proxied send failed"));
        return;
      }
    }
  }

  private async handleSendRequest(reqId: string, text: string): Promise<void> {
    let ok = true;
    let error: string | undefined;
    try {
      await this.opts.onSendRequest?.(text);
    } catch (e) {
      ok = false;
      error = e instanceof Error ? e.message : String(e);
    }
    this.channel?.postMessage({ t: "ack", scope: this.scope, reqId, ok, error } satisfies Wire);
  }

  // ── leader → follower broadcasts ───────────────────────────────────────────
  /** Leader: publish the current message list for `coordinate` to followers. */
  broadcastState(coordinate: string, messages: ChatMessage[]): void {
    if (this.role !== "leader") return;
    this.channel?.postMessage({ t: "state", scope: this.scope, coordinate, messages } satisfies Wire);
  }
  /** Leader: publish the current membership set for `coordinate` to followers. */
  broadcastMembers(coordinate: string, members: string[]): void {
    if (this.role !== "leader") return;
    this.channel?.postMessage({ t: "members", scope: this.scope, coordinate, members } satisfies Wire);
  }

  // ── follower → leader proxy ────────────────────────────────────────────────
  /**
   * Follower: proxy a send to the leader, resolving when it acks. Only supported on
   * the Web Locks path (single-writer guaranteed); off it, followers are read-only.
   */
  proxySend(text: string): Promise<void> {
    if (!this.usingWebLocks || !this.channel) {
      return Promise.reject(new Error("send proxy unavailable in this tab"));
    }
    const reqId = `${this.scope}:${Date.now()}:${this.reqSeq++}`;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error("timed out waiting for the active tab to send"));
      }, this.ackTimeoutMs);
      this.pending.set(reqId, { resolve, reject, timer });
      this.channel!.postMessage({ t: "send", scope: this.scope, reqId, text } satisfies Wire);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
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
