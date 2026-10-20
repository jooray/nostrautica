/**
 * Commutative merge of the user-private per-event settings (30078
 * `nostrautica:ev:<blinded>`, SPECIFICATION §7.3) across one account's devices
 * (audit SB-88).
 *
 * The payload is one replaceable event, so two devices that each read it, change
 * one thing and publish the whole document used to erase each other: the phone's
 * new favourite disappeared the moment the laptop marked someone as met, because
 * the laptop's copy predated the favourite and `publishMonotonic` stepped its
 * `created_at` above the phone's. Same model as the DM read state
 * (dm-read-state.ts): every write is read-merge-write, and the merge is a
 * per-entry last-writer-wins with tombstones, which is commutative, associative
 * and idempotent, so devices converge whatever order their writes land in.
 *
 * WIRE SHAPE (still `v: 2`, additive). The four fields old clients know stay the
 * materialized view: `favorites`/`want_to_meet`/`met` list who is IN the set and
 * `notes` holds the live notes. Beside them:
 *
 *  - `clock[field][pubkey]` = ms timestamp of the last change to that entry. A
 *    pubkey stamped in `clock[field]` but absent from the field is a tombstone.
 *  - `base` = the stamp every entry NOT named in the clock implicitly carries
 *    ("absent as of base").
 *
 * A document without `clock` (written by a client that predates this, or before
 * it) is read as a whole-document assertion made at its `created_at`: everything
 * it lists is present as of then, everything else absent as of then. That is
 * exactly the last-writer-wins those clients always had, so a newer client never
 * does worse than before against an older one, and its own later edits
 * (stamped after that `created_at`) still survive the older client's write.
 */
import { MAX_SETTINGS_TOMBSTONES, PROTOCOL_VERSION } from "./schemas.js";
import type { PerEventSettings, SettingsClock } from "./schemas.js";

export type SettingsListField = "favorites" | "want_to_meet" | "met";
const LIST_FIELDS: SettingsListField[] = ["favorites", "want_to_meet", "met"];
const HEX32 = /^[0-9a-f]{64}$/;

interface Entry {
  present: boolean;
  at: number;
  /** notes only */
  text?: string;
}
interface Normalized {
  base: number;
  lists: Record<SettingsListField, Map<string, Entry>>;
  notes: Map<string, Entry>;
  /** Notes keyed by something that is not a pubkey: carried, never stamped. */
  oddNotes: Record<string, string>;
}

/** A settings document together with the `created_at` (seconds) of the event that carried it. */
export interface StampedSettings {
  settings: PerEventSettings;
  createdAt: number;
}

function normalize({ settings, createdAt }: StampedSettings): Normalized {
  const clock = settings.clock;
  const base = clock ? (settings.base ?? 0) : Math.max(0, createdAt) * 1000;
  const lists = {} as Normalized["lists"];
  for (const f of LIST_FIELDS) {
    const m = new Map<string, Entry>();
    const stamps = clock?.[f] ?? {};
    for (const pk of settings[f] ?? []) m.set(pk, { present: true, at: stamps[pk] ?? base });
    for (const [pk, at] of Object.entries(stamps)) if (!m.has(pk)) m.set(pk, { present: false, at });
    lists[f] = m;
  }
  const notes = new Map<string, Entry>();
  const oddNotes: Record<string, string> = {};
  const noteStamps = clock?.notes ?? {};
  for (const [pk, text] of Object.entries(settings.notes ?? {})) {
    if (HEX32.test(pk)) notes.set(pk, { present: true, at: noteStamps[pk] ?? base, text });
    else oddNotes[pk] = text;
  }
  for (const [pk, at] of Object.entries(noteStamps)) if (!notes.has(pk)) notes.set(pk, { present: false, at });
  return { base, lists, notes, oddNotes };
}

/** The winning view of one entry. Total order, so the merge is commutative. */
function win(a: Entry, b: Entry): Entry {
  if (a.at !== b.at) return a.at > b.at ? a : b;
  if (a.present !== b.present) return a.present ? a : b; // add-wins on a tie
  if ((a.text ?? "") !== (b.text ?? "")) return (a.text ?? "") > (b.text ?? "") ? a : b;
  return a;
}

function mergeMaps(a: Map<string, Entry>, aBase: number, b: Map<string, Entry>, bBase: number): Map<string, Entry> {
  const out = new Map<string, Entry>();
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    out.set(k, win(a.get(k) ?? { present: false, at: aBase }, b.get(k) ?? { present: false, at: bBase }));
  }
  return out;
}

function denormalize(n: Normalized): PerEventSettings {
  const clock: SettingsClock = { favorites: {}, want_to_meet: {}, met: {}, notes: {} };
  const out: PerEventSettings = { v: PROTOCOL_VERSION, favorites: [], want_to_meet: [], met: [], notes: {} };
  const emit = (m: Map<string, Entry>, stamps: Record<string, number>, onPresent: (pk: string, e: Entry) => void) => {
    const ordered = [...m.entries()].sort((x, y) => x[1].at - y[1].at || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
    // A tombstone at or below `base` says nothing `base` does not already say.
    const tombs = ordered.filter(([, e]) => !e.present && e.at > n.base);
    const keepTombs = new Set(tombs.slice(-MAX_SETTINGS_TOMBSTONES).map(([pk]) => pk));
    for (const [pk, e] of ordered) {
      if (e.present) {
        stamps[pk] = e.at;
        onPresent(pk, e);
      } else if (keepTombs.has(pk)) {
        stamps[pk] = e.at;
      }
    }
  };
  for (const f of LIST_FIELDS) emit(n.lists[f], clock[f], (pk) => out[f].push(pk));
  emit(n.notes, clock.notes, (pk, e) => {
    out.notes[pk] = e.text ?? "";
  });
  for (const [k, text] of Object.entries(n.oddNotes)) if (!(k in out.notes)) out.notes[k] = text;
  out.clock = clock;
  out.base = n.base;
  return out;
}

/**
 * Merge two copies of the same settings document (any mix of stamped and
 * legacy). Commutative, associative and idempotent on the materialized view.
 * The result always carries a clock.
 */
export function mergePerEventSettings(a: StampedSettings, b: StampedSettings): PerEventSettings {
  const na = normalize(a);
  const nb = normalize(b);
  const lists = {} as Normalized["lists"];
  for (const f of LIST_FIELDS) lists[f] = mergeMaps(na.lists[f], na.base, nb.lists[f], nb.base);
  return denormalize({
    base: Math.max(na.base, nb.base),
    lists,
    notes: mergeMaps(na.notes, na.base, nb.notes, nb.base),
    oddNotes: { ...nb.oddNotes, ...na.oddNotes },
  });
}

export type SettingsEdit =
  | { kind: "toggle"; list: SettingsListField; pubkey: string }
  | { kind: "note"; pubkey: string; note: string };

/**
 * Apply one user edit, stamped `nowMs` — or just past the entry's current stamp
 * and the document's `base`, so an edit always beats the state it was made
 * against even when this device's clock runs behind the one that wrote it.
 */
export function editPerEventSettings(doc: StampedSettings, edit: SettingsEdit, nowMs: number): PerEventSettings {
  const n = normalize(doc);
  const map = edit.kind === "toggle" ? n.lists[edit.list] : n.notes;
  const cur = map.get(edit.pubkey) ?? { present: false, at: n.base };
  const at = Math.max(Math.floor(nowMs), cur.at + 1, n.base + 1);
  if (edit.kind === "toggle") {
    map.set(edit.pubkey, { present: !cur.present, at });
  } else {
    const text = edit.note.trim();
    map.set(edit.pubkey, text ? { present: true, at, text } : { present: false, at });
  }
  return denormalize(n);
}

/** The empty document, stamped (a first save on a fresh account). */
export function emptyPerEventSettings(): PerEventSettings {
  return {
    v: PROTOCOL_VERSION,
    favorites: [],
    want_to_meet: [],
    met: [],
    notes: {},
    clock: { favorites: {}, want_to_meet: {}, met: {}, notes: {} },
    base: 0,
  };
}
