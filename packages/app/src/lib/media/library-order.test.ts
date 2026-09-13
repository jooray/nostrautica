import { describe, it, expect } from "vitest";
import { orderForGallery } from "./library-order.js";

const clip = (x: string) => ({ x });
type Clip = ReturnType<typeof clip>;

describe("reuse gallery ordering", () => {
  it("puts the newest stamped clip first", () => {
    const items = [clip("a"), clip("b"), clip("c")];
    const at = { a: 100, b: 300, c: 200 };
    expect(orderForGallery(items, at).map((c: Clip) => c.x)).toEqual(["b", "c", "a"]);
  });

  it("reverses stored order when nothing is stamped", () => {
    // Every library written before the stamp existed looks like this, which is
    // the case the user actually hit: four clips, no dates, no way to tell.
    const items = [clip("oldest"), clip("middle"), clip("newest")];
    expect(orderForGallery(items, {}).map((c: Clip) => c.x)).toEqual([
      "newest",
      "middle",
      "oldest",
    ]);
  });

  it("does not promote a stamped clip over an unstamped one just for having a number", () => {
    // A mixed library: the stamp says nothing about how a stamped clip compares
    // to one recorded before stamps existed, so position still decides.
    const items = [clip("old-unstamped"), clip("new-stamped")];
    const ordered = orderForGallery(items, { "new-stamped": 500 });
    expect(ordered.map((c: Clip) => c.x)).toEqual(["new-stamped", "old-unstamped"]);
  });

  it("is stable for clips sharing a timestamp", () => {
    // Two clips added in the same second keep their stored order relative to
    // each other rather than shuffling between renders.
    const items = [clip("a"), clip("b")];
    const at = { a: 100, b: 100 };
    expect(orderForGallery(items, at).map((c: Clip) => c.x)).toEqual(["a", "b"]);
  });
});
