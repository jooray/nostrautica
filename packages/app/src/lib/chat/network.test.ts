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
vi.mock("$lib/nostr/ndk.js", () => ({
  getNdk: () => ({}),
  relaySet: () => undefined,
  fetchEvents: async () => [],
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
