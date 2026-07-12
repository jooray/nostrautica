/**
 * "My events" — a small localStorage-backed list of events the user has created,
 * joined, or opened, so they can always navigate back to them from Home. This is
 * a convenience cache (the authoritative membership is the key material + relays).
 */
export interface RecentEvent {
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

  /** Record (or refresh) an event the user interacted with. */
  record(evt: Omit<RecentEvent, "at">): void {
    if (typeof localStorage === "undefined") return;
    const existing = load().filter((e) => e.naddr !== evt.naddr);
    // Never downgrade a stored role (organizer > attendee > visitor).
    const prior = load().find((e) => e.naddr === evt.naddr);
    const rank = { visitor: 0, attendee: 1, organizer: 2 } as const;
    const role =
      prior && rank[prior.role] > rank[evt.role] ? prior.role : evt.role;
    const next = [{ ...evt, role, at: Date.now() }, ...existing].slice(0, MAX);
    localStorage.setItem(KEY, JSON.stringify(next));
    this.list = next.sort((a, b) => b.at - a.at);
  }

  remove(naddr: string): void {
    const next = load().filter((e) => e.naddr !== naddr);
    if (typeof localStorage !== "undefined") localStorage.setItem(KEY, JSON.stringify(next));
    this.list = next;
  }
}

export const recentEvents = new RecentEvents();
