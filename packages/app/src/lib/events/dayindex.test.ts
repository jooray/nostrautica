/**
 * NIP-52 `D` day-index tags on kind-31923 calendar events (audit P8): one
 * uppercase `D` tag per UTC day the event spans, so strict/date-indexed calendar
 * clients can discover the event, with a bounded tag count.
 */
import { describe, it, expect } from "vitest";
import { dayIndexTags, MAX_DAY_TAGS } from "./create.js";

// 2026-07-24T12:00:00Z and helpers (unix seconds).
const DAY = 86400;
const noonJul24 = Date.UTC(2026, 6, 24, 12, 0, 0) / 1000;

describe("dayIndexTags (audit P8)", () => {
  it("emits a single UTC day tag when there is no end", () => {
    expect(dayIndexTags(noonJul24)).toEqual([["D", "2026-07-24"]]);
  });

  it("emits one tag per covered UTC day, inclusive of the end day", () => {
    const end = noonJul24 + 2 * DAY; // spans Jul 24, 25, 26
    expect(dayIndexTags(noonJul24, end)).toEqual([
      ["D", "2026-07-24"],
      ["D", "2026-07-25"],
      ["D", "2026-07-26"],
    ]);
  });

  it("counts UTC day BOUNDARIES, not 24h windows (an evening event crossing midnight → two days)", () => {
    const start = Date.UTC(2026, 6, 24, 23, 0, 0) / 1000; // 23:00
    const end = Date.UTC(2026, 6, 25, 1, 0, 0) / 1000; // 01:00 next day
    expect(dayIndexTags(start, end)).toEqual([
      ["D", "2026-07-24"],
      ["D", "2026-07-25"],
    ]);
  });

  it("treats an end before start as a single start-day tag", () => {
    expect(dayIndexTags(noonJul24, noonJul24 - DAY)).toEqual([["D", "2026-07-24"]]);
  });

  it("caps the tag count at MAX_DAY_TAGS on an absurd range", () => {
    const tags = dayIndexTags(noonJul24, noonJul24 + 1000 * DAY);
    expect(tags).toHaveLength(MAX_DAY_TAGS);
    expect(tags[0]).toEqual(["D", "2026-07-24"]);
  });
});
