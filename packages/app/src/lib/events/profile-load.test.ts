import { describe, it, expect } from "vitest";
import { classifyProfileLoad, canSubmitLoggedIn } from "./profile-load.js";

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
