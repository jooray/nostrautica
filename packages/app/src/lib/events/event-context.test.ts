/**
 * Authority-boundary signature checks (audit APPK-1): a forged kind-31600 config
 * (bad signature, e.g. injected by a malicious relay or a poisoned cache) must
 * never win the latest-by-created_at pick — even when it is NEWER than the
 * genuine config. Also covers the relay-hint recording (audit APPK-5) that lets
 * grant authentication find custom-relay events later.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { generateSecretKey, getPublicKey, finalizeEvent, verifiedSymbol } from "nostr-tools/pure";
import { naddrEncode } from "nostr-tools/nip19";
import { KIND_EVENT_CONFIG, KIND_CALENDAR_EVENT, makeCoordinate } from "@nostrautica/protocol";

const { fetchEvents, addRelays } = vi.hoisted(() => ({
  fetchEvents: vi.fn(),
  addRelays: vi.fn(),
}));
vi.mock("$lib/nostr/ndk.js", () => ({ fetchEvents, addRelays }));

import {
  __setPersistBackend,
  __resetPersistForTests,
  type CacheEntry,
  type PersistBackend,
} from "$lib/cache/persist.js";
import { loadEventContext, eventRelayHints } from "./event-context.js";

function memPersist(): PersistBackend {
  const store = new Map<string, CacheEntry>();
  return {
    async getAll() {
      return [...store.entries()];
    },
    async put(k, v) {
      store.set(k, v);
    },
    async delete(keys) {
      for (const k of keys) store.delete(k);
    },
  };
}

const eidSk = generateSecretKey();
const eid = getPublicKey(eidSk);
const inbox = getPublicKey(generateSecretKey());
const IDENT = "boundary-event";
const coordinate = makeCoordinate(eid, IDENT);
const naddr = naddrEncode({ kind: KIND_CALENDAR_EVENT, pubkey: eid, identifier: IDENT, relays: [] });

/** A validly-signed 31600 at `at`, optionally carrying home relays. */
function signedConfig(at: number, relays: string[] = []) {
  return finalizeEvent(
    {
      kind: KIND_EVENT_CONFIG,
      created_at: at,
      tags: [
        ["d", IDENT],
        ["v", "2"],
        ["inbox", inbox],
        ...relays.map((r) => ["relay", r]),
      ],
      content: "",
    },
    eidSk,
  );
}

/** A 31600 whose content was tampered with after signing — sig no longer verifies. */
function forgedConfig(at: number) {
  const ev = signedConfig(at);
  const forged: Record<PropertyKey, unknown> = { ...ev, tags: [...ev.tags, ["title", "tampered"]] };
  // finalizeEvent marks its output with nostr-tools' verifiedSymbol and the
  // spread copies it — strip it, or verifyEvent short-circuits on the mark.
  delete forged[verifiedSymbol];
  return forged;
}

/** Route the three loadEventContext fetches by kind. */
function routeByKind(configs: unknown[]) {
  fetchEvents.mockImplementation((filter: { kinds?: number[] }) => {
    if (filter.kinds?.[0] === KIND_EVENT_CONFIG) return Promise.resolve(configs);
    return Promise.resolve([]);
  });
}

describe("loadEventContext — forged-config rejection (APPK-1)", () => {
  beforeEach(() => {
    __resetPersistForTests();
    __setPersistBackend(memPersist());
    fetchEvents.mockReset();
    addRelays.mockReset();
  });

  it("a forged NEWER 31600 loses to a genuine older one", async () => {
    routeByKind([forgedConfig(2_000), signedConfig(1_000)]);
    const ctx = await loadEventContext(naddr);
    expect(ctx.coordinate).toBe(coordinate);
    expect(ctx.configAt).toBe(1_000); // the genuine config won, not the forged newer one
  });

  it("throws when ONLY a forged 31600 exists", async () => {
    routeByKind([forgedConfig(2_000)]);
    await expect(loadEventContext(naddr)).rejects.toThrow("31600");
  });

  it("records the event's home relays as hints for relay-less contexts (APPK-5)", async () => {
    routeByKind([signedConfig(1_000, ["wss://event-home.example"])]);
    await loadEventContext(naddr);
    expect(eventRelayHints(coordinate)).toEqual(["wss://event-home.example"]);
  });

  it("uses edited event metadata as the context cache freshness stamp", async () => {
    const calendar = finalizeEvent(
      {
        kind: KIND_CALENDAR_EVENT,
        created_at: 2_000,
        tags: [["d", IDENT], ["title", "Edited"]],
        content: "",
      },
      eidSk,
    );
    fetchEvents.mockImplementation((filter: { kinds?: number[] }) => {
      if (filter.kinds?.[0] === KIND_EVENT_CONFIG) return Promise.resolve([signedConfig(1_000)]);
      if (filter.kinds?.[0] === KIND_CALENDAR_EVENT) return Promise.resolve([calendar]);
      return Promise.resolve([]);
    });
    const ctx = await loadEventContext(naddr);
    expect(ctx.title).toBe("Edited");
    expect(ctx.contextAt).toBe(2_000);
  });
});
