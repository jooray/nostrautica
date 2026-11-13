/**
 * 0.18: a client sends the 21607 add `intent` only to a coordinator whose latest
 * 31611 lists "attest-intent". A coordinator from before 0.18 rejects an add that
 * carries it, so unknown always means "no intent".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { KIND_COORDINATOR_ANNOUNCE } from "@nostrautica/protocol";

const h = vi.hoisted(() => ({
  store: new Map<string, { at: number; data: unknown }>(),
  listed: undefined as unknown,
  events: [] as unknown[],
  fetches: 0,
}));

vi.mock("$lib/cache/persist.js", () => ({
  ANON: "anon",
  cacheGet: (key: string) => h.store.get(key),
  cacheSet: (key: string, data: unknown, at: number) => {
    const cur = h.store.get(key);
    if (!cur || cur.at <= at) h.store.set(key, { at, data });
  },
}));
vi.mock("$lib/events/coordinators.js", () => ({ cachedCoordinators: () => h.listed }));
vi.mock("$lib/nostr/ndk.js", () => ({
  fetchEventsRelayOnly: vi.fn(async () => {
    h.fetches++;
    return h.events;
  }),
}));

import {
  attestIntentFor,
  knownAttestIntentSupport,
  refreshAttestIntentSupport,
  announceSupportsIntent,
} from "./attest-intent.js";

const sk = generateSecretKey();
const COORD = getPublicKey(sk);

function announce(chat: string[], createdAt = 1_700_000_000) {
  return finalizeEvent(
    {
      kind: KIND_COORDINATOR_ANNOUNCE,
      created_at: createdAt,
      tags: [["d", "nostrautica:coordinator"], ["v", "2"]],
      content: JSON.stringify({ v: 2, name: "C", relays: [], features: { matching: true, talks: true, chat } }),
    },
    sk,
  );
}

beforeEach(() => {
  h.store.clear();
  h.listed = undefined;
  h.events = [];
  h.fetches = 0;
});

describe("attest-intent support (NIP §6.2)", () => {
  it("reads the token from an announcement", () => {
    expect(announceSupportsIntent({ features: { matching: true, talks: true, chat: ["marmot", "attest-intent"] } })).toBe(true);
    // The live third-party coordinator's shape today: chat, no intent support.
    expect(announceSupportsIntent({ features: { matching: true, talks: true, chat: ["marmot"] } })).toBe(false);
    expect(announceSupportsIntent(undefined)).toBeUndefined();
  });

  it("an unknown coordinator gets no intent, and a background read starts", () => {
    expect(attestIntentFor(COORD, "rejoin")).toBeUndefined();
    expect(h.fetches).toBe(1);
  });

  it("an advertising coordinator gets the intent once its announcement is read", async () => {
    h.events = [announce(["marmot", "attest-intent"])];
    expect(await refreshAttestIntentSupport(COORD)).toBe(true);
    expect(attestIntentFor(COORD, "rejoin")).toBe("rejoin");
    expect(attestIntentFor(COORD, "enrol")).toBe("enrol");
    expect(h.fetches).toBe(1); // fresh: no second read
  });

  it("a coordinator that does not advertise it gets a bare add", async () => {
    h.events = [announce(["marmot"])];
    expect(await refreshAttestIntentSupport(COORD)).toBe(false);
    expect(attestIntentFor(COORD, "rejoin")).toBeUndefined();
  });

  it("the latest announcement wins over a stale copy", async () => {
    h.events = [announce(["marmot", "attest-intent"], 1_700_000_000), announce(["marmot"], 1_700_000_500)];
    expect(await refreshAttestIntentSupport(COORD)).toBe(false);
  });

  it("an announcement signed by someone else, or a forged one, is ignored", async () => {
    const other = finalizeEvent(
      { kind: KIND_COORDINATOR_ANNOUNCE, created_at: 1, tags: [], content: JSON.stringify({ v: 2, name: "X", features: { chat: ["attest-intent"] } }) },
      generateSecretKey(),
    );
    // JSON round trip: as a relay delivers it, without nostr-tools' cached "verified" mark.
    const forged = { ...JSON.parse(JSON.stringify(announce(["marmot", "attest-intent"]))), sig: "0".repeat(128) };
    h.events = [other, forged];
    expect(await refreshAttestIntentSupport(COORD)).toBeUndefined();
    expect(knownAttestIntentSupport(COORD)).toBeUndefined();
  });

  it("an unreadable announcement leaves the answer unknown", async () => {
    h.events = [finalizeEvent({ kind: KIND_COORDINATOR_ANNOUNCE, created_at: 1, tags: [], content: "{not json" }, sk)];
    expect(await refreshAttestIntentSupport(COORD)).toBeUndefined();
    expect(attestIntentFor(COORD, "enrol")).toBeUndefined();
  });

  it("reuses the coordinator picker's cached list", () => {
    h.listed = [{ pubkey: COORD, announce: { features: { matching: true, talks: true, chat: ["marmot", "attest-intent"] } } }];
    expect(attestIntentFor(COORD, "enrol")).toBe("enrol");
  });

  it("no coordinator, no intent", () => {
    expect(attestIntentFor(undefined, "rejoin")).toBeUndefined();
  });
});
