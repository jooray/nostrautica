/**
 * Joining a community because you joined one of its events (PROTOCOL-NIP.md
 * §15.5). The rule under test is a negative one: nothing is sent to a community
 * the person did not agree to. Consent is recorded per (owner, child) at the join
 * form; a proof with no recorded answer only ever becomes a card.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import {
  makeCoordinate,
  makeMembershipProof,
  buildEventConfig,
  naddrToCoordinate,
  KIND_COMMUNITY,
  KIND_EVENT_CONFIG,
  type EventConfig,
} from "@nostrautica/protocol";

const { fetchEvents, fetchEventsRelayOnly, sendJoinRequest, loadSelfCopy, loadEventContext } = vi.hoisted(() => ({
  fetchEvents: vi.fn(),
  fetchEventsRelayOnly: vi.fn(),
  sendJoinRequest: vi.fn(),
  loadSelfCopy: vi.fn(),
  loadEventContext: vi.fn(),
}));
vi.mock("$lib/nostr/ndk.js", () => ({ fetchEvents, fetchEventsRelayOnly, publishSigned: vi.fn() }));
vi.mock("$lib/nostr/verify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("$lib/nostr/verify.js")>()),
  onlyVerified: <T,>(events: T[]) => events,
}));
vi.mock("./join.js", () => ({ sendJoinRequest }));
vi.mock("$lib/media/submit.js", () => ({ loadSelfCopy }));
vi.mock("./blinding.js", () => ({ deriveBlindingKey: async () => new Uint8Array(32).fill(7) }));
vi.mock("./social.js", () => ({
  fetchProfiles: async (pks: string[]) => new Map(pks.map((pk) => [pk, { name: "From kind 0" }])),
}));
vi.mock("./event-context.js", () => ({
  loadEventContext,
  cachedEventContext: () => undefined,
  cacheEventContext: () => undefined,
  eventRelayHints: () => [],
}));

import {
  storeParentProof,
  loadParentProof,
  proofChildren,
  recordParentConsent,
  loadParentConsent,
  dismissCommunityOffer,
  evaluateCommunityOffer,
  joinCommunityViaChild,
  autoJoinCommunities,
} from "./community-join.js";
import {
  __setKeystoreBackend,
  setActiveOwner,
  saveEventKeys,
  type EventKeys,
  type KeystoreBackend,
} from "./keystore.js";
import { __resetPersistForTests, setActiveCacheOwner } from "$lib/cache/persist.js";
import { markJoinSent } from "$lib/stores/join-sent.svelte.js";
import type { AppSigner } from "$lib/signer/types.js";

const OWNER = getPublicKey(generateSecretKey());
const COMM_EID = getPublicKey(generateSecretKey());
const COMMUNITY = makeCoordinate(COMM_EID, "btc", KIND_COMMUNITY);
const EVENT_SK = generateSecretKey();
const EVENT_EID = getPublicKey(EVENT_SK);
const EVENT = makeCoordinate(EVENT_EID, "meetup-1");
const EVENT_2 = makeCoordinate(EVENT_EID, "meetup-2");

const signer = { getPublicKey: async () => OWNER } as unknown as AppSigner;

function cfg(eid: string, d: string, extra: Partial<EventConfig> = {}): EventConfig {
  return {
    d, eidPubkey: eid, inbox: getPublicKey(generateSecretKey()), relays: ["wss://relay.example"], chatRelays: [],
    blossom: [], maxVideoSec: 90, maxTalkSec: 900, matching: "off", matchVisibility: "pair", approval: "manual",
    eck: 1, nostrContext: 100, lang: "en", talks: "off", chat: [], ...extra,
  };
}
const configEvent = (c: EventConfig) => ({
  id: `cfg-${c.d}`, kind: KIND_EVENT_CONFIG, pubkey: c.eidPubkey, created_at: 1000,
  tags: buildEventConfig(c).tags, content: "",
});

function memKeystore(): KeystoreBackend {
  const rows = new Map<string, EventKeys & { owner: string }>();
  return {
    async get(o, c) { return rows.get(`${o} ${c}`); },
    async put(rec) { rows.set(`${rec.owner} ${rec.coordinate}`, { ...rec }); },
    async list(o) { return [...rows.values()].filter((r) => r.owner === o); },
    async delete(o, c) { rows.delete(`${o} ${c}`); },
    async legacyGet() { return undefined; },
    async legacyList() { return []; },
    async legacyDelete() {},
    async lockedPut() {}, async lockedList() { return []; }, async lockedDelete() {},
  };
}

function stubLocalStorage() {
  const m = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  });
}

let communityCfg: EventConfig;
let eventCfg: EventConfig;
// Schnorr signing is randomized, so a proof is made once per (child) and reused.
const proofs = new Map<string, { a: string; by: string; sig: string }>();
const proofFor = (child = EVENT) => {
  if (!proofs.has(child)) {
    const p = makeMembershipProof(EVENT_SK, COMMUNITY, child, OWNER);
    proofs.set(child, { a: COMMUNITY, by: p.by, sig: p.sig });
  }
  return proofs.get(child)!;
};

beforeEach(() => {
  __resetPersistForTests();
  setActiveCacheOwner(OWNER);
  __setKeystoreBackend(memKeystore());
  setActiveOwner(OWNER);
  stubLocalStorage();
  communityCfg = cfg(COMM_EID, "btc", { children: [EVENT, EVENT_2] });
  eventCfg = cfg(EVENT_EID, "meetup-1", { parent: COMMUNITY });
  const relay = async (f: { authors?: string[] }) =>
    f.authors?.includes(COMM_EID) ? [configEvent(communityCfg)] : [configEvent(eventCfg)];
  fetchEvents.mockReset().mockImplementation(relay);
  fetchEventsRelayOnly.mockReset().mockImplementation(relay);
  sendJoinRequest.mockReset().mockResolvedValue(true);
  loadSelfCopy.mockReset().mockResolvedValue({ profile: { about: "hi", skills: ["rust"], looking_for: "", links: [] }, media: [] });
  loadEventContext.mockReset().mockImplementation(async (naddr: string) => {
    const { coordinate } = naddrToCoordinate(naddr);
    return {
      coordinate, naddr, title: coordinate === COMMUNITY ? "Bitcoin Community" : "Meetup",
      config: coordinate === COMMUNITY ? communityCfg : eventCfg, summary: "", hashtags: [],
    };
  });
});
afterEach(() => {
  __setKeystoreBackend(null);
  setActiveOwner(null);
  vi.unstubAllGlobals();
});

describe("consent and proof persistence", () => {
  it("round-trips per child and keeps a different child's answer separate", () => {
    recordParentConsent(EVENT, { parent: COMMUNITY, consent: false, name: "Al" });
    recordParentConsent(EVENT_2, { parent: COMMUNITY, consent: true });
    expect(loadParentConsent(EVENT)).toEqual({ parent: COMMUNITY, consent: false, name: "Al" });
    expect(loadParentConsent(EVENT_2)?.consent).toBe(true);
    expect(loadParentConsent(makeCoordinate(EVENT_EID, "never"))).toBeUndefined();
  });

  it("belongs to the identity: another account on the same device sees nothing", () => {
    storeParentProof(EVENT, proofFor());
    recordParentConsent(EVENT, { parent: COMMUNITY, consent: true });
    setActiveCacheOwner(getPublicKey(generateSecretKey()));
    expect(loadParentProof(EVENT)).toBeUndefined();
    expect(loadParentConsent(EVENT)).toBeUndefined();
    expect(proofChildren()).toEqual([]);
  });

  it("indexes children with a proof, once each", () => {
    storeParentProof(EVENT, proofFor());
    storeParentProof(EVENT_2, proofFor(EVENT_2));
    storeParentProof(EVENT, proofFor());
    expect(proofChildren()).toEqual([EVENT_2, EVENT]);
  });

  it("'Not now' keeps the proof and the earlier answer, and only stops the nagging", () => {
    storeParentProof(EVENT, proofFor());
    dismissCommunityOffer(EVENT);
    expect(loadParentProof(EVENT)).toBeDefined();
    expect(loadParentConsent(EVENT)).toMatchObject({ parent: COMMUNITY, dismissed: true });
  });
});

describe("evaluateCommunityOffer", () => {
  it("offers (never joins) when a proof exists and nobody asked", async () => {
    storeParentProof(EVENT, proofFor());
    expect((await evaluateCommunityOffer(EVENT)).decision).toBe("offer");
  });

  it("joins on consent, but ignores a consent given for a different community", async () => {
    storeParentProof(EVENT, proofFor());
    recordParentConsent(EVENT, { parent: COMMUNITY, consent: true });
    expect((await evaluateCommunityOffer(EVENT)).decision).toBe("join");
    const stray = makeCoordinate(COMM_EID, "other", KIND_COMMUNITY);
    recordParentConsent(EVENT, { parent: stray, consent: true });
    expect((await evaluateCommunityOffer(EVENT)).decision).toBe("offer");
  });

  it("stays quiet after an explicit no, a 'not now', or with no proof at all", async () => {
    expect((await evaluateCommunityOffer(EVENT)).decision).toBe("none");
    storeParentProof(EVENT, proofFor());
    recordParentConsent(EVENT, { parent: COMMUNITY, consent: false });
    expect((await evaluateCommunityOffer(EVENT)).decision).toBe("none");
    recordParentConsent(EVENT_2, { parent: COMMUNITY, consent: false });
    storeParentProof(EVENT_2, proofFor(EVENT_2));
    expect((await evaluateCommunityOffer(EVENT_2)).decision).toBe("none");
  });

  it("does nothing for someone already in the community or already waiting on it", async () => {
    storeParentProof(EVENT, proofFor());
    recordParentConsent(EVENT, { parent: COMMUNITY, consent: true });
    markJoinSent(COMMUNITY);
    expect((await evaluateCommunityOffer(EVENT)).decision).toBe("none");
    localStorage.removeItem("nostrautica:join-sent");
    await saveEventKeys({ coordinate: COMMUNITY, role: "attendee", eck: [{ id: 1, key: "AAAA" }] }, OWNER);
    expect((await evaluateCommunityOffer(EVENT)).decision).toBe("none");
  });
});

describe("joinCommunityViaChild", () => {
  it("sends the member_of proof with the profile given to the event and the name from the form", async () => {
    storeParentProof(EVENT, proofFor());
    recordParentConsent(EVENT, { parent: COMMUNITY, consent: true, name: "Alice" });

    expect(await joinCommunityViaChild(signer, EVENT)).toBe(true);

    expect(sendJoinRequest).toHaveBeenCalledTimes(1);
    const [, ctx, input] = sendJoinRequest.mock.calls[0]!;
    expect(ctx.coordinate).toBe(COMMUNITY);
    expect(input.name).toBe("Alice");
    expect(input.profile.skills).toEqual(["rust"]);
    expect(input.memberOf).toEqual({ child: EVENT, by: proofFor().by, sig: proofFor().sig });
    // Marked pending, so the next scan does not send it again.
    expect((await evaluateCommunityOffer(EVENT)).decision).toBe("none");
    expect(await joinCommunityViaChild(signer, EVENT)).toBe(false);
    expect(sendJoinRequest).toHaveBeenCalledTimes(1);
  });

  it("falls back to the kind-0 name when the form's name was never recorded", async () => {
    storeParentProof(EVENT, proofFor());
    await joinCommunityViaChild(signer, EVENT);
    expect(sendJoinRequest.mock.calls[0]![2].name).toBe("From kind 0");
  });

  it("sends nothing when the link has since been withdrawn on either side", async () => {
    storeParentProof(EVENT, proofFor());
    communityCfg = cfg(COMM_EID, "btc", { children: [] });
    expect(await joinCommunityViaChild(signer, EVENT)).toBe(false);
    communityCfg = cfg(COMM_EID, "btc", { children: [EVENT] });
    eventCfg = cfg(EVENT_EID, "meetup-1", {});
    expect(await joinCommunityViaChild(signer, EVENT)).toBe(false);
    expect(sendJoinRequest).not.toHaveBeenCalled();
  });
});

describe("autoJoinCommunities", () => {
  it("joins only the events whose join form said yes", async () => {
    storeParentProof(EVENT, proofFor());
    recordParentConsent(EVENT, { parent: COMMUNITY, consent: true, name: "A" });
    storeParentProof(EVENT_2, proofFor(EVENT_2));
    recordParentConsent(EVENT_2, { parent: COMMUNITY, consent: false });
    const joined = await autoJoinCommunities(signer, [EVENT, EVENT_2]);
    expect(joined).toEqual([COMMUNITY]);
    expect(sendJoinRequest).toHaveBeenCalledTimes(1);
  });

  it("never joins an event whose consent is unknown", async () => {
    storeParentProof(EVENT, proofFor());
    expect(await autoJoinCommunities(signer, [EVENT])).toEqual([]);
    expect(sendJoinRequest).not.toHaveBeenCalled();
  });

  it("swallows a failed send so it cannot fail the grant scan, and retries later", async () => {
    storeParentProof(EVENT, proofFor());
    recordParentConsent(EVENT, { parent: COMMUNITY, consent: true, name: "A" });
    sendJoinRequest.mockRejectedValueOnce(new Error("offline"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await autoJoinCommunities(signer, [EVENT])).toEqual([]);
    expect(await autoJoinCommunities(signer, [EVENT])).toEqual([COMMUNITY]);
  });
});
