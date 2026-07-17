/**
 * DM send-path relay selection (audit G4). A gift-wrapped NIP-17 message must go
 * to the RECIPIENT's declared kind-10050 inboxes (union defaults), not just the
 * sender's default relays — otherwise it never reaches the recipient's other
 * clients. The self-copy goes to the sender's own inboxes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { KIND_DM, KIND_DM_RELAY_LIST } from "@nostrautica/protocol";
import type { VerifiedEvent } from "nostr-tools/pure";

const { fetchEvents, publishOrQueue, streamEvents, signerUnwrap } = vi.hoisted(() => ({
  fetchEvents: vi.fn(),
  publishOrQueue: vi.fn(),
  streamEvents: vi.fn(),
  signerUnwrap: vi.fn(),
}));

vi.mock("$lib/nostr/ndk.js", () => ({ fetchEvents, fetchEventsRelayOnly: vi.fn() }));
vi.mock("$lib/nostr/publish-queue.js", () => ({ publishOrQueue }));
vi.mock("$lib/nostr/stream.js", () => ({ streamEvents }));
// signerWrap tags the wrap with the intended recipient's "p" so we can assert routing.
vi.mock("./giftwrap.js", () => ({
  signerWrap: async (_s: unknown, recipient: string) => ({
    kind: 1059,
    tags: [["p", recipient]],
  }),
  signerUnwrap,
}));

import { relayUrlsFromDmList, selectDmRelays, sendDm, fetchDms, cachedDms } from "./dm.js";
import { DEFAULT_RELAYS } from "$lib/nostr/relays.js";
import {
  __setPersistBackend,
  __resetPersistForTests,
  setActiveCacheOwner,
  type CacheEntry,
  type PersistBackend,
} from "$lib/cache/persist.js";

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

const RECIPIENT = "b".repeat(64);
const ME = "a".repeat(64);

function dmListEvent(pubkey: string, urls: string[]): Partial<VerifiedEvent> {
  return {
    kind: KIND_DM_RELAY_LIST,
    pubkey,
    created_at: 1,
    tags: urls.map((u) => ["relay", u]),
    content: "",
  };
}

describe("relayUrlsFromDmList (pure)", () => {
  it("keeps only well-formed [\"relay\", url] tags", () => {
    expect(
      relayUrlsFromDmList([
        ["relay", "wss://a"],
        ["relay"],
        ["r", "wss://ignored"],
        ["relay", "wss://b"],
      ]),
    ).toEqual(["wss://a", "wss://b"]);
  });
});

describe("selectDmRelays (pure)", () => {
  it("unions the recipient inboxes with defaults, deduped", () => {
    const out = selectDmRelays(["wss://inbox", "wss://relay.damus.io"], [
      "wss://relay.damus.io",
      "wss://nos.lol",
    ]);
    expect(out).toEqual(["wss://inbox", "wss://relay.damus.io", "wss://nos.lol"]);
  });
  it("falls back to defaults alone when the recipient has no 10050", () => {
    expect(selectDmRelays([], ["wss://d1", "wss://d2"])).toEqual(["wss://d1", "wss://d2"]);
  });
});

describe("sendDm relay routing", () => {
  beforeEach(() => {
    fetchEvents.mockReset();
    publishOrQueue.mockReset();
  });

  const signer = {
    method: "local" as const,
    getPublicKey: async () => ME,
    signEvent: vi.fn(),
    nip44Encrypt: async () => "",
    nip44Decrypt: async () => "",
  };

  it("routes the recipient wrap to the recipient's declared 10050 inboxes", async () => {
    fetchEvents.mockImplementation(async (filter: { authors: string[] }) => {
      if (filter.authors[0] === RECIPIENT) return [dmListEvent(RECIPIENT, ["wss://recipient-inbox"])];
      return []; // sender has no 10050
    });

    await sendDm(signer, RECIPIENT, "hi");

    expect(publishOrQueue).toHaveBeenCalledTimes(2);
    const [recipientCall, selfCall] = publishOrQueue.mock.calls;
    // The recipient's wrap goes to their inbox unioned with defaults.
    expect(recipientCall[0].tags).toEqual([["p", RECIPIENT]]);
    expect(recipientCall[1]).toEqual(selectDmRelays(["wss://recipient-inbox"]));
    expect(recipientCall[1]).toContain("wss://recipient-inbox");
    // The self-copy falls back to defaults (sender published no 10050).
    expect(selfCall[0].tags).toEqual([["p", ME]]);
    expect(selfCall[1]).toEqual(DEFAULT_RELAYS);
  });

  it("falls back to defaults when the recipient has no 10050", async () => {
    fetchEvents.mockResolvedValue([]);
    await sendDm(signer, RECIPIENT, "hi");
    const [recipientCall] = publishOrQueue.mock.calls;
    expect(recipientCall[1]).toEqual(DEFAULT_RELAYS);
  });
});

describe("fetchDms unwrap memo persistence (§2.6)", () => {
  const OWNER = "c".repeat(64); // distinct owner so the module cache re-hydrates
  const PEER = "d".repeat(64);
  const signer = { getPublicKey: async () => OWNER } as never;

  beforeEach(() => {
    __resetPersistForTests();
    __setPersistBackend(memPersist());
    setActiveCacheOwner(OWNER);
    streamEvents.mockReset();
    signerUnwrap.mockReset();
  });

  it("decrypts wraps once, then serves history from the persisted memo", async () => {
    // First scan returns one gift-wrap that unwraps to a DM from PEER.
    streamEvents.mockReturnValue({ ready: Promise.resolve([{ id: "wrap-1" }]), stop: () => {} });
    signerUnwrap.mockResolvedValue({
      id: "rumor-1",
      pubkey: PEER,
      kind: KIND_DM,
      tags: [["p", OWNER]],
      content: "hello there",
      created_at: 123,
    });

    const first = await fetchDms(signer);
    // Give the background unwrap loop's .finally(persist) a microtask to settle.
    await Promise.resolve();
    expect(first).toEqual([
      expect.objectContaining({ peer: PEER, from: PEER, text: "hello there", at: 123 }),
    ]);
    // The decrypted message is now in the persistent memo (cache-first paint).
    expect(cachedDms(OWNER)).toEqual([
      expect.objectContaining({ peer: PEER, text: "hello there" }),
    ]);
  });
});
