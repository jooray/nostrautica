import { describe, it, expect } from "vitest";
import { classifyProfileLoad, canSubmitLoggedIn, IdentityFence } from "./profile-load.js";

describe("classifyProfileLoad (UX-O1)", () => {
  it("a fetch failure is 'failed', never a blank 'loaded'", () => {
    const r = classifyProfileLoad({ name: "ignored" }, true);
    expect(r.state).toBe("failed");
    expect(r.name).toBe("");
  });

  it("a profile with a name is 'loaded'", () => {
    const r = classifyProfileLoad({ name: "Ada", about: "hacker" }, false);
    expect(r.state).toBe("loaded");
    expect(r.name).toBe("Ada");
    expect(r.about).toBe("hacker");
  });

  it("a profile with only an about is still 'loaded'", () => {
    expect(classifyProfileLoad({ about: "just a bio" }, false).state).toBe("loaded");
  });

  it("a successful fetch with no public profile is 'empty'", () => {
    expect(classifyProfileLoad(undefined, false).state).toBe("empty");
    expect(classifyProfileLoad({ name: "  ", about: "" }, false).state).toBe("empty");
  });
});

describe("canSubmitLoggedIn (honest submit gate)", () => {
  it("loaded profiles submit as-is", () => {
    expect(canSubmitLoggedIn("loaded", "")).toBe(true);
  });

  it("failed load requires an event-local display name before submit", () => {
    expect(canSubmitLoggedIn("failed", "")).toBe(false);
    expect(canSubmitLoggedIn("failed", "  ")).toBe(false);
    expect(canSubmitLoggedIn("failed", "Grace")).toBe(true);
  });

  it("empty profile requires a local name so the request isn't anonymous", () => {
    expect(canSubmitLoggedIn("empty", "")).toBe(false);
    expect(canSubmitLoggedIn("empty", "Grace")).toBe(true);
  });

  it("never submittable while still loading", () => {
    expect(canSubmitLoggedIn("loading", "Grace")).toBe(false);
    expect(canSubmitLoggedIn("idle", "Grace")).toBe(false);
  });
});

// Audit KIMIK31 W-13: Join's profile state was not tied to the account, so B
// could submit a join request carrying A's name and bio.
describe("IdentityFence (Join's per-account state)", () => {
  const A = "a".repeat(64);
  const B = "b".repeat(64);

  it("reports an account switch so the form can be cleared", () => {
    const fence = new IdentityFence();
    expect(fence.switchTo(A)).toBe(true);
    expect(fence.switchTo(A)).toBe(false); // re-render, same account
    expect(fence.switchTo(null)).toBe(true); // A logged out
    expect(fence.switchTo(B)).toBe(true); // B signed in
  });

  it("a load for A that settles after B signed in is no longer current", () => {
    const fence = new IdentityFence();
    fence.switchTo(A);
    const loadForA = fence.capture();
    fence.switchTo(null);
    fence.switchTo(B);
    expect(fence.isCurrent(loadForA)).toBe(false);
    expect(fence.isCurrent(fence.capture())).toBe(true);
  });

  it("an unchanged account keeps its in-flight load current", () => {
    const fence = new IdentityFence();
    fence.switchTo(A);
    const snapshot = fence.capture();
    fence.switchTo(A);
    expect(fence.isCurrent(snapshot)).toBe(true);
  });
});
