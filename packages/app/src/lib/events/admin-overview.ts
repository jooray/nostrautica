/**
 * Admin operational overview (audit UX-A5). Turns the admin screen from a control
 * LIST into a control ROOM: a compact set of headline metrics an organizer scans
 * at a glance, with urgent exceptions (failed jobs, billing blocked) surfaced
 * ABOVE the healthy detail. Pure so the dashboard is a
 * render of derived state and the exception ordering is unit-testable.
 */
import type { MessageKey } from "$lib/i18n/messages.js";

export type MetricTone = "ok" | "warn" | "neutral";

export type OverviewMetricId =
  | "pending"
  | "approved"
  | "missingIntros"
  | "failedJobs"
  | "talksAwaiting"
  | "matches"
  | "coordinator"
  | "billing";

export interface OverviewMetric {
  id: OverviewMetricId;
  labelKey: MessageKey;
  /** Display value (a count, or a short status string the view localizes). */
  value: number | string;
  tone: MetricTone;
  /** Urgent items float to the top of the dashboard. */
  exception: boolean;
}

export interface OverviewInput {
  pendingCount: number;
  approvedCount: number;
  missingIntros: number;
  failedJobs: number;
  talksAwaiting: number;
  matchesAvailable: boolean;
  hasCoordinator: boolean;
  coordinatorUnknown: boolean; // last-seen not yet fetched
  billingBlocked: boolean;
}

const LABEL: Record<OverviewMetricId, MessageKey> = {
  pending: "admin.overview.pending",
  approved: "admin.overview.approved",
  missingIntros: "admin.overview.missingIntros",
  failedJobs: "admin.overview.failedJobs",
  talksAwaiting: "admin.overview.talksAwaiting",
  matches: "admin.overview.matches",
  coordinator: "admin.overview.coordinator",
  billing: "admin.overview.billing",
};

/**
 * Build the overview metrics, exceptions first. Exceptions: any failed jobs or
 * billing blocked — both are things only the organizer can unblock. Everything
 * else follows in a stable
 * order. Coordinator/billing/talks/matches metrics are omitted when they don't
 * apply (no coordinator attached).
 */
export function buildOverview(input: OverviewInput): {
  exceptions: OverviewMetric[];
  metrics: OverviewMetric[];
} {
  const all: OverviewMetric[] = [];

  // Exception-eligible signals first.
  if (input.failedJobs > 0) {
    all.push({ id: "failedJobs", labelKey: LABEL.failedJobs, value: input.failedJobs, tone: "warn", exception: true });
  }
  if (input.hasCoordinator && input.billingBlocked) {
    all.push({ id: "billing", labelKey: LABEL.billing, value: "billing.blocked", tone: "warn", exception: true });
  }
  // There is deliberately no "coordinator looks stale" exception. The only
  // liveness input available is the timestamp of the coordinator's newest
  // published work for this event, which stops advancing whenever nobody joins —
  // so this tile fired on healthy coordinators during quiet nights (production
  // report 2026-07-28). Until the protocol carries a real heartbeat, a quiet
  // coordinator is indistinguishable from a dead one and must not be reported as
  // an exception. See the comment on `coordQuiet` in Admin.svelte.

  // Healthy detail.
  all.push({ id: "pending", labelKey: LABEL.pending, value: input.pendingCount, tone: input.pendingCount > 0 ? "warn" : "ok", exception: false });
  all.push({ id: "approved", labelKey: LABEL.approved, value: input.approvedCount, tone: "neutral", exception: false });
  all.push({ id: "missingIntros", labelKey: LABEL.missingIntros, value: input.missingIntros, tone: input.missingIntros > 0 ? "neutral" : "ok", exception: false });
  if (input.hasCoordinator) {
    all.push({ id: "talksAwaiting", labelKey: LABEL.talksAwaiting, value: input.talksAwaiting, tone: input.talksAwaiting > 0 ? "warn" : "ok", exception: false });
    all.push({ id: "matches", labelKey: LABEL.matches, value: input.matchesAvailable ? "yes" : "no", tone: "neutral", exception: false });
    // Coordinator presence: "Live" once it has published anything for this event,
    // "Checking…" until we know. Never an exception — see above.
    all.push({
      id: "coordinator",
      labelKey: LABEL.coordinator,
      value: input.coordinatorUnknown ? "coord.unknown" : "coord.ok",
      tone: input.coordinatorUnknown ? "warn" : "ok",
      exception: false,
    });
  }

  return {
    exceptions: all.filter((m) => m.exception),
    metrics: all.filter((m) => !m.exception),
  };
}
