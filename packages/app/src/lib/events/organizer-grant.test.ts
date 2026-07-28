/**
 * The two halves of the co-organizer / second-device hand-off (spec §6.1, §13),
 * both of which failed in the same report on 2026-07-24.
 *
 * Device B — the organizer's second phone, logged in with Amber (NIP-46) — opened
 * Admin, was told it didn't hold the organizer keys, and never unlocked. Device A
 * had already added it and printed "Sent ✓". Reloading device B changed nothing;
 * navigating to Settings and back fixed it. Three defects composed into that:
 *
 *  - the wait returned before its first pass because the NIP-46 session restore
 *    (a bunker connect plus a getPublicKey round-trip, deliberately not awaited by
 *    the layout) hadn't produced a signer yet, and nothing ever restarted it;
 *  - the keystore is owner-scoped and resolves against the owner the session sets
 *    during that same restore, so a device that DID hold the keys read an empty
 *    store and showed the same "not the organizer" card;
 *  - the grant wrap went only to the event's own relays, while the receiving side
 *    (attendee.receiveGrants) reads DEFAULT_RELAYS.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { bytesToHex, makeCoordinate, KIND_DM_RELAY_LIST } from "@nostrautica/protocol";

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

import {
  addCoOrganizer,
  approveAttendee,
  checkForOrganizerGrant,
  fetchPending,
  pollForOrganizerGrant,
  sendAdminCommand,
} from "./organizer.js";
import {
  __setKeystoreBackend,
  setActiveOwner,
  saveEventKeys,
  type EventKeys,
  type KeystoreBackend,
  type LockedEventKeys,
} from "./keystore.js";
import { __setOutboxBackend, type QueuedItem } from "$lib/nostr/publish-queue.js";
import { DEFAULT_RELAYS } from "$lib/nostr/relays.js";
import type { EventContext } from "./event-context.js";
import type { AppSigner } from "$lib/signer/types.js";

const OWNER = "b".repeat(64);
const COORD = makeCoordinate("a".repeat(64), "conf-2026");

type Stored = EventKeys & { owner: string };

/** In-memory keystore, with a one-shot read failure hook for the guard test. */
function memKeystore() {
  const rows = new Map<string, Stored>();
  const locked = new Map<string, LockedEventKeys>();
  const k = (o: string, c: string) => `${o} ${c}`;
  const state = { failNextGet: false };
  const backend: KeystoreBackend = {
    async get(o, c) {
      if (state.failNextGet) {
        state.failNextGet = false;
        throw new Error("storage hiccup");
      }
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
  return { backend, state };
}

function organizerKeys(): EventKeys {
  return {
    coordinate: COORD,
    role: "organizer",
    eck: [{ id: 1, key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }],
    eidNsecHex: bytesToHex(generateSecretKey()),
    einboxNsecHex: bytesToHex(generateSecretKey()),
  };
}

let store: ReturnType<typeof memKeystore>;

beforeEach(() => {
  store = memKeystore();
  __setKeystoreBackend(store.backend);
  setActiveOwner(OWNER);
  fetchEvents.mockReset();
  fetchEventsRelayOnly.mockReset().mockResolvedValue([]);
  publishSigned.mockReset();
});

afterEach(() => {
  __setKeystoreBackend(null);
  setActiveOwner(null);
  __setOutboxBackend(null);
  vi.unstubAllGlobals();
});

describe("waiting for organizer custody (pollForOrganizerGrant)", () => {
  it("keeps waiting through signerless passes and scans grants once the signer lands", async () => {
    // The regression: the old poll opened with `if (!session.signer) return`, was
    // called once from onMount, and so ended before running a single pass on a
    // device whose NIP-46 restore was still in flight. session.npub painted a
    // second later, so the card looked healthy while nothing was polling at all.
    let signer: AppSigner | null = null;
    // The real receiveGrants folds an authenticated 21605 into local custody —
    // that write is what the next keystore read picks up.
    const receiveGrants = vi.fn(async () => {
      await saveEventKeys(organizerKeys(), OWNER);
      return [COORD];
    });
    const signerReadyPerPass: boolean[] = [];
    const granted: EventKeys[] = [];

    await pollForOrganizerGrant({
      coordinate: COORD,
      signer: () => signer,
      receiveGrants,
      stopped: () => false, // the wait ends by finding the keys, not by a flag
      onChecked: (signerReady) => {
        signerReadyPerPass.push(signerReady);
        // The bunker connect resolves mid-wait, exactly as it does on device B.
        if (signerReadyPerPass.length === 2) signer = {} as AppSigner;
      },
      onGranted: (keys) => void granted.push(keys),
      intervalMs: 0,
    });

    expect(signerReadyPerPass).toEqual([false, false, true]);
    expect(receiveGrants).toHaveBeenCalledTimes(1); // never called without a signer
    expect(granted).toHaveLength(1);
    expect(granted[0].role).toBe("organizer");
  });

  it("unlocks a device that already held the keys once the keystore owner is set", async () => {
    // loadEventKeys resolves against the ACTIVE owner, which the session sets
    // during the restore. A page that mounted first read an empty store and
    // showed "you don't hold the organizer keys" on a device that does — and a
    // reload just replayed the race. Re-reading the keystore every pass (rather
    // than only after a grant scan) is what repairs this.
    await saveEventKeys(organizerKeys(), OWNER);
    setActiveOwner(null);
    const receiveGrants = vi.fn(async () => []);
    const granted: EventKeys[] = [];
    let passes = 0;

    await pollForOrganizerGrant({
      coordinate: COORD,
      signer: () => null, // never a signer: no grant scan is possible at all
      receiveGrants,
      stopped: () => false,
      onChecked: () => {
        if (++passes === 2) setActiveOwner(OWNER);
      },
      onGranted: (keys) => void granted.push(keys),
      intervalMs: 0,
    });

    expect(receiveGrants).not.toHaveBeenCalled();
    expect(granted).toHaveLength(1);
    expect(passes).toBe(3);
  });

  it("survives a failing pass instead of dying silently", async () => {
    // receiveGrants was .catch()-guarded but loadEventKeys was not, so one
    // rejected keystore read rejected the loop's promise — which both callers
    // `void` — and the wait was over for the rest of the page's life.
    const receiveGrants = vi
      .fn<() => Promise<string[]>>()
      .mockRejectedValueOnce(new Error("no relay reachable"))
      .mockImplementation(async () => {
        await saveEventKeys(organizerKeys(), OWNER);
        return [COORD];
      });
    const granted: EventKeys[] = [];
    let passes = 0;

    await pollForOrganizerGrant({
      coordinate: COORD,
      signer: () => ({}) as AppSigner,
      receiveGrants,
      stopped: () => false,
      onChecked: () => {
        // Pass 1 died in receiveGrants; make pass 2 die in the keystore read.
        if (++passes === 1) store.state.failNextGet = true;
      },
      onGranted: (keys) => void granted.push(keys),
      intervalMs: 0,
    });

    expect(passes).toBe(3);
    expect(granted).toHaveLength(1);
  });

  it("stops when the caller says so, without a final grant scan", async () => {
    const receiveGrants = vi.fn(async () => []);
    let passes = 0;
    await pollForOrganizerGrant({
      coordinate: COORD,
      signer: () => ({}) as AppSigner,
      receiveGrants,
      stopped: () => passes >= 2, // e.g. the page was destroyed
      onChecked: () => void passes++,
      onGranted: () => expect.unreachable("no grant was ever issued"),
      intervalMs: 0,
    });
    expect(passes).toBe(2);
  });
});

describe("checkForOrganizerGrant (the manual 'Check now' pass)", () => {
  it("holds out for organizer custody — an attendee ECK is not it", async () => {
    await saveEventKeys({ coordinate: COORD, role: "attendee", eck: [] }, OWNER);
    const found = await checkForOrganizerGrant(COORD, {} as AppSigner, async () => []);
    expect(found).toBeUndefined();
  });

  it("propagates a failure so the user who asked for the check hears about it", async () => {
    await expect(
      checkForOrganizerGrant(COORD, {} as AppSigner, async () => {
        throw new Error("bunker unreachable");
      }),
    ).rejects.toThrow("bunker unreachable");
  });
});

describe("addCoOrganizer publishes where the receiver actually reads", () => {
  const ctx = {
    coordinate: COORD,
    config: { relays: ["wss://relay.private.example"] },
  } as unknown as EventContext;
  const coOrganizer = getPublicKey(generateSecretKey());

  it("unions the event's relays with the app defaults", async () => {
    // The grant used to go only to ctx.config.relays while receiveGrants scans
    // DEFAULT_RELAYS, so for an event created with a custom relay set the wrap
    // landed exactly where the co-organizer's client never looks.
    vi.stubGlobal("navigator", { onLine: true });
    publishSigned.mockResolvedValue(undefined);
    await saveEventKeys(organizerKeys(), OWNER);

    const outcome = await addCoOrganizer({} as AppSigner, ctx, coOrganizer);

    expect(outcome).toBe("published");
    const relays = publishSigned.mock.calls[0][1] as string[];
    expect(relays).toContain("wss://relay.private.example");
    for (const url of DEFAULT_RELAYS) expect(relays).toContain(url);
  });

  it("includes the co-organizer's kind-10050 inbox", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    publishSigned.mockResolvedValue(undefined);
    fetchEvents.mockResolvedValue([{
      kind: KIND_DM_RELAY_LIST,
      pubkey: coOrganizer,
      created_at: 1,
      tags: [["relay", "wss://co-organizer-inbox.example"]],
    }]);
    await saveEventKeys(organizerKeys(), OWNER);

    await addCoOrganizer({} as AppSigner, ctx, coOrganizer);

    expect(publishSigned.mock.calls[0][1]).toContain("wss://co-organizer-inbox.example");
  });

  it("reports 'queued' — not 'Sent ✓' — when the wrap only reached the outbox", async () => {
    // Venue Wi-Fi routinely blocks WSS. addCoOrganizer discarded publishOrQueue's
    // boolean and the settings page set "Sent ✓" unconditionally, so the organizer
    // was told the hand-off had happened while the wrap sat in this device's
    // IndexedDB and the other device waited on it forever.
    vi.stubGlobal("navigator", { onLine: false });
    const queued: QueuedItem[] = [];
    __setOutboxBackend({
      async getAll() {
        return queued;
      },
      async put(item) {
        queued.push(item);
      },
      async delete() {},
    });
    await saveEventKeys(organizerKeys(), OWNER);

    const outcome = await addCoOrganizer({} as AppSigner, ctx, coOrganizer);

    expect(outcome).toBe("queued");
    expect(publishSigned).not.toHaveBeenCalled();
    expect(queued).toHaveLength(1); // durably held, not lost
  });

  it("refuses to pretend when this device holds no organizer custody", async () => {
    await expect(addCoOrganizer({} as AppSigner, ctx, coOrganizer)).rejects.toThrow(
      /organizer keys not available/,
    );
  });
});

describe("account-addressed organizer wraps", () => {
  const attendee = getPublicKey(generateSecretKey());
  const coordinator = getPublicKey(generateSecretKey());
  const ctx = {
    coordinate: COORD,
    config: {
      d: "conf-2026",
      eidPubkey: COORD.split(":")[1],
      inbox: getPublicKey(generateSecretKey()),
      coordinator,
      relays: ["wss://event-relay.example"],
    },
  } as unknown as EventContext;

  beforeEach(() => {
    vi.stubGlobal("navigator", { onLine: true });
    publishSigned.mockResolvedValue(undefined);
    fetchEvents.mockImplementation(async (filter: { authors?: string[] }) => [{
      kind: KIND_DM_RELAY_LIST,
      pubkey: filter.authors?.[0],
      created_at: 1,
      tags: [["relay", `wss://${filter.authors?.[0] === attendee ? "attendee" : "coordinator"}-inbox.example`]],
    }]);
  });

  it("routes an initial attendee ECK grant to the attendee inbox plus event/default relays", async () => {
    await saveEventKeys(organizerKeys(), OWNER);

    await approveAttendee({} as AppSigner, ctx, {
      attendeePubkey: attendee,
      name: "Attendee",
      message: "",
      rsvpPublic: false,
      rumorCreatedAt: 1,
    });

    const wrapCall = publishSigned.mock.calls.find(([event]) => event.kind === 1059)!;
    expect(wrapCall[1]).toContain("wss://attendee-inbox.example");
    expect(wrapCall[1]).toContain("wss://event-relay.example");
    for (const url of DEFAULT_RELAYS) expect(wrapCall[1]).toContain(url);
  });

  it("routes coordinator admin commands to the coordinator inbox", async () => {
    await saveEventKeys(organizerKeys(), OWNER);

    await sendAdminCommand(ctx, "recompute");

    expect(publishSigned).toHaveBeenCalledTimes(1);
    expect(publishSigned.mock.calls[0][1]).toContain("wss://coordinator-inbox.example");
    expect(publishSigned.mock.calls[0][1]).toContain("wss://event-relay.example");
  });

  it("keeps E_inbox scans exactly on the event relays", async () => {
    fetchEventsRelayOnly.mockResolvedValue([]);

    await fetchPending(ctx, organizerKeys());

    expect(fetchEventsRelayOnly).toHaveBeenCalledTimes(1);
    expect(fetchEventsRelayOnly.mock.calls[0][1]).toBe(ctx.config.relays);
  });
});
