/**
 * Membership derived from the NETWORK rather than from this device (audit E9).
 *
 * The failure these cover: an attendee's ECK exists on the wire in exactly one
 * place (the one-shot 21602 gift wrap at approval), so once that wrap is gone
 * the event is both unrecoverable AND invisible — Home renders "Nothing here
 * yet", which is indistinguishable from never having joined. The 31602 self-copy
 * every join publishes is a second, permanent record of the SAME membership, and
 * enumerating it by author answers "what did I join?" with no time window and on
 * any device holding the nsec.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import {
  KIND_MY_PROFILE,
  KIND_COMMUNITY,
  makeCoordinate,
  bytesToBase64,
  generateEck,
} from "@nostrautica/protocol";

const { fetchEventsRelayOnly } = vi.hoisted(() => ({ fetchEventsRelayOnly: vi.fn() }));
vi.mock("$lib/nostr/ndk.js", () => ({ fetchEventsRelayOnly, fetchEvents: vi.fn() }));

import { LocalSigner } from "$lib/signer/local.js";
import type { AppSigner } from "$lib/signer/types.js";
import { discoverJoinedSpaces, awaitingKey } from "./membership.js";
import { startScanBudget, type ScanOutcome } from "./scan-budget.js";
import type { EventKeys } from "./keystore.js";
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

const EVENT_COORD = makeCoordinate(getPublicKey(generateSecretKey()), "cypherpunk-2026");
const COMMUNITY_COORD = makeCoordinate(
  getPublicKey(generateSecretKey()),
  "standing-room",
  KIND_COMMUNITY,
);

let idSeq = 0;

/** A 31602 self-copy exactly as join.ts writes one: self-encrypted, `a` inside. */
async function selfCopy(
  signer: AppSigner,
  coordinate: string,
  createdAt: number,
): Promise<Record<string, unknown>> {
  const pubkey = await signer.getPublicKey();
  const content = await signer.nip44Encrypt(
    pubkey,
    JSON.stringify({ v: 2, a: coordinate, rev: 0, media: [] }),
  );
  return {
    id: `self-${++idSeq}`,
    kind: KIND_MY_PROFILE,
    pubkey,
    created_at: createdAt,
    // The real `d` is blinded and unguessable; nothing here may depend on it.
    tags: [["d", `blinded-${idSeq}`]],
    content,
  };
}

/** Wrap a signer so "how many signer round trips did this cost?" is assertable. */
function counted(inner: AppSigner): AppSigner & { decrypts: () => number } {
  let decrypts = 0;
  return {
    ...inner,
    method: inner.method,
    getPublicKey: () => inner.getPublicKey(),
    signEvent: (t) => inner.signEvent(t),
    nip44Encrypt: (pk, pt) => inner.nip44Encrypt(pk, pt),
    nip44Decrypt: (pk, ct) => {
      decrypts++;
      return inner.nip44Decrypt(pk, ct);
    },
    decrypts: () => decrypts,
  };
}

describe("discoverJoinedSpaces", () => {
  let signer: AppSigner;
  let owner: string;

  beforeEach(async () => {
    fetchEventsRelayOnly.mockReset();
    __resetPersistForTests();
    __setPersistBackend(memPersist());
    signer = LocalSigner.generate();
    owner = await signer.getPublicKey();
    setActiveCacheOwner(owner);
    idSeq = 0;
  });

  it("finds every space this identity ever asked to join, newest first", async () => {
    // The reported state: nothing in the key store, nothing in the list, and two
    // joins sitting on the relays that no existing scan would ever surface.
    fetchEventsRelayOnly.mockResolvedValue([
      await selfCopy(signer, EVENT_COORD, 1000),
      await selfCopy(signer, COMMUNITY_COORD, 2000),
    ]);

    const found = await discoverJoinedSpaces(signer);

    expect(found.map((f) => f.coordinate)).toEqual([COMMUNITY_COORD, EVENT_COORD]);
    expect(found[0]!.at).toBe(2000);
    // Both are "waiting for a key" because the key store is empty — which is the
    // whole point: this is exactly the device that used to show nothing at all.
    expect(awaitingKey(found, []).map((f) => f.coordinate)).toEqual([
      COMMUNITY_COORD,
      EVENT_COORD,
    ]);
  });

  it("reads the coordinate's own kind, so a community is discovered like an event", async () => {
    fetchEventsRelayOnly.mockResolvedValue([await selfCopy(signer, COMMUNITY_COORD, 500)]);
    const found = await discoverJoinedSpaces(signer);
    expect(found).toHaveLength(1);
    expect(found[0]!.coordinate.startsWith(`${KIND_COMMUNITY}:`)).toBe(true);
  });

  it("asks for a filter with no time window at all", async () => {
    // The 3-day gift-wrap window is the thing this scan exists to get around; a
    // `since` here would reintroduce the bug it is answering.
    fetchEventsRelayOnly.mockResolvedValue([]);
    await discoverJoinedSpaces(signer);
    const filter = fetchEventsRelayOnly.mock.calls[0]![0] as Record<string, unknown>;
    expect(filter).toEqual({ kinds: [KIND_MY_PROFILE], authors: [owner] });
  });

  it("memoizes what it decrypted, so a second pass costs no signer round trips", async () => {
    // A NIP-46 signer makes every decrypt a remote round trip (and possibly an
    // Amber dialog). A scan that re-reads every self-copy on every Home mount is
    // one nobody can afford to run.
    const spy = counted(signer);
    fetchEventsRelayOnly.mockResolvedValue([
      await selfCopy(signer, EVENT_COORD, 1000),
      await selfCopy(signer, COMMUNITY_COORD, 2000),
    ]);

    const first = await discoverJoinedSpaces(spy);
    expect(spy.decrypts()).toBe(2);

    const second = await discoverJoinedSpaces(spy);
    expect(spy.decrypts()).toBe(2); // nothing new was decrypted…
    // …and the answer is still complete, which is why the memo stores the
    // coordinate rather than a bare "seen" flag.
    expect(second.map((f) => f.coordinate).sort()).toEqual(
      first.map((f) => f.coordinate).sort(),
    );
  });

  it("retries a self-copy whose DECRYPT failed instead of writing it off", async () => {
    // An unreachable/unapproved remote signer fails every decrypt identically to
    // "this record isn't yours". Remembering that would teach the device to stop
    // asking — the same permanent blindness the grant-window latch caused.
    const real = signer;
    let fail = true;
    const flaky: AppSigner = {
      ...real,
      method: real.method,
      getPublicKey: () => real.getPublicKey(),
      signEvent: (t) => real.signEvent(t),
      nip44Encrypt: (pk, pt) => real.nip44Encrypt(pk, pt),
      nip44Decrypt: async (pk, ct) => {
        if (fail) throw new Error("signer not ready");
        return real.nip44Decrypt(pk, ct);
      },
    };
    fetchEventsRelayOnly.mockResolvedValue([await selfCopy(signer, EVENT_COORD, 1000)]);

    const outages: ScanOutcome[] = [];
    expect(await discoverJoinedSpaces(flaky, { onOutcome: (o) => outages.push(o) })).toEqual([]);
    // Attempted but never succeeded: `scanIncomplete` reads that as an outage,
    // not as an empty account.
    expect(outages[0]).toMatchObject({ attempted: 1, succeeded: 0 });

    fail = false;
    const found = await discoverJoinedSpaces(flaky);
    expect(found.map((f) => f.coordinate)).toEqual([EVENT_COORD]);
  });

  it("remembers a decrypted-but-unusable record as definitive", async () => {
    const spy = counted(signer);
    const pubkey = await signer.getPublicKey();
    const junk = {
      id: "self-junk",
      kind: KIND_MY_PROFILE,
      pubkey,
      created_at: 900,
      tags: [["d", "blinded-junk"]],
      content: await signer.nip44Encrypt(pubkey, JSON.stringify({ v: 2, rev: 0 })), // no `a`
    };
    fetchEventsRelayOnly.mockResolvedValue([junk]);

    expect(await discoverJoinedSpaces(spy)).toEqual([]);
    expect(spy.decrypts()).toBe(1);
    expect(await discoverJoinedSpaces(spy)).toEqual([]);
    expect(spy.decrypts()).toBe(1); // read once, never paid for again
  });

  it("ignores a record a relay returned that this identity did not author", async () => {
    const stranger = LocalSigner.generate();
    fetchEventsRelayOnly.mockResolvedValue([await selfCopy(stranger, EVENT_COORD, 1000)]);
    const spy = counted(signer);
    expect(await discoverJoinedSpaces(spy)).toEqual([]);
    expect(spy.decrypts()).toBe(0); // not even a wasted round trip
  });

  it("stops at the reserve rather than starving the scans that can recover a key", async () => {
    // Three claims in the pool, two of them reserved for `normal` work: this
    // scan may take exactly one, then must report itself truncated.
    const budget = startScanBudget({ maxCalls: 3, reserve: 2, now: () => 0 });
    const spy = counted(signer);
    fetchEventsRelayOnly.mockResolvedValue([
      await selfCopy(signer, EVENT_COORD, 3000),
      await selfCopy(signer, COMMUNITY_COORD, 2000),
      await selfCopy(signer, makeCoordinate(getPublicKey(generateSecretKey()), "third"), 1000),
    ]);

    const outcomes: ScanOutcome[] = [];
    const found = await discoverJoinedSpaces(spy, {
      budget,
      onOutcome: (o) => outcomes.push(o),
    });

    expect(spy.decrypts()).toBe(1);
    expect(outcomes[0]!.truncated).toBe(true);
    // Newest first, so the one claim it got was spent on the most recent join.
    expect(found.map((f) => f.coordinate)).toEqual([EVENT_COORD]);
    // And the reserve is intact for the scans that can actually restore custody.
    expect(budget.take()).toBe(true);
    expect(budget.take()).toBe(true);
  });
});

describe("awaitingKey", () => {
  const held = (coordinate: string, eck: EventKeys["eck"]): Pick<EventKeys, "coordinate" | "eck"> => ({
    coordinate,
    eck,
  });
  const realEck = [{ id: 1, key: bytesToBase64(generateEck()) }];
  const discovered = [
    { coordinate: EVENT_COORD, at: 2000 },
    { coordinate: COMMUNITY_COORD, at: 1000 },
  ];

  it("drops a space this device can already open", () => {
    expect(awaitingKey(discovered, [held(EVENT_COORD, realEck)])).toEqual([
      { coordinate: COMMUNITY_COORD, at: 1000 },
    ]);
  });

  it("keeps a space whose key-store record holds no ECK at all", () => {
    // "I know this event exists and cannot read one thing in it" is the state
    // being named, and a record with an empty ECK list is exactly that.
    expect(awaitingKey(discovered, [held(EVENT_COORD, [])])).toEqual(discovered);
  });

  it("keeps everything on a device with an empty key store", () => {
    expect(awaitingKey(discovered, [])).toEqual(discovered);
  });
});
