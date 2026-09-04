import { describe, it, expect } from "vitest";
import type { Event as NostrEvent } from "nostr-tools/core";
import { discoverKeyPackages, type KeyPackageTransport } from "./key-package-discovery.js";

const KIND_KEY_PACKAGE = 30443;
const KIND_RELAY_LIST = 10002;

function ev(partial: Partial<NostrEvent> & { pubkey: string; kind: number }): NostrEvent {
  return {
    id: partial.id ?? Math.random().toString(36).slice(2),
    created_at: partial.created_at ?? 1_700_000_000,
    tags: partial.tags ?? [],
    content: partial.content ?? "",
    sig: "sig",
    ...partial,
  } as NostrEvent;
}

/** Relay-aware fake: events are only visible from the relays they were "published" to. */
class RelayScopedFake implements KeyPackageTransport {
  private byRelay = new Map<string, NostrEvent[]>();

  seed(relay: string, event: NostrEvent): void {
    const list = this.byRelay.get(relay) ?? [];
    list.push(event);
    this.byRelay.set(relay, list);
  }

  async fetch(filter: { kinds?: number[]; authors?: string[] }, relays: string[] = []): Promise<NostrEvent[]> {
    const seen = new Map<string, NostrEvent>();
    for (const relay of relays) {
      for (const e of this.byRelay.get(relay) ?? []) {
        if (filter.kinds && !filter.kinds.includes(e.kind)) continue;
        if (filter.authors && !filter.authors.includes(e.pubkey)) continue;
        seen.set(e.id, e);
      }
    }
    return [...seen.values()];
  }
}

describe("discoverKeyPackages", () => {
  it("finds a key package on the primary (event) relays with no extra lookups", async () => {
    const t = new RelayScopedFake();
    const kp = ev({ id: "kp1", kind: KIND_KEY_PACKAGE, pubkey: "alice" });
    t.seed("wss://event-relay.example", kp);

    const result = await discoverKeyPackages(t, ["alice"], ["wss://event-relay.example"], ["wss://fallback.example"]);
    expect(result.map((e) => e.id)).toEqual(["kp1"]);
  });

  it("falls back to the author's own NIP-65 relays when nothing is on the primary relays", async () => {
    const t = new RelayScopedFake();
    // Whitenoise-style: the key package is published ONLY to the author's own
    // NIP-65 relays, never on the event's relays.
    const relayList = ev({
      kind: KIND_RELAY_LIST,
      pubkey: "whitenoise-user",
      tags: [["r", "wss://own-relay.example"]],
    });
    t.seed("wss://event-relay.example", relayList);
    t.seed("wss://fallback.example", relayList); // discoverable via the bootstrap set too
    const kp = ev({ id: "kp2", kind: KIND_KEY_PACKAGE, pubkey: "whitenoise-user" });
    t.seed("wss://own-relay.example", kp);

    const result = await discoverKeyPackages(
      t,
      ["whitenoise-user"],
      ["wss://event-relay.example"],
      ["wss://fallback.example"],
    );
    expect(result.map((e) => e.id)).toEqual(["kp2"]);
  });

  it("returns nothing for an author with no key package anywhere reachable", async () => {
    const t = new RelayScopedFake();
    const result = await discoverKeyPackages(t, ["ghost"], ["wss://event-relay.example"], ["wss://fallback.example"]);
    expect(result).toEqual([]);
  });

  it("does not duplicate a key package found on both primary and own relays", async () => {
    const t = new RelayScopedFake();
    const kp = ev({ id: "kp3", kind: KIND_KEY_PACKAGE, pubkey: "alice" });
    t.seed("wss://event-relay.example", kp);
    // covered by primary already — remaining stays empty, no 10002 lookup needed
    const result = await discoverKeyPackages(t, ["alice"], ["wss://event-relay.example"], []);
    expect(result.map((e) => e.id)).toEqual(["kp3"]);
  });

  it("mixes authors found on primary relays with authors found only via NIP-65 fallback", async () => {
    const t = new RelayScopedFake();
    const kpOnPrimary = ev({ id: "kp-primary", kind: KIND_KEY_PACKAGE, pubkey: "on-primary" });
    t.seed("wss://event-relay.example", kpOnPrimary);

    const relayList = ev({
      kind: KIND_RELAY_LIST,
      pubkey: "off-primary",
      tags: [["r", "wss://own-relay.example"]],
    });
    t.seed("wss://event-relay.example", relayList);
    const kpOffPrimary = ev({ id: "kp-off-primary", kind: KIND_KEY_PACKAGE, pubkey: "off-primary" });
    t.seed("wss://own-relay.example", kpOffPrimary);

    const result = await discoverKeyPackages(
      t,
      ["on-primary", "off-primary"],
      ["wss://event-relay.example"],
      [],
    );
    expect(new Set(result.map((e) => e.id))).toEqual(new Set(["kp-primary", "kp-off-primary"]));
  });

  it("picks the latest kind-10002 when an author published more than one", async () => {
    const t = new RelayScopedFake();
    const stale = ev({
      kind: KIND_RELAY_LIST,
      pubkey: "alice",
      created_at: 1_000,
      tags: [["r", "wss://stale-relay.example"]],
    });
    const fresh = ev({
      kind: KIND_RELAY_LIST,
      pubkey: "alice",
      created_at: 2_000,
      tags: [["r", "wss://fresh-relay.example"]],
    });
    t.seed("wss://event-relay.example", stale);
    t.seed("wss://event-relay.example", fresh);
    const kp = ev({ id: "kp-fresh", kind: KIND_KEY_PACKAGE, pubkey: "alice" });
    t.seed("wss://fresh-relay.example", kp);
    // Nothing seeded on stale-relay.example, so finding kp-fresh proves the
    // fresh (higher created_at) relay list won, not the stale one.

    const result = await discoverKeyPackages(t, ["alice"], ["wss://event-relay.example"], []);
    expect(result.map((e) => e.id)).toEqual(["kp-fresh"]);
  });

  it("sanitizes untrusted 10002 `r` tags (audit COORD-16): wss-only, capped per author", async () => {
    const t = new RelayScopedFake();
    const relayList = ev({
      kind: KIND_RELAY_LIST,
      pubkey: "hostile",
      tags: [
        ["r", "ws://insecure.example"], // dropped: not wss
        ["r", "not a url"], // dropped: malformed
        // 8 valid wss relays — only the first 5 are fanned out to.
        ...Array.from({ length: 8 }, (_, i): string[] => ["r", `wss://fan-${i}.example`]),
      ],
    });
    t.seed("wss://event-relay.example", relayList);
    const kp = ev({ id: "kp-fan", kind: KIND_KEY_PACKAGE, pubkey: "hostile" });
    t.seed("wss://fan-4.example", kp); // within the cap → still discovered

    const result = await discoverKeyPackages(t, ["hostile"], ["wss://event-relay.example"], []);
    expect(result.map((e) => e.id)).toEqual(["kp-fan"]);
    // The insecure/malformed relays were never queried (no events there anyway),
    // and relays past the cap are out of reach by construction.
    const beyondCap = ev({ id: "kp-beyond", kind: KIND_KEY_PACKAGE, pubkey: "hostile" });
    t.seed("wss://fan-7.example", beyondCap);
    const again = await discoverKeyPackages(t, ["hostile"], ["wss://event-relay.example"], []);
    expect(again.map((e) => e.id)).toEqual(["kp-fan"]);
  });

  // ── newest-wins per (author, `d`) ─────────────────────────────────────────
  // kind-30443 is addressable, so a (pubkey, `d`) pair names ONE live key package.
  // A multi-relay read does not enforce that: a relay that missed (or has not yet
  // received) the rotation still serves the superseded copy, and both come back.
  // Handing the caller both is how `syncMember` ended up inviting a device with an
  // init key it had already discarded — the Welcome is undecryptable, the
  // coordinator holds a leaf for a member who cannot see the room, and only a
  // reload plus Rejoin gets them out of it.
  it("returns only the NEWEST key package per (author, d) when a lagging relay still serves the old one", async () => {
    const t = new RelayScopedFake();
    const stale = ev({
      id: "kp-stale",
      kind: KIND_KEY_PACKAGE,
      pubkey: "alice",
      created_at: 1_700_000_000,
      tags: [["d", "web-laptop"]],
    });
    const rotated = ev({
      id: "kp-rotated",
      kind: KIND_KEY_PACKAGE,
      pubkey: "alice",
      created_at: 1_700_000_060,
      tags: [["d", "web-laptop"]],
    });
    // The lagging relay is listed FIRST, so a "whichever arrives first" caller
    // picks the stale one — that ordering is the whole point of the test.
    t.seed("wss://lagging.example", stale);
    t.seed("wss://event-relay.example", rotated);

    const result = await discoverKeyPackages(
      t,
      ["alice"],
      ["wss://lagging.example", "wss://event-relay.example"],
      [],
    );
    expect(result.map((e) => e.id)).toEqual(["kp-rotated"]);
  });

  it("keeps one key package per slot, so a genuinely multi-device author is not collapsed", async () => {
    const t = new RelayScopedFake();
    const laptop = ev({
      id: "kp-laptop",
      kind: KIND_KEY_PACKAGE,
      pubkey: "alice",
      created_at: 1_700_000_000,
      tags: [["d", "web-laptop"]],
    });
    const phone = ev({
      id: "kp-phone",
      kind: KIND_KEY_PACKAGE,
      pubkey: "alice",
      created_at: 1_700_000_010,
      tags: [["d", "web-phone"]],
    });
    t.seed("wss://event-relay.example", laptop);
    t.seed("wss://event-relay.example", phone);

    const result = await discoverKeyPackages(t, ["alice"], ["wss://event-relay.example"], []);
    expect(new Set(result.map((e) => e.id))).toEqual(new Set(["kp-laptop", "kp-phone"]));
  });

  it("dedupes the NIP-65 fallback against the primary relays too, newest-wins", async () => {
    const t = new RelayScopedFake();
    // Nothing for `bob` on the primary relays → the NIP-65 fallback runs. His own
    // relay serves the fresh copy; a second one of his relays is behind.
    const relayList = ev({
      kind: KIND_RELAY_LIST,
      pubkey: "bob",
      tags: [
        ["r", "wss://bob-lagging.example"],
        ["r", "wss://bob-fresh.example"],
      ],
    });
    t.seed("wss://event-relay.example", relayList);
    t.seed(
      "wss://bob-lagging.example",
      ev({ id: "bob-old", kind: KIND_KEY_PACKAGE, pubkey: "bob", created_at: 1, tags: [["d", "web-1"]] }),
    );
    t.seed(
      "wss://bob-fresh.example",
      ev({ id: "bob-new", kind: KIND_KEY_PACKAGE, pubkey: "bob", created_at: 2, tags: [["d", "web-1"]] }),
    );

    const result = await discoverKeyPackages(t, ["bob"], ["wss://event-relay.example"], []);
    expect(result.map((e) => e.id)).toEqual(["bob-new"]);
  });

  it("breaks a same-second tie deterministically (same input ⇒ same choice)", async () => {
    const t = new RelayScopedFake();
    t.seed(
      "wss://a.example",
      ev({ id: "ffff", kind: KIND_KEY_PACKAGE, pubkey: "carol", created_at: 5, tags: [["d", "web-1"]] }),
    );
    t.seed(
      "wss://b.example",
      ev({ id: "0000", kind: KIND_KEY_PACKAGE, pubkey: "carol", created_at: 5, tags: [["d", "web-1"]] }),
    );
    const first = await discoverKeyPackages(t, ["carol"], ["wss://a.example", "wss://b.example"], []);
    const second = await discoverKeyPackages(t, ["carol"], ["wss://b.example", "wss://a.example"], []);
    expect(first.map((e) => e.id)).toEqual(["0000"]);
    expect(second.map((e) => e.id)).toEqual(["0000"]);
  });
});
