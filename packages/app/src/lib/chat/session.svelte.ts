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
  type TabRole,
  type TabCoordinatorOptions,
} from "./tab-leader.js";

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
export type ChatSessionPhase = "idle" | "setup" | "ready" | "evicted" | "error";

/**
 * This device holds no routable group for the event — it was removed, evicted, or
 * its binding is contradicted by the roster. Distinct from a send that failed on
 * the wire, because only this one is fixed by Rejoin (which revokes the device,
 * rotates its key package and re-attests: an MLS epoch change and a roster
 * republish, quite the wrong price for a dropped socket).
 */
export class ChatUnroutableError extends Error {
  constructor() {
    super("this device is not in the event's chat group");
    this.name = "ChatUnroutableError";
  }
}

class ChatSessionStore {
  /** The event this session belongs to (undefined when idle). */
  naddr = $state<string | undefined>(undefined);
  phase = $state<ChatSessionPhase>("idle");
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
            void this.becomeLeaderClient(tok, coordinator, ctx, signer);
          }
        },
        onLeaderState: (coordinate, messages) => {
          // Follower render: adopt the leader's de-duped, sorted list wholesale.
          if (tok !== this.token || coordinate !== ctx.coordinate) return;
          this.messages = messages;
          this.recomputeReadOnly();
          if (this.phase !== "ready") this.phase = "ready";
        },
        onLeaderMembers: (coordinate, members) => {
          // Real MLS membership, computed by the tab that holds the client. A
          // follower has no group state of its own, so without this its member
          // list would silently fall back to the roster — the very thing this
          // whole path replaces.
          if (tok !== this.token || coordinate !== ctx.coordinate) return;
          this.memberDevices = members;
        },
        onSendRequest: async (text) => {
          // Leader executes a follower's proxied send on the real client.
          if (!this.chat) throw new Error("no chat session");
          await this.chat.send(text);
        },
        onRejoinRequest: async (force) => {
          // Leader performs a follower's rejoin: MLS state has a single writer, so
          // the tab that owns the client is the only one that may re-enrol.
          if (!this.chat) throw new Error("no chat session");
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
    chat.onMessage = (m) => {
      if (tok !== this.token) return;
      this.ingest(m);
      // Mirror the fresh list to follower tabs.
      coordinator.broadcastState(ctx.coordinate, this.messages);
    };
    chat.onStateChange = () => {
      if (tok !== this.token) return;
      void this.syncPhase(tok);
      // Membership changes ARE state changes — an Add, a Remove, or our own
      // eviction all arrive here as a new epoch. Re-read the group rather than
      // trusting the roster, which the coordinator republishes on its own schedule.
      void this.syncMembers(tok, coordinator, ctx.coordinate);
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
    await this.syncMembers(tok, coordinator, ctx.coordinate);
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
    const gid = await this.chat?.nostrGroupId().catch(() => undefined);
    if (tok !== this.token || !gid) return;
    const members = await Promise.resolve()
      .then(() => this.chat?.groupMemberPubkeys())
      .catch(() => undefined);
    if (tok !== this.token) return;
    const me = this.chat?.identity.pubkey;
    this.phase = members && me && !members.includes(me) ? "evicted" : "ready";
  }

  /** Re-run the handshake from scratch (the page's "Try again"). */
  async retry(): Promise<void> {
    if (!this.ctx || !this.signer) return;
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
      await c.proxySend(text);
      return;
    }
    throw new Error("no chat session");
  }

  /** Leader: drop back to `setup` when the client holds no routable group.
   *  Returns whether the group is in fact unroutable (which is the membership
   *  problem Rejoin exists for), as opposed to a transport failure. */
  private async demoteIfUnroutable(): Promise<boolean> {
    const gid = await this.chat?.nostrGroupId().catch(() => undefined);
    if (gid) return false;
    if (this.phase === "ready") this.phase = "setup";
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
  async rejoin(opts?: { force?: boolean }): Promise<void> {
    if (this.rejoining) return;
    this.rejoining = true;
    try {
      if (this.chat) {
        this.phase = "setup";
        const tok = this.token;
        await this.chat.rejoin(opts);
        await this.syncPhase(tok);
        return;
      }
      const c = this.coordinator;
      if (c && c.role === "follower" && !this.readOnly) {
        await c.proxyRejoin(opts?.force ?? false);
        return;
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
