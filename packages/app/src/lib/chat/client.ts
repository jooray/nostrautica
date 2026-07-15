/**
 * MarmotClient lifecycle wrapper for the app (MARMOT-GROUP-CHAT §2/§5, Phase 2).
 *
 * Ties the vendored marmot-ts together with our IndexedDB stores (`stores.ts`),
 * NDK network adapter (`network.ts`), and resolved chat identity (`identity.ts`).
 * Drives the member side of the protocol: publish identity artifacts (10050 +
 * kind-30443 key package, and the 21607 attestation for device-key accounts),
 * join on welcome, subscribe to 445 group traffic, send/receive kind-9 chat, and
 * the eviction/heal loop.
 *
 * NOTE: full send/receive is only observable against a live relay + the
 * coordinator admin bot (Phase 3), which cannot run here. The integration is
 * written to the verified marmot-ts API surface; the final live pass verifies it.
 */
import { MarmotClient } from "@internet-privacy/marmot-ts/client";
import { getNostrGroupIdHex } from "@internet-privacy/marmot-ts/core";
// `proposeRemoveUser` is not in marmot-ts's export map (UPSTREAM U7) — deep-import
// it through the vendored package's `./lib/*` wildcard export.
import { proposeRemoveUser } from "@internet-privacy/marmot-ts/lib/client/group/proposals/remove-member.js";
import { KIND_DM_RELAY_LIST, KIND_RELAY_LIST } from "@nostrautica/protocol";
import type { AppSigner } from "$lib/signer/types.js";
import type { EventContext } from "$lib/events/event-context.js";
import { publishSigned } from "$lib/nostr/ndk.js";
import { resolveChatIdentity, type ChatIdentity } from "./identity.js";
import { makeMarmotStores, marmotKvBackend } from "./stores.js";
import { createMarmotNetwork } from "./network.js";
import { buildChatSend, decodeApplicationMessage, type ChatMessage } from "./messages.js";
import { sendChatKeyAttestation } from "./attest.js";

/** A live chat message listener. */
export type ChatMessageHandler = (message: ChatMessage) => void;

export interface MarmotChatOptions {
  accountSigner: AppSigner;
  ctx: EventContext;
}

/**
 * One event's chat client. Construct with {@link MarmotChat.create}, then
 * {@link ensurePublished} → {@link start}. `onMessage` fires for every decoded
 * application message across the joined group(s).
 */
export class MarmotChat {
  readonly identity: ChatIdentity;
  private readonly client: MarmotClient<undefined, undefined>;
  private readonly ctx: EventContext;
  private readonly accountSigner: AppSigner;
  private connection?: { unsubscribe(): void };
  private inviteSub?: { unsubscribe(): void };
  private onInviteDecrypted?: () => void;
  /** Serializes the startup join and every welcome-driven join so two runs don't race the same welcome. */
  private joining?: Promise<void>;
  private readonly boundGroups = new Set<string>();
  onMessage?: ChatMessageHandler;
  onStateChange?: () => void;

  private constructor(identity: ChatIdentity, ctx: EventContext, accountSigner: AppSigner) {
    this.identity = identity;
    this.ctx = ctx;
    this.accountSigner = accountSigner;
    // Shared IndexedDB backend; namespacing is per chat identity.
    const stores = makeMarmotStores(marmotKvBackend(), identity.pubkey);
    this.client = new MarmotClient<undefined, undefined>({
      // Structural EventSigner (identity.ts) — checked structurally by marmot.
      signer: identity.eventSigner as unknown as MarmotClientCtorSigner,
      accountProofSigner: identity.accountProofSigner,
      network: createMarmotNetwork() as unknown as MarmotClientCtorNetwork,
      groupStateStore: stores.groupStateStore,
      keyPackageStore: stores.keyPackageStore,
      inviteStore: stores.inviteStore,
      rewindStore: stores.rewindStore,
      clientId: identity.clientId,
    });
  }

  static async create(options: MarmotChatOptions): Promise<MarmotChat> {
    const identity = await resolveChatIdentity(options.accountSigner);
    return new MarmotChat(identity, options.ctx, options.accountSigner);
  }

  /** The relays this event's chat uses (the 31600 relay list). */
  private get relays(): string[] {
    return this.ctx.config.relays;
  }

  /**
   * Publish everything other clients/the coordinator need to add this identity:
   * the kind-10050 inbox relay list, a kind-10002 relay list, the kind-30443 key
   * package, and — for device-key (NIP-46/NIP-07) accounts — the 21607
   * attestation binding the chat key to the account. Idempotent.
   */
  async ensurePublished(): Promise<void> {
    await this.ensureRelayLists();
    // Publish (or confirm) the kind-30443 key package on the event relays under
    // this device's stable slot. This is what the coordinator's watcher adds.
    await this.client.keyPackages.ensurePublished({
      relays: this.relays,
      identifier: this.identity.clientId,
      client: "nostrautica-web",
    });
    // Device-key accounts must attest the chat key to the coordinator (sealed by
    // the account key). Local-key accounts are their own chat identity — skip.
    if (!this.identity.isAccountKey) {
      await sendChatKeyAttestation(this.accountSigner, this.ctx, {
        op: "add",
        chatPubkey: this.identity.pubkey,
        clientId: this.identity.clientId,
      });
    }
  }

  /** Publish the chat identity's 10050 (inbox) + 10002 (discovery) relay lists. */
  private async ensureRelayLists(): Promise<void> {
    const relayTags = this.relays.map((r) => ["relay", r]);
    const now = Math.floor(Date.now() / 1000);
    // 10050: NIP-17 inbox relays — where welcomes (1059) are delivered.
    const inbox = this.identity.eventSigner.signEvent({
      kind: KIND_DM_RELAY_LIST,
      created_at: now,
      tags: relayTags,
      content: "",
    });
    // 10002: NIP-65 relay list — key-package discovery.
    const nip65 = this.identity.eventSigner.signEvent({
      kind: KIND_RELAY_LIST,
      created_at: now,
      tags: this.relays.map((r) => ["r", r]),
      content: "",
    });
    await Promise.all([
      publishSigned(inbox as unknown as Parameters<typeof publishSigned>[0], this.relays).catch(() => {}),
      publishSigned(nip65 as unknown as Parameters<typeof publishSigned>[0], this.relays).catch(() => {}),
    ]);
  }

  /**
   * Begin listening for welcomes and group traffic. Joins any pending welcome,
   * connects the 445 subscription for every joined group, and wires message +
   * state listeners. Safe to call after {@link ensurePublished}.
   */
  async start(): Promise<void> {
    // Keep a live 445 auto-connection for every joined group — including groups we
    // join LATER from a welcome that arrives after startup. `connectAll` tracks the
    // manager's `joined` event, so a late join auto-subscribes to its 445 traffic.
    // Installed first so no group (present or future) is missed.
    this.connection = this.client.groups.connectAll();
    // A welcome that arrives after this point is ingested + decrypted by `listen()`
    // into the invite store's "unread" slot, but marmot never *joins* on its own —
    // the app must drive `joinGroupFromWelcome`. The coordinator adds us seconds
    // (or longer) after we publish our key package, so the welcome almost always
    // lands after the initial `joinPending()`; without reacting to it here the
    // member decrypts the welcome and then sits forever, never joining (gap G-3).
    // Drive the join off every `decrypted` event to cover that late-arrival case.
    this.onInviteDecrypted = () => {
      void this.joinPendingAndBind().catch((err) => console.warn("marmot: join-on-welcome failed", err));
    };
    this.client.invites.on("decrypted", this.onInviteDecrypted);
    // Listen for gift-wrapped welcomes on our inbox relays.
    this.inviteSub = await this.client.invites.listen(this.relays);
    // Join + bind anything already waiting (welcome delivered before we started).
    await this.joinPendingAndBind();
  }

  /**
   * Join every pending welcome and bind listeners on the resulting groups.
   * Serialized so the startup call and each `decrypted`-driven call cannot race to
   * join the same welcome; fires {@link onStateChange} when a new group appears so
   * the UI leaves its "setting up" state.
   */
  private async joinPendingAndBind(): Promise<void> {
    const prev = this.joining ?? Promise.resolve();
    this.joining = prev
      .catch(() => {})
      .then(async () => {
        const before = this.boundGroups.size;
        await this.joinPending();
        await this.bindAllGroups();
        if (this.boundGroups.size !== before) this.onStateChange?.();
      });
    await this.joining;
  }

  /** Join any welcome we hold the key package for. */
  async joinPending(): Promise<void> {
    // Move any received gift wraps to "unread" (idempotent), then join every
    // *unread* welcome we still hold the key package for. We iterate `getUnread()`
    // rather than trusting `decryptGiftWraps()`'s return value: a welcome the
    // `listen()` subscription already decrypted lives in "unread" but would not be
    // in a later `decryptGiftWraps()` result, so keying off the return value would
    // silently skip exactly the late-arriving welcome this path exists to join.
    await this.client.invites.decryptGiftWraps().catch(() => []);
    const unread = await this.client.invites.getUnread().catch(() => []);
    for (const invite of unread) {
      try {
        const joinable = await this.client.canJoinInvite(invite);
        if (!joinable) continue;
        await this.client.joinGroupFromWelcome({ welcomeRumor: invite });
        await this.client.invites.markAsRead(invite.id).catch(() => {});
      } catch (err) {
        console.warn("marmot: welcome join failed", err);
      }
    }
  }

  /** Attach message/state listeners to every loaded group (idempotent per group). */
  private async bindAllGroups(): Promise<void> {
    const groups = await this.client.groups.loadAll();
    for (const group of groups) {
      if (this.boundGroups.has(group.idStr)) continue;
      this.boundGroups.add(group.idStr);
      group.on("applicationMessage", (bytes: Uint8Array) => {
        try {
          this.onMessage?.(decodeApplicationMessage(bytes));
        } catch (err) {
          // A non-conformant inner payload is dropped (invalid_encoding, §7).
          console.warn("marmot: dropped malformed application message", err);
        }
      });
      group.on("stateChanged", () => this.onStateChange?.());
    }
  }

  /** The nostr_group_id (hex) for the first joined group, for a 445 `#h` filter. */
  async nostrGroupId(): Promise<string | undefined> {
    const groups = await this.client.groups.loadAll();
    const group = groups[0];
    return group ? getNostrGroupIdHex(group.state) : undefined;
  }

  /** Send a kind-9 chat message to the joined group. Convergence-gated (§2). */
  async send(text: string): Promise<void> {
    const groups = await this.client.groups.loadAll();
    const group = groups[0];
    if (!group) throw new Error("no joined chat group yet");
    const { intent } = buildChatSend(this.identity.pubkey, text);
    await this.client.groups.send(group.id, intent);
  }

  /**
   * Eviction/heal (§5): if IndexedDB was purged our leaf is gone and we hold no
   * group. Republish a fresh key package under the same slot so the coordinator's
   * 30443 watcher re-adds us; a new welcome then arrives and chat resumes from the
   * new epoch (messages in the gap are forward-secret, not recoverable). Returns
   * true when a heal republish was issued.
   */
  async healIfEvicted(): Promise<boolean> {
    const groups = await this.client.groups.loadAll().catch(() => []);
    if (groups.length > 0) return false;
    // No group state — (re)publish identity artifacts to trigger a fresh add.
    await this.ensurePublished();
    return true;
  }

  /** Leave every joined group (self_remove) — the member's clean exit. */
  async leaveAll(): Promise<void> {
    const groups = await this.client.groups.loadAll().catch(() => []);
    for (const group of groups) {
      await this.client.groups.leave(group.id).catch((err) => console.warn("marmot: leave failed", err));
    }
  }

  /** Release live resources (subscriptions/timers). Call on unmount. */
  dispose(): void {
    if (this.onInviteDecrypted) this.client.invites.off("decrypted", this.onInviteDecrypted);
    this.onInviteDecrypted = undefined;
    this.connection?.unsubscribe();
    this.inviteSub?.unsubscribe();
    this.connection = undefined;
    this.inviteSub = undefined;
  }
}

/**
 * Resolve `proposeRemoveUser`'s array-action into a flat proposal list to spread
 * into a commit's `extraProposals` — the UPSTREAM U7 workaround for the engine not
 * flattening an array-typed `ProposalAction`. Admin/co-admin path (§4.6); the app
 * member side never removes others (it uses `leaveAll`). The primary consumer is
 * the coordinator. `context` is the group's `{ state, ciphersuite, groupData }`.
 */
export async function resolveRemoveUserProposals(
  pubkey: string,
  context: unknown,
): Promise<unknown[]> {
  const action = proposeRemoveUser(pubkey);
  const proposals = await action(context as Parameters<typeof action>[0]);
  // Spread the raw array so each ProposalRemove is a first-class extraProposal.
  return [...proposals];
}

// ── Structural helper types (avoid naming non-hoisted applesauce types) ───────
type MarmotClientCtorSigner = ConstructorParameters<typeof MarmotClient>[0]["signer"];
type MarmotClientCtorNetwork = ConstructorParameters<typeof MarmotClient>[0]["network"];
