/**
 * Avatar wiring (Bug 3): a talk card / detail header must show the AUTHOR's kind-0
 * avatar (name + picture), not fall back to bare initials. The bug was that the
 * talk surfaces never passed the resolved `picture` to <Avatar>, so an author with
 * a real photo rendered as initials — and when the author was the viewer, that
 * looked identical to the nav "More" tab's own initials. `avatarInfo` is the pure
 * resolver both surfaces now use.
 */
import { describe, it, expect } from "vitest";
import { avatarInfo, type ProfileMeta } from "./social.js";

const AUTHOR = "a".repeat(64);
const VIEWER = "b".repeat(64);

describe("avatarInfo (Bug 3: talk avatars)", () => {
  it("carries the author's picture through when the profile has one", () => {
    const profiles = new Map<string, ProfileMeta>([
      [AUTHOR, { name: "Ada", picture: "https://example/ada.jpg" }],
    ]);
    expect(avatarInfo(AUTHOR, profiles)).toEqual({
      name: "Ada",
      picture: "https://example/ada.jpg",
    });
  });

  it("resolves by the author's pubkey, never leaking another person's profile", () => {
    const profiles = new Map<string, ProfileMeta>([
      [VIEWER, { name: "Me", picture: "https://example/me.jpg" }],
    ]);
    // The card asks for the AUTHOR; the viewer's profile must not answer.
    expect(avatarInfo(AUTHOR, profiles)).toEqual({ name: undefined, picture: undefined });
  });

  it("returns undefined fields for an unresolved profile (initials fallback)", () => {
    expect(avatarInfo(AUTHOR, new Map())).toEqual({ name: undefined, picture: undefined });
  });
});
