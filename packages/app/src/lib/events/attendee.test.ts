/**
 * Grant authentication tests (spec §8, audit finding C2). Proves the PWA only
 * folds a received 21602 Key Grant / 21605 Organizer Grant into local custody
 * when it is cryptographically sealed by the event's real authority (E_id, or the
 * configured coordinator for key grants) — a grant forged by an arbitrary Nostr
 * key claiming to be that authority is rejected. Pure crypto, no relays.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools/pure";
import {
  makeCoordinate,
  bytesToHex,
  bytesToBase64,
  generateEck,
  KIND_EVENT_CONFIG,
  KIND_KEY_GRANT,
  KIND_ORGANIZER_GRANT,
  type EventConfig,
  type Rumor,
  type KeyGrantContent,
  type OrganizerGrantContent,
} from "@nostrautica/protocol";
import { LocalSigner } from "$lib/signer/local.js";
import { signerWrap, signerUnwrap } from "./giftwrap.js";
import { authenticateKeyGrant, authenticateOrganizerGrant, fetchMatches, cachedMatches, receiveGrants, MAX_GRANT_WRAPS } from "./attendee.js";
import { DEFAULT_RELAYS } from "$lib/nostr/relays.js";
import { startScanBudget, scanIncomplete, type ScanOutcome } from "./scan-budget.js";

// Cache-path setup (CACHING-PLAN §2.3): mock the relay stream so fetchMatches
// runs against a fixed 31605, and inject an in-memory keystore for the ECK.
import type { EventContext } from "./event-context.js";
import {
  __setKeystoreBackend,
  setActiveOwner,
  saveEventKeys,
  loadEventKeys,
  type KeystoreBackend,
} from "./keystore.js";
import {
  __setPersistBackend,
  __resetPersistForTests,
  setActiveCacheOwner,
  cacheGet,
  cacheSet,
  ANON,
  type CacheEntry,
  type PersistBackend,
} from "$lib/cache/persist.js";

const { streamEvents, fetchEvents, fetchEventsRelayOnly } = vi.hoisted(() => ({
  streamEvents: vi.fn(),
  fetchEvents: vi.fn(),
  fetchEventsRelayOnly: vi.fn(),
}));
vi.mock("$lib/nostr/stream.js", () => ({ streamEvents }));
vi.mock("$lib/nostr/ndk.js", () => ({ fetchEvents, fetchEventsRelayOnly }));

function memKeystore(): KeystoreBackend {
  const composite = new Map<string, { owner: string; coordinate: string } & Record<string, unknown>>();
  const locked = new Map<string, { owner: string; coordinate: string; ciphertext: string }>();
  return {
    async get(o, c) {
      return composite.get(`${o} ${c}`) as never;
    },
    async put(rec) {
      composite.set(`${rec.owner} ${rec.coordinate}`, rec as never);
    },
    async list(o) {
      return [...composite.values()].filter((r) => r.owner === o) as never;
    },
    async delete(o, c) {
      composite.delete(`${o} ${c}`);
    },
    async legacyGet() {
      return undefined;
    },
    async legacyList() {
      return [];
    },
    async legacyDelete() {},
    async lockedPut(rec) {
      locked.set(`${rec.owner} ${rec.coordinate}`, rec);
    },
    async lockedList(o) {
      return [...locked.values()].filter((r) => r.owner === o);
    },
    async lockedDelete(o, c) {
      locked.delete(`${o} ${c}`);
    },
  };
}

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

/** A minimal parsed 31600 config for the given E_id / inbox / coordinator. */
function makeConfig(
  eidPubkey: string,
  inbox: string,
  coordinator?: string,
): EventConfig {
  return {
    d: "cypherpunk-2026",
    eidPubkey,
    inbox,
    coordinator,
    relays: [],
    chatRelays: [],
    blossom: [],
    maxVideoSec: 90,
    maxTalkSec: 900,
    matching: "on",
    matchVisibility: "pair",
    approval: "manual",
    eck: 1,
    nostrContext: 0,
    lang: "en",
    talks: "off",
    chat: [],
  };
}

function fakeRumor(pubkey: string, kind: number, content: unknown): Rumor {
  return {
    id: "0".repeat(64),
    pubkey,
    created_at: 1_700_000_000,
    kind,
    tags: [],
    content: JSON.stringify(content),
  };
}

describe("C2 — authenticateKeyGrant (21602)", () => {
  const eidSk = generateSecretKey();
  const eid = getPublicKey(eidSk);
  const coordinator = getPublicKey(generateSecretKey());
  const inbox = getPublicKey(generateSecretKey());
  const coordinate = makeCoordinate(eid, "cypherpunk-2026");
  const config = makeConfig(eid, inbox, coordinator);

  const grant: KeyGrantContent = {
    v: 2,
    a: coordinate,
    role: "attendee",
    eck: [{ id: 1, key: bytesToBase64(generateEck()) }],
    granted_by: eid,
  };

  it("accepts a grant sealed by E_id", () => {
    expect(authenticateKeyGrant(fakeRumor(eid, KIND_KEY_GRANT, grant), grant, config)).toBe(true);
  });

  it("accepts a grant sealed by the configured coordinator", () => {
    const g = { ...grant, granted_by: coordinator };
    expect(authenticateKeyGrant(fakeRumor(coordinator, KIND_KEY_GRANT, g), g, config)).toBe(true);
  });

  it("rejects a grant sealed by an arbitrary Nostr key (forged authority)", () => {
    const attacker = getPublicKey(generateSecretKey());
    const g = { ...grant, granted_by: attacker };
    expect(authenticateKeyGrant(fakeRumor(attacker, KIND_KEY_GRANT, g), g, config)).toBe(false);
  });

  it("rejects a grant whose seal author claims to be E_id but is not", () => {
    const attacker = getPublicKey(generateSecretKey());
    // granted_by lies (says E_id) but the seal author is the attacker.
    expect(authenticateKeyGrant(fakeRumor(attacker, KIND_KEY_GRANT, grant), grant, config)).toBe(
      false,
    );
  });

  it("rejects when granted_by disagrees with the seal author", () => {
    const g = { ...grant, granted_by: coordinator };
    // Sealed by E_id (a legit authority) but claims the coordinator granted it.
    expect(authenticateKeyGrant(fakeRumor(eid, KIND_KEY_GRANT, g), g, config)).toBe(false);
  });

  it("rejects a stale coordinator no longer in the config", () => {
    const oldCoordinator = getPublicKey(generateSecretKey());
    const g = { ...grant, granted_by: oldCoordinator };
    expect(authenticateKeyGrant(fakeRumor(oldCoordinator, KIND_KEY_GRANT, g), g, config)).toBe(
      false,
    );
  });

  it("rejects when the event config is unavailable", () => {
    expect(authenticateKeyGrant(fakeRumor(eid, KIND_KEY_GRANT, grant), grant, undefined)).toBe(
      false,
    );
  });

  it("rejects a grant for a different event's coordinate", () => {
    const otherEid = getPublicKey(generateSecretKey());
    const g = { ...grant, a: makeCoordinate(otherEid, "other-event") };
    // config still describes our event; seal author is our E_id, but the
    // coordinate names a foreign E_id, so the authority no longer matches.
    expect(authenticateKeyGrant(fakeRumor(eid, KIND_KEY_GRANT, g), g, config)).toBe(false);
  });
});

describe("C2 — authenticateOrganizerGrant (21605)", () => {
  const eidSk = generateSecretKey();
  const eid = getPublicKey(eidSk);
  const einboxSk = generateSecretKey();
  const inbox = getPublicKey(einboxSk);
  const coordinate = makeCoordinate(eid, "cypherpunk-2026");
  const config = makeConfig(eid, inbox);

  const grant: OrganizerGrantContent = {
    v: 2,
    a: coordinate,
    eid_nsec: bytesToHex(eidSk),
    einbox_nsec: bytesToHex(einboxSk),
    eck: [{ id: 1, key: bytesToBase64(generateEck()) }],
    config_relays: [],
    granted_by: eid,
  };

  it("accepts a genuine organizer grant sealed by E_id", () => {
    expect(
      authenticateOrganizerGrant(fakeRumor(eid, KIND_ORGANIZER_GRANT, grant), grant, config),
    ).toBe(true);
  });

  it("accepts even without the config (E_id authority + eid_nsec derivation)", () => {
    expect(
      authenticateOrganizerGrant(fakeRumor(eid, KIND_ORGANIZER_GRANT, grant), grant, undefined),
    ).toBe(true);
  });

  it("rejects a grant sealed by an arbitrary Nostr key claiming to be E_id", () => {
    const attacker = getPublicKey(generateSecretKey());
    // Attacker fabricates a grant for our coordinate but can only seal as itself.
    expect(
      authenticateOrganizerGrant(fakeRumor(attacker, KIND_ORGANIZER_GRANT, grant), grant, config),
    ).toBe(false);
  });

  it("rejects when granted_by disagrees with the seal author", () => {
    const g = { ...grant, granted_by: getPublicKey(generateSecretKey()) };
    expect(
      authenticateOrganizerGrant(fakeRumor(eid, KIND_ORGANIZER_GRANT, g), g, config),
    ).toBe(false);
  });

  it("rejects when eid_nsec does not derive the coordinate's E_id", () => {
    const g = { ...grant, eid_nsec: bytesToHex(generateSecretKey()) };
    expect(
      authenticateOrganizerGrant(fakeRumor(eid, KIND_ORGANIZER_GRANT, g), g, config),
    ).toBe(false);
  });

  it("rejects when einbox_nsec does not derive the declared inbox", () => {
    const g = { ...grant, einbox_nsec: bytesToHex(generateSecretKey()) };
    expect(
      authenticateOrganizerGrant(fakeRumor(eid, KIND_ORGANIZER_GRANT, g), g, config),
    ).toBe(false);
  });
});

describe("C2 — end-to-end unwrap + authenticate (no relays)", () => {
  it("genuine E_id grant survives unwrap+auth; forged one is rejected", async () => {
    // The event authority is E_id; a co-organizer knows the E_id secret and seals
    // the grant as E_id. We model E_id itself sealing the grant here.
    const eidSk = generateSecretKey();
    const eid = getPublicKey(eidSk);
    const einboxSk = generateSecretKey();
    const inbox = getPublicKey(einboxSk);
    const coordinate = makeCoordinate(eid, "cypherpunk-2026");
    const config = makeConfig(eid, inbox);
    const attendee = LocalSigner.generate();
    const attendeePk = await attendee.getPublicKey();

    // E_id (the authority) seals a real organizer grant to the recipient.
    const eidSigner = new LocalSigner(eidSk);
    const goodGrant: OrganizerGrantContent = {
      v: 2,
      a: coordinate,
      eid_nsec: bytesToHex(eidSk),
      einbox_nsec: bytesToHex(einboxSk),
      eck: [{ id: 1, key: bytesToBase64(generateEck()) }],
      config_relays: [],
      granted_by: eid,
    };
    const goodWrap = await signerWrap(eidSigner, attendeePk, {
      kind: KIND_ORGANIZER_GRANT,
      content: goodGrant,
    });
    const goodRumor = await signerUnwrap(attendee, goodWrap);
    expect(
      authenticateOrganizerGrant(goodRumor, goodGrant, config),
    ).toBe(true);

    // An attacker seals a grant that claims to be from E_id but is sealed by the
    // attacker's own key. signerUnwrap binds the rumor author to the real seal
    // author, so the claim can't stick.
    const attackerSigner = LocalSigner.generate();
    const forged: OrganizerGrantContent = { ...goodGrant, granted_by: eid };
    const forgedWrap = await signerWrap(attackerSigner, attendeePk, {
      kind: KIND_ORGANIZER_GRANT,
      content: forged,
    });
    const forgedRumor = await signerUnwrap(attendee, forgedWrap);
    expect(forgedRumor.pubkey).toBe(await attackerSigner.getPublicKey());
    expect(
      authenticateOrganizerGrant(forgedRumor, forged, config),
    ).toBe(false);
  });
});

describe("fetchMatches cache write-through (§2.3)", () => {
  const OWNER = "1".repeat(64);
  const COORDINATOR = "9".repeat(64);
  const PEER = "7".repeat(64);
  const EID2 = "e".repeat(64);
  const coordinate = `31923:${EID2}:ev`;
  const ctx = {
    coordinate,
    config: { coordinator: COORDINATOR, relays: [] },
  } as unknown as EventContext;

  const signer = {
    getPublicKey: async () => OWNER,
    nip44Decrypt: async () =>
      JSON.stringify({
        v: 2,
        computed_at: 500,
        matches: [
          { pubkey: PEER, score: 0.9, similarity: 0.8, complementarity: 0.7, reasoning: "good" },
        ],
      }),
  } as never;

  beforeEach(async () => {
    __resetPersistForTests();
    __setPersistBackend(memPersist());
    __setKeystoreBackend(memKeystore());
    setActiveOwner(OWNER);
    setActiveCacheOwner(OWNER);
    await saveEventKeys({ coordinate, role: "attendee", eck: [{ id: 1, key: bytesToBase64(generateEck()) }] });
    streamEvents.mockReset();
  });

  it("persists the decrypted match list owner-scoped for instant repaint", async () => {
    streamEvents.mockReturnValue({
      // Authored by the configured coordinator (record-authority pinning, NIP §3.7).
      ready: Promise.resolve([{ pubkey: COORDINATOR, content: "ct", created_at: 500, tags: [] }]),
      stop: () => {},
    });
    expect(cachedMatches(coordinate)).toBeUndefined();

    const list = await fetchMatches(signer, ctx);
    expect(list?.matches[0].pubkey).toBe(PEER);
    expect(cachedMatches(coordinate)?.matches[0].pubkey).toBe(PEER);

    // Owner-scoped: another identity can't read this match list.
    setActiveCacheOwner("2".repeat(64));
    expect(cachedMatches(coordinate)).toBeUndefined();
  });
});

describe("APPK-5 — grant memoization + config relay set", () => {
  const eidSk = generateSecretKey();
  const eid = getPublicKey(eidSk);
  const coordSk = generateSecretKey();
  const coordinator = getPublicKey(coordSk);
  const inbox = getPublicKey(generateSecretKey());
  const coordinate = makeCoordinate(eid, "cypherpunk-2026");
  const attendee = LocalSigner.generate();
  let attendeePk: string;

  /** A real, validly-signed 31600 for the event (latest-wins candidate). */
  function signedConfig(at = 1_700_000_000) {
    return finalizeEvent(
      {
        kind: KIND_EVENT_CONFIG,
        created_at: at,
        tags: [
          ["d", "cypherpunk-2026"],
          ["v", "2"],
          ["inbox", inbox],
          ["coordinator", coordinator, "1"],
        ],
        content: "",
      },
      eidSk,
    );
  }

  /** A genuine 21602 key grant gift-wrapped to the attendee by the coordinator. */
  async function keyGrantWrap(eckId = 1) {
    const grant: KeyGrantContent = {
      v: 2,
      a: coordinate,
      role: "attendee",
      eck: [{ id: eckId, key: bytesToBase64(generateEck()) }],
      granted_by: coordinator,
    };
    return signerWrap(new LocalSigner(coordSk), attendeePk, {
      kind: KIND_KEY_GRANT,
      content: grant,
    });
  }

  const memoHas = (wrapId: string) =>
    cacheGet<Record<string, true>>("grantwraps")?.data?.[wrapId] === true;

  beforeEach(async () => {
    attendeePk = await attendee.getPublicKey();
    __resetPersistForTests();
    __setPersistBackend(memPersist());
    __setKeystoreBackend(memKeystore());
    setActiveOwner(attendeePk);
    setActiveCacheOwner(attendeePk);
    fetchEvents.mockReset();
    fetchEventsRelayOnly.mockReset();
  });

  it("config-unavailable grant is NOT memoized — it authenticates on a later scan", async () => {
    const wrap = await keyGrantWrap();
    fetchEventsRelayOnly.mockResolvedValue([wrap]);
    fetchEvents.mockResolvedValue([]); // the 31600 is nowhere fetchable yet

    // Scan 1: the grant can't be authenticated without the config…
    expect(await receiveGrants(attendee)).toEqual([]);
    expect(await loadEventKeys(coordinate)).toBeUndefined();
    // …and crucially the wrap is NOT memoized, so the next scan retries it.
    expect(memoHas(wrap.id)).toBe(false);

    // The 31600 becomes fetchable; scan 2 authenticates the same wrap.
    fetchEvents.mockResolvedValue([signedConfig()]);
    expect(await receiveGrants(attendee)).toEqual([coordinate]);
    expect((await loadEventKeys(coordinate))?.eck.map((v) => v.id)).toEqual([1]);
    expect(memoHas(wrap.id)).toBe(true);
  });

  it("a forged grant WITH a fetchable config is a definitive negative — memoized", async () => {
    // Sealed by an arbitrary attacker key but claiming granted_by = coordinator.
    const attacker = LocalSigner.generate();
    const forged: KeyGrantContent = {
      v: 2,
      a: coordinate,
      role: "attendee",
      eck: [{ id: 1, key: bytesToBase64(generateEck()) }],
      granted_by: coordinator,
    };
    const wrap = await signerWrap(attacker, attendeePk, {
      kind: KIND_KEY_GRANT,
      content: forged,
    });
    fetchEventsRelayOnly.mockResolvedValue([wrap]);
    fetchEvents.mockResolvedValue([signedConfig()]);

    expect(await receiveGrants(attendee)).toEqual([]);
    expect(await loadEventKeys(coordinate)).toBeUndefined();
    // Definitively rejected WITH a config in hand: never retried, never prompts
    // the signer for this wrap again.
    expect(memoHas(wrap.id)).toBe(true);
  });

  it("does not latch the full-history backfill when EVERY unwrap failed", async () => {
    // The 2026-07-28 shape: a remote signer (Amber) that answers `get_public_key`
    // but can't complete the nip44_decrypt round trips. Every unwrap fails, so the
    // scan finds nothing — but that is a transport outage, not an empty inbox.
    // Latching the marker here narrows every later scan to giftwrapSince()
    // (now − 3 days), permanently hiding an ECK grant from an event joined a month
    // ago on this device.
    // vitest runs this package under `environment: "node"`, where the
    // backfill marker's localStorage doesn't exist and every read/write is
    // swallowed — so the marker has to be given somewhere real to live before
    // this behaviour is observable at all.
    const store = new Map<string, string>();
    const priorStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      },
    });
    try {
    const wrap = await keyGrantWrap();
    fetchEventsRelayOnly.mockResolvedValue([wrap]);
    fetchEvents.mockResolvedValue([signedConfig()]);
    const deaf = {
      method: "nip46" as const,
      getPublicKey: async () => attendeePk,
      signEvent: attendee.signEvent.bind(attendee),
      nip44Encrypt: async () => {
        throw new Error("signer unreachable");
      },
      nip44Decrypt: async () => {
        throw new Error("signer unreachable");
      },
    };

    expect(await receiveGrants(deaf)).toEqual([]);
    expect((fetchEventsRelayOnly.mock.calls[0]![0] as { since: number }).since).toBe(0);
    // Pre-fix this latched anyway and scan 2 would have used `now − 3 days`,
    // never seeing this (older) wrap again. The marker stayed unset, so the
    // retry is still a FULL-history scan and the grant is found.
    expect(await receiveGrants(attendee)).toEqual([coordinate]);
    expect((fetchEventsRelayOnly.mock.calls[1]![0] as { since: number }).since).toBe(0);
    // Only the pass that actually read a wrap latches it.
    await receiveGrants(attendee);
    expect((fetchEventsRelayOnly.mock.calls[2]![0] as { since: number }).since).toBeGreaterThan(0);
    } finally {
      if (priorStorage) Object.defineProperty(globalThis, "localStorage", priorStorage);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  it("stops unwrapping when the shared budget runs out, and says so", async () => {
    // The 2026-07-28 prompt storm: every un-memoized wrap costs TWO NIP-46
    // round trips, and this loop had no cap at all — a mailbox with hundreds of
    // wraps queued hundreds of Amber dialogs with no progress UI and no way out.
    const wraps = [await keyGrantWrap(1), await keyGrantWrap(2), await keyGrantWrap(3)];
    fetchEventsRelayOnly.mockResolvedValue(wraps);
    fetchEvents.mockResolvedValue([signedConfig()]);

    let unwraps = 0;
    const counted = {
      method: "nip46" as const,
      getPublicKey: async () => attendeePk,
      signEvent: attendee.signEvent.bind(attendee),
      nip44Encrypt: attendee.nip44Encrypt.bind(attendee),
      nip44Decrypt: async (pk: string, ct: string) => {
        unwraps++;
        return attendee.nip44Decrypt(pk, ct);
      },
    };

    const outcomes: ScanOutcome[] = [];
    // One wrap's worth of allowance (a wrap is two decrypts: wrap → seal → rumor).
    const budget = startScanBudget({ maxCalls: 1, now: () => 0 });
    await receiveGrants(counted, { budget, onOutcome: (o) => outcomes.push(o) });

    expect(unwraps).toBe(2); // exactly one wrap walked, not three
    expect(outcomes[0]).toMatchObject({ attempted: 1, succeeded: 1, truncated: true });
    expect(scanIncomplete(outcomes[0]!)).toBe(true);
  });

  it("a truncated full-history pass does not latch the backfill marker", async () => {
    // A pass that ran out of budget saw only part of the history. Latching would
    // narrow every later scan to giftwrapSince() and permanently hide the wraps
    // it never reached — the same trap as the all-unwraps-failed case above.
    const store = new Map<string, string>();
    const priorStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      },
    });
    try {
      fetchEventsRelayOnly.mockResolvedValue([await keyGrantWrap(1), await keyGrantWrap(2)]);
      fetchEvents.mockResolvedValue([signedConfig()]);

      await receiveGrants(attendee, { budget: startScanBudget({ maxCalls: 1, now: () => 0 }) });
      expect((fetchEventsRelayOnly.mock.calls[0]![0] as { since: number }).since).toBe(0);
      // Still a FULL-history scan next time: the marker stayed unset.
      await receiveGrants(attendee);
      expect((fetchEventsRelayOnly.mock.calls[1]![0] as { since: number }).since).toBe(0);
    } finally {
      if (priorStorage) Object.defineProperty(globalThis, "localStorage", priorStorage);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  it("reports a pass where the signer answered nothing as incomplete", async () => {
    // Resolving with `[]` here is exactly what "you have no events" looks like.
    // The outcome is the only thing that can tell the two apart.
    fetchEventsRelayOnly.mockResolvedValue([await keyGrantWrap()]);
    fetchEvents.mockResolvedValue([signedConfig()]);
    const deaf = {
      method: "nip46" as const,
      getPublicKey: async () => attendeePk,
      signEvent: attendee.signEvent.bind(attendee),
      nip44Encrypt: async () => {
        throw new Error("signer unreachable");
      },
      nip44Decrypt: async () => {
        throw new Error("signer unreachable");
      },
    };

    const outcomes: ScanOutcome[] = [];
    expect(await receiveGrants(deaf, { onOutcome: (o) => outcomes.push(o) })).toEqual([]);
    expect(outcomes[0]).toMatchObject({ attempted: 1, succeeded: 0, truncated: false });
    expect(scanIncomplete(outcomes[0]!)).toBe(true);
  });

  it("bounds the persisted grant memo, evicting oldest-inserted entries (App-7)", async () => {
    // Seed the memo above the cap with synthetic, insertion-ordered old entries.
    const seeded: Record<string, true> = {};
    for (let i = 0; i < MAX_GRANT_WRAPS + 50; i++) seeded[`old${i}`] = true;
    cacheSet("grantwraps", seeded, 1); // owner-scoped to the active owner (attendeePk)

    // A fresh non-grant wrap that unwraps successfully gets memoized (line ~323),
    // making the write dirty and triggering the cap.
    const other = await signerWrap(new LocalSigner(coordSk), attendeePk, {
      kind: 14,
      content: { hello: "world" },
    });
    fetchEventsRelayOnly.mockResolvedValue([other]);
    fetchEvents.mockResolvedValue([]);

    await receiveGrants(attendee);

    const memo = cacheGet<Record<string, true>>("grantwraps")!.data;
    const keys = Object.keys(memo);
    expect(keys.length).toBe(MAX_GRANT_WRAPS); // pre-fix: MAX_GRANT_WRAPS + 51 (unbounded)
    expect(memo[other.id]).toBe(true); // newest entry retained
    expect(memo["old0"]).toBeUndefined(); // oldest-inserted evicted
    expect(memo[`old${MAX_GRANT_WRAPS + 49}`]).toBe(true); // recent-old retained
  });

  it("fetches the config from the event's recorded relay hints ∪ defaults (custom-relay event)", async () => {
    // The event lives on a custom relay; a prior context load recorded the hint.
    cacheSet(`relayhints:${coordinate}`, ["wss://custom-relay.example"], 1, ANON);
    const wrap = await keyGrantWrap(2);
    fetchEventsRelayOnly.mockResolvedValue([wrap]);
    fetchEvents.mockResolvedValue([signedConfig()]);

    expect(await receiveGrants(attendee)).toEqual([coordinate]);
    expect((await loadEventKeys(coordinate))?.eck.map((v) => v.id)).toEqual([2]);

    // The config fetch targeted the event's own relay ∪ the app defaults.
    const relays = fetchEvents.mock.calls[0]![1] as string[];
    expect(relays).toEqual(expect.arrayContaining(["wss://custom-relay.example", ...DEFAULT_RELAYS]));
  });
});
