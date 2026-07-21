/**
 * "My events" — a small localStorage-backed list of events the user has created,
 * joined, or opened, so they can always navigate back to them from Home. This is
 * a convenience cache (the authoritative membership is the key material + relays).
 */
import { naddrToCoordinate, coordinateToNaddr } from "@nostrautica/protocol";

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
const RANK = { visitor: 0, attendee: 1, organizer: 2 } as const;

function coordOf(e: RecentEvent): string {
  if (e.coordinate) return e.coordinate;
  try {
    return naddrToCoordinate(e.naddr).coordinate; // backfill legacy entries
  } catch {
    return e.naddr;
  }
}

/** A usable naddr for an entry, reconstructed from the coordinate if missing. */
function naddrOf(e: RecentEvent): string | undefined {
  if (e.naddr) return e.naddr;
  try {
    return coordinateToNaddr(coordOf(e));
  } catch {
    return undefined;
  }
}

/** Collapse entries that refer to the same event (by coordinate). */
function dedupe(list: RecentEvent[]): RecentEvent[] {
  const byCoord = new Map<string, RecentEvent>();
  for (const raw of list) {
    // An entry that can't produce a navigable naddr is useless AND breaks the
    // Home card click ("#/e/undefined", prod console 2026-07-16) — drop it.
    const naddr = naddrOf(raw);
    if (!naddr) continue;
    const coordinate = coordOf(raw);
    const e = { ...raw, naddr, coordinate };
    const prior = byCoord.get(coordinate);
    if (!prior) {
      byCoord.set(coordinate, e);
      continue;
    }
    // Merge: highest role, most-recent timestamp, prefer a real title/icon.
    byCoord.set(coordinate, {
      coordinate,
      naddr: e.at >= prior.at ? e.naddr : prior.naddr,
      title: (e.at >= prior.at ? e.title : prior.title) || prior.title || e.title,
      role: RANK[e.role] >= RANK[prior.role] ? e.role : prior.role,
      icon: e.icon ?? prior.icon,
      at: Math.max(e.at, prior.at),
    });
  }
  return [...byCoord.values()].sort((a, b) => b.at - a.at).slice(0, MAX);
}

function load(): RecentEvent[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    return dedupe(raw ? (JSON.parse(raw) as RecentEvent[]) : []);
  } catch {
    return [];
  }
}

class RecentEvents {
  list = $state<RecentEvent[]>([]);

  init(): void {
    const cleaned = load(); // migrates legacy entries + dedupes
    if (typeof localStorage !== "undefined") localStorage.setItem(KEY, JSON.stringify(cleaned));
    this.list = cleaned;
  }

  /**
   * Record (or refresh) an event the user interacted with. `at` may be supplied
   * to backfill without bumping the event to the top (used by reconcile).
   */
  record(evt: Omit<RecentEvent, "at"> & { at?: number }): void {
    if (typeof localStorage === "undefined") return;
    // Never store an unnavigable entry (see dedupe): reconstruct the naddr from
    // the coordinate, or refuse the record.
    const naddr = naddrOf(evt as RecentEvent);
    if (!naddr) return;
    evt = { ...evt, naddr };
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

  /** Wipe the whole list (audit UX-6: logout must not leave the previous
   *  identity's event titles + roles visible to the next person on a shared
   *  device — this list isn't owner-scoped, so a full clear is the only
   *  correct option, not just a per-owner filter). */
  clear(): void {
    if (typeof localStorage !== "undefined") localStorage.removeItem(KEY);
    this.list = [];
  }
}

export const recentEvents = new RecentEvents();
