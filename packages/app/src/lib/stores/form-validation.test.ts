import { describe, it, expect } from "vitest";
import { validate, errorId, describedBy, hasError } from "./form-validation.js";

describe("form-validation", () => {
  it("collects only failing checks in order and names the first", () => {
    const r = validate([
      { id: "title", message: null },
      { id: "name", message: "Name is required" },
      { id: "end", message: "End is before start" },
    ]);
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual([
      { id: "name", message: "Name is required" },
      { id: "end", message: "End is before start" },
    ]);
    expect(r.firstErrorId).toBe("name");
  });

  it("treats empty-string messages as valid", () => {
    const r = validate([{ id: "a", message: "" }]);
    expect(r.ok).toBe(true);
    expect(r.firstErrorId).toBeUndefined();
  });

  it("is ok with no failing checks", () => {
    expect(validate([{ id: "a", message: null }]).ok).toBe(true);
  });

  it("errorId derives a stable message-element id", () => {
    expect(errorId("title")).toBe("title-error");
  });

  it("describedBy combines hint + error ids only when present", () => {
    expect(describedBy("title", false)).toBeUndefined();
    expect(describedBy("title", true)).toBe("title-error");
    expect(describedBy("title", false, "title-hint")).toBe("title-hint");
    expect(describedBy("title", true, "title-hint")).toBe("title-hint title-error");
  });

  it("hasError reports membership for aria-invalid wiring", () => {
    const errors = [{ id: "name", message: "x" }];
    expect(hasError(errors, "name")).toBe(true);
    expect(hasError(errors, "title")).toBe(false);
  });
});
