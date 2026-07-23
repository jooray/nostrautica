/**
 * "View as visitor" preview (spec §13 organizer QoL). An organizer flips this on
 * to see the event exactly as a non-member would — members-only tabs, sections,
 * the roster preview, and the admin/report/offline affordances all suppressed —
 * without leaving their own key. Scoped to one coordinate so it can't silently
 * bleed across events; a banner lets them exit.
 *
 * A member preview is deliberately NOT offered (an admin's own member view already
 * IS the member view); only the visitor view genuinely differs (NIP §15).
 */

export type PreviewableRole = "visitor" | "pending" | "attendee" | "organizer";

/**
 * The role to render under the preview flag: "visitor" while previewing, otherwise
 * the real role. Pure, so the suppression is unit-testable at the logic level.
 */
export function previewedRole(role: PreviewableRole, previewing: boolean): PreviewableRole {
  return previewing ? "visitor" : role;
}

class VisitorPreview {
  coordinate = $state<string | undefined>(undefined);
  active = $state(false);

  /** True when previewing THIS coordinate as a visitor. */
  isActive(coordinate: string | undefined): boolean {
    return this.active && !!coordinate && this.coordinate === coordinate;
  }

  enable(coordinate: string): void {
    this.coordinate = coordinate;
    this.active = true;
  }

  disable(): void {
    this.active = false;
  }

  toggle(coordinate: string): void {
    if (this.isActive(coordinate)) this.disable();
    else this.enable(coordinate);
  }
}

export const visitorPreview = new VisitorPreview();
