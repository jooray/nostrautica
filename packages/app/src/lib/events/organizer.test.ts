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
  bytesToBase64,
  base64ToBytes,
  makeCoordinate,
  inviteHash,
  generateEck,
  eckEncrypt,
  eckDecrypt,
  KIND_INVITE_LIST,
  KIND_ROSTER,
  splitRoster,
  rosterPageD,
  type InviteListContent,
  type RosterContent,
  type ChatBackend,
  wrapRumor,
  KIND_JOIN_REQUEST,
  KIND_ATTENDEE_WITHDRAWAL,} from "@nostrautica/protocol";
import { WHITENOISE_RELAYS } from "$lib/nostr/relays.js";

const { fetchEvents, fetchEventsRelayOnly, publishSigned } = vi.hoisted(() => ({
  fetchEvents: vi.fn(),
  fetchEventsRelayOnly: vi.fn(),
  publishSigned: vi.fn(),
}));
vi.mock("$lib/nostr/ndk.js", () => ({
  fetchEvents,
  fetchEventsRelayOnly,
  publishSigned,
  isAcceptedRelayUrl: (value: string) => value.startsWith("wss://"),
}));
// The relay fixtures below are unsigned plain objects; NDK does the signature
// checking in production and `onlyVerified` is the re-check at the authority
// boundary. The real `onlyByAuthors` is deliberately kept — the author pin on the
// roster and the invite list is part of what these tests assert.
vi.mock("$lib/nostr/verify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("$lib/nostr/verify.js")>()),
  onlyVerified: <T,>(events: T[]) => events,
}));

import {
  approveAttendee,
  generateInvites,
  revokeAttendeeClient,
  sharedInviteExp,
  updateEventConfig,
  type PendingRequest,
  fetchPending,} from "./organizer.js";
import {
  __setKeystoreBackend,
  setActiveOwner,
  saveEventKeys,
  loadEventKeys,
  type EventKeys,
  type KeystoreBackend,
  type LockedEventKeys,
} from "./keystore.js";
import type { EventContext } from "./event-context.js";
import type { AppSigner } from "$lib/signer/types.js";
import { __resetPersistForTests, setActiveCacheOwner } from "$lib/cache/persist.js";

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
  // The roster/invite-list writers keep an owner-scoped "this device has seen a
  // published X" tripwire in the persistent cache, so each test starts from a
  // device that has never seen either — otherwise test order would decide whether
  // an empty relay answer counts as a first publish or a lost read.
  __resetPersistForTests();
  setActiveCacheOwner(OWNER);
  fetchEvents.mockReset();
  fetchEventsRelayOnly.mockReset().mockResolvedValue([]); // no monotonic collision
  publishSigned.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { onLine: true }); // publishOrQueue takes the immediate-publish path
});

afterEach(() => {
  __setKeystoreBackend(null);
  setActiveOwner(null);
  __resetPersistForTests();
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

    // Feed the just-published list back, the way relays would: the second batch
    // is for the SAME event, and an empty answer after this device has published
    // a list is now treated as a lost read rather than "no codes issued yet"
    // (see "invite list read-modify-write safety" below).
    const first: InviteListContent = JSON.parse(publishSigned.mock.calls[0][0].content);
    fetchEvents.mockResolvedValue([publishedInviteListEvent(first.invites, 2000)]);

    // English is the implicit default (the 31600 omits the tag too), so an
    // ordinary event's links stay byte-identical to what earlier builds emitted.
    const enCtx = { ...ctx, config: { ...ctx.config, lang: "en" } } as EventContext;
    const [en] = await generateInvites({} as AppSigner, enCtx, 1, "https://app.example/");
    expect(en.link).not.toContain("lang=");
  });
});

/**
 * The shared entry code's policy as it reaches the wire.
 *
 * `sharedInviteExp` (unit-tested at the bottom of this file) decides that 0
 * hours means "no deadline"; this is the other half — that `generateInvites`
 * actually OMITS `exp` rather than writing some falsy value into the published
 * entry. `exp` is `positive()` in the schema, so an `exp: 0` would make the whole
 * invite list unparseable to the coordinator and revoke every code on it, not
 * just this one.
 */
describe("shared entry code policy", () => {
  async function publishedEntry(opts: { uses?: number; exp?: number }) {
    await saveEventKeys(organizerKeys(), OWNER);
    fetchEvents.mockResolvedValue([]);
    const [generated] = await generateInvites(
      {} as AppSigner,
      ctx,
      1,
      "https://app.example/",
      "door",
      opts,
    );
    const content: InviteListContent = JSON.parse(publishSigned.mock.calls[0][0].content);
    return { generated, entry: content.invites[0] };
  }

  it("publishes an unlimited, never-expiring code with no exp key at all", async () => {
    const { generated, entry } = await publishedEntry({ uses: 0, exp: undefined });

    expect(entry.uses).toBe(0);
    expect("exp" in entry).toBe(false);
    // And the in-tab record the QR panel renders from agrees, so the panel can
    // say "never expires" from `generated.exp === undefined` alone.
    expect(generated.exp).toBeUndefined();
    expect(generated.uses).toBe(0);
  });

  it("publishes the deadline when one was asked for", async () => {
    const exp = 1_789_500_000 + 168 * 3600;
    const { generated, entry } = await publishedEntry({ uses: 100, exp });

    expect(entry.uses).toBe(100);
    expect(entry.exp).toBe(exp);
    expect(generated.exp).toBe(exp);
  });
});

/**
 * Invite-list republish safety.
 *
 * `generateInvites` is a read-modify-write over a REPLACEABLE event: it publishes
 * `fetchPublishedInvites() + the new hashes`, and `publishMonotonic` adjusts
 * created_at without ever merging content. The reader used to answer `[]` for a
 * missing list, an unparseable one, and a relay that simply didn't answer — so
 * minting one more code during a relay hiccup silently revoked every code already
 * handed out (hashes on a replaceable event; there is no other copy) and
 * restarted labelling at `invite-1`, which corrupts the label↔email join the
 * usage report is built on.
 */
describe("invite list read-modify-write safety", () => {
  /** A 31601 answered by someone who is not E_id. */
  function foreignInviteListEvent(invites: { h: string; label?: string }[], createdAt = 9000) {
    return {
      ...publishedInviteListEvent(invites, createdAt),
      pubkey: getPublicKey(generateSecretKey()),
    };
  }

  it("refuses to regenerate when the published list exists but can't be parsed", async () => {
    await saveEventKeys(organizerKeys(), OWNER);
    fetchEvents.mockResolvedValue([
      { ...publishedInviteListEvent(issuedBatch(3)), content: "{ truncated" },
    ]);

    await expect(
      generateInvites({} as AppSigner, ctx, 1, "https://app.example/"),
    ).rejects.toThrow(/invite list/i);
    expect(publishSigned).not.toHaveBeenCalled();
  });

  it("refuses to regenerate when a list this device has published comes back empty", async () => {
    await saveEventKeys(organizerKeys(), OWNER);
    fetchEvents.mockResolvedValue([publishedInviteListEvent(issuedBatch(12))]);
    await generateInvites({} as AppSigner, ctx, 1, "https://app.example/");
    expect(publishSigned).toHaveBeenCalledTimes(1); // the merged 13-entry list

    // Venue Wi-Fi: the next read answers with nothing at all. That is NOT "no
    // codes have ever been issued" — this device published 13 of them a moment
    // ago — and publishing over it would revoke all 13.
    publishSigned.mockClear();
    fetchEvents.mockResolvedValue([]);
    await expect(
      generateInvites({} as AppSigner, ctx, 1, "https://app.example/"),
    ).rejects.toThrow(/invite list/i);
    expect(publishSigned).not.toHaveBeenCalled();
  });

  it("still publishes the first batch on an event that has never had one", async () => {
    // The other side of the same coin: an empty read on a device that has never
    // seen a list is a genuine first publish and must not be blocked.
    await saveEventKeys(organizerKeys(), OWNER);
    fetchEvents.mockResolvedValue([]);
    const generated = await generateInvites({} as AppSigner, ctx, 2, "https://app.example/");
    expect(generated.map((g) => g.label)).toEqual(["invite-1", "invite-2"]);
    expect(publishSigned).toHaveBeenCalledTimes(1);
  });

  it("ignores a 31601 by another key instead of laundering it into an E_id-signed list", async () => {
    // `authors` is a request a relay may ignore, and this list is not just read —
    // it is merged into a new 31601 and signed by E_id. An injected list would
    // therefore turn the injector's own codes into genuinely published invite
    // hashes, i.e. codes that auto-approve joins to this event.
    await saveEventKeys(organizerKeys(), OWNER);
    const ours = issuedBatch(2);
    const theirs = issuedBatch(5);
    fetchEvents.mockResolvedValue([
      foreignInviteListEvent(theirs), // newer, so it would win an unpinned pick
      publishedInviteListEvent(ours, 1000),
    ]);

    const generated = await generateInvites({} as AppSigner, ctx, 1, "https://app.example/");

    expect(generated[0].label).toBe("invite-3"); // numbered off OUR two, not their five
    const content: InviteListContent = JSON.parse(publishSigned.mock.calls[0][0].content);
    expect(content.invites.map((i) => i.h)).toEqual([
      ...ours.map((i) => i.h),
      inviteHash(getPublicKey(nip19Decode(generated[0].nsec).data as Uint8Array)),
    ]);
  });
});

/**
 * Roster republish safety (the 2026-08 venue-Wi-Fi class of incident).
 *
 * Every roster write here is a whole-index rewrite stamped `max(now, base + 1)`,
 * so it ALWAYS wins the replaceable-event race. `loadRoster` used to answer both
 * of its failure modes — nothing came back, and came back but wouldn't decrypt —
 * with an empty roster, which meant one bad read published "this event has one
 * attendee" over the real index for everybody. Through revoke it was worse:
 * `remaining` came out empty, so nobody was re-granted the rotated ECK and every
 * attendee lost the directory and all future members-only content in one click.
 */
describe("roster read-modify-write safety", () => {
  // Real curve points: these are gift-wrap recipients, so a "1".repeat(64)
  // placeholder fails inside nip44 rather than in the code under test.
  const ALICE = getPublicKey(generateSecretKey());
  const BOB = getPublicKey(generateSecretKey());
  const CAROL = getPublicKey(generateSecretKey());
  const ECK_BYTES = generateEck();

  function organizerKeysWithEck(): EventKeys {
    return { ...organizerKeys(), eck: [{ id: 1, key: bytesToBase64(ECK_BYTES) }] };
  }

  function rosterEvent(
    attendees: { pubkey: string; d: string; role: "attendee" | "organizer" }[],
    createdAt = 5000,
    content?: string,
  ) {
    return {
      id: `roster-${createdAt}`,
      kind: KIND_ROSTER,
      pubkey: EID_PUBKEY,
      created_at: createdAt,
      tags: [["d", IDENTIFIER], ["a", COORD], ["eck", "1"], ["v", "2"]],
      content:
        content ??
        eckEncrypt(ECK_BYTES, JSON.stringify({ v: 2, eck_current: 1, attendees })),
    };
  }

  function request(pubkey: string): PendingRequest {
    return { attendeePubkey: pubkey, name: "N", message: "", rsvpPublic: false, rumorCreatedAt: 1 };
  }

  /** The roster this run actually published, decrypted. */
  function publishedRoster(): RosterContent {
    const ev = publishSigned.mock.calls
      .map((c) => c[0] as { kind: number; content: string })
      .find((e) => e.kind === KIND_ROSTER)!;
    return JSON.parse(eckDecrypt(ECK_BYTES, ev.content)) as RosterContent;
  }

  beforeEach(async () => {
    await saveEventKeys(organizerKeysWithEck(), OWNER);
    fetchEvents.mockResolvedValue([]); // DM relay-list lookup behind the grant wrap
  });

  it("publishes the read roster plus the new attendee when the read succeeded", async () => {
    fetchEventsRelayOnly.mockResolvedValue([
      rosterEvent([{ pubkey: ALICE, d: "d-alice", role: "attendee" }]),
    ]);

    await approveAttendee({} as AppSigner, ctx, request(BOB));

    expect(publishedRoster().attendees.map((a) => a.pubkey)).toEqual([ALICE, BOB]);
  });

  it("aborts the approval when the roster came back undecryptable", async () => {
    // A roster exists; we just can't read it (wrong/rotated ECK, garbled payload).
    // Publishing an empty one over it is not a degraded outcome, it is deletion.
    fetchEventsRelayOnly.mockResolvedValue([rosterEvent([], 5000, "not-a-ciphertext")]);

    await expect(approveAttendee({} as AppSigner, ctx, request(BOB))).rejects.toThrow(
      /couldn't read/i,
    );
    expect(publishSigned).not.toHaveBeenCalled();
  });

  it("aborts the approval when a roster this device has already seen comes back empty", async () => {
    fetchEventsRelayOnly.mockResolvedValue([
      rosterEvent([{ pubkey: ALICE, d: "d-alice", role: "attendee" }]),
    ]);
    await approveAttendee({} as AppSigner, ctx, request(BOB));

    // Wi-Fi drops between two approvals in the same session. An empty answer here
    // cannot be "this event has no roster" — we read and rewrote one seconds ago.
    publishSigned.mockClear();
    fetchEventsRelayOnly.mockResolvedValue([]);
    await expect(approveAttendee({} as AppSigner, ctx, request(CAROL))).rejects.toThrow(
      /couldn't read/i,
    );
    expect(publishSigned).not.toHaveBeenCalled();
  });

  it("still publishes the first roster on an event that has never had one", async () => {
    // The genuine first approval must keep working — the tripwire only fires once
    // this device has actually seen or written a roster for the event.
    fetchEventsRelayOnly.mockResolvedValue([]);

    await approveAttendee({} as AppSigner, ctx, request(BOB));

    expect(publishedRoster().attendees.map((a) => a.pubkey)).toEqual([BOB]);
  });

  /**
   * A roster too big for one NIP-44 payload lives on several 31604s
   * (PROTOCOL-NIP.md §6.2). The organizer paths read and rewrite the whole index,
   * so all of them have to follow the pages — and an approval still has to cost
   * one publish, or the cheapest operation in the app becomes the most expensive.
   */
  describe("paginated roster", () => {
    // Real curve points, generated once: the revoke path gift-wraps a re-grant to
    // every remaining member, and a non-point pubkey fails inside nip44 rather
    // than in the code under test.
    const POOL: string[] = [];
    function member(i: number): string {
      while (POOL.length <= i) POOL.push(getPublicKey(generateSecretKey()));
      return POOL[i]!;
    }

    /** A roster big enough to need more than one page. */
    function bigRoster(n: number): RosterContent {
      return {
        v: 2,
        eck_current: 1,
        attendees: Array.from({ length: n }, (_, i) => ({
          pubkey: member(i),
          d: (i + 0x1000).toString(16).padStart(32, "a"),
          role: "attendee" as const,
        })),
      };
    }

    /** The 31604 events a paginated roster is actually published as. */
    function pageEvents(roster: RosterContent, createdAt = 5000) {
      return splitRoster(roster).map((page, i) => ({
        id: `roster-${i}-${createdAt}`,
        kind: KIND_ROSTER,
        pubkey: EID_PUBKEY,
        created_at: createdAt,
        tags: [["d", rosterPageD(IDENTIFIER, i)], ["a", COORD], ["eck", "1"], ["v", "2"]],
        content: eckEncrypt(ECK_BYTES, JSON.stringify(page)),
      }));
    }

    /** Serve each page only to the REQ that asked for its `d`, as a relay would. */
    function serve(events: { tags: string[][] }[]): void {
      fetchEventsRelayOnly.mockImplementation(async (filter: { "#d"?: string[] }) => {
        const want = new Set(filter["#d"] ?? []);
        return events.filter((e) => e.tags.some((t) => t[0] === "d" && want.has(t[1]!)));
      });
    }

    function publishedRosterPages() {
      return publishSigned.mock.calls
        .map((c) => c[0] as { kind: number; content: string; tags: string[][] })
        .filter((e) => e.kind === KIND_ROSTER);
    }

    it("reads every page and republishes only the one the approval changed", async () => {
      const roster = bigRoster(600);
      const pages = pageEvents(roster);
      expect(pages.length).toBeGreaterThan(1);
      serve(pages);

      await approveAttendee({} as AppSigner, ctx, request(BOB));

      // One publish, not one per page — an approval appends, and packing is
      // front-to-back, so only the last page's bytes moved.
      const published = publishedRosterPages();
      expect(published).toHaveLength(1);
      expect(published[0]!.tags.find((t) => t[0] === "d")?.[1]).toBe(
        rosterPageD(IDENTIFIER, pages.length - 1),
      );
      // And it really carries the new member, on top of everyone already there.
      const lastPage = JSON.parse(eckDecrypt(ECK_BYTES, published[0]!.content)) as RosterContent;
      expect(lastPage.attendees.at(-1)!.pubkey).toBe(BOB);
    });

    it("republishes page 0 as well when the approval opens a new page", async () => {
      // Grow to the point where one more entry needs another page: page 0's
      // `pages` count moves, so it is republished too — two publishes, not N.
      let n = 600;
      // Bounded for the same reason as roster.test.ts's boundary search: without
      // it, a splitRoster that stops paginating hangs the suite instead of
      // failing it.
      while (splitRoster(bigRoster(n + 1)).length === splitRoster(bigRoster(n)).length) {
        n++;
        if (n > 1000) throw new Error("never found a page boundary — splitRoster stopped paginating");
      }
      const pages = pageEvents(bigRoster(n));
      serve(pages);

      await approveAttendee({} as AppSigner, ctx, request(BOB));

      const ds = publishedRosterPages().map((e) => e.tags.find((t) => t[0] === "d")?.[1]);
      expect(new Set(ds)).toEqual(
        new Set([rosterPageD(IDENTIFIER, 0), rosterPageD(IDENTIFIER, pages.length)]),
      );
    });

    it("aborts rather than rewriting the index when a continuation page is missing", async () => {
      // Page 0 says there are N pages and one of them did not come back. The
      // membership is unknown, and republishing what we DID read would drop
      // everyone on the missing page from the event.
      const pages = pageEvents(bigRoster(600));
      serve(pages.slice(0, -1));

      await expect(approveAttendee({} as AppSigner, ctx, request(BOB))).rejects.toThrow(
        /couldn't read/i,
      );
      expect(publishSigned).not.toHaveBeenCalled();
    });

    it("a revoke rewrites every page, because every blinded d changed", async () => {
      const roster = bigRoster(600);
      const victim = roster.attendees[5]!.pubkey;
      const pages = pageEvents(roster);
      serve(pages);
      fetchEvents.mockResolvedValue([]);

      await revokeAttendeeClient({} as AppSigner, ctx, victim);

      const keys = await loadEventKeys(COORD);
      const newEck = base64ToBytes(keys!.eck.find((v) => v.id === 2)!.key);
      const published = publishedRosterPages();
      expect(published.length).toBeGreaterThan(1);
      const merged = published
        .map((e) => JSON.parse(eckDecrypt(newEck, e.content)) as RosterContent)
        .flatMap((p) => p.attendees);
      expect(merged).toHaveLength(roster.attendees.length - 1);
      expect(merged.some((a) => a.pubkey === victim)).toBe(false);
      // Explicit budget: a revoke re-grants the rotated ECK to every remaining
      // member, so this case does 599 real NIP-44 encryptions. It lands around
      // 4.5s alone and tips over vitest's 5s default under a loaded suite — a
      // slow test, not a hanging one.
    }, 60_000);
  });

  it("refuses to revoke against a roster that doesn't list the person being revoked", async () => {
    // Revoke rebuilds the roster from `remaining` and re-grants the rotated ECK to
    // exactly those people, so a stale or partial read doesn't produce a smaller
    // rotation — it locks everyone it failed to see out of the event for good.
    fetchEventsRelayOnly.mockResolvedValue([
      rosterEvent([{ pubkey: ALICE, d: "d-alice", role: "attendee" }]),
    ]);

    await expect(revokeAttendeeClient({} as AppSigner, ctx, BOB)).rejects.toThrow(/roster/i);
    expect(publishSigned).not.toHaveBeenCalled();

    // And the ECK must NOT have been rotated by the aborted attempt: a new version
    // current on this device but granted to nobody would encrypt every later post
    // under a key no attendee holds.
    expect((await loadEventKeys(COORD))?.eck).toHaveLength(1);
  });

  it("revokes normally when the roster does list them", async () => {
    fetchEventsRelayOnly.mockResolvedValue([
      rosterEvent([
        { pubkey: ALICE, d: "d-alice", role: "attendee" },
        { pubkey: BOB, d: "d-bob", role: "attendee" },
      ]),
    ]);

    await revokeAttendeeClient({} as AppSigner, ctx, BOB);

    // The rotated roster keeps Alice (re-keyed) and drops Bob.
    const rotated = publishSigned.mock.calls
      .map((c) => c[0] as { kind: number; content: string; tags: string[][] })
      .find((e) => e.kind === KIND_ROSTER)!;
    const keys = await loadEventKeys(COORD);
    const newEck = keys!.eck.find((v) => v.id === 2)!;
    const content = JSON.parse(
      eckDecrypt(base64ToBytes(newEck.key), rotated.content),
    ) as RosterContent;
    expect(content.attendees.map((a) => a.pubkey)).toEqual([ALICE]);
  });

  /**
   * Revoke mints ECK v(n+1) and re-encrypts the roster and every directory entry
   * under it — and used to persist that key ONLY on this device. Every other path
   * that mints an ECK writes the durable 30078 backup; this one never did. So a
   * coordinator-less organizer who revoked someone and later cleared site data (or
   * moved to a new phone) restored a backup holding only ECK v1, leaving the
   * event's own owner permanently unable to read their own roster and directory.
   * Rotation is forward-only, so there is no way back from that.
   */
  it("writes the rotated ECK to the organizer's durable backup", async () => {
    fetchEventsRelayOnly.mockResolvedValue([
      rosterEvent([
        { pubkey: ALICE, d: "d-alice", role: "attendee" },
        { pubkey: BOB, d: "d-bob", role: "attendee" },
      ]),
    ]);

    // `writeEventKeysBackup` correctly does nothing without BOTH event secrets, so
    // seed a complete custody record — the shared fixture carries no E_inbox key.
    const withInbox = await loadEventKeys(COORD);
    await saveEventKeys({ ...withInbox!, einboxNsecHex: "3".repeat(64) }, OWNER);

    // The backup is self-encrypted through the SIGNER and published monotonically,
    // so this needs a signer that can actually do both.
    const encrypted: string[] = [];
    const signer = {
      getPublicKey: async () => ALICE,
      nip44Encrypt: async (_pk: string, plaintext: string) => {
        encrypted.push(plaintext);
        return `enc:${plaintext}`;
      },
      signEvent: async (e: unknown) => e,
    } as unknown as AppSigner;

    await revokeAttendeeClient(signer, ctx, BOB, new Uint8Array(32).fill(7));

    const keys = await loadEventKeys(COORD);
    const newEck = keys!.eck.find((v) => v.id === 2)!;
    // The backup payload carries the NEW key, not just the old one.
    expect(encrypted.join(" ")).toContain(newEck.key);
  });

  it("still revokes, loudly, when no blinding key is available", async () => {
    // Better a rotation the organizer is warned about than a refusal that leaves a
    // revoked attendee holding a live key.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchEventsRelayOnly.mockResolvedValue([
      rosterEvent([
        { pubkey: ALICE, d: "d-alice", role: "attendee" },
        { pubkey: BOB, d: "d-bob", role: "attendee" },
      ]),
    ]);

    await revokeAttendeeClient({} as AppSigner, ctx, BOB);

    expect((await loadEventKeys(COORD))?.eck).toHaveLength(2);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/only on this device/i);
    warn.mockRestore();
  });
});

/**
 * Withdrawals on an event with no coordinator (2026-09-04 audit).
 *
 * `withdrawAttendee` publishes a 21610 to E_inbox and reports success on the
 * relay ack — but the only handler for that kind is the coordinator's. Without
 * one the rumor sat unread forever: the attendee was told they had left, deleted
 * their self-copy and their media, and stayed in the roster and directory with
 * their ECK still on their device.
 */
describe("fetchPending surfaces withdrawals", () => {
  const EINBOX_SK = generateSecretKey();
  const ATTENDEE_SK = generateSecretKey();
  const ATTENDEE = getPublicKey(ATTENDEE_SK);
  const inboxCtx = {
    ...ctx,
    config: { ...ctx.config, inbox: getPublicKey(EINBOX_SK) },
  } as EventContext;

  const joinWrap = (createdAt: number) =>
    wrapRumor(ATTENDEE_SK, getPublicKey(EINBOX_SK), {
      kind: KIND_JOIN_REQUEST,
      created_at: createdAt,
      content: { v: 2, a: COORD, name: "Ann", message: "hi", rsvp_public: false },
      tags: [["a", COORD]],
    });
  const withdrawWrap = (createdAt: number, deleteData: boolean) =>
    wrapRumor(ATTENDEE_SK, getPublicKey(EINBOX_SK), {
      kind: KIND_ATTENDEE_WITHDRAWAL,
      created_at: createdAt,
      content: { v: 2, a: COORD, delete_data: deleteData },
      tags: [["a", COORD]],
    });

  beforeEach(async () => {
    await saveEventKeys({ ...organizerKeys(), einboxNsecHex: bytesToHex(EINBOX_SK) }, OWNER);
  });

  it("marks an attendee whose withdrawal is newer than their join", async () => {
    fetchEventsRelayOnly.mockResolvedValue([joinWrap(100), withdrawWrap(200, true)]);

    const pending = await fetchPending(inboxCtx, (await loadEventKeys(COORD))!);
    const who = pending.find((p) => p.attendeePubkey === ATTENDEE);
    expect(who?.withdrawn).toBe(true);
    expect(who?.withdrawalRequestedPurge).toBe(true);
  });

  it("does not let a stale withdrawal shadow a later re-join", async () => {
    fetchEventsRelayOnly.mockResolvedValue([withdrawWrap(100, true), joinWrap(200)]);

    const pending = await fetchPending(inboxCtx, (await loadEventKeys(COORD))!);
    expect(pending.find((p) => p.attendeePubkey === ATTENDEE)?.withdrawn).toBeUndefined();
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

/**
 * The "valid for (hours)" field on the shared entry code.
 *
 * The regression this pins is not a crash — it is a silent substitution. The
 * handler used to compute `Math.max(1, hours) * 3600`, so an organizer asking
 * for no expiry (0, the same thing 0 means in the headcount field next to it)
 * got a one-hour code: the most restrictive window the form can express, handed
 * out as if it were the least. Nothing on screen said so, and the symptom only
 * surfaces hours later as "some people got in, most are stuck in the queue".
 */
describe("sharedInviteExp", () => {
  const NOW = 1_789_500_000_000; // ms

  it("omits exp entirely for 0, so the published code never expires", () => {
    expect(sharedInviteExp(0, NOW)).toBeUndefined();
  });

  it("treats an emptied field (null/undefined/NaN) as no expiry, not as one hour", () => {
    expect(sharedInviteExp(null, NOW)).toBeUndefined();
    expect(sharedInviteExp(undefined, NOW)).toBeUndefined();
    expect(sharedInviteExp(NaN, NOW)).toBeUndefined();
    expect(sharedInviteExp(-5, NOW)).toBeUndefined();
  });

  it("converts hours to a unix-SECONDS deadline", () => {
    expect(sharedInviteExp(1, NOW)).toBe(1_789_500_000 + 3600);
    expect(sharedInviteExp(4, NOW)).toBe(1_789_500_000 + 4 * 3600);
    expect(sharedInviteExp(168, NOW)).toBe(1_789_500_000 + 168 * 3600);
  });

  it("produces an integer for a fractional hour count", () => {
    const exp = sharedInviteExp(0.5, NOW);
    expect(exp).toBe(1_789_500_000 + 1800);
    expect(Number.isInteger(exp)).toBe(true);
  });
});
