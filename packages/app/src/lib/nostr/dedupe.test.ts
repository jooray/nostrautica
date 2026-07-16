import { describe, it, expect } from "vitest";
import { replaceableKey, EventDeduper, type MinimalEvent } from "./dedupe.js";

function ev(partial: Partial<MinimalEvent>): MinimalEvent {
  return {
    id: partial.id ?? Math.random().toString(36).slice(2),
    kind: partial.kind ?? 1,
    pubkey: partial.pubkey ?? "pk",
    created_at: partial.created_at,
    tags: partial.tags ?? [],
  };
}

describe("replaceableKey", () => {
  it("keys kind 0/3 and 1xxxx by kind:pubkey", () => {
    expect(replaceableKey(ev({ kind: 0, pubkey: "a" }))).toBe("0:a");
    expect(replaceableKey(ev({ kind: 3, pubkey: "a" }))).toBe("3:a");
    expect(replaceableKey(ev({ kind: 10002, pubkey: "a" }))).toBe("10002:a");
  });

  it("keys addressable kinds by kind:pubkey:d", () => {
    expect(replaceableKey(ev({ kind: 31600, pubkey: "a", tags: [["d", "x"]] }))).toBe(
      "31600:a:x",
    );
    expect(replaceableKey(ev({ kind: 31600, pubkey: "a" }))).toBe("31600:a:");
  });

  it("returns null for regular events", () => {
    expect(replaceableKey(ev({ kind: 1 }))).toBeNull();
    expect(replaceableKey(ev({ kind: 21602 }))).toBeNull();
  });
});

describe("EventDeduper", () => {
  it("dedupes regular events by id", () => {
    const d = new EventDeduper();
    const a = ev({ id: "1", kind: 1 });
    expect(d.accept(a)).toBe(true);
    expect(d.accept(ev({ id: "1", kind: 1 }))).toBe(false);
    expect(d.accept(ev({ id: "2", kind: 1 }))).toBe(true);
    expect(d.snapshot()).toHaveLength(2);
  });

  it("keeps the latest version of a replaceable event, in either arrival order", () => {
    for (const order of [
      [100, 200],
      [200, 100],
    ]) {
      const d = new EventDeduper();
      const old = ev({ id: "old", kind: 31600, pubkey: "a", tags: [["d", "x"]], created_at: 100 });
      const fresh = ev({ id: "new", kind: 31600, pubkey: "a", tags: [["d", "x"]], created_at: 200 });
      const first = order[0] === 100 ? old : fresh;
      const second = order[0] === 100 ? fresh : old;
      expect(d.accept(first)).toBe(true);
      expect(d.accept(second)).toBe(order[0] === 100); // newer accepted, older rejected
      expect(d.snapshot()).toEqual([fresh]);
    }
  });

  it("keeps the first arrival on an equal created_at", () => {
    const d = new EventDeduper();
    const a = ev({ id: "a", kind: 31600, pubkey: "a", tags: [["d", "x"]], created_at: 100 });
    const b = ev({ id: "b", kind: 31600, pubkey: "a", tags: [["d", "x"]], created_at: 100 });
    expect(d.accept(a)).toBe(true);
    expect(d.accept(b)).toBe(false);
    expect(d.snapshot()).toEqual([a]);
  });

  it("keeps distinct d entries separate", () => {
    const d = new EventDeduper();
    expect(d.accept(ev({ id: "1", kind: 31603, pubkey: "a", tags: [["d", "x"]] }))).toBe(true);
    expect(d.accept(ev({ id: "2", kind: 31603, pubkey: "a", tags: [["d", "y"]] }))).toBe(true);
    expect(d.snapshot()).toHaveLength(2);
  });
});
