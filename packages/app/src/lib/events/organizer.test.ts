/**
 * generateInvites label numbering (spec §6.5).
 *
 * `generateInvites` numbers each new code as `${labelPrefix}-${invites.length + 1}`
 * against `invites`, which STARTS as the already-published 31601 list
 * (fetchPublishedInvites) and is pushed to as each new code is minted — so labels
 * are monotonic across separate generation batches, not reset to 1 every time the
 * organizer clicks "Generate". This was confirmed in production: an organizer
 * with 12 codes already issued generated 2 more and got invite-12 and invite-13,
 * not invite-1/invite-2 (2026-07 incident report).
 *
 * There was no test for this before now, and there needs to be one because the
 * organizer guides (all three languages) now document this numbering as fact,
 * and the whole invite-usage export depends on it: `label` is the ONLY join key
 * between a code and a buyer's email address in the organizer's own spreadsheet
 * (see invite-export.ts). If a future change — plausibly an "offline invite
 * generation" feature, or a perf pass that tries to skip the extra relay round
 * trip — drops or reorders the `fetchPublishedInvites` call, numbering silently
 * restarts at 1: two different codes end up sharing a label, the spreadsheet
 * join becomes ambiguous, and the usage report can no longer say which
 * `invite-3` was actually redeemed. Nothing else in the suite would catch that;
 * it's a silent, high-consequence regression that would also make shipped
 * documentation wrong.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { decode as nip19Decode } from "nostr-tools/nip19";
import {
  bytesToHex,
  makeCoordinate,
  inviteHash,
  KIND_INVITE_LIST,
  type InviteListContent,
  type ChatBackend,
} from "@nostrautica/protocol";
import { WHITENOISE_RELAYS } from "$lib/nostr/relays.js";

const { fetchEvents, fetchEventsRelayOnly, publishSigned } = vi.hoisted(() => ({
  fetchEvents: vi.fn(),
  fetchEventsRelayOnly: vi.fn(),
  publishSigned: vi.fn(),
}));
vi.mock("$lib/nostr/ndk.js", () => ({ fetchEvents, fetchEventsRelayOnly, publishSigned }));

import { generateInvites, updateEventConfig } from "./organizer.js";
import {
  __setKeystoreBackend,
  setActiveOwner,
  saveEventKeys,
  type EventKeys,
  type KeystoreBackend,
  type LockedEventKeys,
} from "./keystore.js";
import type { EventContext } from "./event-context.js";
import type { AppSigner } from "$lib/signer/types.js";

const OWNER = "b".repeat(64);
const EID_SK = generateSecretKey();
const EID_PUBKEY = getPublicKey(EID_SK);
const IDENTIFIER = "conf-2026";
const COORD = makeCoordinate(EID_PUBKEY, IDENTIFIER);

const ctx = {
  coordinate: COORD,
  naddr: "naddr1qqxyztest",
  config: {
    eidPubkey: EID_PUBKEY,
    relays: ["wss://relay.example"],
  },
} as unknown as EventContext;

/** In-memory keystore backend, same shape used by organizer-grant.test.ts. */
function memKeystore() {
  type Stored = EventKeys & { owner: string };
  const rows = new Map<string, Stored>();
  const locked = new Map<string, LockedEventKeys>();
  const k = (o: string, c: string) => `${o} ${c}`;
  const backend: KeystoreBackend = {
    async get(o, c) {
      return rows.get(k(o, c));
    },
    async put(rec) {
      rows.set(k(rec.owner, rec.coordinate), { ...rec });
    },
    async list(o) {
      return [...rows.values()].filter((r) => r.owner === o);
    },
    async delete(o, c) {
      rows.delete(k(o, c));
    },
    async legacyGet() {
      return undefined;
    },
    async legacyList() {
      return [];
    },
    async legacyDelete() {},
    async lockedPut(rec) {
      locked.set(k(rec.owner, rec.coordinate), rec);
    },
    async lockedList(o) {
      return [...locked.values()].filter((r) => r.owner === o);
    },
    async lockedDelete(o, c) {
      locked.delete(k(o, c));
    },
  };
  return backend;
}

function organizerKeys(): EventKeys {
  return {
    coordinate: COORD,
    role: "organizer",
    eck: [],
    eidNsecHex: bytesToHex(EID_SK),
  };
}

/** A batch of already-issued invites, labelled invite-1 .. invite-N, each with a
 *  genuinely distinct (and validly-shaped) published hash. */
function issuedBatch(n: number): { h: string; label: string }[] {
  return Array.from({ length: n }, (_, i) => ({
    h: inviteHash(getPublicKey(generateSecretKey())),
    label: `invite-${i + 1}`,
  }));
}

/** The raw 31601 event fetchPublishedInvites reads (only `content` + `created_at`
 *  + `id` matter to the code under test — pickLatest needs id/created_at, the
 *  parser needs content). */
function publishedInviteListEvent(invites: { h: string; label?: string }[], createdAt = 1000) {
  return {
    id: "invitelist-" + createdAt,
    kind: KIND_INVITE_LIST,
    created_at: createdAt,
    pubkey: EID_PUBKEY,
    tags: [
      ["d", IDENTIFIER],
      ["a", COORD],
      ["v", "2"],
    ],
    content: JSON.stringify({ v: 2, invites }),
  };
}

/** Decode a link's `code=` fragment back to hex pubkey, so a test can verify a
 *  label's link really carries THAT label's own invite key, not another's. */
function pubkeyFromLink(link: string): string {
  const nsec = new URL(link.replace("#/", "")).searchParams.get("code")!;
  const decoded = nip19Decode(nsec);
  if (decoded.type !== "nsec") throw new Error("not an nsec");
  return getPublicKey(decoded.data);
}

beforeEach(() => {
  __setKeystoreBackend(memKeystore());
  setActiveOwner(OWNER);
  fetchEvents.mockReset();
  fetchEventsRelayOnly.mockReset().mockResolvedValue([]); // no monotonic collision
  publishSigned.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { onLine: true }); // publishOrQueue takes the immediate-publish path
});

afterEach(() => {
  __setKeystoreBackend(null);
  setActiveOwner(null);
  vi.unstubAllGlobals();
});

describe("generateInvites label numbering", () => {
  it("continues numbering off the published count, not from 1, across batches", async () => {
    // The production incident this guards against: 12 codes already issued,
    // organizer generates 2 more, and used to see invite-1/invite-2 if the
    // published-list fetch were ever skipped. It must be invite-13/invite-14.
    await saveEventKeys(organizerKeys(), OWNER);
    fetchEvents.mockResolvedValue([publishedInviteListEvent(issuedBatch(12))]);

    const generated = await generateInvites({} as AppSigner, ctx, 2, "https://app.example/");

    expect(generated.map((g) => g.label)).toEqual(["invite-13", "invite-14"]);
  });

  it("starts at invite-1 when nothing has been published yet", async () => {
    await saveEventKeys(organizerKeys(), OWNER);
    fetchEvents.mockResolvedValue([]); // no 31601 published at all

    const generated = await generateInvites({} as AppSigner, ctx, 3, "https://app.example/");

    expect(generated.map((g) => g.label)).toEqual(["invite-1", "invite-2", "invite-3"]);
  });

  it("mints distinct codes whose link carries that code's OWN nsec", async () => {
    // Guards the other half of the join-key contract: a label is useless if its
    // link could resolve to a different code's key than the one that hash was
    // published under.
    await saveEventKeys(organizerKeys(), OWNER);
    fetchEvents.mockResolvedValue([publishedInviteListEvent(issuedBatch(1))]); // → next label is invite-2

    const generated = await generateInvites({} as AppSigner, ctx, 5, "https://app.example/");

    const nsecs = new Set(generated.map((g) => g.nsec));
    expect(nsecs.size).toBe(5); // no collisions

    for (const inv of generated) {
      expect(inv.link).toContain(inv.nsec);
      const decoded = nip19Decode(inv.nsec);
      if (decoded.type !== "nsec") throw new Error("not an nsec");
      // The pubkey the link's code decodes to must match what pubkeyFromLink
      // (reading the link's own URL, not `inv.nsec` directly) resolves to — i.e.
      // the label's link is not silently carrying some OTHER invite's code.
      expect(pubkeyFromLink(inv.link)).toBe(getPublicKey(decoded.data));
    }
  });

  it("republishes the full merged list — prior labels survive, new ones are appended", async () => {
    // Losing the old entries on republish would silently orphan every
    // previously-issued code from the usage report AND break label continuity
    // on the NEXT batch (the numbering above depends on this list staying whole).
    await saveEventKeys(organizerKeys(), OWNER);
    const prior = issuedBatch(12);
    fetchEvents.mockResolvedValue([publishedInviteListEvent(prior)]);

    const generated = await generateInvites({} as AppSigner, ctx, 2, "https://app.example/");

    expect(publishSigned).toHaveBeenCalledTimes(1);
    const publishedEvent = publishSigned.mock.calls[0][0];
    const content: InviteListContent = JSON.parse(publishedEvent.content);

    // All 12 prior hashes/labels are still there, in order, ...
    expect(content.invites.slice(0, 12)).toEqual(prior);
    // ... followed by exactly the 2 new ones this call minted.
    expect(content.invites.slice(12).map((i) => i.label)).toEqual(["invite-13", "invite-14"]);
    expect(content.invites.slice(12).map((i) => i.h)).toEqual([
      inviteHash(getPublicKey(nip19Decode(generated[0].nsec).data as Uint8Array)),
      inviteHash(getPublicKey(nip19Decode(generated[1].nsec).data as Uint8Array)),
    ]);
  });

  it("carries the event language on the link, and omits it for English", async () => {
    // Why the link and not just the 31600: `adoptEventLang` cannot run until the
    // config comes back from relays, so an invitee arriving cold watches the
    // whole boot paint in their browser's language and then flip. i18n.init()
    // reads this param before the first paint (see i18n.test.ts).
    await saveEventKeys(organizerKeys(), OWNER);
    fetchEvents.mockResolvedValue([]);

    const skCtx = { ...ctx, config: { ...ctx.config, lang: "sk" } } as EventContext;
    const [sk] = await generateInvites({} as AppSigner, skCtx, 1, "https://app.example/");
    expect(sk.link).toContain("&lang=sk");
    // The code still parses out of the link unchanged — `&` terminates the nsec.
    expect(pubkeyFromLink(sk.link)).toBe(
      getPublicKey(nip19Decode(sk.nsec).data as Uint8Array),
    );

    // English is the implicit default (the 31600 omits the tag too), so an
    // ordinary event's links stay byte-identical to what earlier builds emitted.
    const enCtx = { ...ctx, config: { ...ctx.config, lang: "en" } } as EventContext;
    const [en] = await generateInvites({} as AppSigner, enCtx, 1, "https://app.example/");
    expect(en.link).not.toContain("lang=");
  });
});

/**
 * Admin relay editing (Settings → Relays). An organizer can rewrite an existing
 * event's 31600 `relay` tags, but nothing else may: editing another field must
 * carry the old relays forward unchanged (no silent migration onto new app
 * defaults), and a chat-enabled event must keep the Whitenoise pair folded in so
 * Marmot routing can't be dropped by hand.
 */
describe("updateEventConfig relay editing", () => {
  const fullConfig = {
    d: IDENTIFIER,
    eidPubkey: EID_PUBKEY,
    inbox: getPublicKey(generateSecretKey()),
    relays: ["wss://old.example", "wss://relay.damus.io"],
    chatRelays: [] as string[],
    blossom: [] as string[],
    maxVideoSec: 90,
    maxTalkSec: 900,
    matching: "on",
    matchVisibility: "pair",
    approval: "manual",
    eck: 1,
    nostrContext: 100,
    lang: "en",
    talks: "off",
    chat: [] as ChatBackend[],
  };
  function ctxWith(overrides: Partial<typeof fullConfig>): EventContext {
    return {
      coordinate: COORD,
      naddr: "naddr1test",
      config: { ...fullConfig, ...overrides },
    } as unknown as EventContext;
  }
  function publishedTags(name: string): string[] {
    const ev = publishSigned.mock.calls[0][0] as { tags: string[][] };
    return ev.tags.filter((t) => t[0] === name).map((t) => t[1]);
  }
  function publishedRelayTags(): string[] {
    return publishedTags("relay");
  }

  it("rewrites the 31600 relay tags to exactly the admin-provided set", async () => {
    await saveEventKeys(organizerKeys(), OWNER);
    await updateEventConfig(ctxWith({}), {
      relays: ["wss://nostr.cypherpunk.today", "wss://relay.primal.net"],
    });
    expect(publishSigned).toHaveBeenCalledTimes(1);
    expect(publishedRelayTags()).toEqual([
      "wss://nostr.cypherpunk.today",
      "wss://relay.primal.net",
    ]);
  });

  it("leaves relays untouched when only another field is edited (no silent migration)", async () => {
    await saveEventKeys(organizerKeys(), OWNER);
    await updateEventConfig(ctxWith({}), { retentionDays: 30 });
    expect(publishedRelayTags()).toEqual(["wss://old.example", "wss://relay.damus.io"]);
  });

  // The Whitenoise pair accepts only the Marmot/NIP-17 chat kinds and answers
  // every 31600/31603/kind-5 with "blocked: kind N is not accepted by this
  // relay". Folding it into the event's `relay` tags (as this did until
  // 2026-07-28) therefore guaranteed two failed publishes on every admin save of
  // a chat-enabled event. It belongs in the separate `chat_relay` set.
  it("keeps the Whitenoise pair out of the relay tags and in chat_relay when chat is on", async () => {
    await saveEventKeys(organizerKeys(), OWNER);
    await updateEventConfig(ctxWith({ chat: ["marmot"] }), {
      relays: ["wss://nostr.cypherpunk.today"],
    });
    expect(publishedRelayTags()).toEqual(["wss://nostr.cypherpunk.today"]);
    expect(publishedTags("chat_relay")).toEqual(WHITENOISE_RELAYS);
  });

  it("emits no chat_relay tag at all for a chat-off event", async () => {
    await saveEventKeys(organizerKeys(), OWNER);
    await updateEventConfig(ctxWith({}), { relays: ["wss://nostr.cypherpunk.today"] });
    expect(publishedTags("chat_relay")).toEqual([]);
  });

  // A config republished by a client that already migrated (parseEventConfig
  // moves the legacy pair out of `relay`) must keep carrying the chat relays it
  // was routing over, not silently narrow the set on the next unrelated save.
  it("preserves an existing chat_relay set across an edit that isn't about relays", async () => {
    await saveEventKeys(organizerKeys(), OWNER);
    await updateEventConfig(
      ctxWith({ chat: ["marmot"], chatRelays: ["wss://chat.example", ...WHITENOISE_RELAYS] }),
      { retentionDays: 30 },
    );
    expect(publishedRelayTags()).toEqual(["wss://old.example", "wss://relay.damus.io"]);
    expect(publishedTags("chat_relay")).toEqual([
      "wss://chat.example",
      ...WHITENOISE_RELAYS,
    ]);
  });

  it("dedupes/trims the set and rejects an all-empty relay list", async () => {
    await saveEventKeys(organizerKeys(), OWNER);
    await updateEventConfig(ctxWith({}), {
      relays: ["wss://a.example", "wss://a.example/", "  wss://b.example  "],
    });
    expect(publishedRelayTags()).toEqual(["wss://a.example", "wss://b.example"]);

    publishSigned.mockClear();
    await expect(updateEventConfig(ctxWith({}), { relays: ["", "   "] })).rejects.toThrow(
      /at least one relay/,
    );
    expect(publishSigned).not.toHaveBeenCalled();
  });
});
