import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { npubEncode, nprofileEncode, nsecEncode } from "nostr-tools/nip19";
const { signerWrap, publishAccountGiftWrap } = vi.hoisted(() => ({
  signerWrap: vi.fn(),
  publishAccountGiftWrap: vi.fn(),
}));
vi.mock("$lib/events/giftwrap.js", () => ({ signerWrap }));
vi.mock("$lib/nostr/giftwrap-routing.js", () => ({ publishAccountGiftWrap }));

import {
  parseExternalChatPubkey,
  sendChatLinkRequest,
  sendChatLinkConfirm,
  isLinkedInRoster,
  latestLinkNotice,
  newestLinkNoticeAt,
  linkRefusalMessage,
  refusalEndsLink,
  loadPendingLink,
  savePendingLink,
  clearPendingLink,
  CHAT_LINK_STAGE,
} from "./external-link.js";
import { KIND_CHAT_KEY_ATTESTATION, type CoordinatorStatusContent, type RosterContent } from "@nostrautica/protocol";
import type { AppSigner } from "$lib/signer/types.js";
import type { EventContext } from "$lib/events/event-context.js";

const coordinate = "31923:" + "a".repeat(64) + ":ev";
const account = "c".repeat(64);
const wSk = generateSecretKey();
const W = getPublicKey(wSk);

describe("parseExternalChatPubkey", () => {
  it("accepts npub, nprofile, hex and a nostr: prefix, returning lowercase hex", () => {
    expect(parseExternalChatPubkey(npubEncode(W))).toBe(W);
    expect(parseExternalChatPubkey(`  nostr:${npubEncode(W)} `)).toBe(W);
    expect(parseExternalChatPubkey(nprofileEncode({ pubkey: W, relays: ["wss://r.example"] }))).toBe(W);
    expect(parseExternalChatPubkey(W.toUpperCase())).toBe(W);
  });

  it("refuses an nsec, garbage, and a mangled npub", () => {
    expect(parseExternalChatPubkey(nsecEncode(wSk))).toBeNull();
    expect(parseExternalChatPubkey("hello")).toBeNull();
    expect(parseExternalChatPubkey(npubEncode(W).slice(0, -2) + "qq")).toBeNull();
    expect(parseExternalChatPubkey("a".repeat(63))).toBeNull();
  });
});

describe("21607 link rumors (NIP §10.5)", () => {
  const signer = { getPublicKey: async () => account } as unknown as AppSigner;
  const ctx = {
    coordinate,
    config: { coordinator: "d".repeat(64), relays: ["wss://r.example"] },
  } as unknown as EventContext;

  beforeEach(() => {
    signerWrap.mockReset().mockResolvedValue({ kind: 1059 });
    publishAccountGiftWrap.mockReset().mockResolvedValue(true);
  });

  it("op:link carries the key and a label, sealed by the account to the coordinator", async () => {
    expect(await sendChatLinkRequest(signer, ctx, W)).toBe(true);
    const [sealer, recipient, rumor] = signerWrap.mock.calls[0]!;
    expect(sealer).toBe(signer);
    expect(recipient).toBe("d".repeat(64));
    expect(rumor.kind).toBe(KIND_CHAT_KEY_ATTESTATION);
    expect(rumor.content).toEqual({ v: 2, a: coordinate, op: "link", chat_pubkey: W, label: "White Noise" });
  });

  it("op:link_confirm carries the code as typed (the coordinator normalizes), no proof", async () => {
    await sendChatLinkConfirm(signer, ctx, W, " abcd-efgh ");
    const rumor = signerWrap.mock.calls[0]![2];
    expect(rumor.content).toEqual({ v: 2, a: coordinate, op: "link_confirm", chat_pubkey: W, code: "abcd-efgh" });
  });

  it("reports an outbox-only delivery as false", async () => {
    publishAccountGiftWrap.mockResolvedValue(false);
    expect(await sendChatLinkRequest(signer, ctx, W)).toBe(false);
  });
});

describe("link outcome helpers", () => {
  const notice = (at: number, state: "poison" | "cleared", error_category?: string): CoordinatorStatusContent => ({
    v: 2,
    a: coordinate,
    stage: CHAT_LINK_STAGE,
    state,
    at,
    ...(error_category ? { error_category } : {}),
  });

  it("picks the newest chat_link notice for this attempt, ignoring other stages and earlier actions", () => {
    const other: CoordinatorStatusContent = { v: 2, a: coordinate, stage: "chat_attestation", state: "poison", at: 999 };
    const stale = notice(500, "poison", "chat_link_rate_limited");
    expect(latestLinkNotice([other, stale], 1000)).toBeUndefined(); // older than the slack
    // Within the clock-skew slack, but the user acted after seeing it: not ours.
    const recent = notice(990, "poison", "chat_link_rate_limited");
    expect(latestLinkNotice([recent], 1000)).toBe(recent);
    expect(latestLinkNotice([recent], 1000, newestLinkNoticeAt([recent]))).toBeUndefined();
    const fresh = notice(1005, "cleared");
    expect(latestLinkNotice([recent, fresh, other], 1000, 990)).toBe(fresh);
  });

  it("maps refusal categories, with a generic fallback for unknown ones", () => {
    expect(linkRefusalMessage("chat_link_code_wrong")).toBe("chat.wn.refused.codeWrong");
    expect(linkRefusalMessage("chat_key_package_ineligible")).toBe("chat.wn.refused.keyPackage");
    expect(linkRefusalMessage("something_new")).toBe("chat.wn.refused.other");
    expect(linkRefusalMessage(undefined)).toBe("chat.wn.refused.other");
    // Only a wrong code can be fixed by retyping.
    expect(refusalEndsLink("chat_link_code_wrong")).toBe(false);
    expect(refusalEndsLink("chat_link_expired")).toBe(true);
  });

  it("reads a linked key from the roster's chat_keys", () => {
    const roster = {
      v: 2,
      eck_current: 1,
      attendees: [{ pubkey: account, d: "d", role: "attendee", chat_keys: [{ pubkey: W, added_at: 1, external: true }] }],
    } as RosterContent;
    expect(isLinkedInRoster(roster, account, W)).toBe(true);
    expect(isLinkedInRoster(roster, account, "e".repeat(64))).toBe(false);
    expect(isLinkedInRoster(undefined, account, W)).toBe(false);
  });
});

describe("pending link marker", () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("survives a reload, scoped to account and event, and expires with the code", () => {
    savePendingLink(account, coordinate, { chatPubkey: W, startedAt: 1000 });
    expect(loadPendingLink(account, coordinate, 1000_000)).toEqual({ chatPubkey: W, startedAt: 1000 });
    expect(loadPendingLink("e".repeat(64), coordinate, 1000_000)).toBeUndefined();
    expect(loadPendingLink(account, coordinate, 1000_000 + 30 * 60_000 + 1)).toBeUndefined();
    clearPendingLink(account, coordinate);
    expect(loadPendingLink(account, coordinate, 1000_000)).toBeUndefined();
  });

  it("ignores a corrupt entry and works with storage blocked", () => {
    store.set(`nostrautica:chat-link:${account}:${coordinate}`, "{not json");
    expect(loadPendingLink(account, coordinate)).toBeUndefined();
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    });
    expect(() => savePendingLink(account, coordinate, { chatPubkey: W, startedAt: 1 })).not.toThrow();
    expect(loadPendingLink(account, coordinate)).toBeUndefined();
    expect(() => clearPendingLink(account, coordinate)).not.toThrow();
  });
});
