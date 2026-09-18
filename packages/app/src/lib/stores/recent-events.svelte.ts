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
  /**
   * The network says this identity asked to join, and this device holds no key
   * for it (audit E9, see events/membership.ts).
   *
   * A STATE, not a role — which is why it is a separate field rather than a
   * fourth value in `role`. "visitor" already means something specific and
   * useful ("you have looked at this"), every role comparison in the app is a
   * rank over those three, and the thing being recorded here is orthogonal to
   * all of it: it is the difference between an event that is absent from the
   * list and one that is present but unopenable. It is only ever meaningful
   * alongside "visitor" — anything the key store can place has a real role —
   * and `merge`/`record` below drop it the moment a role outranks that, so an
   * event whose key finally arrives cannot keep rendering "waiting for its key".
   */
  pendingKey?: boolean;
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

/** The coordinate an naddr actually encodes (`fallback` if it won't decode). */
function canonicalCoordinate(naddr: string, fallback: string): string {
  try {
    return naddrToCoordinate(naddr).coordinate;
  } catch {
    return fallback;
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

/** Merge two entries that turned out to be the same event: highest role,
 *  most-recent timestamp, prefer a real title/icon. */
function merge(prior: RecentEvent, e: RecentEvent): RecentEvent {
  const role = RANK[e.role] >= RANK[prior.role] ? e.role : prior.role;
  const newer = e.at >= prior.at ? e : prior;
  const older = e.at >= prior.at ? prior : e;
  return {
    coordinate: e.coordinate || prior.coordinate,
    naddr: e.at >= prior.at ? e.naddr : prior.naddr,
    title: (e.at >= prior.at ? e.title : prior.title) || prior.title || e.title,
    role,
    icon: e.icon ?? prior.icon,
    at: Math.max(e.at, prior.at),
    // Newest-record-wins, like `naddr`/`title` above — and `??`, not `||`: an
    // explicit `false` on the fresher record is a scan that has just looked and
    // found the key, and must beat a stale `true`, while `undefined` is a record
    // with no opinion (ordinary navigation) and inherits the other one's.
    pendingKey: pendingFor(role, newer.pendingKey ?? older.pendingKey),
  };
}

/** A pending-key flag is only ever true of an entry the key store cannot place. */
function pendingFor(role: RecentEvent["role"], pending: boolean | undefined): boolean {
  return role === "visitor" && !!pending;
}

/** Collapse entries that refer to the same event (by coordinate, then by naddr). */
function dedupe(list: RecentEvent[]): RecentEvent[] {
  const byCoord = new Map<string, RecentEvent>();
  for (const raw of list) {
    // An entry that can't produce a navigable naddr is useless AND breaks the
    // Home card click ("#/e/undefined", prod console 2026-07-16) — drop it.
    const naddr = naddrOf(raw);
    if (!naddr) continue;
    const coordinate = coordOf(raw);
    const e: RecentEvent = { ...raw, naddr, coordinate };
    // Enforce "pendingKey implies visitor" on the way IN too — this is the load
    // path for whatever an older build or a half-written record left behind, and
    // the invariant has to hold for anything that reaches a render. CLEARING
    // only, never setting: an absent flag must stay absent, because merge()
    // below relies on telling "no opinion" apart from an explicit `false`.
    if (e.pendingKey && e.role !== "visitor") e.pendingKey = false;
    const prior = byCoord.get(coordinate);
    byCoord.set(coordinate, prior ? merge(prior, e) : e);
  }
  // Second pass — REPAIR, not merge. `coordinate` is the authoritative identity;
  // `naddr` is a navigable encoding of it, and the two must describe the same
  // event. A caller can still pair them wrongly (prod, 2026-07-24: a destroyed
  // EventHome's in-flight onMount recorded its OWN ctx.coordinate against the
  // LIVE route's naddr — a prop read after destroy returns the route you moved
  // TO), which does two kinds of damage: the entry navigates to the wrong event,
  // and it collides on `naddr` with the entry that legitimately owns it. That
  // collision is a duplicate {#each} key — a HARD THROW in Svelte 5, not a
  // warning — which kills the route mid-creation and leaves the pane on
  // "Loading…" forever (the Chat tab was unreachable until localStorage was
  // cleared). Re-derive the naddr from the coordinate so BOTH events survive
  // with correct links; merging them here would silently delete one.
  //
  // A consistent naddr is left untouched, relay hints and all — only a
  // disagreeing one is rebuilt (bare, hints re-learned on the next context load).
  const repaired = [...byCoord.values()].map((e) => {
    if (canonicalCoordinate(e.naddr, e.coordinate) === e.coordinate) return e;
    console.warn("[recent-events] naddr/coordinate mismatch, re-deriving:", e.coordinate);
    try {
      return { ...e, naddr: coordinateToNaddr(e.coordinate) };
    } catch {
      return e; // unparseable coordinate — the naddr pass below still guards
    }
  });
  // Backstop: whatever happens above, the render key must come out unique. Two
  // coordinate STRINGS can still encode to one naddr (hex case, say), and that
  // genuinely IS one event — so merging is right here, unlike the case above.
  const byNaddr = new Map<string, RecentEvent>();
  for (const e of repaired) {
    const prior = byNaddr.get(e.naddr);
    byNaddr.set(e.naddr, prior ? merge(prior, e) : e);
  }
  return [...byNaddr.values()].sort((a, b) => b.at - a.at).slice(0, MAX);
}

function storageKey(owner: string | null): string {
  return owner ? `${KEY}:${owner}` : KEY;
}

function load(owner: string | null): RecentEvent[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(storageKey(owner));
    return dedupe(raw ? (JSON.parse(raw) as RecentEvent[]) : []);
  } catch {
    return [];
  }
}

class RecentEvents {
  list = $state<RecentEvent[]>([]);
  owner = $state<string | null>(null);

  init(): void {
    const cleaned = load(this.owner); // migrates legacy entries + dedupes
    if (typeof localStorage !== "undefined")
      localStorage.setItem(storageKey(this.owner), JSON.stringify(cleaned));
    this.list = cleaned;
  }

  /** Switch the visible role/navigation cache to the active identity. */
  setOwner(owner: string | null): void {
    if (this.owner === owner) return;
    this.owner = owner;
    this.init();
  }

  /**
   * Record (or refresh) an event the user interacted with. `at` may be supplied
   * to backfill without bumping the event to the top (used by reconcile).
   */
  record(evt: Omit<RecentEvent, "at"> & { at?: number }, authoritativeRole = false): void {
    if (typeof localStorage === "undefined") return;
    // Never store an unnavigable entry (see dedupe): reconstruct the naddr from
    // the coordinate, or refuse the record.
    const naddr = naddrOf(evt as RecentEvent);
    if (!naddr) return;
    evt = { ...evt, naddr };
    const all = load(this.owner);
    const prior = all.find((e) => e.coordinate === evt.coordinate);
    const existing = all.filter((e) => e.coordinate !== evt.coordinate);
    // Ordinary navigation cannot downgrade a role based on a transient miss.
    // An explicit reconciliation follows a successful authoritative custody
    // read and may correct an old sticky organizer/attendee label.
    const rank = { visitor: 0, attendee: 1, organizer: 2 } as const;
    const role =
      !authoritativeRole && prior && rank[prior.role] > rank[evt.role] ? prior.role : evt.role;
    // Prefer a real title over a placeholder; keep an existing icon if none given.
    const title = evt.title || prior?.title || "Event";
    const icon = evt.icon ?? prior?.icon;
    const at = evt.at ?? Date.now();
    const pendingKey = pendingFor(role, evt.pendingKey ?? prior?.pendingKey);
    // Through dedupe(), not a raw sort+slice: `existing` only drops entries that
    // match on the coordinate STRING, so an entry whose stored coordinate is
    // stale/empty/differently-cased survives alongside the incoming one and the
    // two collide on `naddr` — the render key. Every assignment to `list` must
    // leave it unique on both identity fields, or the next render throws.
    const next = dedupe([{ ...evt, title, icon, role, at, pendingKey }, ...existing]);
    localStorage.setItem(storageKey(this.owner), JSON.stringify(next));
    this.list = next;
  }

  reconcile(evt: Omit<RecentEvent, "at"> & { at?: number }): void {
    this.record(evt, true);
  }

  /** True if an event (by coordinate) is already tracked. */
  has(coordinate: string): boolean {
    return load(this.owner).some((e) => e.coordinate === coordinate);
  }

  remove(coordinate: string): void {
    const next = load(this.owner).filter((e) => e.coordinate !== coordinate);
    if (typeof localStorage !== "undefined")
      localStorage.setItem(storageKey(this.owner), JSON.stringify(next));
    this.list = next;
  }

  /** Wipe the active owner's list. */
  clear(): void {
    if (typeof localStorage !== "undefined") localStorage.removeItem(storageKey(this.owner));
    this.list = [];
  }
}

export const recentEvents = new RecentEvents();
