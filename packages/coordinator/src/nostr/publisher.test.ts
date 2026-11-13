import { describe, it, expect } from "vitest";
import { generateSecretKey } from "nostr-tools/pure";
import { generateEck, utf8ByteLength, NIP44_MAX_PLAINTEXT_BYTES, type RosterContent } from "@nostrautica/protocol";
import {
  buildRoster,
  buildDirectoryEntry,
  buildMatchMatrix,
  fitMatchMatrix,
  type CreatedAtFor,
  type PublishKeys,
} from "./publisher.js";

const coordSk = generateSecretKey();
const eck = generateEck();
const keys: PublishKeys = { coordSk, eck, eckId: 1 };
const coordinate = "31923:" + "a".repeat(64) + ":ev";
const roster: RosterContent = { v: 2, eck_current: 1, attendees: [] };

/**
 * Replica of the coordinator's private monotonic clock (NIP §3.2):
 * created_at = max(now, last_for_address + 1) per (kind, d) address.
 */
function monotonicClock(nowSec: () => number): CreatedAtFor {
  const last = new Map<string, number>();
  return (kind, d) => {
    const key = `${kind}:${d}`;
    const ts = Math.max(nowSec(), (last.get(key) ?? 0) + 1);
    last.set(key, ts);
    return ts;
  };
}

describe("monotonic publishing (NIP §3.2)", () => {
  it("builders honor a supplied created_at function", () => {
    const ev = buildRoster(keys, coordinate, roster, () => 4242);
    expect(ev.created_at).toBe(4242);
  });

  it("successive publishes to the SAME address in one wall second strictly increase", () => {
    const clock = monotonicClock(() => 1000); // frozen wall clock
    const a = buildRoster(keys, coordinate, roster, clock);
    const b = buildRoster(keys, coordinate, roster, clock);
    const c = buildRoster(keys, coordinate, roster, clock);
    expect(a.created_at).toBe(1000);
    expect(b.created_at).toBe(1001);
    expect(c.created_at).toBe(1002);
    // No same-second collision that §3.1 would then have to tie-break.
    expect(new Set([a.created_at, b.created_at, c.created_at]).size).toBe(3);
  });

  it("distinct addresses (different d) keep independent watermarks", () => {
    const clock = monotonicClock(() => 500);
    const dir1 = buildDirectoryEntry(
      keys,
      coordinate,
      { v: 2, pubkey: "b".repeat(64), profile: { about: "", skills: [], looking_for: "", links: [] }, media: [], updated_at: 1 },
      clock,
    );
    const dir2 = buildDirectoryEntry(
      keys,
      coordinate,
      { v: 2, pubkey: "c".repeat(64), profile: { about: "", skills: [], looking_for: "", links: [] }, media: [], updated_at: 1 },
      clock,
    );
    // Two different attendees → two different blinded d's → both get `now`, no bump.
    expect(dir1.created_at).toBe(500);
    expect(dir2.created_at).toBe(500);
  });

  it("catches up to the wall clock once it advances past the watermark", () => {
    let t = 1000;
    const clock = monotonicClock(() => t);
    const a = buildRoster(keys, coordinate, roster, clock); // 1000
    const b = buildRoster(keys, coordinate, roster, clock); // 1001 (bumped)
    t = 5000; // wall clock jumps ahead
    const c = buildRoster(keys, coordinate, roster, clock); // 5000 (wall wins)
    expect(a.created_at).toBe(1000);
    expect(b.created_at).toBe(1001);
    expect(c.created_at).toBe(5000);
  });
});

describe("fitMatchMatrix (audit KIMIK31 R-1)", () => {
  const pk = (i: number) => i.toString(16).padStart(64, "0");
  const matrix = (n: number) => ({
    v: 2 as const,
    computed_at: 1,
    pairs: Array.from({ length: n }, (_, i) => ({ a: pk(2 * i), b: pk(2 * i + 1), score: i })),
  });

  it("leaves a matrix that fits untouched", () => {
    const m = matrix(10);
    expect(fitMatchMatrix(m)).toEqual({ content: m, dropped: 0 });
  });

  it("keeps the most pairs that fit, best first, and the result encrypts", () => {
    const { content, dropped } = fitMatchMatrix(matrix(1000));
    const bytes = utf8ByteLength(JSON.stringify(content));
    expect(bytes).toBeLessThanOrEqual(NIP44_MAX_PLAINTEXT_BYTES);
    expect(dropped).toBe(1000 - content.pairs.length);
    expect(content.pairs[0]!.score).toBe(999);
    expect(content.pairs.at(-1)!.score).toBe(1000 - content.pairs.length);
    // One more pair would not have fitted.
    const next = { a: pk(0), b: pk(1), score: 0 };
    expect(bytes + 1 + JSON.stringify(next).length).toBeGreaterThan(NIP44_MAX_PLAINTEXT_BYTES);
    expect(() => buildMatchMatrix(keys, coordinate, content)).not.toThrow();
  });
});
