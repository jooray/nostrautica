/**
 * The People tab's warm-up path: one relay read per roster/directory instead of
 * three or four, and a navigation that lands mid-warm adopting the warm's work
 * instead of starting its own.
 *
 * The reported symptom was "opening an event and tapping Ľudia takes too long,
 * even though there is already a prefetch". There was — it just paid for the
 * roster three times and the directory twice (`prefetchAttendeesTab` +
 * `prefetchEventContent` both fetch the directory, and `fetchDirectory` fetches
 * the roster itself), and none of that work was shared with the page's own
 * stream, so tapping People while the warm-up ran started the whole read again
 * from zero.
 *
 * The freshness half of this is tested just as hard as the speed half: sharing
 * is in-flight ONLY. The moment a read settles, the next call must go back to
 * the relays, or a roster change would sit behind a cache nobody revalidates.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools/pure";
import {
  makeCoordinate,
  bytesToBase64,
  generateEck,
  eckEncrypt,
  KIND_ROSTER,
  KIND_DIRECTORY_ENTRY,
  splitRoster,
  rosterPageD,
  type RosterContent,
  type EventConfig,
} from "@nostrautica/protocol";
import type { EventContext } from "./event-context.js";
import type { KeystoreBackend } from "./keystore.js";
import type { PersistBackend, CacheEntry } from "$lib/cache/persist.js";

const { streamEvents, fetchEvents, fetchEventsRelayOnly } = vi.hoisted(() => ({
  streamEvents: vi.fn(),
  fetchEvents: vi.fn(),
  fetchEventsRelayOnly: vi.fn(),
}));
vi.mock("$lib/nostr/stream.js", () => ({ streamEvents }));
vi.mock("$lib/nostr/ndk.js", () => ({ fetchEvents, fetchEventsRelayOnly }));

const { __setKeystoreBackend, setActiveOwner, saveEventKeys } = await import("./keystore.js");
const { __setPersistBackend, __resetPersistForTests, setActiveCacheOwner } = await import(
  "$lib/cache/persist.js"
);
const {
  fetchRoster,
  fetchDirectory,
  streamDirectory,
  cachedDirectory,
  __resetAttendeeInflightForTests,
} = await import("./attendee.js");

// ── Fixtures ─────────────────────────────────────────────────────────────────

const coordSk = generateSecretKey();
const coordinator = getPublicKey(coordSk);
const eid = getPublicKey(generateSecretKey());
const coordinate = makeCoordinate(eid, "warm-event");
const eck = generateEck();
const owner = getPublicKey(generateSecretKey());
const alice = getPublicKey(generateSecretKey());
const bob = getPublicKey(generateSecretKey());

const config = {
  d: "warm-event",
  eidPubkey: eid,
  inbox: getPublicKey(generateSecretKey()),
  coordinator,
  relays: ["wss://r"],
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
} as unknown as EventConfig;
const ctx = { coordinate, naddr: "naddr1warm", title: "Warm", config } as unknown as EventContext;

function rosterEvent(createdAt: number) {
  return finalizeEvent(
    {
      kind: KIND_ROSTER,
      created_at: createdAt,
      tags: [["d", "warm-event"]],
      content: eckEncrypt(
        eck,
        JSON.stringify({
          v: 2,
          eck_current: 1,
          attendees: [
            { pubkey: alice, d: "d-alice", role: "attendee" },
            { pubkey: bob, d: "d-bob", role: "attendee" },
          ],
        }),
      ),
    },
    coordSk,
  );
}

function entryEvent(pubkey: string, d: string, name: string, createdAt: number) {
  return finalizeEvent(
    {
      kind: KIND_DIRECTORY_ENTRY,
      created_at: createdAt,
      tags: [["d", d]],
      content: eckEncrypt(
        eck,
        JSON.stringify({
          v: 2,
          pubkey,
          name,
          profile: { about: "", skills: [], looking_for: "", links: [] },
          media: [],
          updated_at: createdAt,
        }),
      ),
    },
    coordSk,
  );
}

// ── Controllable relay ───────────────────────────────────────────────────────

interface FakeStream {
  kind: number;
  ds: string[];
  deliver: (events: unknown[]) => void;
  settle: (events?: unknown[]) => void;
}
let streams: FakeStream[] = [];
const ofKind = (k: number) => streams.filter((s) => s.kind === k);

function installRelay() {
  streams = [];
  streamEvents.mockImplementation((filters: never, opts: never) => {
    const f = filters as { kinds: number[]; "#d"?: string[] };
    const o = (opts ?? {}) as { onEvent?: (e: unknown) => void };
    let resolve!: (v: unknown[]) => void;
    const ready = new Promise<unknown[]>((r) => (resolve = r));
    const seen: unknown[] = [];
    const s: FakeStream = {
      kind: f.kinds[0],
      ds: f["#d"] ?? [],
      deliver(events) {
        for (const e of events) {
          seen.push(e);
          o.onEvent?.(e);
        }
      },
      settle(events) {
        if (events) s.deliver(events);
        resolve(seen);
      },
    };
    streams.push(s);
    return { ready, stop: () => resolve(seen) };
  });
}

function memKeystore(): KeystoreBackend {
  const composite = new Map<string, Record<string, unknown>>();
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
    async lockedPut() {},
    async lockedList() {
      return [];
    },
    async lockedDelete() {},
  } as KeystoreBackend;
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

const settleMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));
/** Past streamDirectory's 60 ms flush coalescing timer. */
const afterFlush = () => new Promise<void>((r) => setTimeout(r, 90));

beforeEach(async () => {
  installRelay();
  __resetAttendeeInflightForTests();
  __setKeystoreBackend(memKeystore());
  setActiveOwner(owner);
  __resetPersistForTests();
  __setPersistBackend(memPersist());
  setActiveCacheOwner(owner);
  await saveEventKeys({
    coordinate,
    role: "attendee",
    eck: [{ id: 1, key: bytesToBase64(eck) }],
  });
});

/**
 * A roster too big for one NIP-44 payload arrives as several 31604s
 * (PROTOCOL-NIP.md §6.2). The People screen reads page 0, learns the count, and
 * asks for the rest in one more REQ.
 */
describe("reading a paginated roster", () => {
  const pool: string[] = [];
  const member = (i: number) => (pool[i] ??= getPublicKey(generateSecretKey()));

  function paginated(n: number): RosterContent[] {
    return splitRoster({
      v: 2,
      eck_current: 1,
      attendees: Array.from({ length: n }, (_, i) => ({
        pubkey: member(i),
        d: (i + 0x1000).toString(16).padStart(32, "a"),
        role: "attendee" as const,
      })),
    });
  }

  function pageEvent(page: RosterContent, index: number, createdAt = 100) {
    return finalizeEvent(
      {
        kind: KIND_ROSTER,
        created_at: createdAt,
        tags: [["d", rosterPageD("warm-event", index)], ["a", coordinate]],
        content: eckEncrypt(eck, JSON.stringify(page)),
      },
      coordSk,
    );
  }

  it("reassembles every page into one member list", async () => {
    const pages = paginated(600);
    expect(pages.length).toBeGreaterThan(1);
    const promise = fetchRoster(ctx);
    await settleMicrotasks();

    // First REQ: page 0 alone, at the event's own d.
    expect(ofKind(KIND_ROSTER)).toHaveLength(1);
    expect(ofKind(KIND_ROSTER)[0].ds).toEqual(["warm-event"]);
    ofKind(KIND_ROSTER)[0].settle([pageEvent(pages[0]!, 0)]);
    await settleMicrotasks();

    // Second REQ: pages 1..N-1 together, not one round trip each.
    expect(ofKind(KIND_ROSTER)).toHaveLength(2);
    expect(ofKind(KIND_ROSTER)[1].ds).toEqual(
      pages.slice(1).map((_, i) => rosterPageD("warm-event", i + 1)),
    );
    ofKind(KIND_ROSTER)[1].settle(pages.slice(1).map((p, i) => pageEvent(p, i + 1)));

    const roster = await promise;
    expect(roster?.attendees).toHaveLength(600);
    expect(new Set(roster!.attendees.map((a) => a.pubkey)).size).toBe(600);
    expect(roster!.attendees[599]!.pubkey).toBe(member(599));
    // What consumers hold is an ordinary roster — pagination does not leak out.
    expect(roster!.pages).toBeUndefined();
  });

  it("answers 'no roster' rather than a truncated one when a page is missing", async () => {
    const pages = paginated(600);
    const promise = fetchRoster(ctx);
    await settleMicrotasks();
    ofKind(KIND_ROSTER)[0].settle([pageEvent(pages[0]!, 0)]);
    await settleMicrotasks();
    // Everything but the last page comes back.
    ofKind(KIND_ROSTER)[1].settle(pages.slice(1, -1).map((p, i) => pageEvent(p, i + 1)));

    // Not "the members on page 0" — that is a member list missing hundreds of
    // people presented as complete, which is the failure pagination must not have.
    expect(await promise).toBeUndefined();
  });

  it("ignores a page addressed to a different event, even from the same author", async () => {
    const pages = paginated(600);
    const promise = fetchRoster(ctx);
    await settleMicrotasks();
    ofKind(KIND_ROSTER)[0].settle([pageEvent(pages[0]!, 0)]);
    await settleMicrotasks();
    // `<d>:1` could be another space's own `d` under this coordinator. The page's
    // `a` tag is what tells the two apart.
    const impostor = finalizeEvent(
      {
        kind: KIND_ROSTER,
        created_at: 100,
        tags: [["d", rosterPageD("warm-event", 1)], ["a", makeCoordinate(eid, "warm-event:1")]],
        content: eckEncrypt(eck, JSON.stringify(pages[1])),
      },
      coordSk,
    );
    ofKind(KIND_ROSTER)[1].settle([impostor, ...pages.slice(2).map((p, i) => pageEvent(p, i + 2))]);

    expect(await promise).toBeUndefined();
  });

  it("a roster that fits still costs exactly one relay read", async () => {
    const promise = fetchRoster(ctx);
    await settleMicrotasks();
    ofKind(KIND_ROSTER)[0].settle([rosterEvent(100)]);
    expect((await promise)?.attendees).toHaveLength(2);
    expect(ofKind(KIND_ROSTER)).toHaveLength(1);
  });
});

describe("in-flight sharing of the roster read", () => {
  it("collapses concurrent fetchRoster calls into one relay read", async () => {
    const a = fetchRoster(ctx);
    const b = fetchRoster(ctx);
    await settleMicrotasks();
    expect(ofKind(KIND_ROSTER)).toHaveLength(1);
    ofKind(KIND_ROSTER)[0].settle([rosterEvent(100)]);
    expect((await a)?.attendees).toHaveLength(2);
    expect(await b).toEqual(await a);
  });

  it("goes back to the relays once the shared read has settled", async () => {
    // Freshness, not caching: the share window closes when the read does. A
    // roster that changes between two visits must still be seen — this is the
    // difference between deduping work and quietly pinning a stale roster.
    const first = fetchRoster(ctx);
    await settleMicrotasks();
    ofKind(KIND_ROSTER)[0].settle([rosterEvent(100)]);
    await first;

    void fetchRoster(ctx);
    await settleMicrotasks();
    expect(ofKind(KIND_ROSTER)).toHaveLength(2);
  });
});

describe("in-flight sharing of the directory read", () => {
  it("collapses the two event-open warmers into one directory read", async () => {
    // prefetchAttendeesTab and prefetchEventContent both land on fetchDirectory
    // for the same coordinate, back to back, on every event open.
    const a = fetchDirectory(ctx);
    const b = fetchDirectory(ctx);
    await settleMicrotasks();
    expect(ofKind(KIND_ROSTER)).toHaveLength(1);
    ofKind(KIND_ROSTER)[0].settle([rosterEvent(100)]);
    await settleMicrotasks();
    expect(ofKind(KIND_DIRECTORY_ENTRY)).toHaveLength(1);
    ofKind(KIND_DIRECTORY_ENTRY)[0].settle([
      entryEvent(alice, "d-alice", "Alice", 200),
      entryEvent(bob, "d-bob", "Bob", 200),
    ]);
    expect((await a).map((e) => e.name).sort()).toEqual(["Alice", "Bob"]);
    expect(await b).toEqual(await a);
  });

  it("caches the decrypted entries under the key the People page reads", async () => {
    const p = fetchDirectory(ctx);
    await settleMicrotasks();
    ofKind(KIND_ROSTER)[0].settle([rosterEvent(100)]);
    await settleMicrotasks();
    ofKind(KIND_DIRECTORY_ENTRY)[0].settle([entryEvent(alice, "d-alice", "Alice", 200)]);
    await p;
    expect(cachedDirectory(coordinate)?.map((e) => e.name)).toEqual(["Alice"]);
  });
});

describe("streamDirectory adopting an in-flight warm", () => {
  /**
   * Warm up to the point where its ENTRY read is open but unanswered. Wrapped in
   * an object because `return warm` from an async function would AWAIT the warm,
   * which is exactly the state this helper exists to avoid reaching.
   */
  async function warmToEntryRead(): Promise<{ warm: Promise<unknown> }> {
    const warm = fetchDirectory(ctx);
    await settleMicrotasks();
    ofKind(KIND_ROSTER)[0].settle([rosterEvent(100)]);
    await settleMicrotasks();
    return { warm };
  }

  it("paints the warm's entries without waiting for its own round-trip", async () => {
    const { warm } = await warmToEntryRead();
    const paints: string[][] = [];
    await streamDirectory(ctx, (list) => paints.push(list.map((e) => e.name ?? "")));
    await settleMicrotasks();
    // The page opened its own entry stream and nothing has answered it.
    expect(paints).toHaveLength(0);

    // The warm's read lands. Its entries are already decrypted.
    ofKind(KIND_DIRECTORY_ENTRY)[0].settle([
      entryEvent(alice, "d-alice", "Alice", 200),
      entryEvent(bob, "d-bob", "Bob", 200),
    ]);
    await warm;
    await afterFlush();
    expect(paints.at(-1)?.sort()).toEqual(["Alice", "Bob"]);
  });

  it("lets a real event from its own stream supersede an adopted entry", async () => {
    // Ordering matters: an adopted entry is a snapshot with no source event, so
    // it must lose to anything the live stream delivers — otherwise a rename
    // that arrives one round-trip later would never reach the screen.
    const { warm } = await warmToEntryRead();
    const paints: string[][] = [];
    await streamDirectory(ctx, (list) => paints.push(list.map((e) => e.name ?? "")));
    await settleMicrotasks();
    const pageStream = ofKind(KIND_DIRECTORY_ENTRY)[1];

    ofKind(KIND_DIRECTORY_ENTRY)[0].settle([entryEvent(alice, "d-alice", "Alice", 200)]);
    await warm;
    await afterFlush();
    expect(paints.at(-1)).toEqual(["Alice"]);

    pageStream.deliver([entryEvent(alice, "d-alice", "Alice Renamed", 300)]);
    await afterFlush();
    expect(paints.at(-1)).toEqual(["Alice Renamed"]);
  });

  it("still revalidates: adopting a warm does not cancel the page's own read", async () => {
    const { warm } = await warmToEntryRead();
    await streamDirectory(ctx, () => {});
    await settleMicrotasks();
    ofKind(KIND_DIRECTORY_ENTRY)[0].settle([entryEvent(alice, "d-alice", "Alice", 200)]);
    await warm;
    await afterFlush();
    // Two entry reads are open: the warm's (settled) and the page's live one.
    // The adopted paint is a head start, never the final answer.
    expect(ofKind(KIND_DIRECTORY_ENTRY)).toHaveLength(2);
  });
});
