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
import type { Store, MarmotChatLinkRow } from "../store/db.js";
import { keyPackageProfile, type ChatMls } from "./mls.js";
import { normalizeAvatarUrl } from "./avatar.js";
import {
  verifyChatDeviceProof,
  MAX_CHAT_KEYS_PER_ACCOUNT,
  type ChatKeyAttestationContent,
  type CoordinatorStatusContent,
} from "@nostrautica/protocol";
import {
  generateChatLinkCode,
  hashChatLinkCode,
  chatLinkCodeMatches,
  chatLinkCodeMessages,
} from "./link-code.js";

type AnyEvent = { id: string; pubkey: string; kind: number; tags: string[][]; [k: string]: unknown };

export interface MarmotAdminDeps {
  store: Store;
  mls: ChatMls;
  now: () => number;
  /** The coordinator's own pubkey (hex) — always retained in the admin set. */
  coordinatorPubkey: string;
  /** Fetch kind-30443 key packages authored by `authors` for this event. */
  fetchKeyPackages(coordinate: string, authors: string[]): Promise<AnyEvent[]>;
  /**
   * Hand a member sync to the durable job runner. Optional so the admin stays
   * constructible in tests without a queue; when absent, a failed attestation-path
   * sync is only logged, which is the behaviour this exists to replace.
   */
  enqueueSync?(coordinate: string, accountPubkey: string, reenrolling?: string): void;
  /**
   * Run `fn` under the coordinator's per-member subject lock — the same
   * `member:<pubkey>` mutex the live approve / revoke / attestation paths already
   * serialize on.
   *
   * The startup/chat-toggle backfill walks a roster SNAPSHOT and calls
   * `syncMember` for each row, and it took no lock at all: an attestation or a
   * revoke arriving for the same member mid-walk could interleave with the
   * backfill's add, so the two orderings (add-then-revoke, revoke-then-add) could
   * land in either sequence — leaving a revoked device in the group, or a
   * legitimate rejoin undone. The window widened when the install path started
   * subscribing to the event inbox BEFORE running ensureChat, which is the right
   * order for delivery and means live traffic really can arrive during a backfill.
   *
   * Optional so the admin stays constructible in tests without a coordinator; when
   * absent, `fn` simply runs, which is the previous behaviour.
   */
  withMemberLock?(coordinate: string, accountPubkey: string, fn: () => Promise<void>): Promise<void>;
  /**
   * The event's published roster (31604) is now stale — republish it.
   *
   * Every device-management action changes `chat_keys`, which is the ONLY place a
   * client can read the device list from: `ChatHandoffCard` renders
   * `devicesForAccount(roster)` and re-fetches ~4s after an action. Nothing on
   * this path published a new roster, so every action visibly undid itself after
   * that refresh — a revoked device reappeared, a rename reverted, and a
   * newly-added device rendered as a raw pubkey until some UNRELATED approval
   * happened to republish. The approve path has always republished (the
   * coordinator's `grantAndPublish`); the attestation and chat-revoke paths never
   * did, and there was a comment in the app claiming otherwise.
   *
   * Optional so the admin stays constructible in tests without a coordinator; when
   * absent the roster is simply not republished, which is the pre-fix behaviour.
   */
  onRosterChanged?(coordinate: string): void;
  /**
   * Seal a 21606 coordinator-status notice to ONE attendee (NIP §6.3) — the same
   * attendee-scoped channel `surfacePoison` already uses, which the app records in
   * `ownStatusStore`.
   *
   * Used for the attestation refusals below. Every one of them is a dead end the
   * device cannot detect: it published a key package, sent a 21607, and then sat in
   * "setting up your secure chat" forever while the only record of WHY was a line
   * in the coordinator's log. The reasons are already computed here; this hands
   * them to the one person who can act on them.
   *
   * Deliberately NOT called for an attestation from a non-enrolled stranger: that
   * would let anyone who can reach the inbox make the daemon publish gift wraps.
   */
  notifyAttendee?(coordinate: string, accountPubkey: string, content: CoordinatorStatusContent): void;
  log?: (msg: string) => void;
}

/**
 * Sanitized refusal classes for the attendee-facing 21606 (`error_category`).
 * Stable strings — the app maps them to localized guidance, so renaming one is a
 * wire change, not a refactor.
 */
export const CHAT_ATTESTATION_STAGE = "chat_attestation";
export type ChatAttestationRefusal =
  | "chat_device_cap_reached"
  | "chat_key_bound_to_other_account"
  | "chat_proof_invalid"
  | "chat_key_package_ineligible";

/**
 * External-client link (NIP §10.5) notices go out under their OWN stage, so the
 * app's "why is setup stuck" banner (stage `chat_attestation`) and the link card
 * never overwrite each other's latest notice. A `cleared` notice on this stage
 * (code posted, or linked) supersedes an earlier refusal.
 */
export const CHAT_LINK_STAGE = "chat_link";
export type ChatLinkRefusal =
  | "chat_link_unavailable" // the event has no active chat group
  | "chat_link_rate_limited"
  | "chat_link_no_key_package" // no kind-30443 for the external key anywhere we looked
  | "chat_link_failed" // the confirmation group could not be set up
  | "chat_link_no_pending" // a confirm with no matching open request
  | "chat_link_expired"
  | "chat_link_code_wrong"
  | "chat_link_too_many_attempts"
  | "chat_device_cap_reached"
  | "chat_key_bound_to_other_account"
  | "chat_key_package_ineligible";

/** How long a link code stays valid. */
export const CHAT_LINK_TTL_MS = 30 * 60_000;
/** Wrong codes allowed before the request is dead and must be restarted. */
export const CHAT_LINK_MAX_ATTEMPTS = 5;
/**
 * Link REQUESTS per account per event per window. Each one makes the daemon
 * create an MLS group and gift-wrap a Welcome to a key the requester chose, so it
 * is an amplification surface (invite spam to an arbitrary npub) as much as a
 * resource one.
 */
export const CHAT_LINK_MAX_REQUESTS = 5;
export const CHAT_LINK_WINDOW_MS = 60 * 60_000;
/**
 * After a link is confirmed, how long the key package the CONFIRMATION group
 * consumed is kept out of the event-group add.
 *
 * A Marmot client normally deletes a key package's init key once a Welcome has
 * used it and publishes a fresh one; inviting with the spent one would send a
 * Welcome the client can no longer decrypt while the coordinator holds a leaf for
 * it — a member stuck "in" a room they cannot read. Waiting briefly lets the
 * rotated key package appear. Past the grace the old one is used anyway, which is
 * right for a client that marks its key packages last-resort (reusable).
 */
export const CHAT_LINK_CONFIRM_KP_GRACE_MS = 90_000;
/** Default label for a linked external key (the request's own label wins). */
export const EXTERNAL_CHAT_KEY_LABEL = "White Noise";
/** Name of the throwaway confirmation group, as the external client shows it. */
export const CHAT_LINK_GROUP_NAME = "Nostrautica: confirm White Noise link";

/**
 * How long an as-yet-unauthorized kind-30443 is held while its kind-21607
 * attestation catches up (see {@link MarmotAdmin.handleKeyPackageEvent}).
 *
 * Two minutes, against a healthy gap of well under a second. It is sized for the
 * failure it exists to cover — a relay that delivers the two rumors out of order
 * or holds one back — not for a device that has stopped enrolling. Past it the
 * key package is forgotten and the device is back to where it is today: it must
 * publish again, or the durable `chat_sync_member` retry must find it on a relay.
 */
export const HELD_KEY_PACKAGE_TTL_MS = 120_000;

/**
 * Hard cap on held key packages across all events.
 *
 * This material is UNAUTHENTICATED by construction — the whole point is that we
 * do not yet know the author is anybody's device — so it is a memory-growth
 * surface open to anyone who can publish a kind-30443 to a relay the coordinator
 * watches. Oldest-first eviction bounds it at a few hundred KB; an attacker who
 * fills it evicts a legitimate entry, which lands that device back on exactly
 * today's behaviour (dropped, recovered by the next sync) rather than anywhere
 * worse. One entry per author, so a single device republishing cannot fill it.
 */
export const MAX_HELD_KEY_PACKAGES = 256;

export class MarmotAdmin {
  private readonly store: Store;
  private readonly mls: ChatMls;
  private readonly now: () => number;
  private readonly coordinatorPubkey: string;
  private readonly fetchKeyPackages: (coordinate: string, authors: string[]) => Promise<AnyEvent[]>;
  private readonly enqueueSync?: (coordinate: string, accountPubkey: string, reenrolling?: string) => void;
  private readonly withMemberLock?: (
    coordinate: string,
    accountPubkey: string,
    fn: () => Promise<void>,
  ) => Promise<void>;
  private readonly onRosterChanged?: (coordinate: string) => void;
  private readonly notifyAttendee?: (
    coordinate: string,
    accountPubkey: string,
    content: CoordinatorStatusContent,
  ) => void;
  private readonly log: (msg: string) => void;

  constructor(deps: MarmotAdminDeps) {
    this.store = deps.store;
    this.mls = deps.mls;
    this.now = deps.now;
    this.coordinatorPubkey = deps.coordinatorPubkey;
    this.fetchKeyPackages = deps.fetchKeyPackages;
    this.enqueueSync = deps.enqueueSync;
    this.withMemberLock = deps.withMemberLock;
    this.onRosterChanged = deps.onRosterChanged;
    this.notifyAttendee = deps.notifyAttendee;
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
    // Create with the coordinator as the only admin. Organizer chat devices are
    // not members of a brand-new group, and an admin must hold a member leaf
    // (MDK admin-leaf coupling): listing them here made every later commit,
    // invites included, illegal. They are promoted once their Add lands
    // (syncAdmins after a successful add).
    const ids = await this.mls.createGroup({
      name: opts.name,
      description: opts.description,
      relays: opts.relays,
      adminPubkeys: opts.adminPubkeys ?? [this.coordinatorPubkey],
    });
    this.store.upsertMarmotGroup({
      coordinate: opts.coordinate,
      mlsGroupId: ids.mlsGroupIdHex,
      nostrGroupId: ids.nostrGroupIdHex,
      status: "active",
      now: this.now(),
    });
    this.log(`[chat] created MLS group for ${opts.coordinate} (nostr_group_id ${ids.nostrGroupIdHex.slice(0, 12)}…)`);
    // The roster carries the room's nostr_group_id, and members bind to the group
    // it names (NIP §10.4). A replacement group — one recreated after the old one
    // was retired (see retire.ts) — is invisible to members until it is republished.
    this.rosterChanged(opts.coordinate);
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

  /**
   * Reconcile the group's avatar (group.avatar-url.v1) with the event's icon — the
   * `picture` of the E_id kind-0 (see avatar.ts). Commits only when the normalized
   * URL differs from what the group holds, so re-running it on every install and
   * every kind-0 revision is free when nothing changed; a removed icon clears the
   * avatar. An icon that cannot be stored validly is skipped with a log line and
   * the avatar is left as it is — it must never break creation or reconciliation.
   */
  async ensureAvatar(coordinate: string, iconUrl: string | undefined): Promise<void> {
    const group = this.activeGroup(coordinate);
    if (!group) return;
    const normalized = normalizeAvatarUrl(iconUrl);
    if (!normalized.ok) {
      this.log(
        `[chat] event icon of ${coordinate} is not usable as the group avatar (${normalized.reason}) — avatar left unchanged`,
      );
      return;
    }
    if (await this.mls.setAvatar(group.mls_group_id, normalized.url)) {
      this.log(
        normalized.url
          ? `[chat] group avatar of ${coordinate} set to ${normalized.url}`
          : `[chat] group avatar of ${coordinate} cleared (the event has no icon)`,
      );
    }
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
   *
   * A LINKED EXTERNAL client key (NIP §10.5, e.g. an organizer's White Noise) is
   * never promoted: it runs software we don't control, and co-admin there would
   * let it add or remove anyone in the room. It chats as an ordinary member.
   */
  desiredAdminPubkeys(coordinate: string): string[] {
    const admins = new Set<string>([this.coordinatorPubkey]);
    for (const a of this.store.approvedAttendees(coordinate)) {
      if (a.role !== "organizer") continue;
      const external = new Set(
        this.store
          .chatKeysForAccount(coordinate, a.pubkey)
          .filter((k) => k.external)
          .map((k) => k.chat_pubkey),
      );
      for (const id of this.authorizedIdentities(coordinate, a.pubkey)) if (!external.has(id)) admins.add(id);
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

  // ── out-of-order enrolment: key package before attestation ────────────────
  /**
   * Kind-30443s seen from an author who was not (yet) an authorized chat
   * identity, keyed `coordinateauthor`, with the wall-clock deadline past
   * which they are forgotten.
   *
   * A client enrolling in chat publishes two things — its key package (30443) and
   * its device attestation (21607) — and nothing orders them. When the key package
   * wins the race the coordinator had no binding for its author yet, logged
   * "ignored 30443 …: not an authorized chat identity", and DISCARDED it. The
   * attestation arriving a beat later then had to find that key package on a relay
   * all over again, and when it could not — the relay had not settled, or served
   * the read from a node that had not got it yet — the member sat on "Setting up
   * your secure chat…" until something unrelated re-drove the flow.
   *
   * Holding it changes nothing about WHO may be added: the authorization decision
   * still runs when the attestation lands, with the same proof-of-possession check
   * (§10.2) that closed v1's mis-binding and griefing gap. All that changes is that
   * the artifact is still in hand when the decision is finally made.
   */
  private readonly heldKeyPackages = new Map<string, { kp: AnyEvent; expiresAt: number }>();

  private heldKey(coordinate: string, author: string): string {
    return `${coordinate}${author}`;
  }

  /** Remember one unauthorized key package, bounded by TTL and by count. */
  private holdKeyPackage(coordinate: string, kp: AnyEvent): void {
    const now = this.now();
    for (const [k, v] of this.heldKeyPackages) if (v.expiresAt <= now) this.heldKeyPackages.delete(k);
    const key = this.heldKey(coordinate, kp.pubkey);
    // Re-holding an author's newest key package replaces the older one rather than
    // adding a second: 30443 is addressable, so there is exactly one live per
    // (author, `d`), and keeping the stale copy is actively harmful — inviting with
    // it commits an Add whose Welcome the device can no longer decrypt.
    this.heldKeyPackages.delete(key);
    while (this.heldKeyPackages.size >= MAX_HELD_KEY_PACKAGES) {
      const oldest = this.heldKeyPackages.keys().next();
      if (oldest.done) break;
      this.heldKeyPackages.delete(oldest.value);
    }
    this.heldKeyPackages.set(key, { kp, expiresAt: now + HELD_KEY_PACKAGE_TTL_MS });
  }

  /** The key package held for `author`, if one is still within its TTL. */
  private heldKeyPackage(coordinate: string, author: string): AnyEvent | undefined {
    const key = this.heldKey(coordinate, author);
    const entry = this.heldKeyPackages.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.heldKeyPackages.delete(key);
      return undefined;
    }
    return entry.kp;
  }

  private dropHeldKeyPackage(coordinate: string, author: string): void {
    this.heldKeyPackages.delete(this.heldKey(coordinate, author));
  }

  /** How many key packages are currently held (test/diagnostic). */
  heldKeyPackageCount(): number {
    const now = this.now();
    for (const [k, v] of this.heldKeyPackages) if (v.expiresAt <= now) this.heldKeyPackages.delete(k);
    return this.heldKeyPackages.size;
  }

  /**
   * True when at least one of this account's authorized chat identities holds a
   * leaf in the event's group — i.e. the person can actually read the room.
   *
   * Distinct from "their sync job completed": a sync that found no key package at
   * all completes perfectly happily having added nobody, which is exactly the
   * state the enrolment re-check exists to notice.
   */
  async isEnrolled(coordinate: string, accountPubkey: string): Promise<boolean> {
    const group = this.activeGroup(coordinate);
    if (!group) return false;
    for (const id of this.authorizedIdentities(coordinate, accountPubkey)) {
      if (await this.mls.isMember(group.mls_group_id, id)) return true;
    }
    return false;
  }

  /**
   * One choke point for "this event's `chat_keys` changed": drop the eligibility
   * cache AND republish the roster.
   *
   * These two were split before, and only the first had a call site. The 31604
   * roster is the only channel a client can read the device list from, so a bind,
   * a rename (a re-attest with a new label) and a revoke were all invisible until
   * something else — an unrelated approval — happened to republish. The device
   * management UI re-reads the roster ~4s after every action, so what the user
   * actually saw was their own change being undone in front of them.
   *
   * Republishing is fire-and-forget on purpose: the coordinator coalesces roster
   * publishes, and a relay hiccup must never turn an accepted attestation into a
   * rejected one (the binding is already committed to SQLite by the time we get
   * here).
   */
  private rosterChanged(coordinate: string): void {
    this.invalidateEligibility(coordinate);
    this.onRosterChanged?.(coordinate);
  }

  /**
   * Tell ONE attendee, over the 21606 channel their app already listens on, that
   * we refused their device — with the reason we already computed. Best-effort and
   * never allowed to change the refusal itself.
   */
  private notifyRefusal(
    coordinate: string,
    accountPubkey: string,
    category: ChatAttestationRefusal,
  ): void {
    this.notifyAttendee?.(coordinate, accountPubkey, {
      v: 2,
      a: coordinate,
      pubkey: accountPubkey,
      stage: CHAT_ATTESTATION_STAGE,
      state: "poison",
      attempts: 0,
      error_category: category,
      // None of these clear by waiting: the user has to remove a device, use a
      // different account, or re-enrol. Saying "retryable" would be a lie that
      // keeps them staring at the spinner.
      retryable: false,
      at: Math.floor(this.now() / 1000),
    });
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
   *
   * @returns false when a device was left OUT for a reason that can clear on its
   * own — the MLS Add or its Welcome failed on the network, or the rotated key
   * package hasn't propagated yet — so the caller can arrange another attempt
   * (audit B-5). True means "nothing further to do for this member", which
   * includes a device deliberately REFUSED (an ineligible key package, the device
   * cap): those are reported to the owner and must not be retried forever.
   *
   * It does not throw for a single bad key package, deliberately: one undecodable
   * proof version from a newer peer client must not take down a startup backfill
   * that every other event's chat depends on (prod 2026-07-20). The boolean IS the
   * containment — before it existed, the no-crash property silently doubled as
   * "and no retry either".
   */
  async syncMember(
    coordinate: string,
    accountPubkey: string,
    opts?: {
      reenrolling?: string;
      /**
       * Key packages already fetched for a KNOWN set of authors ({@link prefetched}),
       * so a walk over many members costs one relay read instead of one per member.
       * Used only when this member's authorized identities are a subset of the set
       * the batch was fetched for — otherwise (a device attested after the batch was
       * taken) this member falls back to its own fetch, so batching can never make
       * the coordinator act on a roster older than the one it was handed.
       */
      prefetched?: { forAuthors: Set<string>; keyPackages: AnyEvent[] };
    },
  ): Promise<boolean> {
    const group = this.activeGroup(coordinate);
    if (!group) return true;
    const attendee = this.store.getAttendee(coordinate, accountPubkey);
    if (!attendee || attendee.status !== "approved") return true;
    const authors = this.authorizedIdentities(coordinate, accountPubkey);
    const batch = opts?.prefetched;
    const covered = !!batch && authors.every((a) => batch.forAuthors.has(a));
    const kps = covered ? batch.keyPackages : await this.fetchKeyPackages(coordinate, authors);
    const authorized = new Set(authors);
    let candidates = [...kps.filter((kp) => authorized.has(kp.pubkey))];
    // A linked external key whose confirmation group just spent one key package
    // (NIP §10.5): when a rotated one is ALSO visible, simply use that. Only when
    // the spent one is all there is does tryAddKeyPackage hold off and ask for a
    // retry (CHAT_LINK_CONFIRM_KP_GRACE_MS).
    candidates = candidates.filter(
      (kp) =>
        !this.isFreshlySpentConfirmKp(coordinate, kp) ||
        !candidates.some((other) => other.pubkey === kp.pubkey && other.id !== kp.id),
    );
    // Fold in any key package we are HOLDING for one of this member's now-authorized
    // identities that the read above did not return. This is the payoff of
    // {@link heldKeyPackages}: the device published its 30443 before the 21607 that
    // authorizes it, so the watcher could not act on it then — and the relay read
    // that happens now is exactly the read that can still miss it. The
    // authorization is unchanged; `authors` comes from `authorizedIdentities`, i.e.
    // an ACTIVE binding proven by a §10.2 possession proof.
    const fromHold = new Set<string>();
    const seen = new Set(candidates.map((kp) => kp.pubkey));
    for (const author of authors) {
      if (seen.has(author)) {
        this.dropHeldKeyPackage(coordinate, author);
        continue;
      }
      const held = this.heldKeyPackage(coordinate, author);
      if (!held) continue;
      this.log(
        `[chat] using the 30443 ${held.id.slice(0, 8)} held for ${author.slice(0, 8)} in ${coordinate}: it arrived before the attestation that authorized it`,
      );
      fromHold.add(author);
      candidates.push(held);
    }
    let synced = true;
    for (const kp of candidates) {
      // `reconcile`: this path is a DELIBERATE "bring this member up to date" —
      // approval, a fresh attestation, or the startup backfill — so it also repairs
      // an attested device that holds no leaf despite its key package having been
      // consumed. `reenrolling` is narrower: it names the ONE device that just
      // attested for THIS event, and is the only thing that may drop a live leaf.
      // See tryAddKeyPackage.
      const ok = await this.tryAddKeyPackage(coordinate, group.mls_group_id, kp, {
        reconcile: true,
        reenrolling: opts?.reenrolling,
      });
      // Release the hold only on "nothing further to do for this member" — a
      // transient Add/Welcome failure keeps the copy so the durable retry a moment
      // later still has it, which is the whole reason it was kept.
      if (ok && fromHold.has(kp.pubkey)) this.dropHeldKeyPackage(coordinate, kp.pubkey);
      if (!ok) synced = false;
    }
    // An approved organizer's device landing in the group must also be an admin.
    await this.maybeSyncAdmins(coordinate, accountPubkey);
    return synced;
  }

  /**
   * Handle a single kind-30443 from the watcher subscription (§4.2). The event's
   * author must be an approved attendee's authorized chat identity; otherwise it
   * is ignored (an unauthenticated key package is never added). Unknown authors
   * are dropped against the cached eligible set BEFORE any DB hit (COORD-17).
   */
  async handleKeyPackageEvent(coordinate: string, event: AnyEvent): Promise<void> {
    if (!this.eligibleAuthorSet(coordinate).has(event.pubkey)) {
      // HELD, not dropped (see {@link heldKeyPackages}). An enrolling client
      // publishes its 30443 and its 21607 with no ordering between them; when the
      // key package wins, throwing it away meant the attestation seconds later had
      // to re-find it on a relay, and a member whose relay had not settled sat on
      // "Setting up your secure chat…" indefinitely. This is a bounded wait for the
      // authorization decision, NOT a relaxation of it: nothing is added until an
      // authenticated 21607 with a valid §10.2 possession proof binds this author.
      this.holdKeyPackage(coordinate, event);
      this.log(
        `[chat] holding 30443 from ${event.pubkey.slice(0, 8)}: not an authorized chat identity yet — will re-check when its 21607 arrives`,
      );
      return;
    }
    // An eligible author's key package supersedes anything we were holding for it.
    this.dropHeldKeyPackage(coordinate, event.pubkey);
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
  ): Promise<boolean> {
    if (this.isFreshlySpentConfirmKp(coordinate, kp)) {
      // NOT "nothing to do": the linked key IS authorized, we are just waiting for
      // its rotated key package. False hands a deliberate sync to the durable
      // retry; the passive watcher ignores it.
      this.log(
        `[chat] holding off on ${kp.pubkey.slice(0, 8)} in ${coordinate}: 30443 ${kp.id.slice(0, 8)} was just spent by its link-confirmation group — waiting for a rotated one`,
      );
      return false;
    }
    const consumed = this.store.isKpConsumed(coordinate, kp.id);
    if (consumed && !opts?.reconcile) return true;
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
    if (member && !opts?.reconcile) return true;
    // Deliberate sync, they're in, and this key package is already spent: there is
    // nothing new to act on — UNLESS this device just attested re-enrolment for
    // this event, in which case the two sides disagree and the spent key package
    // is the symptom, not the answer.
    //
    // That case used to fall into this bare `return` with NO log line at all: when
    // the attestation reached us before the rotated 30443 had propagated (or a
    // lagging relay served the old one), `syncMember` fetched the consumed key
    // package, returned silently, and the one signal the device can send was
    // discarded. Nothing re-drove it, because the watcher path also short-circuits
    // once the fresh key package arrives. Recovery required pressing Rejoin again
    // AND winning the propagation race.
    if (member && consumed) {
      if (opts?.reenrolling === kp.pubkey) {
        this.log(
          `[chat] ${kp.pubkey.slice(0, 8)} attested re-enrolment in ${coordinate} but its newest visible 30443 ${kp.id.slice(0, 8)} is already consumed — the rotated key package has not propagated yet; asking for another sync`,
        );
        // NOT "nothing to do": the device says it holds no membership, we hold a
        // leaf for it, and the artifact that resolves that disagreement simply
        // hasn't arrived yet. It is a wait, so it needs an actual retry — the
        // 30443 watcher can't provide one, because once the fresh key package
        // lands its own `member && !reconcile` short-circuit returns immediately.
        // Without this the user pressed Rejoin, saw "requested", and had to press
        // it again AND win the propagation race.
        return false;
      }
      return true;
    }
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
      return true; // a deliberate keep, not a failure
    }
    const evaluation = this.mls.evaluateKeyPackage
      ? await this.mls.evaluateKeyPackage(mlsGroupId, kp)
      : { eligible: await this.mls.isEligible(mlsGroupId, kp), reasons: [], alreadyMember: member };
    // "Already a member" is not a refusal — it is the exact condition the branch
    // below exists to repair, and it must not be treated as one.
    //
    // The library computes `eligible: reasons.length === 0` and pushes
    // "already a member" as a reason, so `member === true` implies
    // `eligible === false`. This check used to sit ABOVE the re-enrolment branch,
    // which therefore could never execute in production: a device that lost its
    // MLS state pressed Rejoin, the add arrived with the stale leaf still present,
    // and we refused it AND marked the freshly rotated key package consumed. The
    // user saw "Rejoin requested" and nothing happened; every further press
    // rotated and burned another key package. The test suite did not catch it
    // because the fake MLS returned a fixed eligibility with no membership
    // awareness — it modelled a library that cannot exist.
    // A KeyPackage from before the 0x8009 upgrade (an app tab that has not reloaded,
    // an outdated White Noise). Not reported to the owner as a refusal: nothing is
    // wrong with their device, it just has not published its current KeyPackage
    // yet — and when it does, that is a new event id the watcher adds normally.
    // Recorded as consumed so neither the watcher nor a reconcile re-decodes it.
    if ("legacy" in evaluation && evaluation.legacy) {
      this.store.markKpConsumed(coordinate, kp.id);
      this.log(
        `[chat] skipping 30443 ${kp.id.slice(0, 8)} from ${kp.pubkey.slice(0, 8)} in ${coordinate}: ${evaluation.reasons.join(", ")} — waiting for a current one`,
      );
      return true;
    }
    const onlyBecauseMember =
      evaluation.alreadyMember &&
      evaluation.reasons.every((r) => r.toLowerCase().includes("already a member"));
    if (!evaluation.eligible && !onlyBecauseMember) {
      this.store.markKpConsumed(coordinate, kp.id); // genuinely ineligible (e.g. ciphersuite) → don't re-eval
      const why = evaluation.reasons.length ? `: ${evaluation.reasons.join(", ")}` : "";
      this.log(
        `[chat] 30443 ${kp.id.slice(0, 8)} from ${kp.pubkey.slice(0, 8)} ineligible${why}`,
      );
      // This is the most invisible refusal of the lot: the device published a key
      // package, attested successfully (so it IS in the roster's `chat_keys` and the
      // UI lists it), and then nothing ever happens — the key package is marked
      // consumed so no later pass reconsiders it. Tell the owner, if we know which
      // account owns this chat key; an unbound author cannot be an enrolled
      // attendee, so there is nobody to tell and nothing to publish.
      const owner = this.store.getChatKey(coordinate, kp.pubkey)?.account_pubkey;
      if (owner) this.notifyRefusal(coordinate, owner, "chat_key_package_ineligible");
      return true; // a REFUSAL, reported to the owner — retrying it forever helps nobody
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
      // An organizer device can only be promoted once it holds a leaf.
      if (this.desiredAdminPubkeys(coordinate).includes(kp.pubkey)) {
        await this.syncAdmins(coordinate).catch((e) =>
          this.log(`[chat] promoting ${kp.pubkey.slice(0, 8)} in ${coordinate} failed: ${String(e)}`),
        );
      }
      return true;
    } catch (e) {
      // A single malformed/incompatible key package (e.g. a proof version our
      // vendored marmot-ts can't decode yet, from a newer peer client) must
      // never take down the whole coordinator process — every OTHER event's
      // chat and every OTHER attendee's add depends on this loop finishing
      // (prod incident 2026-07-20: an uncaught throw here during startup
      // backfill crashed the process). Left unconsumed, not ineligible, so
      // it's retried (and can succeed) once the library gains support.
      //
      // But "don't crash" is not "don't retry" (audit B-5). Returning normally
      // here told every caller the member was synced: the attestation path only
      // queued its durable `chat_sync_member` on a THROW, and the approval path's
      // job completed successfully, so one transient relay or marmot failure left
      // the member staring at "Setting up…" with the rumor marked seen and nothing
      // anywhere re-driving it. The boolean carries the failure out instead.
      this.log(
        `[chat] 30443 ${kp.id.slice(0, 8)} from ${kp.pubkey.slice(0, 8)} invite FAILED: ${e instanceof Error ? e.message : e}`,
      );
      return false;
    }
  }

  /** Backfill every approved attendee into the group (config toggled on, §4.2).
   *  Each member under the same `member:<pubkey>` lock the live paths take, so a
   *  revoke or an attestation arriving mid-walk cannot interleave with this
   *  member's add — see {@link MarmotAdminDeps.withMemberLock}. */
  async backfillApproved(coordinate: string): Promise<void> {
    const approved = this.store.approvedAttendees(coordinate);
    // ONE key-package read for the whole roster, not one per member.
    //
    // This walk runs on every restart of every chat-enabled event, and each
    // `syncMember` used to open its own relay fetch for a single author. Measured
    // on a four-event daemon with twelve members each, that was 48 serialized
    // round trips and 84% of the entire boot — the per-event cost DEPLOYMENT.md
    // records as "9–12 s each", growing with both the number of events and the
    // size of their rosters, against a deploy that fails at 240 s. A relay filter
    // takes an author LIST, so the whole roster is one REQ; `syncMember` still
    // filters the result to its own member's authorized identities, so each member
    // sees exactly the key packages it saw before.
    //
    // Not parallelised per member on purpose: what is left after the fetch is a
    // local membership read and, for a member who needs repair, an MLS Add — and
    // Adds against one group are serialized anyway (`MarmotClientMls.serialize`,
    // the concurrent-commit hazard), so concurrency here would buy queueing, not
    // speed.
    const forAuthors = new Set(this.eligibleChatAuthors(coordinate));
    const keyPackages = forAuthors.size ? await this.fetchKeyPackages(coordinate, [...forAuthors]) : [];
    const prefetched = { forAuthors, keyPackages };
    for (const a of approved) {
      let synced = true;
      const sync = async () => {
        synced = await this.syncMember(coordinate, a.pubkey, { prefetched });
      };
      if (this.withMemberLock) await this.withMemberLock(coordinate, a.pubkey, sync);
      else await sync();
      // A member the walk could not add gets a durable retry of their own (audit
      // B-5), rather than being silently left out until the next restart — which,
      // for chat being turned on mid-event, means until the event is over.
      if (!synced && this.enqueueSync) {
        this.log(`[chat] backfill could not add ${a.pubkey.slice(0, 8)} to ${coordinate} — queued for durable retry`);
        this.enqueueSync(coordinate, a.pubkey);
      }
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
    // External-client link (NIP §10.5): its own possession mechanism, its own path.
    if (content.op === "link") return this.handleLinkRequest(coordinate, accountPubkey, content);
    if (content.op === "link_confirm") return this.handleLinkConfirm(coordinate, accountPubkey, content);
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
        this.notifyRefusal(coordinate, accountPubkey, "chat_proof_invalid");
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
        this.notifyRefusal(coordinate, accountPubkey, "chat_device_cap_reached");
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
        this.notifyRefusal(coordinate, accountPubkey, "chat_key_bound_to_other_account");
        return false;
      }
      this.log(`[chat] bound chat key ${content.chat_pubkey.slice(0, 8)} → ${accountPubkey.slice(0, 8)}`);
      // Republish: this add is what puts the device (and its label) in the roster's
      // `chat_keys`, which is the only thing the device-management UI can read.
      this.rosterChanged(coordinate);
      // The attesting device named itself, and `content.a === coordinate` was
      // checked above — so this, and only this, authorizes dropping a leaf we
      // still hold for that device (tryAddKeyPackage's `member` branch).
      if (attendee.status === "approved") {
        // Inline first, so a normal rejoin completes in the same breath as the
        // attestation. But a failure here used to be LOG-ONLY: the approval path
        // has durable `chat_sync_member` retries and this path had none, so a
        // transient marmot or relay failure stranded the member in "setting up"
        // until a restart or another manual Rejoin — while the rumor was marked
        // seen, so nothing re-drove it.
        try {
          const synced = await this.syncMember(coordinate, accountPubkey, { reenrolling: content.chat_pubkey });
          // A FALSE return is the same situation as a throw (audit B-5): the device
          // is not in the group and the reason can clear on its own. It used to be
          // invisible here, because `tryAddKeyPackage` catches its own invite
          // failure — so this whole try/catch, and the durable retry it exists to
          // queue, never fired for the most likely failure of all.
          if (!synced && this.enqueueSync) {
            this.log(
              `[chat] attestation sync for ${accountPubkey.slice(0, 8)} in ${coordinate} did not complete — queued for durable retry`,
            );
            this.enqueueSync(coordinate, accountPubkey, content.chat_pubkey);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (this.enqueueSync) {
            this.log(
              `[chat] attestation sync for ${accountPubkey.slice(0, 8)} in ${coordinate} failed (${msg.slice(0, 120)}) — queued for durable retry`,
            );
            // Carry `reenrolling`. Without it the retry is a PLAIN add, and
            // `tryAddKeyPackage`'s `member && opts?.reenrolling !== kp.pubkey`
            // branch then keeps the stale leaf and refuses it ("likely rotated for
            // another event") — which is the exact case this attestation exists to
            // repair. The user pressed Rejoin, saw "requested", and was not back in;
            // the inline attempt's transient failure had quietly turned the durable
            // retry into a no-op.
            this.enqueueSync(coordinate, accountPubkey, content.chat_pubkey);
          } else {
            this.log(
              `[chat] attestation sync for ${accountPubkey.slice(0, 8)} in ${coordinate} failed with no retry queue: ${msg.slice(0, 160)}`,
            );
          }
        }
      }
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
    // Republish BEFORE the MLS remove: dropping the leaf can take a relay round
    // trip, and the roster is what the user is staring at. Without this the
    // revoked device reappeared in their device list about four seconds later.
    this.rosterChanged(coordinate);
    const group = this.activeGroup(coordinate);
    if (group) await this.mls.removePubkeys(group.mls_group_id, [content.chat_pubkey]);
    // A revoked organizer device must also lose its co-admin standing.
    await this.maybeSyncAdmins(coordinate, accountPubkey);
    this.log(`[chat] revoked chat key ${content.chat_pubkey.slice(0, 8)} for ${accountPubkey.slice(0, 8)}`);
    return true;
  }

  // ── external-client link (21607 op:"link"/"link_confirm", NIP §10.5) ──────
  /**
   * Link an external Marmot client's key (`chat_pubkey`, "W") to this account as
   * a chat device, so the person can also chat from e.g. White Noise.
   *
   * W cannot sign the §10.2 proof — the external client never sees our challenge —
   * so possession is proven one of two ways:
   *  - W IS the sealing account key: the seal itself proves it. Bound at once.
   *  - otherwise: we invite W into a throwaway two-member group, post a one-time
   *    code there, and bind only when {@link handleLinkConfirm} gets that code back.
   *    Only W's holder can read the group, so only they can know the code.
   *
   * The coordinator, never the user, adds W to the event group afterwards — it is
   * the one party that holds the account⇄key binding and removes the key again on
   * revoke or withdrawal.
   *
   * Refusals go to the account over the 21606 channel under {@link CHAT_LINK_STAGE}.
   * Never throws for an MLS/relay failure: that is reported, and the user retries.
   */
  async handleLinkRequest(
    coordinate: string,
    accountPubkey: string,
    content: ChatKeyAttestationContent,
  ): Promise<boolean> {
    const w = content.chat_pubkey;
    const who = `${accountPubkey.slice(0, 8)} → ${w.slice(0, 8)}`;
    if (this.store.getAttendee(coordinate, accountPubkey)?.status !== "approved") {
      // A pending attendee can't see the chat at all; nothing to tell them.
      this.log(`[chat] REJECTED 21607 link ${who}: not an approved attendee`);
      return false;
    }
    const group = this.activeGroup(coordinate);
    if (!group) {
      this.log(`[chat] REJECTED 21607 link ${who}: no active chat group for ${coordinate}`);
      this.notifyLink(coordinate, accountPubkey, "chat_link_unavailable");
      return false;
    }
    // Opportunistic: a request is a fine moment to tear down codes nobody used.
    await this.sweepExpiredLinks();
    const label = content.label?.trim() || EXTERNAL_CHAT_KEY_LABEL;

    const bound = this.store.getChatKey(coordinate, w);
    if (bound && bound.account_pubkey !== accountPubkey) {
      this.log(`[chat] REJECTED 21607 link ${who}: key already bound to another account`);
      this.notifyLink(coordinate, accountPubkey, "chat_key_bound_to_other_account");
      return false;
    }
    if (bound?.status === "active") {
      // Already this account's (a previous link, or W is one of its own devices):
      // possession was proven when it was bound. Nothing to confirm — just make
      // sure it is in the room.
      this.log(`[chat] 21607 link ${who}: already an active chat key of this account — re-syncing`);
      this.notifyLinkProgress(coordinate, accountPubkey);
      await this.syncLinkedKey(coordinate, accountPubkey);
      return true;
    }
    const active = this.store.chatKeysForAccount(coordinate, accountPubkey).filter((k) => k.status === "active");
    if (active.length >= MAX_CHAT_KEYS_PER_ACCOUNT) {
      this.log(`[chat] REJECTED 21607 link ${who}: account already at the ${MAX_CHAT_KEYS_PER_ACCOUNT}-device cap`);
      this.notifyLink(coordinate, accountPubkey, "chat_device_cap_reached");
      return false;
    }

    if (w === accountPubkey) {
      // Self-link: the 21607 is sealed BY this key, which is the proof. The account
      // key becomes a chat member only through this explicit, roster-visible,
      // cap-counted, revocable binding — never implicitly (§10.2).
      return this.bindLinkedKey(coordinate, accountPubkey, w, label);
    }

    // ── a different key: confirmation by one-time code ──
    const now = this.now();
    const prior = this.store.getChatLink(coordinate, accountPubkey);
    const inWindow = !!prior && now - prior.window_started_at < CHAT_LINK_WINDOW_MS;
    const windowStartedAt = inWindow ? prior!.window_started_at : now;
    const windowCount = (inWindow ? prior!.window_count : 0) + 1;
    if (windowCount > CHAT_LINK_MAX_REQUESTS) {
      this.log(`[chat] REJECTED 21607 link ${who}: over ${CHAT_LINK_MAX_REQUESTS} link requests this hour`);
      this.notifyLink(coordinate, accountPubkey, "chat_link_rate_limited");
      return false;
    }
    // One pending link per (coordinate, account): a new request supersedes the old
    // one — its code dies with its group.
    if (prior?.status === "pending") await this.teardownConfirmGroup(prior);

    const kps = (await this.fetchKeyPackages(coordinate, [w]).catch(() => [] as AnyEvent[]))
      .filter((kp) => kp.pubkey === w)
      .sort((a, b) => Number(b.created_at ?? 0) - Number(a.created_at ?? 0) || (a.id < b.id ? -1 : 1));
    // Newest CURRENT (0x8009) KeyPackage first: one account can have several `d`
    // slots (devices, clients), and an outdated one must not shadow a usable one.
    // With only legacy ones, the newest still goes through and is refused below
    // as ineligible, which tells the user to update White Noise.
    const kp = kps.find((k) => keyPackageProfile(k).current) ?? kps[0];
    if (!kp) {
      this.store.countChatLinkRequest(coordinate, accountPubkey, w, windowStartedAt, windowCount, now);
      this.log(`[chat] REJECTED 21607 link ${who}: no kind-30443 key package found for the key`);
      this.notifyLink(coordinate, accountPubkey, "chat_link_no_key_package");
      return false;
    }

    const code = generateChatLinkCode();
    let confirmGroupId: string | undefined;
    try {
      const relays = await this.mls.getRelays(group.mls_group_id);
      const ids = await this.mls.createGroup({
        name: CHAT_LINK_GROUP_NAME,
        description: "A one-time code to link this account to a Nostrautica event chat. You can leave once you're done.",
        relays,
        adminPubkeys: [this.coordinatorPubkey],
      });
      confirmGroupId = ids.mlsGroupIdHex;
      // Persist BEFORE the network steps, so a crash mid-way still leaves a row
      // the expiry sweep can find and tear the group down from.
      this.store.putPendingChatLink({
        coordinate,
        accountPubkey,
        chatPubkey: w,
        label,
        codeHash: hashChatLinkCode(code, coordinate, accountPubkey, w),
        expiresAt: now + CHAT_LINK_TTL_MS,
        confirmGroupId,
        confirmKpId: kp.id,
        windowStartedAt,
        windowCount,
        now,
      });
      const evaluation = this.mls.evaluateKeyPackage
        ? await this.mls.evaluateKeyPackage(confirmGroupId, kp)
        : { eligible: await this.mls.isEligible(confirmGroupId, kp), reasons: [] };
      if (!evaluation.eligible) {
        const why = evaluation.reasons.length ? `: ${evaluation.reasons.join(", ")}` : "";
        this.log(`[chat] REJECTED 21607 link ${who}: key package ${kp.id.slice(0, 8)} ineligible${why}`);
        await this.closeLink(coordinate, accountPubkey);
        this.notifyLink(coordinate, accountPubkey, "chat_key_package_ineligible");
        return false;
      }
      await this.mls.invite(confirmGroupId, kp); // Add commit + Welcome to W's 10050 inbox
      for (const text of chatLinkCodeMessages(code, Math.round(CHAT_LINK_TTL_MS / 60_000)))
        await this.mls.sendText(confirmGroupId, text);
    } catch (e) {
      this.log(`[chat] 21607 link ${who}: confirmation group setup FAILED: ${e instanceof Error ? e.message : e}`);
      if (confirmGroupId) await this.closeLink(coordinate, accountPubkey);
      else this.store.countChatLinkRequest(coordinate, accountPubkey, w, windowStartedAt, windowCount, now);
      this.notifyLink(coordinate, accountPubkey, "chat_link_failed");
      return false;
    }
    this.log(`[chat] 21607 link ${who}: confirmation code posted (group ${confirmGroupId.slice(0, 8)}…)`);
    this.notifyLinkProgress(coordinate, accountPubkey);
    return true;
  }

  /** Check the code typed into Nostrautica against the account's pending link. */
  async handleLinkConfirm(
    coordinate: string,
    accountPubkey: string,
    content: ChatKeyAttestationContent,
  ): Promise<boolean> {
    const w = content.chat_pubkey;
    const who = `${accountPubkey.slice(0, 8)} → ${w.slice(0, 8)}`;
    if (this.store.getAttendee(coordinate, accountPubkey)?.status !== "approved") {
      this.log(`[chat] REJECTED 21607 link_confirm ${who}: not an approved attendee`);
      return false;
    }
    const link = this.store.getChatLink(coordinate, accountPubkey);
    if (!link || link.status !== "pending" || link.chat_pubkey !== w || !content.code) {
      this.log(`[chat] REJECTED 21607 link_confirm ${who}: no pending link for this key`);
      this.notifyLink(coordinate, accountPubkey, "chat_link_no_pending");
      return false;
    }
    if (this.now() >= link.expires_at) {
      this.log(`[chat] REJECTED 21607 link_confirm ${who}: code expired`);
      await this.closeLink(coordinate, accountPubkey);
      this.notifyLink(coordinate, accountPubkey, "chat_link_expired");
      return false;
    }
    if (!chatLinkCodeMatches(content.code, link.code_hash, coordinate, accountPubkey, w)) {
      const attempts = link.attempts + 1;
      if (attempts >= CHAT_LINK_MAX_ATTEMPTS) {
        this.log(`[chat] REJECTED 21607 link_confirm ${who}: wrong code, attempt ${attempts} — link closed`);
        await this.closeLink(coordinate, accountPubkey);
        this.notifyLink(coordinate, accountPubkey, "chat_link_too_many_attempts");
      } else {
        this.log(`[chat] REJECTED 21607 link_confirm ${who}: wrong code (attempt ${attempts}/${CHAT_LINK_MAX_ATTEMPTS})`);
        this.store.setChatLinkAttempts(coordinate, accountPubkey, attempts, this.now());
        this.notifyLink(coordinate, accountPubkey, "chat_link_code_wrong");
      }
      return false;
    }
    // Possession proven. The state may have moved since the request (another
    // account bound W, or this one filled its device slots), so re-check both.
    const bound = this.store.getChatKey(coordinate, w);
    if (bound && bound.account_pubkey !== accountPubkey) {
      await this.closeLink(coordinate, accountPubkey);
      this.notifyLink(coordinate, accountPubkey, "chat_key_bound_to_other_account");
      return false;
    }
    const active = this.store.chatKeysForAccount(coordinate, accountPubkey).filter((k) => k.status === "active");
    if (!active.some((k) => k.chat_pubkey === w) && active.length >= MAX_CHAT_KEYS_PER_ACCOUNT) {
      await this.closeLink(coordinate, accountPubkey);
      this.notifyLink(coordinate, accountPubkey, "chat_device_cap_reached");
      return false;
    }
    // 'linked' keeps confirm_kp_id for the reuse grace (isFreshlySpentConfirmKp).
    this.store.setChatLinkStatus(coordinate, accountPubkey, "linked", this.now());
    const ok = await this.bindLinkedKey(coordinate, accountPubkey, w, link.label?.trim() || EXTERNAL_CHAT_KEY_LABEL);
    // Best effort, and AFTER the bind: the user is done with the code either way.
    await this.teardownConfirmGroup(link);
    return ok;
  }

  /** Bind W as an ACTIVE external chat key, republish the roster, add it to the room. */
  private async bindLinkedKey(
    coordinate: string,
    accountPubkey: string,
    w: string,
    label: string,
  ): Promise<boolean> {
    const recorded = this.store.upsertChatKey({
      coordinate,
      accountPubkey,
      chatPubkey: w,
      label,
      status: "active",
      external: true,
      now: this.now(),
    });
    if (!recorded) {
      this.notifyLink(coordinate, accountPubkey, "chat_key_bound_to_other_account");
      return false;
    }
    this.log(`[chat] linked external chat key ${w.slice(0, 8)} → ${accountPubkey.slice(0, 8)} (${label})`);
    this.rosterChanged(coordinate);
    this.notifyLinkProgress(coordinate, accountPubkey);
    await this.syncLinkedKey(coordinate, accountPubkey);
    return true;
  }

  /** The normal member sync, with the attestation path's durable retry on failure. */
  private async syncLinkedKey(coordinate: string, accountPubkey: string): Promise<void> {
    try {
      const synced = await this.syncMember(coordinate, accountPubkey);
      if (!synced && this.enqueueSync) {
        this.log(`[chat] link sync for ${accountPubkey.slice(0, 8)} in ${coordinate} did not complete — queued for durable retry`);
        this.enqueueSync(coordinate, accountPubkey);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`[chat] link sync for ${accountPubkey.slice(0, 8)} in ${coordinate} failed (${msg.slice(0, 120)})`);
      this.enqueueSync?.(coordinate, accountPubkey);
    }
  }

  /**
   * True when `kp` is the key package a link-confirmation group spent moments ago
   * (see {@link CHAT_LINK_CONFIRM_KP_GRACE_MS}).
   */
  private isFreshlySpentConfirmKp(coordinate: string, kp: AnyEvent): boolean {
    const owner = this.store.getChatKey(coordinate, kp.pubkey);
    if (!owner?.external) return false;
    const link = this.store.getChatLink(coordinate, owner.account_pubkey);
    return (
      !!link &&
      link.status === "linked" &&
      link.chat_pubkey === kp.pubkey &&
      link.confirm_kp_id === kp.id &&
      this.now() - link.updated_at < CHAT_LINK_CONFIRM_KP_GRACE_MS
    );
  }

  /** Close a link that did not complete, tearing its group down. */
  private async closeLink(coordinate: string, accountPubkey: string): Promise<void> {
    const link = this.store.getChatLink(coordinate, accountPubkey);
    this.store.setChatLinkStatus(coordinate, accountPubkey, "closed", this.now());
    if (link) await this.teardownConfirmGroup(link);
  }

  /**
   * Remove W from the confirmation group (so the external client shows it as
   * over) and drop our local state for it. Best effort on both counts: the code
   * is already dead in the database, which is what actually matters.
   */
  private async teardownConfirmGroup(link: MarmotChatLinkRow): Promise<void> {
    const id = link.confirm_group_id;
    if (!id) return;
    try {
      await this.mls.removePubkeys(id, [link.chat_pubkey]);
    } catch (e) {
      this.log(`[chat] confirmation group ${id.slice(0, 8)}: remove failed (${e instanceof Error ? e.message : e})`);
    }
    try {
      await this.mls.destroyGroup(id);
    } catch (e) {
      this.log(`[chat] confirmation group ${id.slice(0, 8)}: destroy failed (${e instanceof Error ? e.message : e})`);
    }
  }

  /** Close every expired pending link and tear its group down (all events). */
  async sweepExpiredLinks(): Promise<number> {
    const expired = this.store.expiredPendingChatLinks(this.now());
    for (const link of expired) {
      this.store.setChatLinkStatus(link.coordinate, link.account_pubkey, "closed", this.now());
      await this.teardownConfirmGroup(link);
    }
    if (expired.length) this.log(`[chat] closed ${expired.length} expired link request(s)`);
    return expired.length;
  }

  private notifyLink(coordinate: string, accountPubkey: string, category: ChatLinkRefusal): void {
    this.notifyAttendee?.(coordinate, accountPubkey, {
      v: 2,
      a: coordinate,
      pubkey: accountPubkey,
      stage: CHAT_LINK_STAGE,
      state: "poison",
      attempts: 0,
      error_category: category,
      retryable: false,
      at: Math.floor(this.now() / 1000),
    });
  }

  /** A `cleared` notice: supersedes an earlier refusal on the link card. */
  private notifyLinkProgress(coordinate: string, accountPubkey: string): void {
    this.notifyAttendee?.(coordinate, accountPubkey, {
      v: 2,
      a: coordinate,
      pubkey: accountPubkey,
      stage: CHAT_LINK_STAGE,
      state: "cleared",
      at: Math.floor(this.now() / 1000),
    });
  }

  // ── remove path ────────────────────────────────────────────────────────────
  /**
   * Remove an attendee from the chat: MLS Remove of the account key AND every
   * attested chat key (§4.2). An MLS Remove is real post-compromise security —
   * strictly stronger than the forward-only ECK rotation the revoke path already
   * does for directory/roster/match content.
   */
  async handleRevoke(
    coordinate: string,
    accountPubkey: string,
    /**
     * Device keys captured by the CALLER before it ran (audit B-9). The
     * `chat_revoke_member` job carries the account's chat pubkeys in its payload
     * because a `delete_data` withdrawal purges `marmot_chat_keys` in the same
     * lock that enqueues this job — so by the time it runs, the store can no
     * longer say which leaves belong to the leaver, and the removal silently
     * covered the account key only. Unioned with whatever is still stored, so a
     * legacy payload (no field) and a non-purging revoke both behave as before.
     */
    opts?: { chatPubkeys?: string[] },
  ): Promise<void> {
    const group = this.activeGroup(coordinate);
    if (!group) return;
    const chatKeys = this.store.chatKeysForAccount(coordinate, accountPubkey);
    const pubkeys = [
      ...new Set([accountPubkey, ...chatKeys.map((k) => k.chat_pubkey), ...(opts?.chatPubkeys ?? [])]),
    ];
    await this.mls.removePubkeys(group.mls_group_id, pubkeys);
    for (const k of chatKeys) this.store.setChatKeyStatus(coordinate, k.chat_pubkey, "revoked", this.now());
    // Same reason as the 21607 revoke path: the removed member's devices stay in
    // every OTHER member's roster-derived view until a new 31604 goes out.
    this.rosterChanged(coordinate);
    // A removed organizer must lose co-admin standing (desiredAdminPubkeys keys
    // off the approved-organizer set, so a removed organizer drops out of it).
    await this.maybeSyncAdmins(coordinate, accountPubkey);
    this.log(
      `[chat] removed ${accountPubkey.slice(0, 8)} (+${pubkeys.length - 1} chat key(s)) from ${coordinate}`,
    );
  }

  // ── 445 ingest ─────────────────────────────────────────────────────────────
  /** Ingest kind-445 traffic so the coordinator's leaf stays converged (§4.1). */
  async ingest(coordinate: string, events: AnyEvent[]): Promise<void> {
    const group = this.store.getMarmotGroup(coordinate);
    if (!group) return; // ingest even when frozen — stay converged
    await this.mls.ingest(group.mls_group_id, events);
  }
}
