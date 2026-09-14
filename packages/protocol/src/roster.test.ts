/**
 * Roster pagination (PROTOCOL-NIP.md §6.2, kind 31604).
 *
 * The 65,535-byte NIP-44 plaintext ceiling used to cap a roster at a few hundred
 * members. These are the invariants that make splitting it across pages safe —
 * above all the two that, if they broke, would be worse than the ceiling was:
 * a roster that FITS must be byte-identical to what shipped before pagination
 * existed, and a roster that does not must produce pages that actually encrypt.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  MAX_ROSTER,
  MAX_ROSTER_PAGES,
  NIP44_MAX_PLAINTEXT_BYTES,
  PROTOCOL_VERSION,
  ROSTER_PAGE_TARGET_BYTES,
  ROSTER_PAGED_VERSION,
  eckDecrypt,
  eckEncrypt,
  mergeRosterPages,
  parsePayloadSafe,
  rosterContentSchema,
  rosterContinuationDs,
  rosterPageCount,
  rosterPageCountOf,
  rosterPageD,
  rosterPageDs,
  splitRoster,
  utf8ByteLength,
  type RosterContent,
} from "./index.js";

const ECK = new Uint8Array(32).fill(7);

function pubkeyOf(i: number): string {
  return i.toString(16).padStart(64, "0");
}

/** An attendee entry of the real shape, optionally carrying a chat device. */
function attendee(i: number, withChatKey = false) {
  return {
    pubkey: pubkeyOf(i),
    d: (i + 0x1000).toString(16).padStart(32, "a"),
    role: (i === 0 ? "organizer" : "attendee") as "organizer" | "attendee",
    ...(withChatKey
      ? {
          chat_keys: [
            { pubkey: pubkeyOf(i + 1_000_000), label: "Chrome on macOS", added_at: 1_700_000_000 },
          ],
        }
      : {}),
  };
}

function roster(n: number, withChatKeys = false, extra: Partial<RosterContent> = {}): RosterContent {
  return {
    v: PROTOCOL_VERSION,
    eck_current: 3,
    ...extra,
    attendees: Array.from({ length: n }, (_, i) => attendee(i, withChatKeys)),
  } as RosterContent;
}

/** Largest n whose single-payload roster still fits, by bisection on real bytes. */
function largestSinglePage(withChatKeys: boolean): number {
  let lo = 1;
  let hi = 2000;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (utf8ByteLength(JSON.stringify(roster(mid, withChatKeys))) <= NIP44_MAX_PLAINTEXT_BYTES) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

describe("roster page addressing (§6.2)", () => {
  it("page 0 is the event's own d; page N is <d>:N", () => {
    expect(rosterPageD("summit-2f1a", 0)).toBe("summit-2f1a");
    expect(rosterPageD("summit-2f1a", 1)).toBe("summit-2f1a:1");
    expect(rosterPageD("summit-2f1a", 7)).toBe("summit-2f1a:7");
    expect(rosterPageDs("summit-2f1a", 3)).toEqual([
      "summit-2f1a",
      "summit-2f1a:1",
      "summit-2f1a:2",
    ]);
    // What a reader asks for in its ONE follow-up REQ after page 0.
    expect(rosterContinuationDs("summit-2f1a", 3)).toEqual(["summit-2f1a:1", "summit-2f1a:2"]);
    expect(rosterContinuationDs("summit-2f1a", 1)).toEqual([]);
  });

  it("rejects a negative or fractional page index rather than inventing an address", () => {
    expect(() => rosterPageD("d", -1)).toThrow(/non-negative integer/);
    expect(() => rosterPageD("d", 1.5)).toThrow(/non-negative integer/);
  });
});

describe("a roster that fits is untouched (the no-flag-day guarantee)", () => {
  it("returns the SAME object, byte-identical, v:2, with no pages key", () => {
    const r = roster(50, true, { nostr_group_id: "d".repeat(64) });
    const before = JSON.stringify(r);
    const pages = splitRoster(r);
    expect(pages).toHaveLength(1);
    // Same reference: there is no re-serialization step that could reorder a key
    // or drop an optional one, so the bytes cannot drift from pre-pagination.
    expect(pages[0]).toBe(r);
    expect(JSON.stringify(pages[0])).toBe(before);
    expect(pages[0]!.v).toBe(PROTOCOL_VERSION);
    expect("pages" in pages[0]!).toBe(false);
    expect(rosterPageCount(r)).toBe(1);
  });

  it("stays v:2 for every size up to the ceiling, including the last one that fits", () => {
    const n = largestSinglePage(false);
    const r = roster(n);
    expect(utf8ByteLength(JSON.stringify(r))).toBeLessThanOrEqual(NIP44_MAX_PLAINTEXT_BYTES);
    const pages = splitRoster(r);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toBe(r);
    // And it really is the boundary: one more entry does not fit in one payload.
    expect(utf8ByteLength(JSON.stringify(roster(n + 1)))).toBeGreaterThan(
      NIP44_MAX_PLAINTEXT_BYTES,
    );
    expect(splitRoster(roster(n + 1)).length).toBeGreaterThan(1);
  });

  it("a page-0-shaped payload with no `pages` key parses as an ordinary v:2 roster", () => {
    const parsed = rosterContentSchema.parse(roster(3));
    expect(parsed.pages).toBeUndefined();
    expect(rosterPageCountOf(parsed)).toBe(1);
  });
});

describe("a roster over the ceiling splits into pages that actually encrypt", () => {
  it("every page is under the NIP-44 ceiling MEASURED AFTER encryption framing", () => {
    // 600 members with an attested chat device each: the case the ceiling used to
    // refuse outright (the coordinator's roster_full).
    const r = roster(600, true, { nostr_group_id: "b".repeat(64) });
    expect(utf8ByteLength(JSON.stringify(r))).toBeGreaterThan(NIP44_MAX_PLAINTEXT_BYTES);

    const pages = splitRoster(r);
    expect(pages.length).toBeGreaterThan(1);

    for (const [i, page] of pages.entries()) {
      const plaintext = JSON.stringify(page);
      expect(utf8ByteLength(plaintext), `page ${i} plaintext bytes`).toBeLessThanOrEqual(
        NIP44_MAX_PLAINTEXT_BYTES,
      );
      expect(utf8ByteLength(plaintext), `page ${i} within packing budget`).toBeLessThanOrEqual(
        ROSTER_PAGE_TARGET_BYTES,
      );
      // Not an estimate off an entry-size table: this is the real NIP-44 v2
      // encrypt that throws over the ceiling, followed by a round trip.
      const ciphertext = eckEncrypt(ECK, plaintext);
      expect(JSON.parse(eckDecrypt(ECK, ciphertext))).toEqual(page);
      // And the page validates as a 31604 payload in its own right.
      expect(() => rosterContentSchema.parse(page)).not.toThrow();
    }
  });

  it("page 0 declares the paged version and the count; continuation pages do not repeat the count", () => {
    const r = roster(600, true, { nostr_group_id: "b".repeat(64) });
    const pages = splitRoster(r);
    expect(pages[0]!.v).toBe(ROSTER_PAGED_VERSION);
    expect(pages[0]!.pages).toBe(pages.length);
    expect(rosterPageCountOf(pages[0]!)).toBe(pages.length);
    // eck_current and nostr_group_id stay on page 0 and stay authoritative.
    expect(pages[0]!.eck_current).toBe(r.eck_current);
    expect(pages[0]!.nostr_group_id).toBe(r.nostr_group_id);
    for (const page of pages.slice(1)) {
      expect(page.v).toBe(ROSTER_PAGED_VERSION);
      expect(page.pages).toBeUndefined();
      expect(page.nostr_group_id).toBeUndefined();
    }
  });

  it("refuses to paginate past what the wire can carry, instead of publishing an invalid page 0", () => {
    expect(() => splitRoster(roster(MAX_ROSTER + 1))).toThrow(/over the 2000-member cap/);
    // A pathological entry size (every member with the maximum chat devices and
    // labels) is caught by the page cap rather than silently exceeding it.
    const fat: RosterContent = {
      v: PROTOCOL_VERSION,
      eck_current: 1,
      attendees: Array.from({ length: MAX_ROSTER }, (_, i) => ({
        pubkey: pubkeyOf(i),
        d: "d".repeat(200),
        role: "attendee" as const,
        chat_keys: Array.from({ length: 10 }, (_, k) => ({
          pubkey: pubkeyOf(i * 100 + k),
          label: "x".repeat(60),
          added_at: 1_700_000_000,
        })),
      })),
    };
    expect(() => splitRoster(fat)).toThrow(
      new RegExp(`over the ${MAX_ROSTER_PAGES}-page cap`),
    );
  });
});

describe("a reader reassembles the pages", () => {
  it("sees every member exactly once, in order, with page 0's eck_current and group id", () => {
    const r = roster(600, true, { nostr_group_id: "b".repeat(64) });
    const pages = splitRoster(r);
    const merged = mergeRosterPages(pages);

    expect(merged.attendees).toHaveLength(r.attendees.length);
    expect(merged.attendees.map((a) => a.pubkey)).toEqual(r.attendees.map((a) => a.pubkey));
    expect(new Set(merged.attendees.map((a) => a.pubkey)).size).toBe(r.attendees.length);
    expect(merged.eck_current).toBe(r.eck_current);
    expect(merged.nostr_group_id).toBe(r.nostr_group_id);
    // Pagination is a wire detail: what consumers hold looks like any roster.
    expect(merged.v).toBe(PROTOCOL_VERSION);
    expect(merged.pages).toBeUndefined();
    // …and re-splitting the merged value reproduces exactly the same pages, so a
    // read-modify-write republish cannot churn pages it did not change.
    expect(splitRoster(merged).map((p) => JSON.stringify(p))).toEqual(
      pages.map((p) => JSON.stringify(p)),
    );
  });

  it("round-trips through real ciphertext, not just objects", () => {
    const r = roster(600, true);
    const wire = splitRoster(r).map((p) => eckEncrypt(ECK, JSON.stringify(p)));
    const read = wire.map((c) => rosterContentSchema.parse(JSON.parse(eckDecrypt(ECK, c))));
    expect(mergeRosterPages(read).attendees.map((a) => a.pubkey)).toEqual(
      r.attendees.map((a) => a.pubkey),
    );
  });

  it("keeps a member once even if a stale higher page repeats them", () => {
    const merged = mergeRosterPages([
      { v: ROSTER_PAGED_VERSION, eck_current: 2, pages: 2, attendees: [attendee(1)] },
      { v: ROSTER_PAGED_VERSION, eck_current: 2, attendees: [attendee(1), attendee(2)] },
    ]);
    expect(merged.attendees.map((a) => a.pubkey)).toEqual([pubkeyOf(1), pubkeyOf(2)]);
  });
});

describe("an old client meets a paginated roster", () => {
  /**
   * The 31604 schema exactly as it shipped before pagination: `v` is the strict
   * `z.literal(2)` and there is no `pages` key. This is what every installed
   * build runs, and the point of the whole version bump is what it does here.
   */
  const preePaginationRosterSchema = z.object({
    v: z.literal(2),
    eck_current: z.number().int().positive(),
    nostr_group_id: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    attendees: z.array(
      z.object({
        pubkey: z.string().regex(/^[0-9a-f]{64}$/),
        d: z.string().max(200),
        role: z.enum(["attendee", "organizer"]),
      }),
    ),
  });

  it("fails loudly with 'Update required' rather than rendering a truncated list", () => {
    const r = roster(600);
    const page0 = splitRoster(r)[0]!;
    // The truncation this replaces: page 0 holds only part of the event.
    expect(page0.attendees.length).toBeLessThan(r.attendees.length);

    const parsed = parsePayloadSafe(preePaginationRosterSchema, page0);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.reason).toBe("newer-version");
    expect(parsed.ok === false && parsed.reason === "newer-version" && parsed.version).toBe(
      ROSTER_PAGED_VERSION,
    );
  });

  it("keeps working on every roster that fits — the same old schema parses it", () => {
    const r = roster(50);
    const page0 = splitRoster(r)[0]!;
    const parsed = parsePayloadSafe(preePaginationRosterSchema, page0);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.value.attendees).toHaveLength(50);
  });

  it("never sees `pages` beside v:2 — the one shape that WOULD truncate silently", () => {
    // A v:2 payload carrying `pages` is exactly what an old client strips and
    // then renders as complete. The schema refuses to produce or accept it.
    expect(() =>
      rosterContentSchema.parse({ v: 2, eck_current: 1, pages: 3, attendees: [] }),
    ).toThrow(/must declare v:3/);
    expect(() =>
      rosterContentSchema.parse({ v: 3, eck_current: 1, pages: 3, attendees: [] }),
    ).not.toThrow();
  });

  it("the roster's v is the ONLY field allowed past PROTOCOL_VERSION, and only when paginated", () => {
    // If this ever fails because PROTOCOL_VERSION moved, the fix is to re-derive
    // the exception, not to delete the test: see ROSTER_PAGED_VERSION's comment.
    // Bumping the repo-wide version to carry this would have been a wire-v3 flag
    // day across every kind to solve a problem in exactly one of them.
    expect(ROSTER_PAGED_VERSION).toBe(PROTOCOL_VERSION + 1);
    // Unpaginated rosters — the overwhelming majority — never declare it.
    expect(splitRoster(roster(10))[0]!.v).toBe(PROTOCOL_VERSION);
    // And a v:3 roster is accepted ONLY by the roster schema. Every other payload
    // keeps the strict literal-2 parse, so this is not a general loosening.
    expect(() => rosterContentSchema.parse({ v: 3, eck_current: 1, attendees: [] })).not.toThrow();
    expect(() => rosterContentSchema.parse({ v: 4, eck_current: 1, attendees: [] })).toThrow();
  });
});

describe("an approval republishes one page, not N", () => {
  it("appending a member leaves every earlier page byte-identical", () => {
    const before = splitRoster(roster(600, true)).map((p) => JSON.stringify(p));
    const after = splitRoster(roster(601, true)).map((p) => JSON.stringify(p));
    expect(before.length).toBeGreaterThan(2); // a real multi-page roster, not a two-page edge
    expect(after).toHaveLength(before.length);
    // Everything but the last page is untouched…
    expect(after.slice(0, -1)).toEqual(before.slice(0, -1));
    // …and the last page is the one that grew.
    expect(after[after.length - 1]).not.toBe(before[before.length - 1]);
  });

  it("an approval that opens a NEW page still leaves the filled pages alone", () => {
    // Grow until the page count increases, then compare across that step.
    const base = 600;
    let n = base;
    let pagesAt = splitRoster(roster(n, true)).length;
    while (splitRoster(roster(n + 1, true)).length === pagesAt && n < base + 400) n++;
    const before = splitRoster(roster(n, true));
    const after = splitRoster(roster(n + 1, true));
    expect(after.length).toBe(before.length + 1);
    // Every filled page between page 0 and the last is byte-identical: opening a
    // new page costs two publishes (page 0's count, plus the new page), not N.
    expect(after.slice(1, before.length).map((p) => JSON.stringify(p))).toEqual(
      before.slice(1, before.length).map((p) => JSON.stringify(p)),
    );
    // Page 0 is republished only because its `pages` count moved — its membership
    // did not, which is what keeps the cost at two rather than N.
    expect(after[0]!.attendees).toEqual(before[0]!.attendees);
    expect(after[0]!.pages).toBe(before[0]!.pages! + 1);
    pagesAt = after.length;
    expect(pagesAt).toBeGreaterThan(1);
  });

  it("page 0's count changing is itself a change to page 0 — a new page is never silent", () => {
    const n = 600;
    let m = n;
    // Bounded: an unbounded search here HANGS instead of failing if splitRoster
    // ever stops paginating, which turns a red suite into a stuck one.
    while (splitRoster(roster(m + 1, true)).length === splitRoster(roster(n, true)).length) {
      m++;
      if (m > n + 400) throw new Error("never found a page boundary — splitRoster stopped paginating");
    }
    const before = splitRoster(roster(m, true));
    const after = splitRoster(roster(m + 1, true));
    expect(after[0]!.pages).toBe(before[0]!.pages! + 1);
    expect(JSON.stringify(after[0])).not.toBe(JSON.stringify(before[0]));
  });
});

describe("the boundary", () => {
  it("exactly at the ceiling: one page, v:2; one entry over: paginated, v:3", () => {
    for (const withChatKeys of [false, true]) {
      const n = largestSinglePage(withChatKeys);
      const atCeiling = roster(n, withChatKeys);
      const overCeiling = roster(n + 1, withChatKeys);

      expect(utf8ByteLength(JSON.stringify(atCeiling))).toBeLessThanOrEqual(
        NIP44_MAX_PLAINTEXT_BYTES,
      );
      expect(utf8ByteLength(JSON.stringify(overCeiling))).toBeGreaterThan(
        NIP44_MAX_PLAINTEXT_BYTES,
      );

      const fits = splitRoster(atCeiling);
      expect(fits, `n=${n} chatKeys=${withChatKeys}`).toHaveLength(1);
      expect(fits[0]!.v).toBe(PROTOCOL_VERSION);
      // The one that fits must still encrypt — the ceiling check IS the encrypt
      // precondition, so this is the assertion that ties them together.
      expect(() => eckEncrypt(ECK, JSON.stringify(fits[0]))).not.toThrow();

      const split = splitRoster(overCeiling);
      expect(split.length).toBeGreaterThan(1);
      expect(split[0]!.v).toBe(ROSTER_PAGED_VERSION);
      expect(split.flatMap((p) => p.attendees)).toHaveLength(n + 1);
      for (const page of split) {
        expect(() => eckEncrypt(ECK, JSON.stringify(page))).not.toThrow();
      }
    }
  });

  it("the single-payload roster ONE entry over the ceiling would have thrown before", () => {
    // This is the failure pagination exists to remove: the pre-pagination writer
    // handed the whole roster to eckEncrypt and it threw from inside the approve
    // path, with the ECK grant already published.
    const n = largestSinglePage(false);
    expect(() => eckEncrypt(ECK, JSON.stringify(roster(n + 1)))).toThrow();
    // Now the same roster publishes as pages that each encrypt.
    for (const page of splitRoster(roster(n + 1))) {
      expect(() => eckEncrypt(ECK, JSON.stringify(page))).not.toThrow();
    }
  });
});
