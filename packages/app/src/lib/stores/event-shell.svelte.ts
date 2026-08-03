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

class EventShell {
  naddr = $state<string | undefined>(undefined);
  ctx = $state<EventContext | undefined>(undefined);
  role = $state<EventRole>("visitor");
  loading = $state(false);
  private token = 0;

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
      this.loading = false;
      return; // not a decodable event address; nothing to resolve
    }
    const cached = cachedEventContext(naddr);
    if (cached) this.ctx = cached; // no flash on inter-subpage navigation
    // Seed from the persisted label before any await (§2.13) — never flash
    // "Visitor" at an organizer.
    const cachedRole = cacheGet<EventRole>(roleKey(coordinate))?.data;
    if (cachedRole) this.role = cachedRole;

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
}

export const eventShell = new EventShell();
