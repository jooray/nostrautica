import { describe, it, expect } from "vitest";
import { shouldOpenFromBody } from "./open-from-body.js";

/** Minimal stand-in for `Element.closest` over a synthetic ancestor chain. */
function nodeIn(...ancestorTags: string[]): Element {
  return {
    closest: (sel: string) => {
      const wanted = sel.split(",").map((s) => s.trim());
      return ancestorTags.some((t) => wanted.includes(t)) ? ({} as Element) : null;
    },
  } as unknown as Element;
}

describe("opening a match entry from its body", () => {
  it("opens on a plain click in the prose", () => {
    // The whole point: the reasoning is most of the entry, and clicking it is
    // the obvious way to open the person it is about.
    expect(shouldOpenFromBody(nodeIn("p"), true)).toBe(true);
  });

  it("leaves a click on a control to that control", () => {
    // Follow, want-to-meet and message live inside the entry. Opening the
    // person as well would make every one of them do two things.
    for (const tag of ["button", "a", "summary", "details", "input", "textarea"]) {
      expect(shouldOpenFromBody(nodeIn(tag), true), tag).toBe(false);
    }
  });

  it("does not open when the click ended a text selection", () => {
    // Selecting the reasoning to paste it into a message is a drag that ends in
    // a mouseup on the entry. Treating that as a tap would yank the reader
    // somewhere else the moment they finished highlighting.
    expect(shouldOpenFromBody(nodeIn("p"), false)).toBe(false);
  });

  it("treats a missing target as openable rather than dead", () => {
    expect(shouldOpenFromBody(null, true)).toBe(true);
  });
});
