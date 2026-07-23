import { describe, it, expect } from "vitest";
import { advanceStage, stageRank, isSecured } from "./backup-stages.js";

describe("backup stages (UX-O7)", () => {
  it("orders none < copied < saved < confirmed", () => {
    expect(stageRank("none")).toBeLessThan(stageRank("copied"));
    expect(stageRank("copied")).toBeLessThan(stageRank("saved"));
    expect(stageRank("saved")).toBeLessThan(stageRank("confirmed"));
  });

  it("advances forward but never regresses", () => {
    expect(advanceStage("none", "copied")).toBe("copied");
    expect(advanceStage("copied", "saved")).toBe("saved");
    expect(advanceStage("saved", "confirmed")).toBe("confirmed");
    // A late/duplicate lower signal (e.g. another copy after saving) never regresses.
    expect(advanceStage("saved", "copied")).toBe("saved");
    expect(advanceStage("confirmed", "copied")).toBe("confirmed");
  });

  it("only 'confirmed' counts as secured — a copy does not", () => {
    expect(isSecured("none")).toBe(false);
    expect(isSecured("copied")).toBe(false);
    expect(isSecured("saved")).toBe(false);
    expect(isSecured("confirmed")).toBe(true);
  });
});
