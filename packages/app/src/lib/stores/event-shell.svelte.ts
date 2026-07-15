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
import { isMarmotChatEnabled } from "@nostrautica/protocol";
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

export type EventRole = "visitor" | "pending" | "attendee" | "organizer";

class EventShell {
  naddr = $state<string | undefined>(undefined);
  ctx = $state<EventContext | undefined>(undefined);
  role = $state<EventRole>("visitor");
  loading = $state(false);
  private token = 0;

  get isOrganizer(): boolean {
    return this.role === "organizer";
  }
  /** Approved member (attendee or organizer) — the roster is member-encrypted. */
  get isMember(): boolean {
    return this.role === "attendee" || this.role === "organizer";
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
    if (!naddr) {
      this.naddr = undefined;
      this.ctx = undefined;
      this.role = "visitor";
      this.loading = false;
      return;
    }
    this.naddr = naddr;
    const cached = cachedEventContext(naddr);
    if (cached) this.ctx = cached; // no flash on inter-subpage navigation
    this.loading = true;
    try {
      const ctx = cached ?? (await loadEventContext(naddr));
      if (tok !== this.token) return;
      this.ctx = ctx;
      const approved = await isApproved(ctx.coordinate).catch(() => false);
      let keys = await loadEventKeys(ctx.coordinate).catch(() => undefined);
      // Fresh-device deep-link: no local custody for an event this identity may
      // have created — read back the 30078 eventkeys backup (once per session).
      if (!keys && session.signer) {
        await recoverEventKeys(session.signer).catch(() => {});
        keys = await loadEventKeys(ctx.coordinate).catch(() => undefined);
      }
      if (tok !== this.token) return;
      const organizer = keys?.role === "organizer";
      this.role = organizer
        ? "organizer"
        : approved
          ? "attendee"
          : joinSentAt(ctx.coordinate) !== undefined
            ? "pending"
            : "visitor";
    } catch {
      /* keep whatever context/role we already have */
    } finally {
      if (tok === this.token) this.loading = false;
    }
  }
}

export const eventShell = new EventShell();
