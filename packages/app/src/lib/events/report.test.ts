/**
 * Post-event report assembly (spec §13). The report must reflect what actually
 * happened at the venue: met people (with notes), want-to-meet people who were
 * NOT met, favorite talks, and every private note.
 */
import { describe, it, expect } from "vitest";
import { assembleReport, followTargets, safeNpub } from "./report.js";
import type { PerEventSettings } from "@nostrautica/protocol";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const D = "d".repeat(64);

const nameOf = (p: string) => ({ [A]: "Alice", [B]: "Bob", [C]: "Carol", [D]: "Dave" })[p] ?? p.slice(0, 6);

function settings(over: Partial<PerEventSettings> = {}): PerEventSettings {
  return { v: 2, favorites: [], want_to_meet: [], met: [], notes: {}, ...over };
}

describe("assembleReport", () => {
  it("lists met people with their notes and npubs", () => {
    const r = assembleReport({
      settings: settings({ met: [A, B], notes: { [A]: "great chat about relays" } }),
      nameOf,
    });
    expect(r.met.map((p) => p.name)).toEqual(["Alice", "Bob"]);
    expect(r.met[0].note).toBe("great chat about relays");
    expect(r.met[1].note).toBeUndefined();
    expect(r.met[0].npub).toBe(safeNpub(A));
  });

  it("wantedNotMet is want-to-meet minus met", () => {
    const r = assembleReport({
      settings: settings({ want_to_meet: [A, B, C], met: [B] }),
      nameOf,
    });
    expect(r.wantedNotMet.map((p) => p.pubkey)).toEqual([A, C]);
  });

  it("notes lists every noted person, skipping blank notes", () => {
    const r = assembleReport({
      settings: settings({ notes: { [A]: "note", [B]: "   ", [C]: "another" } }),
      nameOf,
    });
    expect(r.notes.map((p) => p.pubkey).sort()).toEqual([A, C].sort());
  });

  it("carries resolved favorite talks through unchanged", () => {
    const talks = [{ d: "t1", title: "Nostr 101" }];
    const r = assembleReport({ settings: settings(), favoriteTalks: talks, nameOf });
    expect(r.favoriteTalks).toEqual(talks);
  });

  it("empty settings produce an all-empty report", () => {
    const r = assembleReport({ settings: settings(), nameOf });
    expect(r.met).toEqual([]);
    expect(r.wantedNotMet).toEqual([]);
    expect(r.notes).toEqual([]);
    expect(r.favoriteTalks).toEqual([]);
  });
});

describe("followTargets", () => {
  it("unions met + want-to-meet, met first, deduped", () => {
    expect(followTargets(settings({ met: [A, B], want_to_meet: [B, C] }))).toEqual([A, B, C]);
  });
  it("honors per-person opt-out", () => {
    expect(followTargets(settings({ met: [A, B], want_to_meet: [C] }), new Set([B]))).toEqual([A, C]);
  });
  it("empty when nothing marked", () => {
    expect(followTargets(settings())).toEqual([]);
  });
});
