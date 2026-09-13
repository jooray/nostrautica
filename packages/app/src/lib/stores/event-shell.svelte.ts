/**
 * Shared event context + role for the event-scoped shell (redesign §4.4). The
 * EventNav and the layout's persistent compact header read this so they don't
 * have to re-plumb event data through every page. It is additive and read-only
 * for the shell — pages keep their own onMount loading (they need richer data).
 *
 * Token-guarded exactly like theme-injector.ts: a stale sync from a superseded
 * navigation never clobbers the current event. Reads from cache first so tab
 * gating almost never flashes.
 */
import { isCommunityCoordinate } from "@nostrautica/protocol";
import { isMarmotChatEnabled, naddrToCoordinate } from "@nostrautica/protocol";
import {
  loadEventContext,
  cachedEventContext,
  type EventContext,
} from "$lib/events/event-context.js";
import { isApproved } from "$lib/events/attendee.js";
import { loadEventKeys } from "$lib/events/keystore.js";
import { recoverEventKeys } from "$lib/events/recover.js";
import { joinSentAt } from "$lib/stores/join-sent.svelte.js";
import { session } from "$lib/signer/session.svelte.js";
import { visitorPreview, previewedRole } from "$lib/stores/visitor-preview.svelte.js";
import { cacheGet, cacheSet } from "$lib/cache/persist.js";

export type EventRole = "visitor" | "pending" | "attendee" | "organizer";

// Persist the resolved role per coordinate (owner-scoped, CACHING-PLAN §2.13) so
// a cold boot seeds the shell's role before the async keystore/grants
// reconciliation — never flash "Visitor" at an organizer.
function roleKey(coordinate: string): string {
  return `role:${coordinate}`;
}

/** How often to re-check local custody while the shell renders "pending". Short,
 *  because it is a keystore read with no relay traffic behind it. */
const APPROVAL_WATCH_MS = 5_000;

class EventShell {
  naddr = $state<string | undefined>(undefined);
  ctx = $state<EventContext | undefined>(undefined);
  role = $state<EventRole>("visitor");
  loading = $state(false);
  private token = 0;
  /** Interval that watches for an approval landing while we render "pending". */
  private approvalWatch: ReturnType<typeof setInterval> | undefined;
  private watching: string | undefined;

  /**
   * The role the shell should render as — the real role, unless the organizer is
   * previewing the event as a visitor (spec §13), in which case every member/
   * organizer nav surface is suppressed to the public view.
   */
  get effectiveRole(): EventRole {
    return previewedRole(this.role, visitorPreview.isActive(this.ctx?.coordinate));
  }
  get isOrganizer(): boolean {
    return this.effectiveRole === "organizer";
  }
  /** Approved member (attendee or organizer) — the roster is member-encrypted. */
  get isMember(): boolean {
    return this.effectiveRole === "attendee" || this.effectiveRole === "organizer";
  }
  get showPeople(): boolean {
    return this.isMember;
  }
  /**
   * A standing community rather than a dated event (config `mode`).
   *
   * Read from the coordinate's KIND (31612 against 31923), which is the single
   * source of truth — there is no `mode` tag on the config, precisely so the two
   * have nowhere to disagree (PROTOCOL-NIP.md §1.1).
   *
   * Reads false while the context is still loading, which is the right way
   * round: an event is what every record written before communities existed is,
   * so the fallback is the common case rather than a flash of the rarer one.
   */
  get isCommunity(): boolean {
    return !!this.ctx && isCommunityCoordinate(this.ctx.coordinate);
  }
  get showMatches(): boolean {
    return (
      this.isMember &&
      !!this.ctx?.config.coordinator &&
      this.ctx.config.matching === "on"
    );
  }
  /**
   * Talks destination (spec F2). Gated exactly like showMatches: members-only, and
   * only when the organizer enabled talks (`talks !== "off"`). A normal (talks-off)
   * event never shows the Talks tab or any talk step.
   */
  get showTalks(): boolean {
    return this.isMember && !!this.ctx && this.ctx.config.talks !== "off";
  }
  /** In "prerecord-first" mode Talks is featured before People in the nav order. */
  get talksFirst(): boolean {
    return this.ctx?.config.talks === "prerecord-first";
  }
  /**
   * Marmot group chat (MARMOT-GROUP-CHAT §7). Members-only, and only when the
   * event has `chat=marmot` AND a coordinator (the MLS admin bot) — a
   * coordinator-less chat tag is treated as absent. Non-members never see it.
   */
  get showChat(): boolean {
    return this.isMember && !!this.ctx && isMarmotChatEnabled(this.ctx.config);
  }

  /**
   * Reconcile the shell with the current event naddr. Call from a layout $effect
   * with `eventNaddr(router.route)` (and read session.pubkey so it re-runs on
   * login/logout). Stale responses are dropped via the request token.
   */
  async sync(naddr: string | undefined): Promise<void> {
    const tok = ++this.token;
    // Guard the string "undefined" / "null" too — a bad hash or a coerced
    // missing prop becomes truthy and would otherwise hit naddrToCoordinate
    // ("Bad event address: \"undefined\"" / bech32 Letter-"1" error).
    if (!naddr || naddr === "undefined" || naddr === "null") {
      this.naddr = undefined;
      this.ctx = undefined;
      this.role = "visitor";
      this.loading = false;
      return;
    }
    this.naddr = naddr;
    if (session.pubkey && !session.custodyReady) {
      this.loading = true;
      return;
    }
    // The coordinate is DERIVABLE from the naddr — it is what the naddr encodes.
    // Everything the role depends on (the persisted label, ECK custody, the
    // join marker) is keyed by it and lives on this device, so none of it has
    // any business waiting for a relay. It used to anyway: the whole block below
    // sat behind `await loadEventContext(naddr)`, so opening a previously-visited
    // event offline, or on a cold mirror, showed the visitor view until the
    // network answered — and answered nothing the role needed.
    let coordinate: string;
    try {
      coordinate = naddrToCoordinate(naddr).coordinate;
    } catch {
      // Reset before bailing: without this the previous event's role stays, so a
      // malformed address navigated to FROM an event you organize renders as
      // organizer.
      this.role = "visitor";
      this.loading = false;
      return; // not a decodable event address; nothing to resolve
    }
    const cached = cachedEventContext(naddr);
    if (cached) this.ctx = cached; // no flash on inter-subpage navigation
    // Seed from the persisted label before any await (§2.13) — never flash
    // "Visitor" at an organizer.
    const cachedRole = cacheGet<EventRole>(roleKey(coordinate))?.data;
    // `?? "visitor"`, not `if (cachedRole)`. The store is a singleton and this is
    // the only place `role` is seeded on navigation, so leaving it alone when the
    // NEW event has no cached label kept the PREVIOUS event's: an organizer of X
    // opening Y for the first time rendered Y with Admin, People and Matches until
    // the custody read below resolved. The no-flash guarantee this line exists for
    // is about a previously-visited event, where `cachedRole` is present; where it
    // is absent we genuinely know nothing yet, and "visitor" is the honest floor —
    // the same one the store starts at and the same one the bad-address branch
    // above uses.
    this.role = cachedRole ?? "visitor";

    this.loading = true;
    try {
      // Resolve the role from local custody FIRST, and independently of the
      // context load below. `isApproved`/`loadEventKeys` are keystore reads.
      const approved = await isApproved(coordinate);
      let keys = await loadEventKeys(coordinate);
      // Fresh-device deep-link: no local custody for an event this identity may
      // have created — read back the 30078 eventkeys backup (once per session).
      if (!keys && session.signer) {
        await recoverEventKeys(session.signer).catch(() => {});
        keys = await loadEventKeys(coordinate);
      }
      if (tok !== this.token) return;
      const resolved: EventRole = keys?.role === "organizer"
        ? "organizer"
        : approved
          ? "attendee"
          : joinSentAt(coordinate) !== undefined
            ? "pending"
            : "visitor";
      this.role = resolved;
      // Reached only after successful custody reads, so it is authoritative and
      // may correct a sticky stale organizer label.
      cacheSet(roleKey(coordinate), resolved, Math.floor(Date.now() / 1000));
      // An approval that lands WHILE the event is open must move the nav, not wait
      // for a navigation (see watchForApproval).
      this.watchForApproval(resolved === "pending" ? coordinate : undefined);

      // The context is needed for the tab GATING (matching/talks/chat flags),
      // not for the role. Load it after, so a slow or unreachable relay delays
      // only the tabs whose visibility genuinely depends on the event's config.
      const ctx = cached ?? (await loadEventContext(naddr));
      if (tok !== this.token) return;
      this.ctx = ctx;
    } catch {
      /* keep whatever context/role we already have */
    } finally {
      if (tok === this.token) this.loading = false;
    }
  }

  /**
   * Re-resolve ONLY the role from local custody, for the event already synced.
   *
   * Deliberately network-free: everything the role depends on (ECK custody, the
   * organizer label, the join marker) is a keystore read on this device. That is
   * what makes it cheap enough to poll.
   */
  async refreshRole(): Promise<void> {
    const naddr = this.naddr;
    if (!naddr) return;
    let coordinate: string;
    try {
      coordinate = naddrToCoordinate(naddr).coordinate;
    } catch {
      return;
    }
    const tok = this.token;
    const approved = await isApproved(coordinate).catch(() => false);
    const keys = await loadEventKeys(coordinate).catch(() => undefined);
    if (tok !== this.token || this.naddr !== naddr) return; // superseded navigation
    const resolved: EventRole = keys?.role === "organizer"
      ? "organizer"
      : approved
        ? "attendee"
        : joinSentAt(coordinate) !== undefined
          ? "pending"
          : "visitor";
    if (resolved === this.role) return;
    this.role = resolved;
    cacheSet(roleKey(coordinate), resolved, Math.floor(Date.now() / 1000));
    this.watchForApproval(resolved === "pending" ? coordinate : undefined);
  }

  /**
   * While the shell renders "pending", watch for the approval landing.
   *
   * Reported from production: an attendee approved while sitting on the event page
   * kept the visitor-shaped bottom nav — no People, no Matches — even though the
   * page itself had already noticed and was offering "see who's here". Leaving to
   * "all events" and coming back fixed it. The cause is that `sync()` runs from a
   * layout effect keyed on the route and the session, so nothing re-ran it when the
   * ECK grant arrived mid-visit: the page's own grant poll updated the PAGE and had
   * no way to tell the SHELL.
   *
   * Watching here rather than calling out from the page keeps it working on every
   * event subpage, not just the one that happens to poll. The check is a local
   * keystore read, so this costs no relay traffic; the page's poll does the
   * fetching, this just notices the result.
   */
  private watchForApproval(coordinate: string | undefined): void {
    if (this.watching === coordinate) return;
    this.watching = coordinate;
    if (this.approvalWatch !== undefined) {
      clearInterval(this.approvalWatch);
      this.approvalWatch = undefined;
    }
    if (!coordinate || typeof setInterval !== "function") return;
    this.approvalWatch = setInterval(() => {
      void this.refreshRole();
    }, APPROVAL_WATCH_MS);
  }
}

export const eventShell = new EventShell();
