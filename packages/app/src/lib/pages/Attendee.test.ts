/**
 * The attendee page's own name precedence.
 *
 * The page used to read `kind0?.name` straight off the JSON it parsed out of the
 * kind-0 event, while every OTHER surface in the app (the People roster, talk
 * cards, DM headers, quoted notes) resolves names through `profileDisplayName`,
 * which prefers `display_name`. So the same person could be "Ada Lovelace" in
 * the roster and "ada1815" on the profile you opened by tapping that row — and
 * on this page specifically the wrong name arrives SECOND: the cache paint uses
 * the already-resolved cached meta, then the relay fetch overwrote `kind0` with
 * the raw content and the heading changed under the reader.
 */
import { describe, it, expect } from "vitest";
import { attendeeDisplayName } from "./Attendee.svelte";

const FALLBACK = "Attendee";

describe("attendeeDisplayName", () => {
  it("prefers display_name over an older name, like the rest of the app", () => {
    expect(
      attendeeDisplayName({ name: "ada1815", display_name: "Ada Lovelace" }, null, FALLBACK),
    ).toBe("Ada Lovelace");
  });

  it("reads the legacy displayName spelling too", () => {
    expect(attendeeDisplayName({ name: "ada1815", displayName: "Ada Lovelace" }, null, FALLBACK)).toBe(
      "Ada Lovelace",
    );
  });

  /**
   * The worse half of the bug: with only `display_name` set, `kind0?.name` is
   * undefined, so the page fell through to the join-time entry name — or, with
   * no entry, to a 40-character slice of their bio as a HEADING — while the
   * profile in hand had a perfectly good name in it.
   */
  it("uses display_name rather than falling through to the entry or the bio", () => {
    expect(
      attendeeDisplayName(
        { display_name: "Ada Lovelace" },
        { name: "ada (join-time)", profile: { about: "Countess of Lovelace, wrote the first" } },
        FALLBACK,
      ),
    ).toBe("Ada Lovelace");
  });

  it("treats an empty or whitespace kind-0 name as absent, not as a blank heading", () => {
    // `"   " || …` is truthy, so the old path rendered a visually empty heading
    // (and blank Avatar initials) instead of using the name it did have.
    expect(attendeeDisplayName({ name: "   " }, { name: "Ada", profile: {} }, FALLBACK)).toBe("Ada");
    expect(attendeeDisplayName({ display_name: "" }, { name: "Ada", profile: {} }, FALLBACK)).toBe("Ada");
  });

  it("ignores a non-string name instead of rendering it", () => {
    expect(attendeeDisplayName({ name: 42 }, { name: "Ada", profile: {} }, FALLBACK)).toBe("Ada");
  });

  it("still falls back through entry name, bio slice, then the generic label", () => {
    expect(attendeeDisplayName(null, { name: "Ada", profile: {} }, FALLBACK)).toBe("Ada");
    expect(
      attendeeDisplayName(null, { profile: { about: "x".repeat(60) } }, FALLBACK),
    ).toBe("x".repeat(40));
    expect(attendeeDisplayName(null, null, FALLBACK)).toBe(FALLBACK);
    expect(attendeeDisplayName({}, null, FALLBACK)).toBe(FALLBACK);
  });

  it("trims a padded name, so the heading is not indented by the profile", () => {
    expect(attendeeDisplayName({ display_name: "  Ada Lovelace  " }, null, FALLBACK)).toBe(
      "Ada Lovelace",
    );
  });
});
