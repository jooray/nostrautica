import { describe, it, expect } from "vitest";
import { withProviderTimeout, ProviderTimeoutError, PROVIDER_TIMEOUTS } from "./http.js";

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
