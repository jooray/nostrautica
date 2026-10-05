import { describe, it, expect } from "vitest";
import { normalizeAvatarUrl, profilePicture, AVATAR_URL_MAX_BYTES } from "./avatar.js";

describe("normalizeAvatarUrl (group.avatar-url.v1 producer rules)", () => {
  it("stores the WHATWG-serialized form", () => {
    expect(normalizeAvatarUrl("HTTPS://Example.COM:443/a/./b/../c.png")).toEqual({
      ok: true,
      url: "https://example.com/a/c.png",
    });
    expect(normalizeAvatarUrl("https://example.com")).toEqual({ ok: true, url: "https://example.com/" });
    expect(normalizeAvatarUrl("https://bücher.example/x.png")).toEqual({
      ok: true,
      url: "https://xn--bcher-kva.example/x.png",
    });
  });

  it("treats a missing or blank icon as the empty (no avatar) state", () => {
    expect(normalizeAvatarUrl(undefined)).toEqual({ ok: true, url: "" });
    expect(normalizeAvatarUrl("   ")).toEqual({ ok: true, url: "" });
  });

  it.each([
    ["http://example.com/a.png", "scheme"],
    ["data:image/png;base64,AAAA", "scheme"],
    ["https://user:pw@example.com/a.png", "userinfo"],
    ["https://user@example.com/a.png", "userinfo"],
    ["https://example.com/a.png#frag", "fragment"],
    ["https://example.com/a.png#", "fragment"],
    ["example.com/a.png", "not a URL"],
  ])("rejects %s", (raw, why) => {
    const r = normalizeAvatarUrl(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(why);
  });

  it("rejects a URL over 2048 bytes once serialized", () => {
    const base = "https://example.com/";
    expect(normalizeAvatarUrl(base + "a".repeat(AVATAR_URL_MAX_BYTES - base.length)).ok).toBe(true);
    expect(normalizeAvatarUrl(base + "a".repeat(AVATAR_URL_MAX_BYTES - base.length + 1)).ok).toBe(false);
  });
});

describe("profilePicture", () => {
  it("reads a string picture and ignores anything else", () => {
    expect(profilePicture(JSON.stringify({ picture: "https://x/y.png", banner: "b" }))).toBe("https://x/y.png");
    expect(profilePicture(JSON.stringify({ picture: 5 }))).toBeUndefined();
    expect(profilePicture("not json")).toBeUndefined();
    expect(profilePicture(undefined)).toBeUndefined();
  });
});
