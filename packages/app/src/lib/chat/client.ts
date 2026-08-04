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
import type { GroupRumorHistory } from "@internet-privacy/marmot-ts/client";
import { getNostrGroupIdHex, getPubkeyLeafNodes } from "@internet-privacy/marmot-ts/core";
// `proposeRemoveUser` is not in marmot-ts's export map (UPSTREAM U7) — deep-import
// it through the vendored package's `./lib/*` wildcard export.
import { proposeRemoveUser } from "@internet-privacy/marmot-ts/lib/client/group/proposals/remove-member.js";
import { KIND_DM_RELAY_LIST, KIND_RELAY_LIST } from "@nostrautica/protocol";
import type { AppSigner } from "$lib/signer/types.js";
import type { EventContext } from "$lib/events/event-context.js";
import { publishSigned, fetchEventsRelayOnly } from "$lib/nostr/ndk.js";
import { chatRelaysOf, unionRelays } from "$lib/nostr/relays.js";
import { fetchProfiles, type ProfileMeta } from "$lib/events/social.js";
import { fetchRoster, cachedRoster } from "$lib/events/attendee.js";
import {
  resolveChatIdentity,
  buildChatKeyProfile,
  defaultDeviceLabel,
  type ChatIdentity,
} from "./identity.js";
import {
  makeMarmotStores,
  makeMarmotHistoryFactory,
  marmotKvBackend,
  namespacedStore,
  MARMOT_NAMESPACES,
  type MarmotKvBackend,
} from "./stores.js";
import { createMarmotNetwork } from "./network.js";
import {
  buildChatSend,
  decodeApplicationMessage,
  roundTripChatRumor,
  rumorToChatMessage,
  CHAT_KIND_TEXT,
  CHAT_KIND_REACTION,
  CHAT_KIND_EDIT,
  type ChatMessage,
} from "./messages.js";
import { sendChatKeyAttestation } from "./attest.js";

/** Addressable MLS key-package event (Marmot / NIP-104). */
const KIND_KEY_PACKAGE = 30443;

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
  private readonly client: MarmotClient<GroupRumorHistory, undefined>;
  private readonly ctx: EventContext;
  private readonly accountSigner: AppSigner;
  private connection?: { unsubscribe(): void };
  private inviteSub?: { unsubscribe(): void };
  private onInviteDecrypted?: () => void;
  /** Serializes the startup join and every welcome-driven join so two runs don't race the same welcome. */
  private joining?: Promise<void>;
  private readonly boundGroups = new Set<string>();
  /** Event-coordinate → nostr_group_id bindings (APPK-3), per chat identity. */
  private readonly eventGroups: ReturnType<typeof makeMarmotStores>["eventGroupStore"];
  /** Kept so the removed-member repair can snapshot/restore a group's history namespace. */
  private readonly kvBackend: MarmotKvBackend;
  /** Memoized at most one live roster fetch per client, to reconcile a recorded
   *  binding against a cold/stale cache (see currentEventGroups). Memoizing the
   *  RESULT (not just "did we try") matters: if the cache stays stale, every call
   *  after the first must keep using what the live fetch actually found instead
   *  of falling back to trusting the (possibly proven-wrong) recorded value. */
  private liveRosterFetch?: Promise<string | undefined>;
  onMessage?: ChatMessageHandler;
  onStateChange?: () => void;

  private constructor(identity: ChatIdentity, ctx: EventContext, accountSigner: AppSigner) {
    this.identity = identity;
    this.ctx = ctx;
    this.accountSigner = accountSigner;
    // Shared IndexedDB backend; namespacing is per chat identity.
    const backend = marmotKvBackend();
    const stores = makeMarmotStores(backend, identity.pubkey);
    this.eventGroups = stores.eventGroupStore;
    this.kvBackend = backend;
    this.client = new MarmotClient<GroupRumorHistory, undefined>({
      // Structural EventSigner (identity.ts) — checked structurally by marmot.
      signer: identity.eventSigner as unknown as MarmotClientCtorSigner,
      accountProofSigner: identity.accountProofSigner,
      network: createMarmotNetwork() as unknown as MarmotClientCtorNetwork,
      groupStateStore: stores.groupStateStore,
      keyPackageStore: stores.keyPackageStore,
      inviteStore: stores.inviteStore,
      rewindStore: stores.rewindStore,
      // Durable decrypted-message history so past + while-offline messages survive
      // a navigation/reload (§5). marmot auto-saves every ingested/sent application
      // message here; we replay it on bind (see replayHistory).
      historyFactory: makeMarmotHistoryFactory(backend, identity.pubkey),
      clientId: identity.clientId,
    });
  }

  static async create(options: MarmotChatOptions): Promise<MarmotChat> {
    const identity = await resolveChatIdentity(options.accountSigner);
    return new MarmotChat(identity, options.ctx, options.accountSigner);
  }

  /**
   * The relays this event's chat uses: the 31600 `relay` list PLUS its separate
   * `chat_relay` list. Chat is the one subsystem that talks to both — the interop
   * relays carry exactly the kinds this class publishes (30443 key packages,
   * 0/10002/10050 identity, 445/1059 traffic) and refuse everything else, which
   * is why they are not in `config.relays` for the rest of the app to publish to.
   */
  private get relays(): string[] {
    return unionRelays(this.ctx.config.relays, chatRelaysOf(this.ctx.config));
  }

  /**
   * Publish everything other clients/the coordinator need to add this identity:
   * the kind-10050 inbox relay list, a kind-10002 relay list, the kind-30443 key
   * package, and — for device-key (NIP-46/NIP-07) accounts — the 21607
   * attestation binding the chat key to the account. Idempotent.
   */
  async ensurePublished(opts?: { force?: boolean; rotate?: boolean }): Promise<void> {
    // Publish (or refresh) this device key's own kind-0 (NIP §10.3) so other
    // Marmot clients — and our chat UI, which resolves sender names by fetching
    // this exact pubkey's kind-0 — can show a name/picture instead of a bare
    // pubkey. Every account type has a per-device chat key now (D3), so this is
    // unconditional. Unlike everything below, it is NOT gated on "already joined":
    // a kind-0 is a plain profile note, not MLS state, so republishing it here
    // every open also self-heals identities that joined before this existed.
    await this.ensureChatKeyProfile();

    // Already a joined member OF THIS EVENT's group (APPK-3)? Publish NOTHING
    // else. Re-advertising a fresh kind-30443 key package, or (for device-key
    // accounts) re-sending an op:"add" 21607 attestation, prompts the coordinator
    // to add us AGAIN — a new MLS Add commit, a new epoch, a forked ratchet —
    // after which our persisted group state is behind the group and the live 445
    // stream is undecryptable. That is the "re-adds me every time I open chat, so
    // I never see messages" bug. Persisted group state is authoritative; identity
    // (re)publish is only for the not-yet-joined first run and the eviction-heal
    // path (healIfEvicted, §5), both of which reach here with NO group FOR THIS
    // EVENT — a group from ANOTHER event must not suppress this event's
    // bootstrap.
    // "Joined" means a group of this event's in which OUR OWN leaf is still
    // present — not merely one we hold state for. A member the coordinator has
    // removed (revoke, admin remove) keeps its local group state and its history:
    // it can still read what it already has and cannot send or read anything new.
    // Checking only for the group's presence made that state permanent, because
    // this bootstrap — the one thing that would ask to be added back — skipped
    // itself on every open (prod 2026-07-30).
    if (!opts?.force && (await this.isEventGroupMember())) return;
    await this.ensureRelayLists();
    // Rotate when we are EVICTED — holding this event's group with our own leaf
    // gone — rather than merely not-yet-added. The key package we still advertise
    // is the one that was spent on the Add that created that leaf, so the
    // coordinator has long since recorded its event id as consumed and skips it;
    // re-advertising it is a no-op that leaves us stuck (prod 2026-07-30: the
    // re-attestation landed, the coordinator matched it against the same consumed
    // key package, and nothing happened). A not-yet-added client must NOT rotate:
    // its key package may be the one an in-flight Welcome was encrypted to, and
    // rotating discards the private material needed to join with it.
    if (opts?.rotate || (await this.isEvictedFromEventGroup())) await this.rotateKeyPackage();
    // Publish (or confirm) the kind-30443 key package on the event relays under
    // this device's stable slot. This is what the coordinator's watcher adds.
    await this.client.keyPackages.ensurePublished({
      relays: this.relays,
      identifier: this.identity.clientId,
      client: "nostrautica-web",
    });
    // Bug 2 heal: marmot's `keyPackages.ensurePublished` early-returns whenever a
    // locally-stored key package is still "unused", WITHOUT checking the kind-30443
    // is actually on the relays. So a publish that never reached the relay (our
    // NDK adapter swallows a failed send, network.ts), or a relay that dropped /
    // expired the event, leaves this client believing it advertised a key package
    // the coordinator can never see — with no log on either side. Verify the 30443
    // is retrievable; if not, force a fresh publish to the same `d` slot (the relay
    // replaces in place, so this can't spawn a duplicate).
    await this.ensureKeyPackageOnRelays();
    // Every account type attests its per-device chat key to the coordinator (D3),
    // sealed by the account key and carrying a proof of possession (NIP §10.2).
    await sendChatKeyAttestation(this.accountSigner, this.ctx, {
      op: "add",
      chatPubkey: this.identity.pubkey,
      clientId: this.identity.clientId,
      label: defaultDeviceLabel(),
      deviceSecretKey: this.identity.secretKey,
    });
  }

  /** Publish the device chat key's own kind-0 (name/picture borrowed from the
   *  real account's profile, marked "(chat)") — see {@link buildChatKeyProfile}. */
  private async ensureChatKeyProfile(): Promise<void> {
    const account = await fetchProfiles([this.identity.account]).catch(
      () => new Map<string, ProfileMeta>(),
    );
    const meta = account.get(this.identity.account);
    const ev = buildChatKeyProfile(this.identity, meta?.name, meta?.picture);
    await publishSigned(ev as unknown as Parameters<typeof publishSigned>[0], this.relays).catch(() => {});
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
   * Verify our kind-30443 key package is actually retrievable from the event
   * relays; if it isn't, force a fresh publish under the same slot. This heals the
   * gap where marmot's `ensurePublished` trusts a stale local "unused" record and
   * never re-advertises a key package that never reached (or was dropped by) the
   * relay — the coordinator's 30443 watcher then never adds us (Bug 2). A
   * relay-only read (no cache) is used so a locally-cached-but-not-on-relay copy
   * doesn't mask the miss. Best-effort: failures here must not block startup.
   */
  private async ensureKeyPackageOnRelays(): Promise<void> {
    try {
      // Only relevant while we're still waiting to be added TO THIS EVENT
      // (APPK-3): a client that already holds this event's group is a member
      // and needs no key-package re-advertisement. Scoping to the not-yet-joined
      // case also means we never republish a fresh key package for an existing
      // member (which could prompt a redundant re-add).
      const groups = await this.currentEventGroups();
      if (groups.length > 0) return;
      const found = await fetchEventsRelayOnly(
        {
          kinds: [KIND_KEY_PACKAGE],
          authors: [this.identity.pubkey],
          "#d": [this.identity.clientId],
        },
        this.relays,
      ).catch(() => []);
      if (found.length > 0) return;
      // Absent from every relay — republish to the same `d` slot (relay-replaces).
      await this.client.keyPackages.create({
        relays: this.relays,
        identifier: this.identity.clientId,
        client: "nostrautica-web",
      });
    } catch (err) {
      console.warn("marmot: key-package relay re-verification failed", err);
    }
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

  /**
   * Join pending welcomes — but ONLY ones bound to this event's coordinator
   * (audit APPK-2). A welcome's `rumor.pubkey` is the cryptographically
   * verified seal author (NIP-59 rumor/seal author binding, enforced by the
   * gift-wrap unwrap), so requiring it to equal the signed 31600's coordinator
   * rejects the stray-group attack: anyone can fetch the public kind-30443 key
   * package and gift-wrap a Welcome for THEIR OWN MLS group, but they cannot
   * seal it as the event's coordinator. Non-matching invites stay unread — a
   * different event's session (same identity) may own them (APPK-3).
   */
  async joinPending(): Promise<void> {
    // Move any received gift wraps to "unread" (idempotent), then join every
    // *unread* welcome we still hold the key package for. We iterate `getUnread()`
    // rather than trusting `decryptGiftWraps()`'s return value: a welcome the
    // `listen()` subscription already decrypted lives in "unread" but would not be
    // in a later `decryptGiftWraps()` result, so keying off the return value would
    // silently skip exactly the late-arriving welcome this path exists to join.
    await this.client.invites.decryptGiftWraps().catch(() => []);
    const unread = await this.client.invites.getUnread().catch(() => []);
    const coordinator = this.ctx.config.coordinator;
    for (const invite of unread) {
      try {
        if (!coordinator || invite.pubkey !== coordinator) {
          console.warn(
            "marmot: ignoring welcome not sealed by the event's coordinator",
            invite.id,
          );
          continue;
        }
        const joinable = await this.client.canJoinInvite(invite);
        if (!joinable) continue;
        const { group } = await this.joinAdoptingOverRemovedState(invite);
        const joined = group as unknown as MarmotGroupLike;
        // Defense in depth: the joined group's roster must actually contain the
        // coordinator's leaf — a welcome that passed the seal check but yielded
        // a coordinator-less group is purged locally (no self-remove publish:
        // we owe a hostile group no traffic) and never recorded.
        if (!groupHasMember(joined, coordinator)) {
          console.warn(
            "marmot: joined group lacks the event coordinator — purging it",
            invite.id,
          );
          await this.client.groups.destroy(group.id).catch(() => {});
          continue;
        }
        // APPK-3 / NIP §10.4: bind this event's coordinate to the joined group so
        // every later bind/send/membership check targets THIS event's room only.
        // A welcome carries no event coordinate, so with two chat events on the
        // SAME coordinator a welcome for the OTHER event is indistinguishable at
        // the MLS layer. Ground truth is the coordinator-advertised `nostr_group_id`
        // on the (member-only, ECK) roster.
        //
        // FAIL-CLOSED: a binding is ONLY ever created from a verified roster id
        // that matches this joined group. Until then the group stays an UNBOUND
        // CANDIDATE — joined in marmot's pool but never bound, so currentEventGroups()
        // gives it no listener, no history replay, no display, and no send target.
        // The old code recorded a first-verified-wins binding whenever the roster
        // carried no id yet; that could silently adopt another same-coordinator
        // event's (or an unverified) group as this event's room. currentEventGroups()
        // repairs the binding later, once the roster (re)publishes the id and matches.
        const joinedId = getNostrGroupIdHex(group.state);
        const advertised = cachedRoster(this.ctx.coordinate)?.nostr_group_id;
        const existing = await this.recordedEventGroupId();
        if (existing) {
          if (existing !== joinedId) {
            console.warn(
              "marmot: joined another group — keeping this event's existing verified binding",
            );
          }
        } else if (advertised && joinedId === advertised) {
          await this.eventGroups.setItem(this.ctx.coordinate, joinedId).catch(() => {});
        } else {
          console.warn(
            "marmot: joined group left as an unbound candidate (no verified roster id match yet)",
          );
        }
        await this.client.invites.markAsRead(invite.id).catch(() => {});
      } catch (err) {
        console.warn("marmot: welcome join failed", err);
      }
    }
  }

  /**
   * Join from a welcome, clearing our own removed-member corpse first if that is
   * the only thing in the way.
   *
   * A re-add is an Add into the SAME MLS group, so the welcome carries the same
   * `groupId` as the state we already hold — and being removed does not delete
   * that state: marmot keeps the tombstone deliberately and leaves purging to the
   * app (marmot-group.js "we keep the tombstone rather than auto-destroying").
   * `adoptClientState` then refuses the perfectly good state the join just built,
   * throwing `Group <id> already exists` against the PERSISTENT registry
   * (groups-manager.js, group-registry.js `has()` → IndexedDB). The caller used to
   * swallow that as a console warning, so `markAsRead` never ran and the same
   * welcome was retried and re-thrown on every chat open, forever: the device
   * stayed listed under "Chat devices", still held group state (so the composer
   * was enabled), and could never send. Pressing "Rejoin this chat" changed
   * nothing, because rejoin destroys no local state.
   *
   * Repair is deliberately narrow. We only discard state we have PROVEN is a
   * corpse — same group id, and no leaf of our own chat key in it — so a working
   * group is never destroyed by a stray error string. Decrypted history is
   * snapshotted and written back afterwards: `groups.destroy()` is the library's
   * only supported teardown and it purges the message history with the state,
   * which would silently cost the user their readable backlog. The re-joined group
   * has the same id, so the restored history lands in the same namespace and
   * `replayHistory` paints it exactly as before.
   *
   * Anything unexpected falls through to the original throw — the pre-existing
   * behaviour — rather than deleting something we do not understand.
   */
  private async joinAdoptingOverRemovedState(
    invite: Parameters<MarmotClient<GroupRumorHistory, undefined>["joinGroupFromWelcome"]>[0]["welcomeRumor"],
  ): Promise<Awaited<ReturnType<MarmotClient<GroupRumorHistory, undefined>["joinGroupFromWelcome"]>>> {
    try {
      return await this.client.joinGroupFromWelcome({ welcomeRumor: invite });
    } catch (err) {
      // The vendored library is pinned, so matching its message is stable; the
      // real safety comes from the corpse check below, not from this parse.
      const message = err instanceof Error ? err.message : String(err);
      const mlsIdHex = /^Group ([0-9a-f]+) already exists$/.exec(message)?.[1];
      if (!mlsIdHex) throw err;

      const existing = (await this.client.groups
        .get(mlsIdHex)
        .catch(() => undefined)) as MarmotGroupLike | undefined;
      // No leaf of ours in it ⇒ we were removed and this is the corpse. If we DO
      // hold a leaf, the welcome is for a group we are already in and dropping it
      // would destroy a working room — leave it alone and rethrow.
      if (!existing || groupHasMember(existing, this.identity.pubkey)) throw err;

      const history = namespacedStore<unknown>(
        this.kvBackend,
        this.identity.pubkey,
        `${MARMOT_NAMESPACES.history}:${mlsIdHex}`,
      );
      const saved: [string, unknown][] = [];
      for (const key of await history.keys().catch(() => [])) {
        const value = await history.getItem(key).catch(() => null);
        if (value !== null) saved.push([key, value]);
      }

      console.warn("marmot: discarding removed-member state to adopt the re-invite", mlsIdHex);
      await this.client.groups.destroy(mlsIdHex);
      const joined = await this.client.joinGroupFromWelcome({ welcomeRumor: invite });

      for (const [key, value] of saved) await history.setItem(key, value).catch(() => undefined);
      return joined;
    }
  }

  /**
   * True when we hold this event's group AND our own chat key still holds a leaf
   * in it — i.e. we are actually a member, not just a client with leftover state.
   *
   * The distinction is the whole bug: an MLS Remove strips our leaf but leaves our
   * local group state (and its decrypted history) exactly where it was, so "do we
   * have the group?" answers yes for a member who has been removed. Every check
   * that means "are we in the room?" has to ask this instead.
   */
  private async isEventGroupMember(): Promise<boolean> {
    const groups = await this.currentEventGroups();
    return groups.some((g) => groupHasMember(g, this.identity.pubkey));
  }

  /**
   * True when we hold this event's group but are no longer in it — removed, as
   * opposed to never added. The two need different treatment: a removed client's
   * advertised key package has already been spent, a not-yet-added one's has not.
   */
  private async isEvictedFromEventGroup(): Promise<boolean> {
    const groups = await this.currentEventGroups();
    return groups.length > 0 && !groups.some((g) => groupHasMember(g, this.identity.pubkey));
  }

  /** The nostr_group_id recorded for THIS event's verified join, if any. */
  private async recordedEventGroupId(): Promise<string | undefined> {
    return (await this.eventGroups.getItem(this.ctx.coordinate).catch(() => null)) ?? undefined;
  }

  /**
   * The joined group(s) belonging to the CURRENT event — at most one in
   * practice (audit APPK-3). Everything that binds, sends, replays, or checks
   * membership goes through here instead of `groups.loadAll()` so attending
   * two chat-enabled events never mixes messages or misdelivers a send.
   *
   * Ground truth is the coordinator-advertised `nostr_group_id` on this event's
   * (member-only, ECK) roster: the authoritative event→group binding an MLS
   * Welcome cannot carry. We resolve THIS event's group deterministically
   * against that id instead of guessing "the single coordinator-verified group"
   * — the old guess silently adopted another same-coordinator event's already-
   * joined group, which could misdeliver an OUTGOING message (audit APPK-3).
   *
   * Results are ordered so a state we still hold a leaf in comes first. Being
   * removed and re-added leaves TWO states for one `nostr_group_id` — the dead
   * pre-removal one and the live post-Welcome one — and `groups[0]` is what sends
   * route to, so without this a rejoin could "succeed" and still send into the
   * corpse. Ordering rather than filtering keeps the dead state bound, so the
   * history it holds still replays into the room.
   */
  private async currentEventGroups(): Promise<MarmotGroupLike[]> {
    const groups = await this.resolveEventGroups();
    if (groups.length < 2) return groups;
    return [
      ...groups.filter((g) => groupHasMember(g, this.identity.pubkey)),
      ...groups.filter((g) => !groupHasMember(g, this.identity.pubkey)),
    ];
  }

  /** {@link currentEventGroups} without the own-leaf ordering (roster resolution only). */
  private async resolveEventGroups(): Promise<MarmotGroupLike[]> {
    const all = (await this.client.groups.loadAll().catch(() => [])) as MarmotGroupLike[];
    const recorded = await this.recordedEventGroupId();
    // Cheap, hot-path-safe: the roster is fetched+cached by the People/event
    // screens, so the send/bind path reads it without a network round-trip.
    const advertised = cachedRoster(this.ctx.coordinate)?.nostr_group_id;

    if (recorded) {
      // A recorded binding that contradicts the authoritative roster is a stale
      // or (pre-fix) mis-bound entry: nothing re-points it on its own, because the
      // bind path only ran on a MISSING binding. Reconcile against the roster —
      // but the CACHE itself can be stale (decrypted+cached before the coordinator
      // started advertising nostr_group_id, or before this event's group existed),
      // in which case it silently omits the field and looks identical to "no id
      // yet". Nothing else on the chat-open path is guaranteed to have refreshed
      // it (only the People/Admin screens warm this cache), so a wrong recorded
      // binding could otherwise never self-heal. Try one live read before giving
      // up — same "cache first, then one network read" shape as the no-binding
      // branch below. Memoized per client: if the cache never warms, every later
      // call reuses what that one live fetch found instead of re-fetching (which
      // would hammer the relay on every send) OR silently reverting to trusting
      // `recorded` again (which would UN-DO the refusal below on the very next
      // call, since the cache still can't prove it wrong the second time).
      let liveAdvertised = advertised;
      if (!liveAdvertised) {
        this.liveRosterFetch ??= fetchRoster(this.ctx)
          .then((r) => r?.nostr_group_id)
          .catch(() => undefined);
        liveAdvertised = await this.liveRosterFetch;
      }
      // FAIL-CLOSED (NIP §10.4): with NO roster id available at all — cold/stale
      // cache AND a failed or id-less live fetch — we cannot confirm the recorded
      // binding still names this event's group. Refuse to route rather than trust an
      // unverifiable binding (a binding is only ever created from a verified roster
      // id, but a legacy pre-fix install may hold a fail-open one). Chat stays
      // "setting up" until the roster republishes the id.
      if (!liveAdvertised) {
        console.warn(
          "marmot: no roster-advertised group id to confirm the recorded binding — refusing to route (fail-closed)",
        );
        return [];
      }
      if (liveAdvertised !== recorded) {
        const match = all.filter((g) => safeGroupIdHex(g) === liveAdvertised);
        if (match.length > 0) {
          // We hold this event's real group — re-point the binding to it.
          await this.eventGroups.setItem(this.ctx.coordinate, liveAdvertised).catch(() => {});
          return match;
        }
        // The roster names a group we have NOT joined. The recorded binding is
        // provably wrong, so returning it would misdeliver; refuse to route until
        // we're actually added to this event's group (a heal republish follows).
        console.warn(
          "marmot: recorded group binding disagrees with the roster and the correct group isn't joined — refusing to route",
        );
        return [];
      }
      return all.filter((g) => safeGroupIdHex(g) === recorded);
    }

    // No recorded binding (a pre-scoping install, or not yet joined). Bind
    // deterministically to the group the roster names — cache first, then one
    // network read (this branch stops running as soon as a binding is recorded).
    const groupId = advertised ?? (await fetchRoster(this.ctx).catch(() => undefined))?.nostr_group_id;
    if (groupId) {
      const match = all.filter((g) => safeGroupIdHex(g) === groupId);
      if (match.length > 0) {
        await this.eventGroups.setItem(this.ctx.coordinate, groupId).catch(() => {});
        return match;
      }
      // The roster names this event's group but we haven't joined it yet — we're
      // simply not a member of THIS event's room. Never adopt a different joined
      // group (that is exactly the misdelivery this fix removes).
      return [];
    }

    // The roster advertises no id (a coordinator that predates APPK-3, or no
    // group exists yet). A correct mechanism now exists, so we deliberately do
    // NOT fall back to the old "single coordinator-verified group" guess — that
    // guess is what misrouted a send across two same-coordinator events. Treat
    // the event as unbound (chat stays "setting up") until the roster republishes
    // with the id; this degrades gracefully instead of risking the wrong room.
    if (all.length > 0) {
      console.warn(
        "marmot: no roster-advertised group id and no recorded binding — refusing to guess the room",
      );
    }
    return [];
  }

  /** Attach message/state listeners to THIS EVENT's group(s) (idempotent). */
  private async bindAllGroups(): Promise<void> {
    const groups = await this.currentEventGroups();
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
      // Paint the durable history for this group immediately, so a re-open shows
      // the whole conversation (not just what arrives live after this mount). The
      // live `connectAll` backfill then adds anything sent while we were away; both
      // flow through onMessage, which de-dupes by rumor id (§5).
      await this.replayHistory(group);
    }
  }

  /**
   * Emit every persisted decrypted message for a group through `onMessage`. marmot
   * auto-saves each ingested/sent application message into `group.history`
   * (KeyValueRumorHistoryBackend, IndexedDB), so this is a local read — no relay,
   * no re-decrypt of past ciphertext (which the forward-only ratchet couldn't do
   * anyway). Best-effort: a missing/empty history just yields nothing.
   */
  private async replayHistory(group: {
    history?: { queryRumors(filters: unknown): Promise<unknown[]> };
  }): Promise<void> {
    try {
      const rumors = await group.history?.queryRumors({
        kinds: [CHAT_KIND_TEXT, CHAT_KIND_REACTION, CHAT_KIND_EDIT],
      });
      for (const rumor of rumors ?? []) {
        try {
          this.onMessage?.(rumorToChatMessage(rumor as Parameters<typeof rumorToChatMessage>[0]));
        } catch (err) {
          console.warn("marmot: dropped malformed history rumor", err);
        }
      }
    } catch (err) {
      console.warn("marmot: history replay failed", err);
    }
  }

  /** The nostr_group_id (hex) of THIS EVENT's group, for a 445 `#h` filter. */
  async nostrGroupId(): Promise<string | undefined> {
    const groups = await this.currentEventGroups();
    const group = groups[0];
    return group ? getNostrGroupIdHex(group.state) : undefined;
  }

  /** Send a kind-9 chat message to THIS EVENT's group. Convergence-gated (§2). */
  async send(text: string): Promise<void> {
    const groups = await this.currentEventGroups();
    const group = groups[0];
    if (!group) throw new Error("no joined chat group yet");
    const { rumor, intent } = buildChatSend(this.identity.pubkey, text);
    await this.client.groups.send(group.id, intent);
    // Optimistic local echo (Bug 4): marmot does not deliver our own application
    // message back to us over the 445 subscription, so the sender would otherwise
    // never see what they sent. Surface it through the same `onMessage` path; it
    // de-dupes by inner rumor id, so a real echo (if one ever arrives) can't double
    // up. `roundTripChatRumor` reproduces the exact bytes the group emits.
    try {
      this.onMessage?.(roundTripChatRumor(rumor as unknown as Parameters<typeof roundTripChatRumor>[0]));
    } catch (err) {
      console.warn("marmot: local echo of sent message failed", err);
    }
  }

  /**
   * Eviction/heal (§5): if IndexedDB was purged our leaf is gone and we hold no
   * group. Republish a fresh key package under the same slot so the coordinator's
   * 30443 watcher re-adds us; a new welcome then arrives and chat resumes from the
   * new epoch (messages in the gap are forward-secret, not recoverable). Returns
   * true when a heal republish was issued.
   *
   * NOTE this only covers the case where the coordinator holds NO leaf for us and
   * has not yet consumed our advertised key package. When either is false the
   * republish is a silent no-op on both sides — {@link rejoin} is the escalation
   * that actually breaks that deadlock.
   */
  async healIfEvicted(): Promise<boolean> {
    const groups = await this.currentEventGroups();
    if (groups.length > 0) return false;
    // No group state FOR THIS EVENT (APPK-3) — (re)publish identity artifacts
    // to trigger a fresh add.
    await this.ensurePublished();
    return true;
  }

  /**
   * Ask the coordinator to add this device to the event's group again — the
   * recovery for a device that is a *listed* chat device of an approved attendee
   * (it shows up in the roster's `chat_keys`, so ChatHandoffCard lists it) yet holds
   * no usable group, so every send fails with "no joined chat group yet".
   *
   * Simply republishing (what {@link healIfEvicted} does) cannot fix that state,
   * because a plain re-advertisement is a no-op at three separate points:
   *
   *  1. marmot's `keyPackages.ensurePublished` returns the existing *unused* local
   *     key package, and "used" is only set by a successful join — so a member
   *     whose welcome never arrived re-advertises the SAME kind-30443 event
   *     forever (same `d` slot, same content ⇒ same event id);
   *  2. the coordinator dedupes by that event id (`marmot_consumed_kps`, 30 days),
   *     so the re-advertised key package is dropped before anything else runs;
   *  3. even a fresh key package is skipped while the coordinator still holds a
   *     leaf for us — its "already a member" check treats us as present when, from
   *     our side, we are not.
   *
   * So the sequence here is deliberately: revoke this device (drops the stale leaf
   * so 3 no longer holds), rotate the key package (a NEW event id, so 1 and 2 no
   * longer hold), then re-attest, which lands as an ordinary first-time enrolment
   * on the coordinator (`handleAttestation` → `syncMember` → Add + Welcome).
   *
   * Same-device-key throughout: the account's device slot, its label and its
   * `chat_keys` roster entry are reused rather than burning one of the
   * MAX_CHAT_KEYS_PER_ACCOUNT slots on a freshly-minted identity (the manual
   * workaround this replaces — clearing site data — burns one every time).
   *
   * History from before the new Add stays unreadable: MLS is forward-secret, and
   * no recovery path can change that.
   */
  async rejoin(opts?: { force?: boolean }): Promise<void> {
    // Don't tear down a working membership on a misclick — but "working" means our
    // leaf is still in the group, NOT merely that we hold group state. Guarding on
    // the latter made this a silent no-op for the one state it exists to fix: a
    // removed member, who keeps the group and its history and can no longer send
    // (prod 2026-07-30 — pressing Rejoin reported success and published nothing).
    //
    // `force` is for the UI's button, which is only reachable after a send has
    // actually failed or setup has stalled. There, the user's evidence beats ours:
    // a client that never processed its own removal commit still believes it holds
    // a leaf, and refusing would strand exactly the person asking for help.
    if (!opts?.force && (await this.isEventGroupMember())) return;
    // A previous fail-closed refusal may have memoized "the roster advertises no
    // group id" for the life of this client (see currentEventGroups). Drop it, or
    // the rejoin below succeeds and routing still refuses afterwards.
    this.liveRosterFetch = undefined;
    // 1. Revoke: the coordinator removes every leaf of this chat key (§3.3). Sent
    //    FIRST so the re-add below can never be processed as "already a member".
    await sendChatKeyAttestation(this.accountSigner, this.ctx, {
      op: "revoke",
      chatPubkey: this.identity.pubkey,
    });
    // 2. Rotate the key package (same `d` slot, so the relay replaces in place —
    //    new event id, new init key, nothing the coordinator has consumed) and
    //    re-attest: `ensurePublished` re-sends op:"add" with a fresh proof of
    //    possession, re-activating the same device row and driving syncMember.
    //    Forced past the membership check: when the caller forced this rejoin, our
    //    own state may still (wrongly) believe we hold a leaf.
    await this.ensurePublished({ force: true, rotate: true });
    // 4. Pick up a welcome that is already waiting; later ones arrive through the
    //    `decrypted` listener start() installed.
    await this.joinPendingAndBind();
  }

  /**
   * Publish a NEW kind-30443 under this device's existing slot, retiring the old
   * one's private material. `rotate` needs the local ref of the package to replace;
   * with none stored (a client that never published, or whose local key-package
   * store was cleared) this falls back to a plain create — the same slot either
   * way, so the relay replaces rather than accumulates.
   */
  private async rotateKeyPackage(): Promise<void> {
    const opts = { relays: this.relays, client: "nostrautica-web" };
    const stored = await this.client.keyPackages.list().catch(() => []);
    // Prefer this device's own slot; `list()` can also hold packages tracked from
    // relays (no private material), which cannot be rotated.
    const mine = stored.find((k) => k.identifier === this.identity.clientId) ?? stored[0];
    if (mine) {
      await this.client.keyPackages.rotate(mine.keyPackageRef, {
        ...opts,
        d: this.identity.clientId,
      });
      return;
    }
    await this.client.keyPackages.create({ ...opts, identifier: this.identity.clientId });
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

/** The slice of a marmot `MarmotGroup` this wrapper uses (structural — tests fake it). */
interface MarmotGroupLike {
  id: Uint8Array;
  idStr: string;
  state: Parameters<typeof getNostrGroupIdHex>[0];
  history?: { queryRumors(filters: unknown): Promise<unknown[]> };
  on: (event: string, fn: (...args: any[]) => void) => void;
}

/** nostr_group_id hex for a group, or undefined when the state can't yield one. */
function safeGroupIdHex(group: MarmotGroupLike): string | undefined {
  try {
    return getNostrGroupIdHex(group.state);
  } catch {
    return undefined;
  }
}

/**
 * True when `pubkey` holds at least one leaf in the group's MLS roster — the
 * account-identity-proof binding (marmot-ts maps each credential to a nostr
 * pubkey). Used for post-join coordinator verification (audit APPK-2) and the
 * pre-event-scoping migration (audit APPK-3).
 */
function groupHasMember(group: MarmotGroupLike, pubkey: string): boolean {
  try {
    return getPubkeyLeafNodes(group.state, pubkey).length > 0;
  } catch {
    return false;
  }
}
