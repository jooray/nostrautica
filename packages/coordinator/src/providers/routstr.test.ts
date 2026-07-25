import { describe, it, expect, vi } from "vitest";
import { parseProviderAnnouncement, RoutstrLlm } from "./routstr.js";

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

describe("RoutstrLlm proof accounting on failure (COORD-5 / H-4)", () => {
  const req = { system: "s", user: "u", schema: {}, schemaName: "n", model: "m" };

  it("calls payment.fail() when the completion request errors post-reservation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNRESET");
      }),
    );
    const fail = vi.fn(async () => {});
    const llm = new RoutstrLlm({
      nodeUrl: "https://node/v1",
      payment: { prepare: async () => ({ "X-Cashu": "tok" }), settle: async () => {}, fail },
      // This unit test mocks global.fetch; skip R22 DNS pinning for the fake host.
      net: { allowInsecure: true },
    });
    await expect(llm.completeStructured(req)).rejects.toThrow(/ECONNRESET/);
    expect(fail).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("calls payment.fail() on a non-2xx completion response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 502 })),
    );
    const fail = vi.fn(async () => {});
    const llm = new RoutstrLlm({
      nodeUrl: "https://node/v1",
      payment: { prepare: async () => ({}), settle: async () => {}, fail },
      // This unit test mocks global.fetch; skip R22 DNS pinning for the fake host.
      net: { allowInsecure: true },
    });
    await expect(llm.completeStructured(req)).rejects.toThrow(/502/);
    expect(fail).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
