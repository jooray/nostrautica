/**
 * Where a new event's relays end up (create.ts).
 *
 * Chat-enabled events need the Whitenoise/Marmot interop relays, and until
 * 2026-07-28 `createEvent` got them there by unioning them into the event's own
 * relay list. Measured with `nak` on 2026-07-28 (30 kinds × 9 relays, throwaway
 * key), both of those relays accept ONLY kinds 0/3/445/1059/10000/10002/10050/
 * 30443 and answer everything else with `blocked: kind N is not accepted by this
 * relay` — so that union meant the kind-31923 and kind-31600 this very function
 * publishes were rejected by two of the event's own relays, and the event's
 * naddr shipped two relay hints that can never serve it.
 *
 * These tests pin the split: general relays in `relay`, chat relays in
 * `chat_relay`, and nothing chat-related in a chat-off event at all.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { naddrToCoordinate, parseEventConfig } from "@nostrautica/protocol";
import { DEFAULT_RELAYS, WHITENOISE_RELAYS } from "$lib/nostr/relays.js";

const { publishOrQueue, fetchEvents, fetchEventsRelayOnly, publishSigned, saveEventKeys } =
  vi.hoisted(() => ({
    publishOrQueue: vi.fn(async (_event?: unknown, _relays?: string[]) => true),
    fetchEvents: vi.fn(async () => []),
    fetchEventsRelayOnly: vi.fn(async () => []),
    publishSigned: vi.fn(async () => true),
    saveEventKeys: vi.fn(async () => {}),
  }));
vi.mock("$lib/nostr/ndk.js", () => ({ fetchEvents, fetchEventsRelayOnly, publishSigned }));
vi.mock("$lib/nostr/publish-queue.js", () => ({
  publishOrQueue,
  toOutcome: (ok: boolean) => (ok ? "published" : "queued"),
}));
vi.mock("./keystore.js", () => ({
  saveEventKeys,
  loadEventKeys: vi.fn(async () => undefined),
  currentEck: vi.fn(() => undefined),
}));

import { createEvent, type CreateEventInput } from "./create.js";
import type { AppSigner } from "$lib/signer/types.js";

const ownerSk = generateSecretKey();
const owner: AppSigner = {
  getPublicKey: async () => getPublicKey(ownerSk),
  signEvent: async (t: any) => ({ ...t, id: "id", sig: "sig", pubkey: getPublicKey(ownerSk) }),
  nip44Encrypt: async (_pk: string, plaintext: string) => plaintext,
  nip44Decrypt: async (_pk: string, ciphertext: string) => ciphertext,
} as unknown as AppSigner;

function input(over: Partial<CreateEventInput> = {}): CreateEventInput {
  return {
    title: "Cypherpunk 2026",
    summary: "A conference",
    start: 1_800_000_000,
    maxVideoSec: 90,
    maxTalkSec: 900,
    matching: "on",
    matchVisibility: "pair",
    approval: "manual",
    nostrContext: 0,
    ...over,
  };
}

/** The tags of the kind-31600 config this run published. */
function publishedConfigTags(): string[][] {
  const call = publishOrQueue.mock.calls
    .map((c) => c[0] as unknown as { kind: number; tags: string[][] })
    .find((e) => e?.kind === 31600);
  if (!call) throw new Error("no 31600 published");
  return call.tags;
}
function tagValues(name: string): string[] {
  return publishedConfigTags()
    .filter((t) => t[0] === name)
    .map((t) => t[1]!);
}
/** Every relay set any of the create publishes targeted. */
function publishTargets(): string[] {
  return publishOrQueue.mock.calls.flatMap((c) => (c[1] as unknown as string[]) ?? []);
}

describe("createEvent relay split", () => {
  beforeEach(() => {
    publishOrQueue.mockClear();
    saveEventKeys.mockClear();
  });

  it("puts the chat interop relays in chat_relay, never in the event's relay list", async () => {
    const relays = ["wss://nostr.cypherpunk.today", "wss://nos.lol"];
    const created = await createEvent(owner, input({ chat: ["marmot"], relays }), new Uint8Array(32));

    expect(created.config.relays).toEqual(relays);
    expect(created.config.chatRelays).toEqual(WHITENOISE_RELAYS);
    expect(tagValues("relay")).toEqual(relays);
    expect(tagValues("chat_relay")).toEqual(WHITENOISE_RELAYS);

    // Nothing is published TO them, and the naddr doesn't advertise them: they
    // reject 31600/31923 and can't serve them back either.
    for (const url of WHITENOISE_RELAYS) expect(publishTargets()).not.toContain(url);
    expect(naddrToCoordinate(created.naddr).relays).toEqual(relays);
  });

  it("emits no chat_relay tag at all when chat is off", async () => {
    const created = await createEvent(owner, input(), new Uint8Array(32));
    expect(created.config.relays).toEqual(DEFAULT_RELAYS);
    expect(created.config.chatRelays).toEqual([]);
    expect(publishedConfigTags().some((t) => t[0] === "chat_relay")).toBe(false);
  });

  it("attaches no interop relays to a loopback-only (local e2e) event", async () => {
    const created = await createEvent(
      owner,
      input({ chat: ["marmot"], relays: ["ws://localhost:7777"] }),
      new Uint8Array(32),
    );
    expect(created.config.chatRelays).toEqual([]);
    expect(publishTargets()).not.toContain(WHITENOISE_RELAYS[0]);
  });

  it("round-trips through the published tags (what a reader actually sees)", async () => {
    const relays = ["wss://nostr.cypherpunk.today"];
    const created = await createEvent(owner, input({ chat: ["marmot"], relays }), new Uint8Array(32));
    const parsed = parseEventConfig(created.eidPubkey, publishedConfigTags());
    expect(parsed.relays).toEqual(relays);
    expect(parsed.chatRelays).toEqual(WHITENOISE_RELAYS);
    expect(parsed.chat).toEqual(["marmot"]);
  });
});
