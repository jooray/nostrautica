import { describe, it, expect, vi } from "vitest";
import { parseProviderAnnouncement, RoutstrLlm, estimateRequestTokens } from "./routstr.js";

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

/** Audit R-49: a reservation that lands after the prepare deadline. */
describe("RoutstrLlm late payment reservation", () => {
  const req = { system: "s", user: "u", schema: {}, schemaName: "n", model: "m" };
  it("quarantines the late reservation through its own handle, never the next request's", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ choices: [{ message: { content: "{}" } }] })));
    let resolveLate!: (r: any) => void;
    const late = { headers: { "X-Cashu": "late" }, settle: vi.fn(async () => {}), fail: vi.fn(async () => {}) };
    const next = { headers: { "X-Cashu": "next" }, settle: vi.fn(async () => {}), fail: vi.fn(async () => {}) };
    const reserve = vi
      .fn()
      .mockImplementationOnce(() => new Promise((r) => (resolveLate = r)))
      .mockImplementationOnce(async () => next);
    const llm = new RoutstrLlm({
      nodeUrl: "https://node/v1",
      payment: { prepare: async () => ({}), settle: async () => {}, reserve },
      net: { allowInsecure: true },
    });
    const first = llm.completeStructured(req).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(String(await first)).toMatch(/timeout/);
    // The next request reserves and settles its own payment…
    await llm.completeStructured(req);
    expect(next.settle).toHaveBeenCalledTimes(1);
    // …and only then does the abandoned prepare finish: it is failed, not settled.
    resolveLate(late);
    await vi.advanceTimersByTimeAsync(0);
    expect(late.fail).toHaveBeenCalledTimes(1);
    expect(late.settle).not.toHaveBeenCalled();
    expect(next.fail).not.toHaveBeenCalled();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});

/** Audit SB-06: Routstr kept the flat 120 s deadline Venice outgrew. */
describe("RoutstrLlm completion deadline scales with max_tokens", () => {
  it("gives a 12,000-token score batch the same 300 s Venice does", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_u: unknown, init: RequestInit) =>
          new Promise((_r, rej) => init.signal?.addEventListener("abort", () => rej(init.signal!.reason))),
      ),
    );
    const llm = new RoutstrLlm({
      nodeUrl: "https://node/v1",
      payment: { prepare: async () => ({}), settle: async () => {}, fail: async () => {} },
      net: { allowInsecure: true },
    });
    let outcome = "pending";
    const p = llm
      .completeStructured({ system: "s", user: "u", schema: {}, schemaName: "n", model: "m", maxTokens: 12_000 })
      .then(() => (outcome = "resolved"), (e: Error) => (outcome = e.message));
    await vi.advanceTimersByTimeAsync(130_000);
    expect(outcome).toBe("pending"); // the flat 120 s used to have fired by now
    await vi.advanceTimersByTimeAsync(171_000);
    await p;
    expect(outcome).toMatch(/timeout/);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});

/** Audit DS41-044: funding came from max_tokens alone, i.e. 1 sat for an unbudgeted call. */
describe("estimateRequestTokens", () => {
  it("counts the prompt as well as the output budget", () => {
    expect(estimateRequestTokens({ system: "s".repeat(4000), user: "u".repeat(36000) })).toBe(10_000 + 4096);
    expect(estimateRequestTokens({ system: "", user: "", maxTokens: 12_000 })).toBe(12_000);
  });
});
