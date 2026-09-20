/**
 * The rows of the event "More" menu, in one place because two surfaces render
 * them: the More page on a phone, and the desktop rail, which has the height to
 * show the whole menu inline and therefore has no More tab at all (user
 * feedback 2026-09-20).
 *
 * Pure — role and session facts arrive as arguments rather than being read off
 * the stores — so the gating can be unit-tested without mounting anything.
 */
import { t } from "$lib/i18n/i18n.svelte.js";
import type { IconName } from "./icons/paths.js";
import type { Route } from "$lib/router/routes.js";

export type MoreRow = {
  icon: IconName;
  label: string;
  go: Route;
  /**
   * Route names that mean "you are already here". The More page doesn't use it
   * (every row leads away from it); the rail lights the row you are on, and a
   * destination can be reached under more than one route name — a DM thread is
   * still Messages, an event's settings page is still Manage event.
   */
  here: string[];
};

export function moreRows(o: {
  naddr: string;
  isMember: boolean;
  isOrganizer: boolean;
  loggedIn: boolean;
}): MoreRow[] {
  const rows: MoreRow[] = [];
  if (o.isMember) {
    rows.push({
      icon: "person",
      label: t("profile.mine.title"),
      go: { name: "myProfile", naddr: o.naddr },
      here: ["myProfile"],
    });
  }
  if (o.loggedIn) {
    // "Messages", not "Chat": this row opens DIRECT messages, while the nav's
    // Chat tab opens the event GROUP chat. Both rendered t("nav.chat"), so the
    // app showed one label pointing at two different destinations — and the
    // participant guide calls this one Messages anyway.
    rows.push({ icon: "chat", label: t("nav.messages"), go: { name: "dm" }, here: ["dm", "dmPeer"] });
  }
  if (o.isOrganizer) {
    rows.push({
      icon: "sliders",
      label: t("more.manageEvent"),
      go: { name: "admin", naddr: o.naddr },
      here: ["admin", "eventSettings"],
    });
  }
  rows.push({ icon: "star", label: t("more.allEvents"), go: { name: "home" }, here: ["home"] });
  rows.push({ icon: "plus", label: t("more.createEvent"), go: { name: "create" }, here: ["create"] });
  rows.push({ icon: "sliders", label: t("nav.settings"), go: { name: "settings" }, here: ["settings"] });
  return rows;
}
