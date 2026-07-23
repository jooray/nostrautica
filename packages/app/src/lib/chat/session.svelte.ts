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
import { ChatTabCoordinator, type TabRole } from "./tab-leader.js";

/**
 * `setup` — client is up, no group yet (waiting on the coordinator's Add +
 * welcome). `ready` — joined; the room is usable. `error` — the handshake threw.
 */
export type ChatSessionPhase = "idle" | "setup" | "ready" | "error";

class ChatSessionStore {
  /** The event this session belongs to (undefined when idle). */
  naddr = $state<string | undefined>(undefined);
  phase = $state<ChatSessionPhase>("idle");
  error = $state<unknown>(null);
  /** Every decoded message, de-duped by rumor id and chronologically sorted. */
  messages = $state<ChatMessage[]>([]);
  /** Our own chat identity pubkey (marks "my" bubbles); set once the client exists. */
  chatPubkey = $state<string | undefined>(undefined);
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
  /** The multi-tab coordinator (leader election + follower proxy). */
  private coordinator?: ChatTabCoordinator;

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
    const ctx = this.ctx;
    const signer = this.signer;
    if (!ctx || !signer) return;
    this.phase = "setup";
    this.error = null;
    const run = (async () => {
      // Multi-tab leadership (H-7): exactly one tab per account owns the live client
      // and all MLS mutation; other tabs proxy through a BroadcastChannel. Scope the
      // election to the account so two tabs never mutate the shared per-identity
      // IndexedDB MLS state concurrently.
      const scope = this.owner ?? (await signer.getPublicKey());
      if (tok !== this.token) return;
      const coordinator = new ChatTabCoordinator({
        scope,
        onRoleChange: (role) => {
          if (tok !== this.token) return;
          this.tabRole = role;
          this.recomputeReadOnly();
        },
        onLeaderState: (coordinate, messages) => {
          // Follower render: adopt the leader's de-duped, sorted list wholesale.
          if (tok !== this.token || coordinate !== ctx.coordinate) return;
          this.messages = messages;
          this.recomputeReadOnly();
          if (this.phase !== "ready") this.phase = "ready";
        },
        onSendRequest: async (text) => {
          // Leader executes a follower's proxied send on the real client.
          if (!this.chat) throw new Error("no chat session");
          await this.chat.send(text);
        },
        onSyncRequest: () => {
          if (tok === this.token) coordinator.broadcastState(ctx.coordinate, this.messages);
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
        this.phase = "ready";
        return;
      }

      // Leader: the whole marmot-ts + ts-mls stack (~220 kB gz) is lazy — a chat-off
      // event, or a non-member, never loads it.
      const { MarmotChat } = await import("./client.js");
      const chat = await MarmotChat.create({ accountSigner: signer, ctx });
      if (tok !== this.token) {
        chat.dispose();
        return;
      }
      this.chat = chat;
      this.chatPubkey = chat.identity.pubkey;
      this.recomputeReadOnly();
      chat.onMessage = (m) => {
        if (tok !== this.token) return;
        this.ingest(m);
        // Mirror the fresh list to follower tabs.
        coordinator.broadcastState(ctx.coordinate, this.messages);
      };
      chat.onStateChange = () => {
        if (tok === this.token) void this.syncPhase(tok);
      };
      // First v2 chat session: best-effort retire the account's legacy 31602
      // chat-device-key backup (NIP §7.5). Leader-only + once-per-account gated, so
      // followers don't duplicate it. Fire-and-forget — never blocks the handshake.
      void import("./legacy-cleanup.js")
        .then(({ deleteLegacyChatDeviceKeyBackup }) =>
          deleteLegacyChatDeviceKeyBackup(signer, ctx.config.relays),
        )
        .catch(() => {});
      // Publish the key package (+ attestation for device-key accounts) so the
      // coordinator can add us, then listen for the welcome and 445 traffic.
      await chat.ensurePublished();
      await chat.start();
      await this.syncPhase(tok);
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

  /** De-dupe by inner rumor id, keep chronological order (Bug 4 echo-safe). */
  private ingest(m: ChatMessage): void {
    if (this.messages.some((x) => x.id === m.id)) return;
    this.messages = [...this.messages, m].sort((a, b) => a.createdAt - b.createdAt);
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

  /** Joined a group ⇒ the room is usable. */
  private async syncPhase(tok: number): Promise<void> {
    const gid = await this.chat?.nostrGroupId().catch(() => undefined);
    if (tok !== this.token) return;
    if (gid) this.phase = "ready";
  }

  /** Re-run the handshake from scratch (the page's "Try again"). */
  async retry(): Promise<void> {
    if (!this.ctx || !this.signer) return;
    this.chat?.dispose();
    this.chat = undefined;
    this.chatPubkey = undefined;
    this.messages = [];
    await this.begin();
  }

  async send(text: string): Promise<void> {
    // Leader owns the client and sends directly.
    if (this.chat) {
      await this.chat.send(text);
      return;
    }
    // Interactive follower proxies the send to the leader tab (Web Locks path only).
    const c = this.coordinator;
    if (c && c.role === "follower" && !this.readOnly) {
      await c.proxySend(text);
      return;
    }
    throw new Error("no chat session");
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
    // Release leadership so another tab can take over immediately.
    this.coordinator?.dispose();
    this.coordinator = undefined;
    this.tabRole = "pending";
    this.readOnly = false;
    this.chat?.dispose();
    this.chat = undefined;
    this.chatPubkey = undefined;
    this.messages = [];
    this.phase = "idle";
    this.error = null;
    this.naddr = undefined;
    this.ctx = undefined;
    this.signer = undefined;
    this.owner = undefined;
  }
}

export const chatSession = new ChatSessionStore();
