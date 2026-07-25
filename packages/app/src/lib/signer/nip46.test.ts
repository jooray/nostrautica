/**
 * NIP-46 sign-in: input handling and the teardown contract of the nostrconnect
 * wait.
 *
 * The teardown half exists because of a real, reproduced bug in nostr-tools
 * 2.23.9: it wires an `AbortSignal` by ASSIGNING `onabort` once per relay
 * (`opts.abort.onabort = reject` in AbstractRelay.connect, `params.abort.onabort
 * = () => sub.close(…)` in AbstractRelay.subscribe), so with N relays sharing one
 * signal only the last assignment survives. `subscribeMap` only fires `onclose`
 * once ALL N relays have closed, so `BunkerSigner.fromURI` never settles —
 * verified against a real SimplePool over a fake WebSocket: still pending after
 * abort with 2 or 3 relays, rejects only with exactly 1.
 *
 * Consequently `startNostrConnect` must decide the outcome itself. These tests
 * pin that: Cancel settles, the timeout settles, the pool is destroyed exactly
 * once, a connected signer's pool is NOT destroyed by a late Cancel, and no timer
 * or transport is left behind. `BunkerSigner.fromURI` is mocked as a
 * never-settling promise precisely because that is what the real one does here.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NIP46_RELAYS } from "$lib/nostr/relays.js";

const { FakePool, fromURI, fromBunker, parseBunkerInput } = vi.hoisted(() => {
  /** Only the surface signer/nip46.ts touches: destroy, ensureRelay, the health hooks. */
  class FakePool {
    static instances: FakePool[] = [];
    static last(): FakePool {
      return FakePool.instances[FakePool.instances.length - 1];
    }
    destroyed = 0;
    onRelayConnectionFailure?: (url: string) => void;
    onRelayConnectionSuccess?: (url: string) => void;
    constructor() {
      FakePool.instances.push(this);
    }
    destroy() {
      this.destroyed++;
    }
    async ensureRelay() {
      return {};
    }
  }
  return {
    FakePool,
    fromURI: vi.fn(),
    fromBunker: vi.fn(),
    parseBunkerInput: vi.fn(),
  };
});

vi.mock("nostr-tools/pool", () => ({ SimplePool: FakePool }));
vi.mock("nostr-tools/nip46", () => ({
  BunkerSigner: { fromURI, fromBunker },
  parseBunkerInput,
  createNostrConnectURI: (o: { clientPubkey: string; secret: string }) =>
    `nostrconnect://${o.clientPubkey}?secret=${o.secret}`,
}));

const {
  Nip46Signer,
  isBunkerScheme,
  looksLikeBunkerUri,
  normalizeBunkerUri,
} = await import("./nip46.js");

const PUBKEY = "ab".repeat(32);
/** A BunkerSigner stand-in: `bp` is read for the pointer, `connect` for the handshake. */
const fakeBunker = () => ({
  bp: { pubkey: PUBKEY, relays: [] as string[], secret: null },
  connect: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
});
/** What the real fromURI does with >1 relay once aborted: nothing, forever. */
const neverSettles = () => new Promise<never>(() => {});

beforeEach(() => {
  FakePool.instances.length = 0;
  fromURI.mockReset();
  fromBunker.mockReset();
  parseBunkerInput.mockReset();
});

describe("bunker link detection is case-insensitive (iOS auto-capitalisation)", () => {
  const relayQs = "?relay=wss%3A%2F%2Frelay.example";

  it("routes a capitalised, hand-typed link to the bunker path", () => {
    // iOS capitalises the first typed character. The sign-in UI used to test
    // `startsWith("bunker://")`, so this went to "Import key" and died with a
    // bech32 error that named nothing relevant.
    expect(isBunkerScheme(`Bunker://${PUBKEY}${relayQs}`)).toBe(true);
    expect(isBunkerScheme(`BUNKER://${PUBKEY}`)).toBe(true);
    expect(isBunkerScheme(`  bunker://${PUBKEY}  `)).toBe(true);
  });

  it("still routes keys to the key importer", () => {
    expect(isBunkerScheme("nsec1abcdef")).toBe(false);
    expect(isBunkerScheme("Nsec1abcdef")).toBe(false);
    expect(isBunkerScheme("ncryptsec1abcdef")).toBe(false);
    expect(isBunkerScheme("")).toBe(false);
  });

  it("accepts a half-typed link — validation belongs to the connect path", () => {
    // No `?relay=` yet. Routing must already say "bunker" so the user gets
    // "that doesn't look like a valid bunker link" instead of a bech32 error.
    expect(isBunkerScheme(`bunker://${PUBKEY}`)).toBe(true);
    expect(looksLikeBunkerUri(`bunker://${PUBKEY}`)).toBe(false);
    expect(looksLikeBunkerUri(`bunker://${PUBKEY}${relayQs}`)).toBe(true);
  });

  it("normalizes only the scheme and pubkey — the query is case-significant", () => {
    // nostr-tools' BUNKER_REGEX is case-SENSITIVE on both scheme and hex, and
    // silently falls through to a NIP-05 lookup when it doesn't match. Relay
    // URLs and the connect secret must survive untouched.
    const out = normalizeBunkerUri(
      `  Bunker://${PUBKEY.toUpperCase()}?relay=wss%3A%2F%2FRelay.Example&secret=AbCdEf  `,
    );
    expect(out).toBe(
      `bunker://${PUBKEY}?relay=wss%3A%2F%2FRelay.Example&secret=AbCdEf`,
    );
  });

  it("leaves anything that isn't a bunker link alone", () => {
    expect(normalizeBunkerUri("  NSEC1AbC  ")).toBe("NSEC1AbC");
  });
});

describe("startNostrConnect settles on our terms, not the library's", () => {
  it("cancel() rejects the wait and destroys the pool exactly once", async () => {
    fromURI.mockReturnValue(neverSettles());
    const handle = Nip46Signer.startNostrConnect(["wss://a", "wss://b", "wss://c"]);
    const rejected = expect(handle.connected).rejects.toThrow("Cancelled");
    handle.cancel();
    handle.cancel(); // idempotent: a double-tap must not double-destroy
    await rejected;
    expect(FakePool.last().destroyed).toBe(1);
  });

  it("the timeout actually fires (it was a silent no-op)", async () => {
    fromURI.mockReturnValue(neverSettles());
    const handle = Nip46Signer.startNostrConnect(["wss://a", "wss://b"], 20);
    await expect(handle.connected).rejects.toThrow(/didn't respond/);
    expect(FakePool.last().destroyed).toBe(1);
  });

  it("names the relay that refused the socket instead of a bare timeout", async () => {
    fromURI.mockImplementation(() => {
      // What AbstractSimplePool reports as sockets come up or fail.
      const pool = FakePool.last();
      pool.onRelayConnectionFailure?.("wss://relay.nsec.app/");
      pool.onRelayConnectionSuccess?.("wss://nos.lol/");
      return neverSettles();
    });
    const handle = Nip46Signer.startNostrConnect(["wss://nos.lol", "wss://relay.nsec.app"], 20);
    const err = await handle.connected.catch((e: Error) => e);
    expect((err as Error).message).toContain("relay.nsec.app");
    // A relay that came up is not the user's problem — don't blame it.
    expect((err as Error).message).not.toContain("nos.lol");
  });

  it("clears its own timer on cancel, so Retry doesn't stack timers", () => {
    vi.useFakeTimers();
    try {
      fromURI.mockReturnValue(neverSettles());
      const handle = Nip46Signer.startNostrConnect(["wss://a", "wss://b"], 120_000);
      handle.connected.catch(() => {});
      expect(vi.getTimerCount()).toBe(1);
      handle.cancel();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands the pool to the connected signer — a later cancel() must not kill it", async () => {
    fromURI.mockResolvedValue(fakeBunker());
    const handle = Nip46Signer.startNostrConnect(["wss://a", "wss://b"]);
    const signer = await handle.connected;
    expect(signer.serialize().bunker.pubkey).toBe(PUBKEY);
    // SignInOptions' onMount teardown calls cancel() on unmount — which is
    // exactly what a successful sign-in triggers as it navigates away.
    handle.cancel();
    expect(FakePool.last().destroyed).toBe(0);
  });

  it("closes a signer that arrives after we gave up, instead of leaking it", async () => {
    let resolveLate!: (b: unknown) => void;
    fromURI.mockReturnValue(new Promise((res) => (resolveLate = res)));
    const handle = Nip46Signer.startNostrConnect(["wss://a", "wss://b"]);
    const rejected = expect(handle.connected).rejects.toThrow("Cancelled");
    handle.cancel();
    await rejected;
    const late = fakeBunker();
    resolveLate(late);
    await Promise.resolve();
    await Promise.resolve();
    expect(late.close).toHaveBeenCalled();
  });

  it("tears down once when fromURI fails on its own", async () => {
    fromURI.mockRejectedValue(new Error("subscription closed before connection was established."));
    const handle = Nip46Signer.startNostrConnect(["wss://a", "wss://b"]);
    await expect(handle.connected).rejects.toThrow(/subscription closed/);
    expect(FakePool.last().destroyed).toBe(1);
  });
});

describe("fromBunkerUri unions the pointer's relays with our own", () => {
  it("connects on pointer ∪ NIP46_RELAYS but persists only the pointer's", async () => {
    parseBunkerInput.mockResolvedValue({
      pubkey: PUBKEY,
      relays: ["wss://relay.nsec.app"],
      secret: "s3cret",
    });
    const bunker = fakeBunker();
    fromBunker.mockReturnValue(bunker);

    const signer = await Nip46Signer.fromBunkerUri(
      `bunker://${PUBKEY}?relay=wss%3A%2F%2Frelay.nsec.app&secret=s3cret`,
    );

    const transport = fromBunker.mock.calls[0][1] as { relays: string[] };
    expect(transport.relays[0]).toBe("wss://relay.nsec.app");
    for (const dflt of NIP46_RELAYS) expect(transport.relays).toContain(dflt);
    // The union is policy re-derived per connect, not state frozen into storage:
    // a later change to NIP46_RELAYS must take effect on the next restore.
    expect(signer.serialize().bunker.relays).toEqual(["wss://relay.nsec.app"]);
  });

  it("accepts a capitalised link by normalizing before parsing", async () => {
    parseBunkerInput.mockResolvedValue({
      pubkey: PUBKEY,
      relays: ["wss://relay.example"],
      secret: null,
    });
    fromBunker.mockReturnValue(fakeBunker());
    await Nip46Signer.fromBunkerUri(
      `Bunker://${PUBKEY.toUpperCase()}?relay=wss%3A%2F%2Frelay.example`,
    );
    // nostr-tools would have rejected the capitalised form outright.
    expect(parseBunkerInput).toHaveBeenCalledWith(
      `bunker://${PUBKEY}?relay=wss%3A%2F%2Frelay.example`,
    );
  });

  it("rejects a link with no relay before touching the network", async () => {
    await expect(Nip46Signer.fromBunkerUri(`bunker://${PUBKEY}`)).rejects.toThrow(
      /valid bunker link/,
    );
    expect(parseBunkerInput).not.toHaveBeenCalled();
    expect(FakePool.instances.length).toBe(0);
  });
});
