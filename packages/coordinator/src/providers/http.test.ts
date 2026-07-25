import { describe, it, expect, afterEach } from "vitest";
import { withProviderTimeout, ProviderTimeoutError, PROVIDER_TIMEOUTS } from "./http.js";
import { VeniceLlm } from "./venice.js";

describe("withProviderTimeout (audit H-4)", () => {
  it("returns the callback value when it resolves before the deadline", async () => {
    await expect(withProviderTimeout("fast", 1000, async () => 42)).resolves.toBe(42);
  });

  it("throws ProviderTimeoutError when the callback stalls past the deadline", async () => {
    const p = withProviderTimeout(
      "stall",
      20,
      (signal) =>
        new Promise((_, reject) => {
          // Simulate fetch(): rejects with an AbortError once the signal fires.
          signal.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const err = await p.catch((e) => e);
    expect(err).toBeInstanceOf(ProviderTimeoutError);
    expect((err as ProviderTimeoutError).timeoutMs).toBe(20);
    expect((err as ProviderTimeoutError).label).toBe("stall");
    // The classified message must contain the marker errorCategory() keys on.
    expect(String(err).toLowerCase()).toContain("provider timeout");
  });

  it("aborts the signal it hands the callback when the deadline fires", async () => {
    let seen: AbortSignal | undefined;
    const p = withProviderTimeout("t", 10, (signal) => {
      seen = signal;
      return new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    });
    await expect(p).rejects.toBeInstanceOf(ProviderTimeoutError);
    expect(seen?.aborted).toBe(true);
  });

  it("propagates a non-abort error unchanged (not misreported as a timeout)", async () => {
    const boom = new Error("boom");
    await expect(
      withProviderTimeout("t", 1000, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });

  it("exposes sane default deadlines per operation class", () => {
    expect(PROVIDER_TIMEOUTS.metadata).toBeGreaterThan(0);
    expect(PROVIDER_TIMEOUTS.completion).toBeGreaterThanOrEqual(PROVIDER_TIMEOUTS.metadata);
    expect(PROVIDER_TIMEOUTS.stt).toBeGreaterThanOrEqual(PROVIDER_TIMEOUTS.completion);
  });
});

describe("caller-signal cancellation combines with the deadline (audit R13)", () => {
  it("throws immediately when the caller signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort(new Error("shutting down"));
    let ran = false;
    await expect(
      withProviderTimeout(
        "already",
        1000,
        async () => {
          ran = true;
          return 1;
        },
        ac.signal,
      ),
    ).rejects.toThrow();
    // The callback never ran — the request never opened a socket.
    expect(ran).toBe(false);
  });

  it("a caller abort unwinds the call and is NOT reclassified as a provider timeout", async () => {
    const ac = new AbortController();
    let seen: AbortSignal | undefined;
    const p = withProviderTimeout(
      "long-stt",
      // A huge deadline: only the caller abort can end this, proving the caller
      // signal — not the internal timeout — drives cancellation.
      600_000,
      (signal) => {
        seen = signal;
        return new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted"))),
        );
      },
      ac.signal,
    );
    ac.abort(new Error("coordinator shutting down"));
    const err = await p.catch((e) => e);
    // The combined signal the callback saw is aborted…
    expect(seen?.aborted).toBe(true);
    // …and the failure is the caller's reason, NOT a ProviderTimeoutError.
    expect(err).not.toBeInstanceOf(ProviderTimeoutError);
    expect(String((err as Error).message)).toContain("shutting down");
  });
});

describe("shutdown aborts a REAL provider adapter path (audit R13)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("VeniceLlm.completeStructured aborts its fetch when the caller signal fires", async () => {
    // Mock ONLY the network layer (global fetch), not the handler: the request hangs
    // until ITS signal aborts, exactly like a slow provider holding the socket open.
    let fetchSignal: AbortSignal | undefined;
    globalThis.fetch = ((_url: any, init: any) => {
      fetchSignal = init?.signal as AbortSignal;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal.reason ?? new DOMException("aborted", "AbortError")),
        );
      });
    }) as typeof fetch;

    const llm = new VeniceLlm({
      baseUrl: "https://api.venice.ai/api/v1",
      // A no-op payment strategy (ApiKeyPayment shape) — no real key needed.
      payment: { prepare: async () => ({}), settle: async () => {} },
      // This test mocks global.fetch to hang; skip R22 DNS pinning for the host.
      net: { allowInsecure: true },
    });

    const ac = new AbortController();
    const call = llm.completeStructured({
      system: "s",
      user: "u",
      schema: { type: "object" },
      schemaName: "t",
      model: "mock",
      signal: ac.signal,
    });
    // Let the request open, then simulate a coordinator shutdown.
    await new Promise((r) => setTimeout(r, 5));
    ac.abort(new Error("coordinator shutting down"));

    const err = await call.catch((e) => e);
    // The real adapter forwarded a combined signal to fetch(), and it aborted.
    expect(fetchSignal?.aborted).toBe(true);
    // The call rejected (it did not hang to the 2-minute completion deadline).
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ProviderTimeoutError);
  });
});
