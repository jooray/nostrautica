/**
 * The Marmot admin bot's decision logic (MARMOT-GROUP-CHAT §4.2), kept free of any
 * direct marmot-ts coupling so it is unit-testable against a {@link ChatMls} fake.
 *
 * Responsibilities:
 *  - one MLS group per chat-enabled event ({@link ensureGroup});
 *  - authenticate kind-21607 chat-key attestations and bind account⇄chat-key;
 *  - add members on approval / on a fresh authorized key package (the single
 *    mechanism that serves initial-add, multi-device, and eviction-heal);
 *  - remove members on revoke (real MLS Remove → forward secrecy);
 *  - ingest kind-445 traffic so the coordinator stays converged.
 *
 * A chat-off event never reaches here: the coordinator only constructs the admin's
 * group and subscriptions when `isMarmotChatEnabled` holds.
 */
import type { Store } from "../store/db.js";
import type { ChatMls } from "./mls.js";
import {
  verifyChatDeviceProof,
  MAX_CHAT_KEYS_PER_ACCOUNT,
  type ChatKeyAttestationContent,
} from "@nostrautica/protocol";

type AnyEvent = { id: string; pubkey: string; kind: number; tags: string[][]; [k: string]: unknown };

export interface MarmotAdminDeps {
  store: Store;
  mls: ChatMls;
  now: () => number;
  /** The coordinator's own pubkey (hex) — always retained in the admin set. */
  coordinatorPubkey: string;
  /** Fetch kind-30443 key packages authored by `authors` for this event. */
  fetchKeyPackages(coordinate: string, authors: string[]): Promise<AnyEvent[]>;
  log?: (msg: string) => void;
}

export class MarmotAdmin {
  private readonly store: Store;
  private readonly mls: ChatMls;
  private readonly now: () => number;
  private readonly coordinatorPubkey: string;
  private readonly fetchKeyPackages: (coordinate: string, authors: string[]) => Promise<AnyEvent[]>;
  private readonly log: (msg: string) => void;

  constructor(deps: MarmotAdminDeps) {
    this.store = deps.store;
    this.mls = deps.mls;
    this.now = deps.now;
    this.coordinatorPubkey = deps.coordinatorPubkey;
    this.fetchKeyPackages = deps.fetchKeyPackages;
    this.log = deps.log ?? (() => {});
  }

  // ── group lifecycle ────────────────────────────────────────────────────────
  /** Create the event's group if absent; returns its MLS + routing ids. */
  async ensureGroup(opts: {
    coordinate: string;
    name: string;
    description: string;
    relays: string[];
    adminPubkeys?: string[];
  }): Promise<{ mlsGroupIdHex: string; nostrGroupIdHex: string }> {
    const existing = this.store.getMarmotGroup(opts.coordinate);
    if (existing) {
      // A frozen group re-activates when chat is toggled back on (§9 Q4).
      if (existing.status === "frozen") this.store.setMarmotGroupStatus(opts.coordinate, "active");
      // Reconcile the admin set on every ensureGroup: organizers approved (or
      // whose chat devices changed) while chat was frozen/offline are promoted
      // now, and a coordinator that lost its admin state re-asserts it.
      await this.syncAdmins(opts.coordinate);
      return { mlsGroupIdHex: existing.mls_group_id, nostrGroupIdHex: existing.nostr_group_id };
    }
    // Create with the coordinator + any already-approved organizer chat devices
    // as admins (usually just the coordinator at creation time; organizers are
    // promoted as they approve/attest — see syncAdmins).
    const ids = await this.mls.createGroup({
      name: opts.name,
      description: opts.description,
      relays: opts.relays,
      adminPubkeys: opts.adminPubkeys ?? this.desiredAdminPubkeys(opts.coordinate),
    });
    this.store.upsertMarmotGroup({
      coordinate: opts.coordinate,
      mlsGroupId: ids.mlsGroupIdHex,
      nostrGroupId: ids.nostrGroupIdHex,
      status: "active",
      now: this.now(),
    });
    this.log(`[chat] created MLS group for ${opts.coordinate} (nostr_group_id ${ids.nostrGroupIdHex.slice(0, 12)}…)`);
    return ids;
  }

  /** Stop adding/welcoming members; the group itself lives on (§9 Q4 freeze). */
  freeze(coordinate: string): void {
    if (this.store.getMarmotGroup(coordinate)) {
      this.store.setMarmotGroupStatus(coordinate, "frozen");
      this.log(`[chat] froze group for ${coordinate} (chat tag removed)`);
    }
  }

  private activeGroup(coordinate: string): { mls_group_id: string } | undefined {
    const g = this.store.getMarmotGroup(coordinate);
    return g && g.status === "active" ? g : undefined;
  }

  /**
   * Self-heal a group's routing relays (marmot.transport.nostr.routing.v1):
   * additively union in `relays`, a no-op if they're already all present.
   * Fixes groups created before a relay (e.g. a peer client's own relay) was
   * added to the coordinator's defaults — without this, an already-created
   * group's baked-in routing state never picks up a later default change.
   */
  async ensureRelays(coordinate: string, relays: string[]): Promise<void> {
    const group = this.activeGroup(coordinate);
    if (!group) return;
    await this.mls.ensureRelays(group.mls_group_id, relays);
  }

  // ── authorized chat identities ─────────────────────────────────────────────
  /**
   * The chat identities eligible to be added for ONE account (audit P6, maintainer
   * decision — ATTESTED DEVICES ONLY): every ACTIVE attested chat device key bound
   * to this account via an authenticated kind-21607 attestation (§3.2, §10.1).
   *
   * The attendee's ACCOUNT pubkey is NOT included. Pre-fix it was always eligible,
   * so any kind-30443 key package signed by the account key could be added to the
   * group WITHOUT a 21607 possession proof, a label, a roster `chat_keys` entry, or
   * a slot in the five-device cap — bypassing v2's per-device authorization,
   * visibility, and revocation model (and it could promote an organizer account key
   * straight to MLS admin). Under v2, a chat identity exists only once it has a
   * proven, roster-visible, cap-bounded device attestation. A local-key attendee
   * simply attests its own key as a device (op:"add" with a self-proof) like any
   * other; there is no implicit account-key path.
   */
  authorizedIdentities(coordinate: string, accountPubkey: string): string[] {
    return this.store
      .chatKeysForAccount(coordinate, accountPubkey)
      .filter((k) => k.status === "active")
      .map((k) => k.chat_pubkey);
  }

  /**
   * Every chat identity the coordinator will add for this event — the union over
   * APPROVED attendees of their authorized identities. This is both the 30443
   * watcher's author set and the authentication gate: a key package whose author
   * is not in this set is not an approved attendee's authorized chat identity and
   * is never added (§4.1: "authenticated via the kind-21607 attestations").
   */
  eligibleChatAuthors(coordinate: string): string[] {
    const authors = new Set<string>();
    for (const a of this.store.approvedAttendees(coordinate)) {
      for (const id of this.authorizedIdentities(coordinate, a.pubkey)) authors.add(id);
    }
    return [...authors];
  }

  // ── second MLS admin: organizer device promotion (§13.2 recovery) ─────────
  /**
   * The MLS admin set this event SHOULD have: the coordinator itself plus every
   * ACTIVE authorized chat identity of every APPROVED organizer-role attendee.
   * Promoting an organizer's own chat device keys to co-admin is what makes a
   * coordinator-DB loss survivable — an organizer device can still add/remove
   * members and rotate metadata when the coordinator's admin state is gone.
   * The coordinator is ALWAYS retained: dropping it would lock the running bot
   * out of admin commits.
   */
  desiredAdminPubkeys(coordinate: string): string[] {
    const admins = new Set<string>([this.coordinatorPubkey]);
    for (const a of this.store.approvedAttendees(coordinate)) {
      if (a.role !== "organizer") continue;
      for (const id of this.authorizedIdentities(coordinate, a.pubkey)) admins.add(id);
    }
    return [...admins];
  }

  /** Reconcile the group's on-chain admin set with {@link desiredAdminPubkeys}. */
  async syncAdmins(coordinate: string): Promise<void> {
    const group = this.activeGroup(coordinate);
    if (!group) return;
    const desired = this.desiredAdminPubkeys(coordinate);
    await this.mls.setAdmins(group.mls_group_id, desired);
  }

  /** True if `accountPubkey` is an approved organizer-role attendee of this event. */
  private isOrganizer(coordinate: string, accountPubkey: string): boolean {
    const a = this.store.getAttendee(coordinate, accountPubkey);
    return a?.role === "organizer";
  }

  /** Re-sync admins only when the changed account is an organizer (cheap gate). */
  private async maybeSyncAdmins(coordinate: string, accountPubkey: string): Promise<void> {
    if (this.isOrganizer(coordinate, accountPubkey)) await this.syncAdmins(coordinate);
  }

  // ── watcher fast-path gate (audit COORD-17) ───────────────────────────────
  // The 30443 watcher fires for EVERY key package anyone publishes on public
  // relays; computing eligibleChatAuthors (a DB walk) per event is a DoS surface.
  // Cache the eligible-author set per event and drop unknown authors before any
  // DB hit. Invalidated on approve/attest/revoke via invalidateEligibility().
  private readonly eligibleCache = new Map<string, Set<string>>();

  /** Drop the cached eligible-author set (call on approve/attest/revoke). */
  invalidateEligibility(coordinate: string): void {
    this.eligibleCache.delete(coordinate);
  }

  private eligibleAuthorSet(coordinate: string): Set<string> {
    let set = this.eligibleCache.get(coordinate);
    if (!set) {
      set = new Set(this.eligibleChatAuthors(coordinate));
      this.eligibleCache.set(coordinate, set);
    }
    return set;
  }

  // ── add paths ──────────────────────────────────────────────────────────────
  /**
   * Sync one approved attendee into the group: fetch the current 30443s for each
   * of their authorized chat identities and add every valid, unconsumed one. This
   * one routine serves approval, multi-device, and eviction-heal.
   */
  async syncMember(
    coordinate: string,
    accountPubkey: string,
    opts?: { reenrolling?: string },
  ): Promise<void> {
    const group = this.activeGroup(coordinate);
    if (!group) return;
    const attendee = this.store.getAttendee(coordinate, accountPubkey);
    if (!attendee || attendee.status !== "approved") return;
    const authors = this.authorizedIdentities(coordinate, accountPubkey);
    const kps = await this.fetchKeyPackages(coordinate, authors);
    const authorized = new Set(authors);
    for (const kp of kps) {
      if (!authorized.has(kp.pubkey)) continue; // relay returned an unrelated author
      // `reconcile`: this path is a DELIBERATE "bring this member up to date" —
      // approval, a fresh attestation, or the startup backfill — so it also repairs
      // an attested device that holds no leaf despite its key package having been
      // consumed. `reenrolling` is narrower: it names the ONE device that just
      // attested for THIS event, and is the only thing that may drop a live leaf.
      // See tryAddKeyPackage.
      await this.tryAddKeyPackage(coordinate, group.mls_group_id, kp, {
        reconcile: true,
        reenrolling: opts?.reenrolling,
      });
    }
    // An approved organizer's device landing in the group must also be an admin.
    await this.maybeSyncAdmins(coordinate, accountPubkey);
  }

  /**
   * Handle a single kind-30443 from the watcher subscription (§4.2). The event's
   * author must be an approved attendee's authorized chat identity; otherwise it
   * is ignored (an unauthenticated key package is never added). Unknown authors
   * are dropped against the cached eligible set BEFORE any DB hit (COORD-17).
   */
  async handleKeyPackageEvent(coordinate: string, event: AnyEvent): Promise<void> {
    if (!this.eligibleAuthorSet(coordinate).has(event.pubkey)) {
      this.log(`[chat] ignored 30443 from ${event.pubkey.slice(0, 8)}: not an authorized chat identity`);
      return;
    }
    const group = this.activeGroup(coordinate);
    if (!group) return;
    await this.tryAddKeyPackage(coordinate, group.mls_group_id, event);
  }

  /**
   * Idempotent add of one authorized key package; records consumption.
   *
   * `reconcile` (the {@link syncMember} paths only) additionally RETRIES a key
   * package this event has already consumed when its author holds no leaf. That
   * combination is the signature of a member who never actually made it into the
   * group — the Add threw after the id was recorded, the Welcome was lost, or the
   * member was removed and their client still advertises the same kind-30443 —
   * and the plain consumption check turned it into a 30-day dead end: the client
   * re-advertises an identical (addressable, same-`d`) event, so the id never
   * changes and no later pass ever reconsiders it. Membership is the ground truth,
   * so a device that isn't in the group gets another attempt whenever the
   * coordinator is deliberately syncing that member (approval, attestation,
   * startup backfill). The passive 30443 watcher keeps the cheap id check, so a
   * relay replaying old key packages can't drive repeated Add commits.
   *
   * `reenrolling` names the chat pubkey whose kind-21607 attestation for THIS
   * event triggered the sync. It is the only warrant for dropping a leaf we
   * still hold (see the `member` branch below); `reconcile` alone is not,
   * because it is also true for the startup backfill and for a sibling device's
   * attestation, neither of which says anything about THIS device's state.
   */
  private async tryAddKeyPackage(
    coordinate: string,
    mlsGroupId: string,
    kp: AnyEvent,
    opts?: { reconcile?: boolean; reenrolling?: string },
  ): Promise<void> {
    const consumed = this.store.isKpConsumed(coordinate, kp.id);
    if (consumed && !opts?.reconcile) return;
    const member = await this.mls.isMember(mlsGroupId, kp.pubkey);
    // Passive watcher, and they're already in: nothing to do — and crucially, do
    // NOT record this key package as consumed. A client re-enrolling publishes its
    // rotated key package a beat BEFORE the attestation that explains it, so the
    // watcher sees it first; consuming it here spends the one artifact the
    // attestation's reconcile needs moments later, and the member stays stuck with
    // both sides silent (prod 2026-07-30: 30443 f09b5d6d consumed by the watcher,
    // the attestation one second later then found nothing to add). The id check is
    // only a dedupe, so leaving it unrecorded costs one local membership read per
    // relay replay and nothing else.
    if (member && !opts?.reconcile) return;
    // Deliberate sync, they're in, and this key package is already spent: there is
    // nothing new to act on.
    if (member && consumed) return;
    // They're in and the key package is fresh — but a fresh key package is NOT by
    // itself evidence that this device left the room, because one 30443 slot is
    // shared across every event the device is in. Rotating it to re-enrol in event
    // A makes it look brand new to event B as well, and the triggers that don't
    // come from the device (startup backfill — which runs on every coordinator
    // restart, so every deploy — or a SIBLING device's attestation) would then
    // evict a member of B who was never in trouble. Only the device's own
    // attestation for THIS event speaks to this device's membership here.
    if (member && opts?.reenrolling !== kp.pubkey) {
      this.log(
        `[chat] keeping ${kp.pubkey.slice(0, 8)} in ${coordinate}: fresh 30443 ${kp.id.slice(0, 8)} but no re-enrolment attestation for this event (likely rotated for another event)`,
      );
      return;
    }
    if (!(await this.mls.isEligible(mlsGroupId, kp))) {
      this.store.markKpConsumed(coordinate, kp.id); // ineligible (e.g. ciphersuite) → don't re-eval
      this.log(`[chat] 30443 ${kp.id.slice(0, 8)} from ${kp.pubkey.slice(0, 8)} ineligible`);
      return;
    }
    if (consumed) {
      this.log(
        `[chat] re-adding ${kp.pubkey.slice(0, 8)} to ${coordinate}: attested device holds no leaf despite 30443 ${kp.id.slice(0, 8)} being consumed`,
      );
    }
    if (member) {
      // Reaching here means THIS device attested re-enrolment for THIS event (the
      // guard above), so the two sides genuinely disagree about whether it is in
      // the room — and the device is the one that can tell: it only re-attests
      // while it holds no membership of its own, and it only publishes a FRESH key
      // package when re-enrolling. Our leaf says yes, its state says no — and its
      // state is the one that has to decrypt. Trust it: drop the stale leaf, then
      // add the new key package below.
      //
      // Prod 2026-07-30: without this the re-attestation hit the "already a member"
      // short-circuit, silently consumed the new key package, and left the member
      // unable to send with nothing logged. Deliberately NOT done for the passive
      // 30443 watcher, nor for any sync this device didn't ask for: one key-package
      // slot is shared across events, so a rotation driven by ANOTHER event would
      // otherwise churn this group's epoch — or evict a healthy member outright.
      this.log(
        `[chat] re-enrolling ${kp.pubkey.slice(0, 8)} in ${coordinate}: fresh 30443 ${kp.id.slice(0, 8)} from a device we still hold a leaf for — removing it first`,
      );
      await this.mls.removePubkeys(mlsGroupId, [kp.pubkey]);
    }
    try {
      await this.mls.invite(mlsGroupId, kp); // Add commit + Welcome (marmot delivers)
      this.store.markKpConsumed(coordinate, kp.id);
      this.log(`[chat] added ${kp.pubkey.slice(0, 8)} to ${coordinate} from 30443 ${kp.id.slice(0, 8)}`);
    } catch (e) {
      // A single malformed/incompatible key package (e.g. a proof version our
      // vendored marmot-ts can't decode yet, from a newer peer client) must
      // never take down the whole coordinator process — every OTHER event's
      // chat and every OTHER attendee's add depends on this loop finishing
      // (prod incident 2026-07-20: an uncaught throw here during startup
      // backfill crashed the process). Left unconsumed, not ineligible, so
      // it's retried (and can succeed) once the library gains support.
      this.log(
        `[chat] 30443 ${kp.id.slice(0, 8)} from ${kp.pubkey.slice(0, 8)} invite FAILED: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  /** Backfill every approved attendee into the group (config toggled on, §4.2). */
  async backfillApproved(coordinate: string): Promise<void> {
    for (const a of this.store.approvedAttendees(coordinate)) {
      await this.syncMember(coordinate, a.pubkey);
    }
  }

  // ── attestations (21607) ───────────────────────────────────────────────────
  /**
   * Record an authenticated chat-key attestation. `accountPubkey` is the SEAL
   * AUTHOR the coordinator already bound via `unwrapRumor`, so the binding is
   * authenticated by the account key itself (§3.3). The account must be an enrolled
   * attendee of this event; an attestation from a stranger is rejected. Only when
   * the account is approved is the new key actually synced into the group — an
   * "add" from a still-pending attendee (the enrol-at-approval-time flow) is
   * *recorded* so it's picked up on approval, but never synced to the group until
   * then. A "revoke" from a non-approved account is rejected outright.
   *
   * Revoke authorization (audit COORD-1): the target key must already be bound to
   * THIS account (or be the account key itself) — an enrolled stranger can never
   * evict another member's key. Rebinding a chat_pubkey already owned by another
   * account is likewise refused at the store layer (audit COORD-10).
   *
   * Proof of possession (NIP §10.2): an `op:"add"` MUST carry a `proof` — a BIP-340
   * signature by the chat DEVICE key over the §10.2 challenge (binding coordinate,
   * account, chat pubkey, and the rumor's `created_at`). Without a valid proof the
   * add is rejected, so an account can no longer bind a chat key it doesn't control.
   * The rumor's `created_at` is passed in because it is part of the signed challenge.
   *
   * @returns true if the attestation was accepted (recorded), false if rejected.
   */
  async handleAttestation(
    coordinate: string,
    accountPubkey: string,
    content: ChatKeyAttestationContent,
    createdAt: number,
  ): Promise<boolean> {
    if (content.a !== coordinate) return false;
    const attendee = this.store.getAttendee(coordinate, accountPubkey);
    if (!attendee) {
      this.log(`[chat] REJECTED 21607 from ${accountPubkey.slice(0, 8)}: not an enrolled attendee`);
      return false;
    }
    if (content.op === "add") {
      // Proof of possession (NIP §10.2): the chat DEVICE key must sign the challenge
      // that binds this (coordinate, account, chat pubkey, created_at). The schema
      // already requires `proof` on add; re-verify the signature here before binding.
      if (
        !content.proof ||
        !verifyChatDeviceProof(content.proof, coordinate, accountPubkey, content.chat_pubkey, createdAt)
      ) {
        this.log(
          `[chat] REJECTED 21607 add from ${accountPubkey.slice(0, 8)}: invalid/missing proof of possession for ${content.chat_pubkey.slice(0, 8)}`,
        );
        return false;
      }
      // Per-account device cap (NIP §10.1): at most MAX_CHAT_KEYS_PER_ACCOUNT active
      // keys per account per event. A refresh of an already-active key doesn't count
      // against the cap; activating a NEW (or previously-revoked) key beyond it does.
      const active = this.store
        .chatKeysForAccount(coordinate, accountPubkey)
        .filter((k) => k.status === "active");
      const alreadyActive = active.some((k) => k.chat_pubkey === content.chat_pubkey);
      if (!alreadyActive && active.length >= MAX_CHAT_KEYS_PER_ACCOUNT) {
        this.log(
          `[chat] REJECTED 21607 add from ${accountPubkey.slice(0, 8)}: account already at the ${MAX_CHAT_KEYS_PER_ACCOUNT}-device cap`,
        );
        return false;
      }
      const recorded = this.store.upsertChatKey({
        coordinate,
        accountPubkey,
        chatPubkey: content.chat_pubkey,
        clientId: content.client_id ?? null,
        label: content.label ?? null,
        status: "active",
        now: this.now(),
      });
      if (!recorded) {
        this.log(
          `[chat] REJECTED 21607 add from ${accountPubkey.slice(0, 8)}: chat key ${content.chat_pubkey.slice(0, 8)} already bound to another account`,
        );
        return false;
      }
      this.log(`[chat] bound chat key ${content.chat_pubkey.slice(0, 8)} → ${accountPubkey.slice(0, 8)}`);
      this.invalidateEligibility(coordinate);
      // The attesting device named itself, and `content.a === coordinate` was
      // checked above — so this, and only this, authorizes dropping a leaf we
      // still hold for that device (tryAddKeyPackage's `member` branch).
      if (attendee.status === "approved")
        await this.syncMember(coordinate, accountPubkey, { reenrolling: content.chat_pubkey });
      return true;
    }
    // op === "revoke": drop the key and remove its leaves (lost device, §3.3).
    // Only an APPROVED account may revoke, and only a key it owns (its own account
    // key or a chat key already bound to it) — never another member's (COORD-1).
    if (attendee.status !== "approved") {
      this.log(`[chat] REJECTED 21607 revoke from ${accountPubkey.slice(0, 8)}: not an approved attendee`);
      return false;
    }
    const bound = this.store.getChatKey(coordinate, content.chat_pubkey);
    if (content.chat_pubkey !== accountPubkey && bound?.account_pubkey !== accountPubkey) {
      this.log(
        `[chat] REJECTED 21607 revoke from ${accountPubkey.slice(0, 8)}: chat key ${content.chat_pubkey.slice(0, 8)} is not bound to this account`,
      );
      return false;
    }
    this.store.setChatKeyStatus(coordinate, content.chat_pubkey, "revoked", this.now());
    this.invalidateEligibility(coordinate);
    const group = this.activeGroup(coordinate);
    if (group) await this.mls.removePubkeys(group.mls_group_id, [content.chat_pubkey]);
    // A revoked organizer device must also lose its co-admin standing.
    await this.maybeSyncAdmins(coordinate, accountPubkey);
    this.log(`[chat] revoked chat key ${content.chat_pubkey.slice(0, 8)} for ${accountPubkey.slice(0, 8)}`);
    return true;
  }

  // ── remove path ────────────────────────────────────────────────────────────
  /**
   * Remove an attendee from the chat: MLS Remove of the account key AND every
   * attested chat key (§4.2). An MLS Remove is real post-compromise security —
   * strictly stronger than the forward-only ECK rotation the revoke path already
   * does for directory/roster/match content.
   */
  async handleRevoke(coordinate: string, accountPubkey: string): Promise<void> {
    const group = this.activeGroup(coordinate);
    if (!group) return;
    const chatKeys = this.store.chatKeysForAccount(coordinate, accountPubkey);
    const pubkeys = [accountPubkey, ...chatKeys.map((k) => k.chat_pubkey)];
    await this.mls.removePubkeys(group.mls_group_id, pubkeys);
    for (const k of chatKeys) this.store.setChatKeyStatus(coordinate, k.chat_pubkey, "revoked", this.now());
    this.invalidateEligibility(coordinate);
    // A removed organizer must lose co-admin standing (desiredAdminPubkeys keys
    // off the approved-organizer set, so a removed organizer drops out of it).
    await this.maybeSyncAdmins(coordinate, accountPubkey);
    this.log(`[chat] removed ${accountPubkey.slice(0, 8)} (+${chatKeys.length} chat key(s)) from ${coordinate}`);
  }

  // ── 445 ingest ─────────────────────────────────────────────────────────────
  /** Ingest kind-445 traffic so the coordinator's leaf stays converged (§4.1). */
  async ingest(coordinate: string, events: AnyEvent[]): Promise<void> {
    const group = this.store.getMarmotGroup(coordinate);
    if (!group) return; // ingest even when frozen — stay converged
    await this.mls.ingest(group.mls_group_id, events);
  }
}
