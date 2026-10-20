import { describe, it, expect } from "vitest";
import {
  editPerEventSettings,
  emptyPerEventSettings,
  mergePerEventSettings,
  type StampedSettings,
} from "./settings-merge.js";
import { perEventSettingsSchema, MAX_SETTINGS_TOMBSTONES, type PerEventSettings } from "./schemas.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

const s = (settings: PerEventSettings, createdAt = 0): StampedSettings => ({ settings, createdAt });
const view = (d: PerEventSettings) => ({
  favorites: [...d.favorites].sort(),
  want_to_meet: [...d.want_to_meet].sort(),
  met: [...d.met].sort(),
  notes: d.notes,
});

describe("per-event settings merge (audit SB-88)", () => {
  it("two devices editing the same baseline both keep their change", () => {
    // Both devices read {favorites:[A], note A}.
    const baseline = editPerEventSettings(
      s(editPerEventSettings(s(emptyPerEventSettings()), { kind: "toggle", list: "favorites", pubkey: A }, 1_000)),
      { kind: "note", pubkey: A, note: "relays" },
      1_001,
    );
    const phone = editPerEventSettings(s(baseline), { kind: "toggle", list: "favorites", pubkey: B }, 5_000);
    const laptop = editPerEventSettings(s(baseline), { kind: "toggle", list: "met", pubkey: C }, 8_000);

    const ab = mergePerEventSettings(s(phone, 5), s(laptop, 8));
    const ba = mergePerEventSettings(s(laptop, 8), s(phone, 5));
    expect(view(ab)).toEqual(view(ba));
    expect(ab.favorites.sort()).toEqual([A, B]);
    expect(ab.met).toEqual([C]);
    expect(ab.notes[A]).toBe("relays");
  });

  it("a removal survives a stale copy that still lists the entry (tombstone)", () => {
    const withB = editPerEventSettings(s(emptyPerEventSettings()), { kind: "toggle", list: "want_to_meet", pubkey: B }, 1_000);
    const removed = editPerEventSettings(s(withB), { kind: "toggle", list: "want_to_meet", pubkey: B }, 2_000);
    const merged = mergePerEventSettings(s(withB), s(removed));
    expect(merged.want_to_meet).toEqual([]);
    expect(mergePerEventSettings(s(removed), s(withB)).want_to_meet).toEqual([]);
  });

  it("notes are last-writer-wins per pubkey, and a cleared note stays cleared", () => {
    const one = editPerEventSettings(s(emptyPerEventSettings()), { kind: "note", pubkey: A, note: "first" }, 1_000);
    const later = editPerEventSettings(s(one), { kind: "note", pubkey: A, note: "second" }, 3_000);
    const otherDevice = editPerEventSettings(s(one), { kind: "note", pubkey: B, note: "bee" }, 2_000);
    const m = mergePerEventSettings(s(later), s(otherDevice));
    expect(m.notes).toEqual({ [A]: "second", [B]: "bee" });
    const cleared = editPerEventSettings(s(m), { kind: "note", pubkey: A, note: "  " }, 4_000);
    expect(mergePerEventSettings(s(cleared), s(later)).notes[A]).toBeUndefined();
  });

  it("is associative and idempotent", () => {
    const x = editPerEventSettings(s(emptyPerEventSettings()), { kind: "toggle", list: "favorites", pubkey: A }, 10);
    const y = editPerEventSettings(s(emptyPerEventSettings()), { kind: "toggle", list: "favorites", pubkey: B }, 20);
    const z = editPerEventSettings(s(x), { kind: "toggle", list: "favorites", pubkey: A }, 30);
    const left = mergePerEventSettings(s(mergePerEventSettings(s(x), s(y))), s(z));
    const right = mergePerEventSettings(s(x), s(mergePerEventSettings(s(y), s(z))));
    expect(view(left)).toEqual(view(right));
    expect(view(mergePerEventSettings(s(left), s(left)))).toEqual(view(left));
    expect(left.favorites).toEqual([B]);
  });

  it("reads a legacy (clock-less) payload as a whole-document write at its created_at", () => {
    // A newer device favourited C at t=100 s; an OLD client then published a v2
    // payload without a clock at t=50 s that lists only A: C survives (newer), A is in.
    const mine = editPerEventSettings(s(emptyPerEventSettings()), { kind: "toggle", list: "favorites", pubkey: C }, 100_000);
    const legacy: PerEventSettings = { v: 2, favorites: [A], want_to_meet: [], met: [], notes: { [A]: "old" } };
    const m = mergePerEventSettings(s(mine), s(legacy, 50));
    expect(m.favorites.sort()).toEqual([A, C]);
    expect(m.notes[A]).toBe("old");
    // …but a legacy write made AFTER the favourite is a full-state assertion and
    // removes it, exactly the last-writer-wins those clients always had.
    expect(mergePerEventSettings(s(mine), s(legacy, 200)).favorites).toEqual([A]);
  });

  it("an edit made against a legacy document beats it even with a lagging clock", () => {
    const legacy: PerEventSettings = { v: 2, favorites: [A], want_to_meet: [], met: [], notes: {} };
    // Device clock says 1 s, the legacy event is stamped 1000 s.
    const e = editPerEventSettings(s(legacy, 1_000), { kind: "toggle", list: "favorites", pubkey: A }, 1_000);
    expect(e.favorites).toEqual([]);
    expect(mergePerEventSettings(s(e), s(legacy, 1_000)).favorites).toEqual([]);
  });

  it("produces a payload that both the current and a clock-unaware schema parse", () => {
    const d = editPerEventSettings(s(emptyPerEventSettings()), { kind: "toggle", list: "met", pubkey: A }, 1);
    const json = JSON.parse(JSON.stringify(d));
    expect(perEventSettingsSchema.parse(json).met).toEqual([A]);
    // What an old reader keeps: the four materialized fields.
    const { clock: _c, base: _b, ...old } = json;
    void _c;
    void _b;
    expect(perEventSettingsSchema.parse(old)).toMatchObject({ met: [A] });
  });

  it("caps tombstones at MAX_SETTINGS_TOMBSTONES, dropping the oldest", () => {
    let d = emptyPerEventSettings();
    const pk = (i: number) => i.toString(16).padStart(64, "0");
    for (let i = 0; i < MAX_SETTINGS_TOMBSTONES + 5; i++) {
      d = editPerEventSettings(s(d), { kind: "toggle", list: "favorites", pubkey: pk(i) }, 10 + 2 * i);
      d = editPerEventSettings(s(d), { kind: "toggle", list: "favorites", pubkey: pk(i) }, 11 + 2 * i);
    }
    expect(Object.keys(d.clock!.favorites)).toHaveLength(MAX_SETTINGS_TOMBSTONES);
    expect(d.clock!.favorites[pk(0)]).toBeUndefined();
    expect(perEventSettingsSchema.safeParse(d).success).toBe(true);
  });
});
