import { describe, it, expect } from "vitest";
import { rosterEmptyReason } from "./Attendees.svelte";

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
