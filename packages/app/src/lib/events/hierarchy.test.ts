/**
 * The app half of the space hierarchy (PROTOCOL-NIP.md §15): the pure rules the UI
 * and the auto-join share, the proof an organizer client puts in a key grant, the
 * community's child list, and the verification an organizer does on a `member_of`
 * join request. The wire primitives themselves are tested in packages/protocol.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import {
  bytesToHex,
  bytesToBase64,
  generateEck,
  eckEncrypt,
  makeCoordinate,
  makeMembershipProof,
  buildEventConfig,
  parseEventConfig,
  unwrapRumor,
  wrapRumor,
  naddrToCoordinate,
  memberOfTag,
  KIND_JOIN_REQUEST,
  verifyMembershipProof,
  membershipAuthorities,
  KIND_COMMUNITY,
  KIND_EVENT_CONFIG,
  KIND_ROSTER,
  KIND_KEY_GRANT,
  KIND_DM_RELAY_LIST,
  keyGrantContentSchema,
  type EventConfig,
} from "@nostrautica/protocol";

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
vi.mock("$lib/nostr/verify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("$lib/nostr/verify.js")>()),
  onlyVerified: <T,>(events: T[]) => events,
}));

import {
  decideCommunityJoin,
  sortChildren,
  verifyMemberOfClaim,
  verifyQueueMembership,
  loadChildren,
  linkedParentFor,
  fetchNewestConfig,
  grantParentField,
  __resetLinkMemoForTests,
} from "./hierarchy.js";
import { approveAttendee, reissueGrantsWithProof, fetchPending, type PendingRequest } from "./organizer.js";
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
import { __resetPersistForTests, setActiveCacheOwner } from "$lib/cache/persist.js";

const OWNER = "b".repeat(64);
const ECK_BYTES = generateEck();

// Two spaces, two E_ids: the community and one of its meetups.
const COMM_SK = generateSecretKey();
const COMM_EID = getPublicKey(COMM_SK);
const COMMUNITY = makeCoordinate(COMM_EID, "btc-community", KIND_COMMUNITY);
const EVENT_SK = generateSecretKey();
const EVENT_EID = getPublicKey(EVENT_SK);
const EVENT = makeCoordinate(EVENT_EID, "meetup-oct");
const COORDINATOR_SK = generateSecretKey();
const COORDINATOR = getPublicKey(COORDINATOR_SK);
const ATTENDEE_SK = generateSecretKey();
const ATTENDEE = getPublicKey(ATTENDEE_SK);
const OTHER = getPublicKey(generateSecretKey());

function config(eid: string, d: string, extra: Partial<EventConfig> = {}): EventConfig {
  return {
    d,
    eidPubkey: eid,
    inbox: getPublicKey(generateSecretKey()),
    relays: ["wss://relay.example"],
    chatRelays: [],
    blossom: [],
    maxVideoSec: 90,
    maxTalkSec: 900,
    matching: "off",
    matchVisibility: "pair",
    approval: "manual",
    eck: 1,
    nostrContext: 100,
    lang: "en",
    talks: "off",
    chat: [],
    ...extra,
  };
}

const communityCfg = (children: string[] = [EVENT]) => config(COMM_EID, "btc-community", { children });
const eventCfg = (extra: Partial<EventConfig> = {}) =>
  config(EVENT_EID, "meetup-oct", { parent: COMMUNITY, ...extra });

/** A signed-looking 31600 relay event for a config (signatures are not checked here). */
function configEvent(cfg: EventConfig, createdAt = 1000) {
  const built = buildEventConfig(cfg);
  return {
    id: `cfg-${cfg.d}-${createdAt}`,
    kind: KIND_EVENT_CONFIG,
    pubkey: cfg.eidPubkey,
    created_at: createdAt,
    tags: built.tags,
    content: "",
  };
}

function ctxOf(coordinate: string, cfg: EventConfig, extra: Partial<EventContext> = {}): EventContext {
  return { coordinate, naddr: `naddr-${coordinate.slice(-8)}`, config: cfg, title: "T", summary: "", hashtags: [], ...extra } as EventContext;
}

describe("decideCommunityJoin", () => {
  const base = { hasProof: true, consent: undefined as boolean | undefined, dismissed: false, isMember: false, isPending: false };
  it("joins automatically only on recorded consent", () => {
    expect(decideCommunityJoin({ ...base, consent: true })).toBe("join");
  });
  it("never joins silently without consent: unknown consent only offers", () => {
    expect(decideCommunityJoin({ ...base, consent: undefined })).toBe("offer");
  });
  it("respects an explicit no and a 'not now'", () => {
    expect(decideCommunityJoin({ ...base, consent: false })).toBe("none");
    expect(decideCommunityJoin({ ...base, dismissed: true })).toBe("none");
  });
  it("does nothing without a proof, or when already a member or waiting", () => {
    expect(decideCommunityJoin({ ...base, hasProof: false, consent: true })).toBe("none");
    expect(decideCommunityJoin({ ...base, consent: true, isMember: true })).toBe("none");
    expect(decideCommunityJoin({ ...base, consent: true, isPending: true })).toBe("none");
    expect(decideCommunityJoin({ ...base, isMember: true })).toBe("none");
  });
});

describe("sortChildren", () => {
  const NOW = 1_000_000;
  const e = (title: string, start?: number) => ({ coordinate: `c-${title}`, title, start });
  it("puts upcoming first (soonest first), then undated, then past (newest first)", () => {
    const sorted = sortChildren(
      [e("past-old", NOW - 500), e("later", NOW + 900), e("undated"), e("past-new", NOW - 10), e("soon", NOW + 10)],
      NOW,
    );
    expect(sorted.map((c) => c.title)).toEqual(["soon", "later", "undated", "past-new", "past-old"]);
  });
  it("treats an event starting right now as upcoming, and is deterministic on ties", () => {
    const sorted = sortChildren([e("b", NOW), e("a", NOW)], NOW);
    expect(sorted.map((c) => c.title)).toEqual(["a", "b"]);
  });
});

describe("verifyMemberOfClaim (§15.4)", () => {
  const proofBy = (sk: Uint8Array, who = ATTENDEE) => {
    const p = makeMembershipProof(sk, COMMUNITY, EVENT, who);
    return { child: EVENT, by: p.by, sig: p.sig };
  };

  it("accepts an E_id-signed proof when both newest configs link the spaces", () => {
    expect(verifyMemberOfClaim(COMMUNITY, communityCfg(), proofBy(EVENT_SK), eventCfg(), ATTENDEE)).toBe(true);
  });

  it("accepts a proof signed by the child's current coordinator", () => {
    const cfg = eventCfg({ coordinator: COORDINATOR });
    expect(verifyMemberOfClaim(COMMUNITY, communityCfg(), proofBy(COORDINATOR_SK), cfg, ATTENDEE)).toBe(true);
  });

  it("rejects a coordinator the child has since replaced", () => {
    const claim = proofBy(COORDINATOR_SK);
    expect(verifyMemberOfClaim(COMMUNITY, communityCfg(), claim, eventCfg(), ATTENDEE)).toBe(false);
  });

  it("requires the link from BOTH sides", () => {
    const claim = proofBy(EVENT_SK);
    expect(verifyMemberOfClaim(COMMUNITY, communityCfg([]), claim, eventCfg(), ATTENDEE)).toBe(false);
    expect(verifyMemberOfClaim(COMMUNITY, communityCfg(), claim, eventCfg({ parent: undefined }), ATTENDEE)).toBe(false);
    expect(verifyMemberOfClaim(COMMUNITY, communityCfg(), claim, undefined, ATTENDEE)).toBe(false);
  });

  it("rejects a proof for someone else, or signed by a stranger", () => {
    expect(verifyMemberOfClaim(COMMUNITY, communityCfg(), proofBy(EVENT_SK, OTHER), eventCfg(), ATTENDEE)).toBe(false);
    expect(verifyMemberOfClaim(COMMUNITY, communityCfg(), proofBy(generateSecretKey()), eventCfg(), ATTENDEE)).toBe(false);
  });
});

describe("verifyQueueMembership", () => {
  it("verifies each request against the child's config, fetched once per child", async () => {
    const good = makeMembershipProof(EVENT_SK, COMMUNITY, EVENT, ATTENDEE);
    const forged = makeMembershipProof(generateSecretKey(), COMMUNITY, EVENT, OTHER);
    const fetchConfig = vi.fn(async () => eventCfg());
    const verified = await verifyQueueMembership(
      COMMUNITY,
      communityCfg(),
      [
        { attendeePubkey: ATTENDEE, memberOf: [{ child: EVENT, by: good.by, sig: good.sig }] },
        { attendeePubkey: OTHER, memberOf: [{ child: EVENT, by: forged.by, sig: forged.sig }] },
        { attendeePubkey: getPublicKey(generateSecretKey()) },
      ],
      fetchConfig,
    );
    expect([...verified]).toEqual([[ATTENDEE, EVENT]]);
    expect(fetchConfig).toHaveBeenCalledTimes(1);
  });

  it("does not even fetch a child the community does not list", async () => {
    const p = makeMembershipProof(EVENT_SK, COMMUNITY, EVENT, ATTENDEE);
    const fetchConfig = vi.fn(async () => eventCfg());
    const verified = await verifyQueueMembership(
      COMMUNITY,
      communityCfg([]),
      [{ attendeePubkey: ATTENDEE, memberOf: [{ child: EVENT, by: p.by, sig: p.sig }] }],
      fetchConfig,
    );
    expect(verified.size).toBe(0);
    expect(fetchConfig).not.toHaveBeenCalled();
  });
});

describe("loadChildren", () => {
  const NOW = 2_000_000;
  const child = (d: string) => makeCoordinate(EVENT_EID, d);
  const ctxFor = (coordinate: string, title: string, start: number | undefined, parent: string | undefined = COMMUNITY) =>
    ctxOf(coordinate, config(EVENT_EID, coordinate, { parent }), { title, start, naddr: `naddr-${title}` });

  it("sorts upcoming first then past, and skips unloadable or non-reciprocating children", async () => {
    const [a, b, c, d, gone] = ["a", "b", "c", "d", "gone"].map(child);
    const byCoord = new Map<string, EventContext>([
      [a, ctxFor(a, "past", NOW - 100)],
      [b, ctxFor(b, "next", NOW + 100)],
      [c, ctxFor(c, "later", NOW + 5000)],
      [d, ctxFor(d, "elsewhere", NOW + 1, makeCoordinate(COMM_EID, "other-community", KIND_COMMUNITY))],
    ]);
    // naddr is bech32, so resolve by decoding instead of substring tricks.
    const loadByCoordinate = async (naddr: string) => {
      const ctx = byCoord.get(naddrToCoordinate(naddr).coordinate);
      if (!ctx) throw new Error("unreachable");
      return ctx;
    };
    const list = await loadChildren(
      COMMUNITY,
      { children: [a, b, c, d, gone], relays: ["wss://relay.example"] },
      NOW,
      loadByCoordinate,
    );
    expect(list.map((x) => x.title)).toEqual(["next", "later", "past"]);
  });
});

describe("fetchNewestConfig re-checks what the relay returned (audit SB-10)", () => {
  it("ignores a newer config of the same E_id under a different d, a different author, or kind", async () => {
    const mine = configEvent(eventCfg(), 1000);
    // A hostile relay ignores `#d` and serves the E_id's NEWER config for another
    // space: same author, so its signature verifies just as well.
    const otherD = configEvent(config(EVENT_EID, "meetup-nov", { coordinator: COORDINATOR, coordinatorGen: 1 }), 2000);
    const otherAuthor = { ...configEvent(config(OTHER, "meetup-oct"), 3000), pubkey: OTHER };
    const otherKind = { ...configEvent(eventCfg(), 4000), kind: KIND_ROSTER };
    fetchEvents.mockReset().mockResolvedValue([otherD, otherAuthor, otherKind, mine]);
    const cfg = await fetchNewestConfig(EVENT);
    expect(cfg?.d).toBe("meetup-oct");
    expect(cfg?.inbox).toBe(mine.tags.find((t) => t[0] === "inbox")![1]);
    expect(cfg?.coordinator).toBeUndefined();
  });

  it("returns nothing when no candidate is the requested record", async () => {
    fetchEvents.mockReset().mockResolvedValue([configEvent(config(EVENT_EID, "meetup-nov"), 2000)]);
    expect(await fetchNewestConfig(EVENT)).toBeUndefined();
  });
});

// ── Grants carry the proof ───────────────────────────────────────────────────

function memKeystore(): KeystoreBackend {
  type Stored = EventKeys & { owner: string };
  const rows = new Map<string, Stored>();
  const locked = new Map<string, LockedEventKeys>();
  const k = (o: string, c: string) => `${o} ${c}`;
  return {
    async get(o, c) { return rows.get(k(o, c)); },
    async put(rec) { rows.set(k(rec.owner, rec.coordinate), { ...rec }); },
    async list(o) { return [...rows.values()].filter((r) => r.owner === o); },
    async delete(o, c) { rows.delete(k(o, c)); },
    async legacyGet() { return undefined; },
    async legacyList() { return []; },
    async legacyDelete() {},
    async lockedPut(rec) { locked.set(k(rec.owner, rec.coordinate), rec); },
    async lockedList(o) { return [...locked.values()].filter((r) => r.owner === o); },
    async lockedDelete(o, c) { locked.delete(k(o, c)); },
  };
}

describe("key grants from an organizer client carry the community proof (§15.3)", () => {
  let communityEvents: ReturnType<typeof configEvent>[];
  let roster: { pubkey: string; d: string; role: "attendee" | "organizer" }[];

  /** Answers like a relay: the community's 31600, the roster, nothing else. */
  const relay = async (filter: { kinds?: number[]; authors?: string[] }) => {
    if (filter.kinds?.includes(KIND_EVENT_CONFIG) && filter.authors?.includes(COMM_EID)) return communityEvents;
    if (filter.kinds?.includes(KIND_ROSTER)) {
      return [{
        id: "roster-1", kind: KIND_ROSTER, pubkey: EVENT_EID, created_at: 5000,
        tags: [["d", "meetup-oct"], ["a", EVENT], ["eck", "1"], ["v", "2"]],
        content: eckEncrypt(ECK_BYTES, JSON.stringify({ v: 2, eck_current: 1, attendees: roster })),
      }];
    }
    if (filter.kinds?.includes(KIND_DM_RELAY_LIST)) return [];
    return [];
  };

  /** Every key grant the run published, opened with the attendee's key. */
  function grantsTo(sk: Uint8Array) {
    return publishSigned.mock.calls
      .map((c) => c[0] as { kind: number })
      .filter((e) => e.kind === 1059)
      .flatMap((wrap) => {
        try {
          const rumor = unwrapRumor(wrap as never, sk, [KIND_KEY_GRANT]);
          return [keyGrantContentSchema.parse(JSON.parse(rumor.content))];
        } catch {
          return [];
        }
      });
  }

  const request = (pubkey: string): PendingRequest => ({
    attendeePubkey: pubkey, name: "N", message: "", rsvpPublic: false, rumorCreatedAt: 1,
  });

  beforeEach(async () => {
    __resetPersistForTests();
    setActiveCacheOwner(OWNER);
    __setKeystoreBackend(memKeystore());
    setActiveOwner(OWNER);
    __resetLinkMemoForTests();
    vi.stubGlobal("navigator", { onLine: true });
    publishSigned.mockReset().mockResolvedValue(undefined);
    communityEvents = [configEvent(communityCfg())];
    roster = [];
    fetchEvents.mockReset().mockImplementation(relay);
    fetchEventsRelayOnly.mockReset().mockImplementation(relay);
    await saveEventKeys(
      {
        coordinate: EVENT, role: "organizer",
        eck: [{ id: 1, key: bytesToBase64(ECK_BYTES) }],
        eidNsecHex: bytesToHex(EVENT_SK),
        einboxNsecHex: bytesToHex(generateSecretKey()),
      },
      OWNER,
    );
  });
  afterEach(() => {
    __setKeystoreBackend(null);
    setActiveOwner(null);
    vi.unstubAllGlobals();
  });

  it("approving into a linked event includes a proof that verifies for exactly that attendee", async () => {
    const ctx = ctxOf(EVENT, eventCfg());
    await approveAttendee({} as AppSigner, ctx, request(ATTENDEE));

    const [grant] = grantsTo(ATTENDEE_SK);
    expect(grant?.parent?.a).toBe(COMMUNITY);
    const cfg = eventCfg();
    expect(verifyMembershipProof(grant!.parent!, COMMUNITY, EVENT, ATTENDEE, membershipAuthorities(EVENT, cfg))).toBe(true);
    // The same proof is worthless for anyone else.
    expect(verifyMembershipProof(grant!.parent!, COMMUNITY, EVENT, OTHER, membershipAuthorities(EVENT, cfg))).toBe(false);
  });

  it("adds no proof when the event has no parent", async () => {
    await approveAttendee({} as AppSigner, ctxOf(EVENT, eventCfg({ parent: undefined })), request(ATTENDEE));
    const [grant] = grantsTo(ATTENDEE_SK);
    expect(grant).toBeDefined();
    expect(grant!.parent).toBeUndefined();
  });

  it("adds no proof while the community does not list the event back", async () => {
    communityEvents = [configEvent(communityCfg([]))];
    await approveAttendee({} as AppSigner, ctxOf(EVENT, eventCfg()), request(ATTENDEE));
    expect(grantsTo(ATTENDEE_SK)[0]!.parent).toBeUndefined();
  });

  it("a relay failure costs the optional proof, never the approval", async () => {
    fetchEvents.mockImplementation(async (filter: { kinds?: number[] }) => {
      if (filter.kinds?.includes(KIND_EVENT_CONFIG)) throw new Error("relay down");
      return relay(filter);
    });
    await approveAttendee({} as AppSigner, ctxOf(EVENT, eventCfg()), request(ATTENDEE));
    expect(grantsTo(ATTENDEE_SK)[0]).toBeDefined();
    expect(grantsTo(ATTENDEE_SK)[0]!.parent).toBeUndefined();
  });

  it("linking an event with approved attendees re-issues grants carrying the proof", async () => {
    const second = generateSecretKey();
    roster = [
      { pubkey: ATTENDEE, d: "d1", role: "attendee" },
      { pubkey: getPublicKey(second), d: "d2", role: "attendee" },
    ];
    const sent = await reissueGrantsWithProof(ctxOf(EVENT, eventCfg()));
    expect(sent).toBe(2);
    expect(grantsTo(ATTENDEE_SK)[0]!.parent?.a).toBe(COMMUNITY);
    expect(grantsTo(second)[0]!.parent?.a).toBe(COMMUNITY);
    // The re-issue keeps custody: same ECK set, same role.
    expect(grantsTo(ATTENDEE_SK)[0]!.eck).toHaveLength(1);
  });

  it("re-issues nothing for an event that is not (yet) linked", async () => {
    roster = [{ pubkey: ATTENDEE, d: "d1", role: "attendee" }];
    communityEvents = [configEvent(communityCfg([]))];
    expect(await reissueGrantsWithProof(ctxOf(EVENT, eventCfg()))).toBe(0);
    expect(grantsTo(ATTENDEE_SK)).toHaveLength(0);
  });

  it("memoizes the link check across an 'Approve all' run", async () => {
    const ctx = ctxOf(EVENT, eventCfg());
    for (let i = 0; i < 4; i++) await grantParentField(ctx, EVENT_SK, getPublicKey(generateSecretKey()));
    const configReads = fetchEvents.mock.calls.filter((c) => (c[0] as { kinds?: number[] }).kinds?.includes(KIND_EVENT_CONFIG));
    expect(configReads).toHaveLength(1);
    expect(await linkedParentFor(ctx)).toBe(COMMUNITY);
  });
});

describe("a join request's member_of claims are surfaced for the queue", () => {
  it("parseEventConfig round-trips parent and children (what the link check reads)", () => {
    const parsed = parseEventConfig(EVENT_EID, buildEventConfig(eventCfg()).tags);
    expect(parsed.parent).toBe(COMMUNITY);
    expect(parseEventConfig(COMM_EID, buildEventConfig(communityCfg()).tags).children).toEqual([EVENT]);
  });

  it("fetchPending keeps a member_of tag from a 21600 on the pending request", async () => {
    const inboxSk = generateSecretKey();
    const proof = makeMembershipProof(EVENT_SK, COMMUNITY, EVENT, ATTENDEE);
    const wrap = wrapRumor(ATTENDEE_SK, getPublicKey(inboxSk), {
      kind: KIND_JOIN_REQUEST,
      content: { v: 2, name: "Alice", message: "", rsvp_public: false },
      tags: [["a", COMMUNITY], memberOfTag(EVENT, proof)],
    });
    fetchEventsRelayOnly.mockReset().mockResolvedValue([wrap]);
    const keys: EventKeys = { coordinate: COMMUNITY, role: "organizer", eck: [], einboxNsecHex: bytesToHex(inboxSk) };
    const [req] = await fetchPending(ctxOf(COMMUNITY, communityCfg()), keys);
    expect(req!.attendeePubkey).toBe(ATTENDEE);
    expect(req!.memberOf).toEqual([{ child: EVENT, by: proof.by, sig: proof.sig }]);
    // ...and that claim is what the queue then verifies.
    const verified = await verifyQueueMembership(COMMUNITY, communityCfg(), [req!], async () => eventCfg());
    expect(verified.get(ATTENDEE)).toBe(EVENT);
  });
});
