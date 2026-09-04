/**
 * Who is allowed to author the event theme (spec §7.4 kind 31609).
 *
 * This is the one relay-sourced string the app puts straight into a <style>
 * element in <head> (theme-injector.ts), so the read is an authority boundary in
 * a way that a "just cosmetics" field is not. Until this test existed the read
 * was `fetchEvents({authors:[E_id]}).sort(created_at desc)[0]` — and a relay
 * filter is a REQUEST, not a guarantee: nothing stopped any relay in the event's
 * set from answering with a validly-signed 31609 from a key it made up, which is
 * a stylesheet over the whole app shell. Concretely: a `position: fixed` overlay
 * that phishes for an nsec, `display: none` on the control someone needs to
 * leave a room, and `background-image: url(https://evil/…)` beacons, which the
 * CSP allows because img-src permits any https origin.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { KIND_EVENT_THEME, makeCoordinate } from "@nostrautica/protocol";

const { fetchEvents } = vi.hoisted(() => ({ fetchEvents: vi.fn() }));
vi.mock("$lib/nostr/ndk.js", () => ({
  fetchEvents,
  fetchEventsRelayOnly: vi.fn(),
  publishSigned: vi.fn(),
  isAcceptedRelayUrl: (value: string) => value.startsWith("wss://"),
}));
// Fixtures are unsigned; NDK verifies signatures in production. The real
// `onlyByAuthors` is kept — the author pin is the whole point here.
vi.mock("$lib/nostr/verify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("$lib/nostr/verify.js")>()),
  onlyVerified: <T,>(events: T[]) => events,
}));

import { fetchEventTheme } from "./theme.js";
import type { EventContext } from "./event-context.js";
import { __resetPersistForTests } from "$lib/cache/persist.js";

const EID = "e".repeat(64);
const IMPOSTOR = "f".repeat(64);
const COORD = makeCoordinate(EID, "conf-2026");
const ctx = { coordinate: COORD, config: { relays: ["wss://relay.example"] } } as EventContext;

function themeEvent(
  pubkey: string,
  css: string,
  createdAt: number,
  id = `t-${createdAt}`,
  /** `null` = omit the `v` tag entirely (the "absent tag" case). */
  vTag: string[] | null = ["v", "2"],
) {
  return {
    id,
    kind: KIND_EVENT_THEME,
    pubkey,
    created_at: createdAt,
    tags: [["d", "conf-2026"], ["a", COORD], ...(vTag ? [vTag] : [])],
    content: css,
  };
}

const HOSTILE = `.overlay{position:fixed;inset:0;background:url("https://evil.example/b")}`;

describe("fetchEventTheme author pinning", () => {
  beforeEach(() => {
    __resetPersistForTests();
    fetchEvents.mockReset();
  });

  it("returns the CSS E_id published", async () => {
    fetchEvents.mockResolvedValue([themeEvent(EID, "body{color:teal}", 1000)]);
    expect(await fetchEventTheme(ctx)).toBe("body{color:teal}");
  });

  it("ignores a 31609 by anyone but E_id, even when it is the newest", async () => {
    // The attack: one relay in the event's set answers the theme query with its
    // own signed 31609. `created_at desc` alone hands it the app shell.
    fetchEvents.mockResolvedValue([
      themeEvent(IMPOSTOR, HOSTILE, 9_000),
      themeEvent(EID, "body{color:teal}", 1_000),
    ]);
    expect(await fetchEventTheme(ctx)).toBe("body{color:teal}");
  });

  it("returns undefined when only an impostor answered — no theme beats a hostile one", async () => {
    fetchEvents.mockResolvedValue([themeEvent(IMPOSTOR, HOSTILE, 9_000)]);
    expect(await fetchEventTheme(ctx)).toBeUndefined();
  });

  it("ignores a 31609 whose `v` tag is absent or not \"2\" (NIP §2)", async () => {
    // 31609 is the one public custom kind with no content schema — its content is
    // RAW CSS, so unlike every other kind there is no `"v": 2` inside the payload
    // to reject on and the tag is the ENTIRE version signal. It was also the one
    // kind checking nothing at all: `hasCurrentVersionTag` existed in the protocol
    // package with zero call sites anywhere. Until this, a v1 theme (or a v3 one
    // written against semantics this build predates) was injected verbatim into
    // <head> and styled the whole app shell.
    for (const vTag of [null, ["v", "1"], ["v", "3"], ["v", "two"], ["v"]]) {
      __resetPersistForTests();
      fetchEvents.mockResolvedValue([themeEvent(EID, HOSTILE, 9_000, "t-wrong-v", vTag)]);
      expect(await fetchEventTheme(ctx)).toBeUndefined();
    }
    // A correctly-versioned theme from the same author still wins, so the filter
    // is on the version and not on something incidental to these fixtures.
    __resetPersistForTests();
    fetchEvents.mockResolvedValue([
      themeEvent(EID, HOSTILE, 9_000, "t-v1", ["v", "1"]),
      themeEvent(EID, "body{color:teal}", 1_000),
    ]);
    expect(await fetchEventTheme(ctx)).toBe("body{color:teal}");
  });

  it("breaks a created_at tie on the LOWEST id (§3.1), not on arrival order", async () => {
    // Two revisions signed in the same second is ordinary (a save, a quick fix).
    // An ad-hoc sort leaves the winner to whichever relay answered first, so two
    // readers could see two different stylesheets for the same event.
    const low = themeEvent(EID, "body{color:low}", 500, "0".repeat(64));
    const high = themeEvent(EID, "body{color:high}", 500, "f".repeat(64));
    fetchEvents.mockResolvedValue([high, low]);
    expect(await fetchEventTheme(ctx)).toBe("body{color:low}");
    __resetPersistForTests();
    fetchEvents.mockResolvedValue([low, high]);
    expect(await fetchEventTheme(ctx)).toBe("body{color:low}");
  });
});
