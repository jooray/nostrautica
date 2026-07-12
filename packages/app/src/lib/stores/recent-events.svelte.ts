/**
 * "My events" — a small localStorage-backed list of events the user has created,
 * joined, or opened, so they can always navigate back to them from Home. This is
 * a convenience cache (the authoritative membership is the key material + relays).
 */
export interface RecentEvent {
  coordinate: string; // stable identity (naddr relay hints can vary)
  naddr: string;
  title: string;
  role: "organizer" | "attendee" | "visitor";
  icon?: string;
  at: number; // last-opened unix ms
}

const KEY = "nostrautica:recent-events";
const MAX = 30;

function load(): RecentEvent[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as RecentEvent[]) : [];
  } catch {
    return [];
  }
}

class RecentEvents {
  list = $state<RecentEvent[]>([]);

  init(): void {
    this.list = load().sort((a, b) => b.at - a.at);
  }

  /**
   * Record (or refresh) an event the user interacted with. `at` may be supplied
   * to backfill without bumping the event to the top (used by reconcile).
   */
  record(evt: Omit<RecentEvent, "at"> & { at?: number }): void {
    if (typeof localStorage === "undefined") return;
    const all = load();
    const prior = all.find((e) => e.coordinate === evt.coordinate);
    const existing = all.filter((e) => e.coordinate !== evt.coordinate);
    // Never downgrade a stored role (organizer > attendee > visitor).
    const rank = { visitor: 0, attendee: 1, organizer: 2 } as const;
    const role = prior && rank[prior.role] > rank[evt.role] ? prior.role : evt.role;
    // Prefer a real title over a placeholder; keep an existing icon if none given.
    const title = evt.title || prior?.title || "Event";
    const icon = evt.icon ?? prior?.icon;
    const at = evt.at ?? Date.now();
    const next = [{ ...evt, title, icon, role, at }, ...existing]
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX);
    localStorage.setItem(KEY, JSON.stringify(next));
    this.list = next;
  }

  /** True if an event (by coordinate) is already tracked. */
  has(coordinate: string): boolean {
    return load().some((e) => e.coordinate === coordinate);
  }

  remove(coordinate: string): void {
    const next = load().filter((e) => e.coordinate !== coordinate);
    if (typeof localStorage !== "undefined") localStorage.setItem(KEY, JSON.stringify(next));
    this.list = next;
  }
}

export const recentEvents = new RecentEvents();
