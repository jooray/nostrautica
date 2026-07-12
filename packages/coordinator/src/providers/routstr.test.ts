import { describe, it, expect } from "vitest";
import { parseProviderAnnouncement } from "./routstr.js";

describe("Routstr provider discovery (kind 38421)", () => {
  it("extracts endpoint (u) and mint tags", () => {
    const result = parseProviderAnnouncement({
      tags: [
        ["u", "https://node-a.routstr.com/v1"],
        ["u", "https://node-b.routstr.com/v1"],
        ["mint", "https://mint.example"],
        ["t", "llm"],
      ],
    });
    expect(result.endpoints).toEqual([
      "https://node-a.routstr.com/v1",
      "https://node-b.routstr.com/v1",
    ]);
    expect(result.mints).toEqual(["https://mint.example"]);
  });

  it("handles an announcement with no endpoints", () => {
    expect(parseProviderAnnouncement({ tags: [["t", "x"]] })).toEqual({
      endpoints: [],
      mints: [],
    });
  });
});
