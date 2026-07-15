/**
 * DM send-path relay selection (audit G4). A gift-wrapped NIP-17 message must go
 * to the RECIPIENT's declared kind-10050 inboxes (union defaults), not just the
 * sender's default relays — otherwise it never reaches the recipient's other
 * clients. The self-copy goes to the sender's own inboxes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { KIND_DM_RELAY_LIST } from "@nostrautica/protocol";
import type { VerifiedEvent } from "nostr-tools/pure";

const { fetchEvents, publishOrQueue } = vi.hoisted(() => ({
  fetchEvents: vi.fn(),
  publishOrQueue: vi.fn(),
}));

vi.mock("$lib/nostr/ndk.js", () => ({ fetchEvents, fetchEventsRelayOnly: vi.fn() }));
vi.mock("$lib/nostr/publish-queue.js", () => ({ publishOrQueue }));
// signerWrap tags the wrap with the intended recipient's "p" so we can assert routing.
vi.mock("./giftwrap.js", () => ({
  signerWrap: async (_s: unknown, recipient: string) => ({
    kind: 1059,
    tags: [["p", recipient]],
  }),
  signerUnwrap: vi.fn(),
}));

import { relayUrlsFromDmList, selectDmRelays, sendDm } from "./dm.js";
import { DEFAULT_RELAYS } from "$lib/nostr/relays.js";

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
