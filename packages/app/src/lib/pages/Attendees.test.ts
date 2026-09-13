import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { rosterEmptyReason, rosterStaleCue, formatAsOf } from "./Attendees.svelte";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p: string) => readFileSync(resolve(pkgRoot, p), "utf8");

/**
 * The three-way split that replaced one string doing three jobs.
 *
 * The old copy ("No attendees visible … if you haven't joined yet, that's why;
 * if you were just approved, refresh in a moment") rendered for ANY empty
 * roster that hadn't thrown. The reader it was most wrong for is also its most
 * likely reader: an approved attendee standing in the venue, whose Wi-Fi blocks
 * WSS. Nothing throws in that case — the stream just never hears back — so they
 * were told they probably hadn't joined the event they were standing in.
 */
describe("rosterEmptyReason", () => {
  const base = { loading: false, hasKey: true, online: true, relay: "connected" } as const;

  // EV-9. Holding an ECK is what `hasKey` reports, and it says nothing about
  // whether that ECK is the CURRENT one. A member the organizer revoked, or one
  // whose grant for a rotation has not landed, holds a stale key: entries arrive,
  // none of them open, and the page said "Nobody is on the list yet" — a claim
  // about the event, and the wrong one. The people are there.
  it("says the KEY is stale when entries arrived and none decrypted", () => {
    expect(rosterEmptyReason({ ...base, undecryptable: 3 })).toBe("staleKey");
  });

  it("outranks unreachable and empty, but never loading", () => {
    // Undecryptable entries are positive evidence people ARE here, which makes
    // both of those sentences false. Mid-pass we still know nothing.
    expect(rosterEmptyReason({ ...base, undecryptable: 1, relay: "failed" })).toBe("staleKey");
    expect(rosterEmptyReason({ ...base, undecryptable: 1, online: false })).toBe("staleKey");
    expect(rosterEmptyReason({ ...base, undecryptable: 1, loading: true })).toBe("loading");
  });

  it("does not fire for a genuinely empty roster, or for a non-member", () => {
    expect(rosterEmptyReason({ ...base, undecryptable: 0 })).toBe("none");
    expect(rosterEmptyReason({ ...base })).toBe("none");
    // No ECK at all is still "you haven't joined", not "your key is stale".
    expect(rosterEmptyReason({ ...base, hasKey: false, undecryptable: 2 })).toBe("notApproved");
  });

  it("says loading while the pass is still in flight", () => {
    expect(rosterEmptyReason({ ...base, loading: true })).toBe("loading");
    // Loading outranks everything: mid-pass we know nothing yet, so neither
    // "you're not approved" nor "the network is down" is a claim we can make.
    expect(rosterEmptyReason({ ...base, loading: true, hasKey: false, online: false })).toBe(
      "loading",
    );
  });

  it("says not-approved when this device has no event key", () => {
    // streamDirectory returns undefined with no ECK — the only honest membership
    // signal the page has, and the ONLY case where "you haven't joined" is true.
    expect(rosterEmptyReason({ ...base, hasKey: false })).toBe("notApproved");
  });

  it("blames the network, not the user, when the relays never answered", () => {
    // The venue-WiFi case that motivated the whole split.
    expect(rosterEmptyReason({ ...base, relay: "failed" })).toBe("unreachable");
    expect(rosterEmptyReason({ ...base, online: false })).toBe("unreachable");
  });

  it("treats idle/connecting as unreachable rather than as an empty event", () => {
    // Neither state is evidence a relay answered, and "nobody is here" is a
    // factual claim about the event. Don't make it without an answer.
    expect(rosterEmptyReason({ ...base, relay: "idle" })).toBe("unreachable");
    expect(rosterEmptyReason({ ...base, relay: "connecting" })).toBe("unreachable");
  });

  it("only calls the roster genuinely empty with a key AND a live relay", () => {
    expect(rosterEmptyReason(base)).toBe("none");
  });
});

/**
 * The People list paints from cache first and revalidates behind it, which is
 * the right trade in a venue: a slightly old list beats a spinner, and that is
 * deliberately not up for renegotiation here. What was missing is the other
 * half. Offline, or on venue Wi-Fi that blocks WSS, the revalidation never
 * lands, and a roster cached a week ago is pixel-identical to one read a second
 * ago. `rosterEmptyReason` above already refuses to call a roster empty without
 * a live relay; this refuses to let a FULL one imply it is current.
 */
describe("rosterStaleCue", () => {
  const base = { entries: 44, settled: true, confirmed: false, syncedAt: 1_700_000_000_000 };

  it("owns up to a cache paint this session could not confirm", () => {
    // The case the cue exists for: rows on screen, the pass finished, and no
    // relay ever answered. Nothing on screen said so before.
    expect(rosterStaleCue(base)).toEqual({ show: true, at: 1_700_000_000_000 });
  });

  it("says nothing once the network has confirmed the list", () => {
    expect(rosterStaleCue({ ...base, confirmed: true }).show).toBe(false);
  });

  it("does not flash on the first frame of a healthy load", () => {
    // A cache paint starts with `loading` already false, so "not confirmed yet"
    // is true for the few hundred ms before a good connection answers. A cue
    // that fires on every healthy load is one nobody reads on a bad one.
    expect(rosterStaleCue({ ...base, settled: false }).show).toBe(false);
  });

  it("stays out of the way of the empty states", () => {
    // An empty roster is already explained by rosterEmptyReason, in a card that
    // names the actual cause. Two overlapping explanations is worse than one.
    expect(rosterStaleCue({ ...base, entries: 0 }).show).toBe(false);
  });

  it("still shows when the age is unknown, rather than staying silent", () => {
    // No recorded read (cache written by an older build, or the key evicted).
    // "This is a saved list and I cannot tell how old" is still worth more than
    // a list that quietly implies it is current.
    expect(rosterStaleCue({ ...base, syncedAt: undefined })).toEqual({ show: true, at: undefined });
  });
});

describe("formatAsOf", () => {
  const at = new Date(2026, 8, 14, 14, 5).getTime();

  it("gives a bare clock for a read from today", () => {
    const now = new Date(2026, 8, 14, 18, 40).getTime();
    // 12- or 24-hour is the locale's business; "no date component" is the point.
    expect(formatAsOf(at, now, "en")).toMatch(/(?:14|0?2)[:.]05/);
    expect(formatAsOf(at, now, "en")).not.toMatch(/[A-Za-z]{3}|\d{1,2}[./]\d/);
  });

  it("carries the date once the read is not from today", () => {
    // The misreading this exists to prevent: "as of 14:05" on a roster read
    // last Tuesday reads as five minutes ago, which is the exact impression the
    // cue is there to remove. A week-old list has to look a week old.
    const now = new Date(2026, 8, 21, 14, 10).getTime();
    const out = formatAsOf(at, now, "en");
    expect(out).toMatch(/14/);
    expect(out).toMatch(/Sep/);
    // Yesterday counts as not-today, even eleven minutes ago by the clock.
    const justAfterMidnight = new Date(2026, 8, 15, 0, 11).getTime();
    expect(formatAsOf(new Date(2026, 8, 14, 23, 55).getTime(), justAfterMidnight, "en")).toMatch(
      /Sep/,
    );
  });

  it("formats in the reader's locale", () => {
    const now = new Date(2026, 8, 21, 14, 10).getTime();
    expect(formatAsOf(at, now, "sk")).not.toBe(formatAsOf(at, now, "en"));
  });
});

/**
 * Two decisions on this surface that a later, reasonable-looking edit would
 * silently reverse. Both were settled by measurement, both have their numbers
 * in the files below, and neither is visible from the diff that would undo it —
 * so they are asserted rather than left as comments to be skimmed past.
 */
describe("standing decisions on the People surface", () => {
  it("skips offscreen roster rows for layout, never removes them from the DOM", () => {
    const src = read("src/lib/pages/Attendees.svelte");
    // Read the RULE, not the file: the prose around it names every one of these
    // properties, so a whole-file match would pass on the comment alone.
    // Containment has to lift for the focused row or paint containment clips the
    // 2px-offset focus ring to the row box, losing three of its four edges (seen
    // by screenshot: only the right-hand edge survives).
    const rule = /\.roster-list\s*>\s*li:not\(:focus-within\)\s*\{([^}]*)\}/.exec(src);
    expect(rule, "roster rows lost their :not(:focus-within) guard").not.toBeNull();
    const decls = rule?.[1] ?? "";
    // Virtualization (audit §7.3.5) bought render speed by unmounting rows, and
    // browser Find and screen readers then missed every attendee off screen.
    // content-visibility buys the same speed with all the rows still in the
    // document; anything that unmounts them is the old bug coming back.
    expect(decls).toMatch(/content-visibility:\s*auto/);
    // `auto` in the placeholder size, never a bare length: a fixed row height is
    // the OTHER thing virtualization broke, clipping rows at large text sizes.
    // `contain-intrinsic-size: 60px` would reintroduce exactly that for every
    // row the reader has not scrolled to yet.
    expect(decls).toMatch(/contain-intrinsic-size:\s*auto\s+\d/);
  });

  it("never clamps a match reasoning, at any width", () => {
    const src = read("src/lib/components/MatchEntry.svelte");
    const rule = /\.why\s*\{([^}]*)\}/.exec(src);
    expect(rule, "MatchEntry lost its .why rule").not.toBeNull();
    const decls = rule?.[1] ?? "";
    expect(decls).not.toMatch(/line-clamp|max-height|-webkit-box/);
    // The question was re-opened for the 420px two-pane column and closed with
    // the measurement in that file's header: the median reasoning is THREE lines
    // there against four on a phone, so clamping would make a desktop show less
    // about each person than a phone does. The measure cap stays because prose
    // wants 65-75 characters a line; it is not a height clamp.
    expect(decls).toMatch(/max-width:\s*68ch/);
  });
});
