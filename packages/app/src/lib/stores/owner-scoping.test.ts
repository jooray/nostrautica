/**
 * Stores that survived an account switch (audit EV-16).
 *
 * `logout()` cleared some of these. `adopt()` — the OTHER way the identity
 * changes, and the one that happens when you import a key or sign in as someone
 * else without logging out first — cleared none of them. On a shared device that
 * meant the previous person's state was still live for the next one.
 *
 * Each `setOwner` is idempotent for the same pubkey on purpose: a session RESTORE
 * re-adopts the same identity, and wiping there would throw away a pending join
 * the user is genuinely waiting on, or a mute list they just loaded.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ownStatusStore } from "./own-status.svelte.js";
import { mutes } from "./mutes.svelte.js";
import { setJoinSentOwner, markJoinSent, joinSentAt, clearAllJoinSent } from "./join-sent.svelte.js";
import { setInviteOwner, storeInvite, loadInvite } from "./invite-store.js";
import type { CoordinatorStatusContent } from "@nostrautica/protocol";

const A = "a".repeat(64);
const B = "b".repeat(64);
const COORD = "31923:abc:evt";

const poison = (): CoordinatorStatusContent =>
  ({ v: 2, a: COORD, pubkey: A, stage: "process_attendee", state: "poison", at: 1 }) as CoordinatorStatusContent;

describe("ownStatusStore is owner-scoped", () => {
  beforeEach(() => ownStatusStore.setOwner(null));

  it("does not show one account's private failure notices to the next", () => {
    // These are sealed to a single attendee precisely so nobody else sees them —
    // and since the readiness journey started deriving its "failed" step from
    // them, a leak stopped being a stray banner and became B's own stepper
    // reporting B had failed.
    ownStatusStore.setOwner(A);
    ownStatusStore.set(COORD, [poison()]);
    expect(ownStatusStore.poison(COORD)).toHaveLength(1);

    ownStatusStore.setOwner(B);
    expect(ownStatusStore.poison(COORD)).toHaveLength(0);
  });

  it("keeps what it scanned when the SAME identity is re-adopted (a restore)", () => {
    ownStatusStore.setOwner(A);
    ownStatusStore.set(COORD, [poison()]);
    ownStatusStore.setOwner(A);
    expect(ownStatusStore.poison(COORD)).toHaveLength(1);
  });
});

describe("mutes is owner-scoped", () => {
  it("drops the previous identity's set, and leaves a reload possible", () => {
    mutes.setOwner(A);
    mutes.muted = new Set([B]);
    expect(mutes.isMuted(B)).toBe(true);

    mutes.setOwner(B);
    expect(mutes.isMuted(B)).toBe(false);
    // `loadedFor` must be cleared, not set to the new pubkey: setting it would tell
    // `load()` this identity had already been fetched, and the new owner would
    // permanently mute nobody.
    expect((mutes as unknown as { loadedFor: string | null }).loadedFor).toBe(null);
  });

  it("is a no-op for the same identity", () => {
    mutes.setOwner(A);
    mutes.muted = new Set([B]);
    mutes.setOwner(A);
    expect(mutes.isMuted(B)).toBe(true);
  });
});

describe("join-sent markers are owner-scoped", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", (() => {
      const m = new Map<string, string>();
      return {
        getItem: (k: string) => m.get(k) ?? null,
        setItem: (k: string, v: string) => void m.set(k, v),
        removeItem: (k: string) => void m.delete(k),
      };
    })());
    clearAllJoinSent();
  });

  it("does not show A's pending join to B", () => {
    setJoinSentOwner(A);
    markJoinSent(COORD);
    expect(joinSentAt(COORD)).toBeDefined();

    setJoinSentOwner(B);
    expect(joinSentAt(COORD)).toBeUndefined();
  });

  it("keeps a pending join across a restore of the same identity", () => {
    setJoinSentOwner(A);
    markJoinSent(COORD);
    setJoinSentOwner(A);
    expect(joinSentAt(COORD)).toBeDefined();
  });
});

describe("invite codes are owner-scoped", () => {
  beforeEach(() => {
    vi.stubGlobal("sessionStorage", (() => {
      const m = new Map<string, string>();
      return {
        getItem: (k: string) => m.get(k) ?? null,
        setItem: (k: string, v: string) => void m.set(k, v),
        removeItem: (k: string) => void m.delete(k),
      };
    })());
  });

  it("does not hand A's unredeemed invite to B", () => {
    // The code is a single-use nsec that auto-approves whoever redeems it.
    setInviteOwner(A);
    storeInvite(COORD, "nsec1aaa");
    expect(loadInvite(COORD)).toBe("nsec1aaa");

    setInviteOwner(B);
    expect(loadInvite(COORD)).toBeUndefined();

    // …and A still has theirs when they come back, rather than it being wiped.
    setInviteOwner(A);
    expect(loadInvite(COORD)).toBe("nsec1aaa");
  });
});
