/**
 * DM send-path relay selection (audit G4). A gift-wrapped NIP-17 message must go
 * to the RECIPIENT's declared kind-10050 inboxes (union defaults), not just the
 * sender's default relays — otherwise it never reaches the recipient's other
 * clients. The self-copy goes to the sender's own inboxes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { KIND_DM, KIND_DM_RELAY_LIST } from "@nostrautica/protocol";
import type { VerifiedEvent } from "nostr-tools/pure";

const { fetchEvents, publishOrQueue, streamEvents, signerWrap, signerUnwrap } = vi.hoisted(() => ({
  fetchEvents: vi.fn(),
  publishOrQueue: vi.fn(),
  streamEvents: vi.fn(),
  signerWrap: vi.fn(async (_s: unknown, recipient: string, _input: unknown) => ({
    kind: 1059,
    tags: [["p", recipient]],
  })),
  signerUnwrap: vi.fn(),
}));

vi.mock("$lib/nostr/ndk.js", () => ({
  fetchEvents,
  fetchEventsRelayOnly: vi.fn(),
  isAcceptedRelayUrl: (value: string) => {
    try {
      const url = new URL(value);
      return url.protocol === "wss:" ||
        (url.protocol === "ws:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
    } catch {
      return false;
    }
  },
}));
vi.mock("$lib/nostr/publish-queue.js", () => ({ publishOrQueue }));
vi.mock("$lib/nostr/stream.js", () => ({ streamEvents }));
// signerWrap tags the wrap with the intended recipient's "p" so we can assert routing.
vi.mock("./giftwrap.js", () => ({
  signerWrap,
  signerUnwrap,
}));

import {
  relayUrlsFromDmList,
  selectDmRelays,
  sendDm,
  fetchDms,
  cachedDms,
  scanDmGiftWraps,
  MAX_DM_RELAYS,
  DM_HISTORY_PAGE_LIMIT,
  DM_HISTORY_PAGES_PER_SCAN,
} from "./dm.js";
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

  it("rejects unsafe URLs, dedupes, and caps untrusted relay lists", () => {
    const valid = Array.from({ length: MAX_DM_RELAYS + 5 }, (_, i) => `wss://relay-${i}.example`);
    expect(
      relayUrlsFromDmList([
        ["relay", "https://not-a-relay.example"],
        ["relay", "ws://public-insecure.example"],
        ["relay", "not a url"],
        ["relay", "ws://localhost:7777"],
        ...valid.map((url) => ["relay", url]),
        ["relay", valid[0] + "/"],
      ]),
    ).toEqual(["ws://localhost:7777", ...valid.slice(0, MAX_DM_RELAYS - 1)]);
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
  it("rejects invalid routes and caps the effective relay set", () => {
    const inboxes = Array.from({ length: MAX_DM_RELAYS + 5 }, (_, i) => `wss://inbox-${i}.example`);
    const out = selectDmRelays(["https://bad.example", ...inboxes], ["wss://default.example"]);
    expect(out).toHaveLength(MAX_DM_RELAYS);
    expect(out).not.toContain("https://bad.example");
    expect(out).toContain("wss://default.example");
  });
});

describe("sendDm relay routing", () => {
  beforeEach(() => {
    fetchEvents.mockReset();
    publishOrQueue.mockReset();
    signerWrap.mockClear();
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

  it("wraps one identical rumor for the recipient and self copies", async () => {
    fetchEvents.mockResolvedValue([]);
    await sendDm(signer, RECIPIENT, "same rumor");
    expect(signerWrap).toHaveBeenCalledTimes(2);
    expect(signerWrap.mock.calls[0][2]).toEqual(signerWrap.mock.calls[1][2]);
    expect(signerWrap.mock.calls[0][2]).toEqual(expect.objectContaining({
      content: "same rumor",
      created_at: expect.any(Number),
    }));
  });
});

function wraps(count: number, newest: number, prefix: string) {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`,
    created_at: newest - i,
  }));
}

describe("scanDmGiftWraps ciphertext routing and history", () => {
  beforeEach(() => {
    __resetPersistForTests();
    __setPersistBackend(memPersist());
    fetchEvents.mockReset();
    streamEvents.mockReset();
  });

  it("reads incoming wraps from the owner's custom kind-10050 inbox union defaults", async () => {
    const owner = "1".repeat(64);
    setActiveCacheOwner(owner);
    fetchEvents.mockResolvedValue([dmListEvent(owner, ["wss://my-private-inbox.example"])]);
    streamEvents.mockReturnValue({ ready: Promise.resolve([]), stop: () => {} });

    await scanDmGiftWraps(owner);

    expect(fetchEvents).toHaveBeenCalledWith({ kinds: [KIND_DM_RELAY_LIST], authors: [owner] });
    expect(streamEvents).toHaveBeenCalledTimes(1);
    expect(streamEvents.mock.calls[0][1].relays).toEqual(
      selectDmRelays(["wss://my-private-inbox.example"]),
    );
    expect(signerUnwrap).not.toHaveBeenCalled();
  });

  it("observes recent ciphertext without consuming paginated history", async () => {
    const owner = "4".repeat(64);
    setActiveCacheOwner(owner);
    fetchEvents.mockResolvedValue([]);
    streamEvents.mockReturnValue({
      ready: Promise.resolve([{ id: "recent-wrap", created_at: 900 }]),
      stop: () => {},
    });

    await scanDmGiftWraps(owner, { history: false });

    expect(streamEvents).toHaveBeenCalledTimes(1);
    expect(streamEvents.mock.calls[0][0]).toMatchObject({ since: expect.any(Number) });
    expect(streamEvents.mock.calls[0][0]).not.toHaveProperty("until");
  });

  it("paginates backward, deduping the inclusive timestamp boundary", async () => {
    const owner = "2".repeat(64);
    setActiveCacheOwner(owner);
    fetchEvents.mockResolvedValue([]);
    const first = wraps(DM_HISTORY_PAGE_LIMIT, 1_000, "first");
    const second = [
      first[first.length - 1],
      ...wraps(DM_HISTORY_PAGE_LIMIT - 1, 800, "second"),
    ];
    streamEvents
      .mockReturnValueOnce({ ready: Promise.resolve(first), stop: () => {} })
      .mockReturnValueOnce({ ready: Promise.resolve(second), stop: () => {} })
      .mockReturnValueOnce({ ready: Promise.resolve([]), stop: () => {} });

    const result = await scanDmGiftWraps(owner);

    expect(result).toHaveLength(DM_HISTORY_PAGE_LIMIT * 2 - 1);
    expect(new Set(result.map((wrap) => wrap.id)).size).toBe(result.length);
    expect(streamEvents.mock.calls.map(([filter]) => filter.until)).toEqual([
      undefined,
      1_000 - DM_HISTORY_PAGE_LIMIT + 1,
      800 - (DM_HISTORY_PAGE_LIMIT - 2),
    ]);
  });

  it("bounds a repeated full page and forces the inclusive cursor backward", async () => {
    const owner = "3".repeat(64);
    setActiveCacheOwner(owner);
    fetchEvents.mockResolvedValue([]);
    const repeated = wraps(DM_HISTORY_PAGE_LIMIT, 100, "stuck").map((wrap) => ({
      ...wrap,
      created_at: 100,
    }));
    streamEvents.mockReturnValue({ ready: Promise.resolve(repeated), stop: () => {} });

    const result = await scanDmGiftWraps(owner);

    expect(result).toHaveLength(DM_HISTORY_PAGE_LIMIT);
    expect(streamEvents).toHaveBeenCalledTimes(DM_HISTORY_PAGES_PER_SCAN);
    expect(streamEvents.mock.calls.map(([filter]) => filter.until)).toEqual([
      undefined,
      100,
      99,
      98,
      97,
    ]);
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
