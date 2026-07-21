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
    if (this.naddr === naddr && this.owner === owner && (this.chat || this.starting)) {
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
    const ctx = this.ctx;
    const signer = this.signer;
    if (!ctx || !signer) return;
    this.phase = "setup";
    this.error = null;
    const run = (async () => {
      // The whole marmot-ts + ts-mls stack (~220 kB gz) is lazy — a chat-off
      // event, or a non-member, never loads it.
      const { MarmotChat } = await import("./client.js");
      const chat = await MarmotChat.create({ accountSigner: signer, ctx });
      if (tok !== this.token) {
        chat.dispose();
        return;
      }
      this.chat = chat;
      this.chatPubkey = chat.identity.pubkey;
      chat.onMessage = (m) => {
        if (tok !== this.token) return;
        this.ingest(m);
      };
      chat.onStateChange = () => {
        if (tok === this.token) void this.syncPhase(tok);
      };
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
    if (!this.chat) throw new Error("no chat session");
    await this.chat.send(text);
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
