/**
 * View-as-visitor preview (spec §13): the pure role-suppression logic that hides
 * member/organizer surfaces while an organizer previews the public view.
 */
import { describe, it, expect } from "vitest";
import { previewedRole } from "./visitor-preview.svelte.js";

describe("previewedRole", () => {
  it("suppresses an organizer to a visitor while previewing", () => {
    expect(previewedRole("organizer", true)).toBe("visitor");
  });
  it("suppresses an attendee to a visitor while previewing", () => {
    expect(previewedRole("attendee", true)).toBe("visitor");
  });
  it("returns the real role when not previewing", () => {
    expect(previewedRole("organizer", false)).toBe("organizer");
    expect(previewedRole("attendee", false)).toBe("attendee");
  });
});
