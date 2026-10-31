import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NDKKind } from "@nostr-dev-kit/ndk";

/** What the next streamEvents call resolves with, and whether every relay EOSEd. */
let next: { events: unknown[]; allAnswered: boolean };
const streamEvents = vi.fn((_filters: unknown, _opts: unknown) => ({
  ready: Promise.resolve(next.events.map((raw) => ({ rawEvent: () => raw }))),
  stop: () => {},
  answered: () => next.allAnswered,
  allAnswered: () => next.allAnswered,
}));
vi.mock("$lib/nostr/stream.js", () => ({
  streamEvents: (f: unknown, o: unknown) => streamEvents(f, o),
}));
const publishSignedOutcomes = vi.fn();
vi.mock("$lib/nostr/ndk.js", () => ({
  getNdk: () => ({}),
  relaySet: () => undefined,
  fetchEvents: async () => [],
  publishSignedOutcomes: (e: unknown, r: unknown) => publishSignedOutcomes(e, r),
}));

import { createMarmotNetwork } from "./network.js";
import { RelaysUnansweredError } from "$lib/nostr/unanswered.js";

const RELAY = "wss://relay.test";
const FILTER = { kinds: [445 as NDKKind] };
const event = { id: "e1", kind: 445, created_at: 1, tags: [], content: "", pubkey: "p", sig: "s" };

describe("createMarmotNetwork().request", () => {
  beforeEach(() => streamEvents.mockClear());

  it("returns the events when every relay asked answered", async () => {
    next = { events: [event], allAnswered: true };
    expect(await createMarmotNetwork().request([RELAY], FILTER)).toEqual([event]);
    expect(streamEvents).toHaveBeenCalledWith({ kinds: [445] }, { relays: [RELAY] });
  });

  // marmot-ts 0.8.0 records a resolved page as "this relay has nothing more in
  // that window" in a persisted cursor, so a timeout must not look like an answer.
  it("rejects a timed-out read instead of resolving its partial results", async () => {
    next = { events: [event], allAnswered: false };
    await expect(createMarmotNetwork().request([RELAY], FILTER)).rejects.toBeInstanceOf(
      RelaysUnansweredError,
    );
  });

  it("rejects an empty read no relay answered", async () => {
    next = { events: [], allAnswered: false };
    await expect(createMarmotNetwork().request([RELAY], FILTER)).rejects.toBeInstanceOf(
      RelaysUnansweredError,
    );
  });
});

/**
 * Audit K-7: a timed-out commit publish must not read as a definite failure.
 * marmot-ts keeps the exact commit bytes for retry only when a response is
 * `uncertain`; a plain `ok:false` on every relay makes it roll the commit back,
 * and a relay that stored it anyway then forks this device off the group.
 */
describe("createMarmotNetwork().publish — refused vs. unanswered (audit K-7)", () => {
  beforeEach(() => publishSignedOutcomes.mockReset());

  it("marks a timeout and a dropped socket uncertain, per relay", async () => {
    publishSignedOutcomes.mockResolvedValueOnce([
      { url: "wss://a", ok: false, reason: "Timeout: 2500ms" },
      { url: "wss://b", ok: false, reason: "Relay is disconnected" },
    ]);
    const res = await createMarmotNetwork().publish(["wss://a", "wss://b"], event as never);
    expect(res["wss://a"]).toMatchObject({ ok: false, uncertain: true });
    expect(res["wss://b"]).toMatchObject({ ok: false, uncertain: true });
  });

  it("reports an explicit relay refusal as a definite ok:false", async () => {
    publishSignedOutcomes.mockResolvedValueOnce([
      { url: "wss://a", ok: false, reason: "blocked: kind 445 not accepted" },
      { url: "wss://b", ok: false, reason: "rate-limited: slow down" },
    ]);
    const res = await createMarmotNetwork().publish(["wss://a", "wss://b"], event as never);
    expect(res["wss://a"]).toEqual({ from: "wss://a", ok: false, message: "blocked: kind 445 not accepted" });
    expect(res["wss://b"]?.ok).toBe(false);
    expect(res["wss://b"]?.uncertain).toBeUndefined();
  });

  it("counts an ack and a duplicate as stored", async () => {
    publishSignedOutcomes.mockResolvedValueOnce([
      { url: "wss://a", ok: true },
      { url: "wss://b", ok: false, reason: "duplicate: already have it" },
    ]);
    const res = await createMarmotNetwork().publish(["wss://a", "wss://b"], event as never);
    expect(res["wss://a"]?.ok).toBe(true);
    expect(res["wss://b"]?.ok).toBe(true);
  });

  it("a publish that could not even start is uncertain, never a refusal", async () => {
    publishSignedOutcomes.mockRejectedValueOnce(new Error("no relays"));
    const res = await createMarmotNetwork().publish(["wss://a"], event as never);
    expect(res["wss://a"]).toMatchObject({ ok: false, uncertain: true });
  });

  it("a requested relay that produced no outcome is uncertain", async () => {
    publishSignedOutcomes.mockResolvedValueOnce([{ url: "wss://a", ok: false, reason: "invalid: bad sig" }]);
    const res = await createMarmotNetwork().publish(["wss://a", "wss://silent"], event as never);
    expect(res["wss://a"]?.uncertain).toBeUndefined();
    expect(res["wss://silent"]).toMatchObject({ ok: false, uncertain: true });
  });
});
