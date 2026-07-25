/**
 * NIP-52 `D` day-index tags on kind-31923 calendar events (audit P8 / R5): one
 * uppercase `D` tag per UTC day the event spans, valued as the DECIMAL
 * day-granularity Unix timestamp `String(Math.floor(unixSeconds / 86400))` —
 * NOT an ISO `YYYY-MM-DD` string — so strict/date-indexed calendar clients can
 * discover the event, with a bounded tag count and exclusive-end semantics.
 */
import { describe, it, expect } from "vitest";
import { dayIndexTags, MAX_DAY_TAGS } from "./create.js";

// 2026-07-24T12:00:00Z and helpers (unix seconds).
const DAY = 86400;
const noonJul24 = Date.UTC(2026, 6, 24, 12, 0, 0) / 1000;
// The decimal day index for a given UTC calendar day (midnight is an exact
// multiple of DAY, so this is the same index noon of that day floors to).
const idx = (y: number, m: number, d: number) => String(Date.UTC(y, m, d) / 1000 / DAY);
const jul = (d: number) => idx(2026, 6, d);

describe("dayIndexTags (audit P8 / R5)", () => {
  it("emits a single decimal UTC day index when there is no end", () => {
    expect(dayIndexTags(noonJul24)).toEqual([["D", jul(24)]]);
  });

  it("emits one tag per covered UTC day, inclusive of the day the end falls in", () => {
    const end = noonJul24 + 2 * DAY; // Jul 24 12:00 → Jul 26 12:00 (spans 24, 25, 26)
    expect(dayIndexTags(noonJul24, end)).toEqual([["D", jul(24)], ["D", jul(25)], ["D", jul(26)]]);
  });

  it("counts UTC day BOUNDARIES, not 24h windows (an evening event crossing midnight → two days)", () => {
    const start = Date.UTC(2026, 6, 24, 23, 0, 0) / 1000; // 23:00
    const end = Date.UTC(2026, 6, 25, 1, 0, 0) / 1000; // 01:00 next day
    expect(dayIndexTags(start, end)).toEqual([["D", jul(24)], ["D", jul(25)]]);
  });

  it("treats `end` as EXCLUSIVE — an end exactly at midnight excludes that day", () => {
    const start = Date.UTC(2026, 6, 24, 10, 0, 0) / 1000; // Jul 24 10:00
    const end = Date.UTC(2026, 6, 25, 0, 0, 0) / 1000; // exactly Jul 25 00:00 (boundary)
    // The event occurs entirely within Jul 24; Jul 25 gets no tag.
    expect(dayIndexTags(start, end)).toEqual([["D", jul(24)]]);
  });

  it("treats an end before start as a single start-day tag", () => {
    expect(dayIndexTags(noonJul24, noonJul24 - DAY)).toEqual([["D", jul(24)]]);
  });

  it("caps the tag count at MAX_DAY_TAGS on an absurd range", () => {
    const tags = dayIndexTags(noonJul24, noonJul24 + 1000 * DAY);
    expect(tags).toHaveLength(MAX_DAY_TAGS);
    expect(tags[0]).toEqual(["D", jul(24)]);
  });
});
