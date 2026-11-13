import { describe, it, expect, vi, afterEach } from "vitest";
import { MarmotClientMls, PENDING_PUBLICATION_SWEEP_MS } from "./mls.js";

/** The retained-commit sweep (audit K-7): loadAll retries once per group, starts the timer only when asked, and stop() ends it. */
describe("MarmotClientMls retry sweep", () => {
  afterEach(() => vi.useRealTimers());

  it("loadAll retries every group once, and starts one sweep when asked to", async () => {
    vi.useFakeTimers();
    const retried: string[] = [];
    const client = {
      groups: {
        listIds: async () => [new Uint8Array([0xab])],
        get: async (id: string) => ({
          state: { groupContext: { epoch: 1n } },
          retryPendingPublication: async () => {
            retried.push(id);
            return [];
          },
        }),
      },
    };
    const mls = new MarmotClientMls(client as never);
    await mls.loadAll();
    await vi.advanceTimersByTimeAsync(PENDING_PUBLICATION_SWEEP_MS);
    expect(retried).toEqual(["ab"]); // the load's own retry; no timer by default

    retried.length = 0;
    await mls.loadAll({ retrySweepEveryMs: PENDING_PUBLICATION_SWEEP_MS });
    await mls.loadAll({ retrySweepEveryMs: PENDING_PUBLICATION_SWEEP_MS }); // idempotent: one timer
    expect(retried).toEqual(["ab", "ab"]); // once per load

    retried.length = 0;
    await vi.advanceTimersByTimeAsync(PENDING_PUBLICATION_SWEEP_MS);
    expect(retried).toEqual(["ab"]);

    mls.stop();
    await vi.advanceTimersByTimeAsync(PENDING_PUBLICATION_SWEEP_MS * 3);
    expect(retried).toEqual(["ab"]);
  });

  it("warns only about a publication still unacknowledged, not about groups with nothing to retry", async () => {
    const groups: Record<string, unknown> = {
      bb: { retryPendingPublication: async () => Promise.reject(new Error("Group was disbanded")) },
      cc: {
        retryPendingPublication: async () =>
          Promise.reject(new Error("Failed to publish commit: publish timed out")),
      },
    };
    const client = {
      groups: {
        listIds: async () => [new Uint8Array([0xaa]), new Uint8Array([0xbb]), new Uint8Array([0xcc])],
        get: async (id: string) => {
          if (id === "aa") throw new Error("state did not load");
          return groups[id];
        },
      },
    };
    const warned: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((m: unknown) => void warned.push(String(m)));
    try {
      await new MarmotClientMls(client as never).retryPendingPublications();
    } finally {
      spy.mockRestore();
    }
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/group cc… still not acknowledged: Failed to publish commit/);
  });

  // Audit KIMIK31 R-9: the daemon now drives the sweep one group at a time, so
  // the per-group lock is what keeps a commit off a group whose retry is in flight.
  it("a group's retry holds that group's lock: an invite on it waits, another group's does not", async () => {
    let release!: () => void;
    const hang = new Promise<void>((r) => (release = r));
    const events: string[] = [];
    const client = {
      groups: {
        listIds: async () => [new Uint8Array([0xab]), new Uint8Array([0xcd])],
        get: async (id: string) => ({
          state: { ratchetTree: [], groupContext: { epoch: 1n } },
          retryPendingPublication: async () => {
            events.push(`retry ${id} start`);
            if (id === "ab") await hang;
            events.push(`retry ${id} end`);
            return [];
          },
        }),
        invite: async (id: string) => void events.push(`invite ${id}`),
      },
    };
    const mls = new MarmotClientMls(client as never);
    const retry = mls.retryGroupPendingPublication("ab");
    const kp = { pubkey: "f".repeat(64) } as never;
    const sameGroup = mls.invite("ab", kp);
    await mls.invite("cd", kp); // a different group is not held up
    await new Promise((r) => setTimeout(r, 0));
    expect([...events].sort()).toEqual(["invite cd", "retry ab start"]); // and no "invite ab" yet
    release();
    await Promise.all([retry, sameGroup]);
    expect(events.slice(2)).toEqual(["retry ab end", "invite ab"]);
  });
});
