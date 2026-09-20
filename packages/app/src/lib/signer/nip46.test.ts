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

const { FakePool, fromURI, fromBunker, parseBunkerInput, createNostrConnectURI } = vi.hoisted(() => {
  /**
   * Only the surface signer/nip46.ts touches: destroy, ensureRelay, the health
   * hooks, and — the one that matters for reconnect recovery —
   * `listConnectionStatus()`.
   *
   * `connection` is this fake's stand-in for each AbstractRelay's `_connected`
   * flag, and `setConnected` is the ONLY way to move it, exactly as in the real
   * library: a mid-request drop and its later recovery both mutate that flag
   * and fire no pool hook at all. Tests that want to simulate a socket dropping
   * must therefore go through `setConnected`, not through the hooks — driving
   * the hooks by hand is what let the recovery ship inert.
   */
  class FakePool {
    static instances: FakePool[] = [];
    static last(): FakePool {
      return FakePool.instances[FakePool.instances.length - 1];
    }
    destroyed = 0;
    onRelayConnectionFailure?: (url: string) => void;
    onRelayConnectionSuccess?: (url: string) => void;
    connection = new Map<string, boolean>();
    constructor() {
      FakePool.instances.push(this);
    }
    /**
     * A relay that never opened. The real pool deletes it from `relays` inside
     * `ensureRelay`'s catch and then calls the failure hook, so the map and the
     * hook agree — the fake must too, or tests pass on states production can't
     * reach.
     */
    relayFailed(url: string) {
      this.connection.delete(url);
      this.onRelayConnectionFailure?.(url);
    }
    /** A relay that opened: present and connected, then the success hook. */
    relayConnected(url: string) {
      this.connection.set(url, true);
      this.onRelayConnectionSuccess?.(url);
    }
    /**
     * A mid-life socket transition — `handleHardClose` flipping `_connected` to
     * false and reconnecting, or `ws.onopen` flipping it back. Deliberately
     * fires NO hook, because the library fires none here. This is the drop the
     * reconnect recovery exists for.
     */
    setConnected(url: string, connected: boolean) {
      this.connection.set(url, connected);
    }
    /** A relay whose socket errored after connecting: dropped from the map for good. */
    relayVanished(url: string) {
      this.connection.delete(url);
    }
    listConnectionStatus() {
      return this.connection;
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
    createNostrConnectURI: vi.fn((o: { clientPubkey: string; secret: string; perms?: string[] }) =>
      `nostrconnect://${o.clientPubkey}?secret=${o.secret}`,
    ),
  };
});

vi.mock("nostr-tools/pool", () => ({ SimplePool: FakePool }));
vi.mock("nostr-tools/nip46", () => ({
  BunkerSigner: { fromURI, fromBunker },
  parseBunkerInput,
  createNostrConnectURI,
}));

const {
  Nip46Signer,
  isBunkerScheme,
  looksLikeBunkerUri,
  normalizeBunkerUri,
  safeNip46AuthUrl,
} = await import("./nip46.js");

const PUBKEY = "ab".repeat(32);
/** A BunkerSigner stand-in: `bp` is read for the pointer, `connect` for the handshake. */
const fakeBunker = () => ({
  bp: { pubkey: PUBKEY, relays: [] as string[], secret: null },
  connect: vi.fn(async () => {}),
  ping: vi.fn(async () => {}),
  switchRelays: vi.fn(async () => false),
  sendRequest: vi.fn(async (_method: string, _params: string[]) => "ack"),
  getPublicKey: vi.fn(async () => PUBKEY),
  signEvent: vi.fn(),
  nip44Encrypt: vi.fn(),
  nip44Decrypt: vi.fn(),
  logout: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
});
/** What the real fromURI does with >1 relay once aborted: nothing, forever. */
const neverSettles = () => new Promise<never>(() => {});

/**
 * Let the health tracker observe the connection map once.
 *
 * A mid-life socket transition raises no event anywhere in nostr-tools — the
 * relay flips its own `_connected` flag and reconnects itself — so
 * `trackPoolHealth` polls for it, and a simulated drop is invisible until a tick
 * of that interval. Advancing to the next timer rather than a fixed duration
 * keeps this honest if the poll interval is ever retuned.
 *
 * Requires fake timers; the tests that simulate a drop opt in individually
 * rather than globally, so the rest of the file keeps real timing.
 */
const advanceHealthPoll = () => vi.advanceTimersToNextTimerAsync();

beforeEach(() => {
  FakePool.instances.length = 0;
  fromURI.mockReset();
  fromBunker.mockReset();
  parseBunkerInput.mockReset();
  createNostrConnectURI.mockClear();
});

describe("auth_url validation", () => {
  it("accepts only credential-free https URLs", () => {
    expect(safeNip46AuthUrl("https://signer.example/approve?id=1")).toBe(
      "https://signer.example/approve?id=1",
    );
    expect(safeNip46AuthUrl("http://signer.example/approve")).toBeNull();
    expect(safeNip46AuthUrl("javascript:alert(1)")).toBeNull();
    expect(safeNip46AuthUrl("https://user:pass@signer.example/approve")).toBeNull();
  });
});

describe("permissions", () => {
  it("requests the complete event-kind set in nostrconnect URIs", () => {
    fromURI.mockReturnValue(neverSettles());
    const handle = Nip46Signer.startNostrConnect(["wss://relay.example"]);
    handle.connected.catch(() => {});
    handle.cancel();
    const perms = createNostrConnectURI.mock.calls[0][0].perms as string[];
    expect(perms).toEqual(expect.arrayContaining([
      "sign_event:5",
      "sign_event:10000",
      "sign_event:10050",
    ]));
  });
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
      pool.relayFailed("wss://relay.nsec.app/");
      pool.relayConnected("wss://nos.lol/");
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

  it("names the relays that refused the socket when fromURI gives up on its own", async () => {
    // The library's own message for this ("subscription closed before
    // connection was established.") names nobody and reads like a bug in the
    // app. It fires after 3 s of socket timeouts, long before our 120 s budget,
    // so the relay-naming message must be attached HERE, not only to the timer.
    fromURI.mockImplementation(() => {
      const pool = FakePool.last();
      pool.relayFailed("wss://nos.lol");
      pool.relayFailed("wss://relay.example");
      return Promise.reject(new Error("subscription closed before connection was established."));
    });
    const handle = Nip46Signer.startNostrConnect(["wss://nos.lol", "wss://relay.example"]);
    const err = await handle.connected.catch((e: Error) => e);
    expect((err as Error).message).toContain("nos.lol");
    expect((err as Error).message).toContain("relay.example");
    expect((err as Error).message).not.toContain("subscription closed");
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
    const connect = bunker.sendRequest.mock.calls[0]!;
    expect(connect[0]).toBe("connect");
    expect(connect[1][2]).toContain("sign_event:10050");
  });

  it("never lets switch_relays narrow the transport (2026-07-28 login incident)", async () => {
    // nostr-tools' switchRelays() REPLACES bp.relays with the signer's answer and
    // re-subscribes on that set alone — it does not union. A signer naming one
    // relay would collapse four independent ephemeral-reply sockets to one (and
    // Amber's default list still names the 502-ing relay.nsec.app). We suppress it
    // on every construction so `signerRelays()` stays the only authority.
    parseBunkerInput.mockResolvedValue({
      pubkey: PUBKEY,
      relays: ["wss://old.example"],
      secret: "secret",
    });
    const bunker = fakeBunker();
    bunker.switchRelays.mockImplementation(async () => {
      bunker.bp.relays = ["wss://signer-selected.example"];
      return true;
    });
    fromBunker.mockReturnValue(bunker);

    const signer = await Nip46Signer.fromBunkerUri(
      `bunker://${PUBKEY}?relay=wss%3A%2F%2Fold.example&secret=secret`,
    );
    expect(bunker.switchRelays).not.toHaveBeenCalled();
    expect((fromBunker.mock.calls[0][2] as { skipSwitchRelays?: boolean }).skipSwitchRelays).toBe(
      true,
    );
    // The pointer records the relays the handshake actually completed on; the
    // union with NIP46_RELAYS is re-derived per connect, never frozen into storage.
    expect(signer.serialize().bunker.relays).toEqual(["wss://old.example"]);
  });

  it("re-drives the connect wait when a signer relay drops and recovers", async () => {
    // The desktop/flaky-relay gap: no tab handoff, so nothing signals visibility.
    // The signer's connect ack is lost while the socket is down; only the
    // reconnect-driven retry (a fresh connect + ping) settles the wait.
    vi.useFakeTimers();
    parseBunkerInput.mockResolvedValue({
      pubkey: PUBKEY,
      relays: ["wss://relay.example"],
      secret: "s3cret",
    });
    const bunker = fakeBunker();
    bunker.sendRequest.mockReturnValue(neverSettles()); // the first connect ack never arrives
    fromBunker.mockReturnValue(bunker);

    const connecting = Nip46Signer.fromBunkerUri(
      `bunker://${PUBKEY}?relay=wss%3A%2F%2Frelay.example`,
    );
    // Let fromBunkerUri reach connectWithRecovery and register the health listener.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    const pool = FakePool.last();
    // The socket was up, drops, and comes back — no hook fires for either, which
    // is why this has to be observed off the connection map.
    pool.setConnected("wss://relay.example/", true);
    await advanceHealthPoll();
    pool.setConnected("wss://relay.example/", false);
    await advanceHealthPoll();
    pool.setConnected("wss://relay.example/", true);
    await advanceHealthPoll();

    const signer = await connecting;
    expect(signer.serialize().bunker.pubkey).toBe(PUBKEY);
    expect(bunker.ping).toHaveBeenCalled(); // the reconnect recovery probe answered
    vi.useRealTimers();
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

describe("persisted restore", () => {
  const persisted = {
    clientSkHex: "01".repeat(32),
    bunker: { pubkey: PUBKEY, relays: ["wss://relay.example"], secret: "consumed" },
    userPubkey: PUBKEY,
  };

  it("probes an authorized channel before reusing a consumed connect secret", async () => {
    const bunker = fakeBunker();
    fromBunker.mockReturnValue(bunker);
    const signer = await Nip46Signer.fromPersisted(persisted);
    expect(bunker.ping).toHaveBeenCalledTimes(1);
    expect(bunker.connect).not.toHaveBeenCalled();
    expect(await signer.getPublicKey()).toBe(PUBKEY);
  });

  it("falls back to connect when the transport probe fails", async () => {
    const bunker = fakeBunker();
    bunker.ping.mockRejectedValueOnce(new Error("not authorized"));
    fromBunker.mockReturnValue(bunker);
    await Nip46Signer.fromPersisted(persisted);
    expect(bunker.connect).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid user pubkey", async () => {
    const bunker = fakeBunker();
    bunker.getPublicKey.mockResolvedValue("not-a-pubkey");
    fromBunker.mockReturnValue(bunker);
    await expect(Nip46Signer.fromPersisted(persisted)).rejects.toThrow(/invalid pubkey/);
  });
});

describe("ordinary RPC validation and foreground recovery", () => {
  async function signerWith(bunker = fakeBunker()) {
    parseBunkerInput.mockResolvedValue({
      pubkey: PUBKEY,
      relays: ["wss://relay.example"],
      secret: null,
    });
    fromBunker.mockReturnValue(bunker);
    return { signer: await Nip46Signer.fromBunkerUri(
      `bunker://${PUBKEY}?relay=wss%3A%2F%2Frelay.example`,
    ), bunker };
  }

  it("sends the exact event template and rejects a modified response", async () => {
    const { signer, bunker } = await signerWith();
    const template = { kind: 1, created_at: 123, content: "hello", tags: [["t", "test"]] };
    bunker.signEvent.mockResolvedValue({
      ...template,
      content: "changed",
      pubkey: PUBKEY,
      id: "00".repeat(32),
      sig: "00".repeat(64),
    });
    await expect(signer.signEvent(template)).rejects.toThrow(/different event/);
    expect(bunker.signEvent).toHaveBeenCalledWith(template);
    expect(bunker.signEvent.mock.calls[0][0]).not.toHaveProperty("pubkey");
  });

  it("retries an RPC once after a signer relay drops and recovers (no handoff)", async () => {
    // The flaky-relay case with no visibility change at all (desktop blip, or a
    // signer on a separate phone): a drop-then-recover during the pending request
    // wins the race against the lost first reply and re-drives it exactly once.
    const { signer, bunker } = await signerWith();
    vi.useFakeTimers();
    bunker.nip44Encrypt
      .mockReturnValueOnce(new Promise(() => {})) // first reply lost on the dropped socket
      .mockResolvedValueOnce("ciphertext");
    const pool = FakePool.last();
    pool.setConnected("wss://relay.example/", true);
    const result = signer.nip44Encrypt(PUBKEY, "hello");
    // A mid-request drop and recovery, as the library reports them: the
    // connection map flips, and not one pool hook is called.
    await advanceHealthPoll();
    pool.setConnected("wss://relay.example/", false);
    await advanceHealthPoll();
    pool.setConnected("wss://relay.example/", true);
    await advanceHealthPoll();
    await expect(result).resolves.toBe("ciphertext");
    expect(bunker.ping).toHaveBeenCalledTimes(1); // the recovery probe
    expect(bunker.nip44Encrypt).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("treats a relay dropped from the pool entirely as a drop, not as still up", async () => {
    // A socket that ERRORS after connecting doesn't linger disconnected: the relay
    // sets skipReconnection (reconnectAttempts is 0 once ws.onopen has run), so the
    // pool deletes it outright. The connection map then says nothing about that
    // relay at all — absence is the only evidence the socket went away, and a
    // tracker that only looked at present-and-false would never see the recovery.
    const { signer, bunker } = await signerWith();
    vi.useFakeTimers();
    bunker.nip44Encrypt
      .mockReturnValueOnce(new Promise(() => {})) // reply lost with the relay
      .mockResolvedValueOnce("ciphertext");
    const pool = FakePool.last();
    pool.setConnected("wss://relay.example/", true);
    const result = signer.nip44Encrypt(PUBKEY, "hello");
    await advanceHealthPoll();
    pool.relayVanished("wss://relay.example/");
    await advanceHealthPoll();
    // The pool re-opens it under the same url on the next use.
    pool.setConnected("wss://relay.example/", true);
    await advanceHealthPoll();
    await expect(result).resolves.toBe("ciphertext");
    expect(bunker.nip44Encrypt).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("does NOT retry on a bare relay connect (an 'up' with no preceding drop)", async () => {
    // A socket finishing its initial connect must not provoke a duplicate RPC —
    // that would pop a second Amber approval for no reason. Only a recover that
    // FOLLOWS a drop counts.
    const { signer, bunker } = await signerWith();
    vi.useFakeTimers();
    let resolveFirst!: (v: string) => void;
    bunker.nip44Encrypt.mockReturnValueOnce(new Promise<string>((r) => (resolveFirst = r)));
    const pool = FakePool.last();
    const result = signer.nip44Encrypt(PUBKEY, "hello");
    pool.relayConnected("wss://relay.example/"); // initial connect, no prior drop
    await advanceHealthPoll();
    resolveFirst("ciphertext");
    await expect(result).resolves.toBe("ciphertext");
    expect(bunker.nip44Encrypt).toHaveBeenCalledTimes(1); // no duplicate send
    expect(bunker.ping).not.toHaveBeenCalled(); // no recovery probe fired
    vi.useRealTimers();
  });

  it("probes and retries once after a pending RPC was backgrounded", async () => {
    let state: DocumentVisibilityState = "visible";
    const fakeDocument = new EventTarget() as Document;
    Object.defineProperty(fakeDocument, "visibilityState", { get: () => state });
    vi.stubGlobal("document", fakeDocument);
    try {
      const { signer, bunker } = await signerWith();
      bunker.nip44Encrypt
        .mockReturnValueOnce(new Promise(() => {}))
        .mockResolvedValueOnce("ciphertext");
      const result = signer.nip44Encrypt(PUBKEY, "hello");
      state = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      state = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      await expect(result).resolves.toBe("ciphertext");
      expect(bunker.ping).toHaveBeenCalledTimes(1);
      expect(bunker.nip44Encrypt).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

/**
 * `connectWithRecovery` settled only through its own internal `settle()`, but
 * every caller bounded it from the OUTSIDE with `withTimeout`. That rejects the
 * wrapper and leaves the inner promise pending forever, so `settle()` — the only
 * thing that removes the visibilitychange listener and unsubscribes from
 * `trackPoolHealth` — was never reached on a timeout or a cancel. The orphaned
 * handler then calls connect()/ping() on a closed bunker every time the tab is
 * foregrounded, and the 1 Hz health poll keeps polling a destroyed pool, for the
 * rest of the page's life. They accumulate one per failed attempt.
 */
describe("a connect wait that times out tears itself down", () => {
  const bunkerUri = `bunker://${PUBKEY}?relay=wss%3A%2F%2Frelay.example`;

  function stubDocument() {
    let state: DocumentVisibilityState = "visible";
    const doc = new EventTarget() as Document;
    Object.defineProperty(doc, "visibilityState", { get: () => state });
    vi.stubGlobal("document", doc);
    return {
      doc,
      hide: () => {
        state = "hidden";
        doc.dispatchEvent(new Event("visibilitychange"));
      },
      show: () => {
        state = "visible";
        doc.dispatchEvent(new Event("visibilitychange"));
      },
    };
  }

  it("stops listening and stops polling once the connect deadline fires", async () => {
    const d = stubDocument();
    vi.useFakeTimers();
    try {
      const bunker = fakeBunker();
      // The signer never answers: the connect request hangs forever.
      bunker.sendRequest.mockReturnValue(neverSettles());
      bunker.ping.mockReturnValue(neverSettles());
      parseBunkerInput.mockResolvedValue({
        pubkey: PUBKEY,
        relays: ["wss://relay.example"],
        secret: null,
      });
      fromBunker.mockReturnValue(bunker);

      const pending = Nip46Signer.fromBunkerUri(bunkerUri);
      const settled = pending.then(
        () => "resolved",
        () => "rejected",
      );
      // Past the 45 s connect budget.
      await vi.advanceTimersByTimeAsync(46_000);
      expect(await settled).toBe("rejected");

      const sendsBefore = bunker.sendRequest.mock.calls.length;
      const pingsBefore = bunker.ping.mock.calls.length;
      // A later foreground handoff must not wake a wait that is over.
      d.hide();
      d.show();
      await vi.advanceTimersByTimeAsync(0);
      expect(bunker.sendRequest.mock.calls.length).toBe(sendsBefore);
      expect(bunker.ping.mock.calls.length).toBe(pingsBefore);

      // …and no 1 Hz poll survives against the destroyed pool.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("stops listening and stops polling when the wait is CANCELLED", async () => {
    const d = stubDocument();
    vi.useFakeTimers();
    try {
      const bunker = fakeBunker();
      bunker.sendRequest.mockReturnValue(neverSettles());
      bunker.ping.mockReturnValue(neverSettles());
      parseBunkerInput.mockResolvedValue({
        pubkey: PUBKEY,
        relays: ["wss://relay.example"],
        secret: null,
      });
      fromBunker.mockReturnValue(bunker);

      const controller = new AbortController();
      const pending = Nip46Signer.fromBunkerUri(bunkerUri, controller.signal);
      const settled = pending.then(
        () => "resolved",
        (e: Error) => e.message,
      );
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      expect(await settled).toBe("Cancelled");

      const sendsBefore = bunker.sendRequest.mock.calls.length;
      d.hide();
      d.show();
      await vi.advanceTimersByTimeAsync(0);
      expect(bunker.sendRequest.mock.calls.length).toBe(sendsBefore);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

/**
 * The RPC lifecycle diverged from the two connect state machines beside it, and
 * was missing what they had. Each of these is a distinct way that cost a user a
 * duplicate Amber prompt or a wrong error.
 */
describe("RPC lifecycle parity with the connect paths", () => {
  async function signerWithBunker(bunker = fakeBunker()) {
    parseBunkerInput.mockResolvedValue({
      pubkey: PUBKEY,
      relays: ["wss://relay.example"],
      secret: null,
    });
    fromBunker.mockReturnValue(bunker);
    const signer = await Nip46Signer.fromBunkerUri(
      `bunker://${PUBKEY}?relay=wss%3A%2F%2Frelay.example`,
    );
    return { signer, bunker };
  }

  function stubDocument() {
    let state: DocumentVisibilityState = "visible";
    const doc = new EventTarget() as Document;
    Object.defineProperty(doc, "visibilityState", { get: () => state });
    vi.stubGlobal("document", doc);
    return {
      set: (next: DocumentVisibilityState) => {
        state = next;
        doc.dispatchEvent(new Event("visibilitychange"));
      },
    };
  }

  it("RACES the resumed attempt against the first, so a merely DELAYED reply wins", async () => {
    // The common Amber case: the reply is late, not lost. The first attempt was
    // ABANDONED (`void first.catch(…)`) and a fresh operation() issued, so the
    // approval the user had already given was thrown away and the signer was
    // prompted a second time. Replies are id-keyed, so racing is safe.
    const d = stubDocument();
    try {
      const { signer, bunker } = await signerWithBunker();
      let answerFirst!: (v: string) => void;
      bunker.nip44Encrypt
        .mockReturnValueOnce(new Promise<string>((r) => (answerFirst = r)))
        .mockReturnValueOnce(new Promise(() => {})); // the retry never answers
      const result = signer.nip44Encrypt(PUBKEY, "hello");

      d.set("hidden");
      d.set("visible"); // handoff → probe + retry
      await Promise.resolve();
      answerFirst("late-but-valid"); // attempt 1 finally replies
      await expect(result).resolves.toBe("late-but-valid");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not fail a request that rejected while the tab was HIDDEN", async () => {
    // A mobile browser killing the socket mid-publish rejected the RPC on the
    // spot — i.e. it failed while the user was inside the signer app looking at
    // the approval. connectWithRecovery has guarded against exactly this since
    // it was written; the RPC path did not.
    const d = stubDocument();
    try {
      const { signer, bunker } = await signerWithBunker();
      let killFirst!: (e: Error) => void;
      bunker.nip44Encrypt
        .mockReturnValueOnce(new Promise<string>((_, rej) => (killFirst = rej)))
        .mockResolvedValueOnce("ciphertext");
      const result = signer.nip44Encrypt(PUBKEY, "hello");

      d.set("hidden");
      killFirst(new Error("WebSocket closed")); // socket reaped while backgrounded
      await Promise.resolve();
      d.set("visible"); // the user comes back having approved
      await expect(result).resolves.toBe("ciphertext");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not count time spent inside the signer app against the RPC deadline", async () => {
    // RPC_TIMEOUT_MS was wall-clock, so spending more than 60 s approving in
    // Amber reported "your signer didn't respond" to someone who had approved.
    const d = stubDocument();
    vi.useFakeTimers();
    try {
      const { signer, bunker } = await signerWithBunker();
      let answer!: (v: string) => void;
      bunker.nip44Encrypt.mockReturnValue(new Promise<string>((r) => (answer = r)));
      const result = signer.nip44Encrypt(PUBKEY, "hello");
      const settled = result.then(
        (v) => v,
        (e: Error) => `rejected: ${e.message}`,
      );

      d.set("hidden"); // the user switches to the signer
      await vi.advanceTimersByTimeAsync(5 * 60_000); // five minutes approving
      d.set("visible");
      answer("ciphertext");
      expect(await settled).toBe("ciphertext");
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("still reports a signer that is silent while the tab stays in the FOREGROUND", async () => {
    const d = stubDocument();
    vi.useFakeTimers();
    try {
      const { signer, bunker } = await signerWithBunker();
      bunker.nip44Encrypt.mockReturnValue(neverSettles());
      void d;
      const settled = signer.nip44Encrypt(PUBKEY, "hello").then(
        () => "resolved",
        () => "rejected",
      );
      await vi.advanceTimersByTimeAsync(61_000);
      expect(await settled).toBe("rejected");
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("re-arms the resume signal, so a SECOND handoff still makes progress", async () => {
    // `resumed` was one-shot: a user who bounced to the signer twice (glance,
    // come back, realise it needs a PIN, go again — routine on Android) got no
    // signal at all the second time and waited out the whole deadline.
    const d = stubDocument();
    try {
      const { signer, bunker } = await signerWithBunker();
      bunker.nip44Encrypt
        .mockReturnValueOnce(new Promise(() => {}))
        .mockReturnValueOnce(new Promise(() => {}))
        .mockResolvedValueOnce("ciphertext");
      const result = signer.nip44Encrypt(PUBKEY, "hello");

      d.set("hidden");
      d.set("visible"); // first handoff
      await Promise.resolve();
      await Promise.resolve();
      d.set("hidden");
      d.set("visible"); // second handoff — used to be a no-op
      await expect(result).resolves.toBe("ciphertext");
      expect(bunker.nip44Encrypt).toHaveBeenCalledTimes(3);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("get_public_key is asked once, not once per caller", () => {
  it("shares one in-flight RPC between concurrent first-time callers", async () => {
    const bunker = fakeBunker();
    let answer!: (pk: string) => void;
    bunker.getPublicKey.mockReturnValue(new Promise<string>((r) => (answer = r)));
    parseBunkerInput.mockResolvedValue({
      pubkey: PUBKEY,
      relays: ["wss://relay.example"],
      secret: null,
    });
    fromBunker.mockReturnValue(bunker);
    const signer = await Nip46Signer.fromBunkerUri(
      `bunker://${PUBKEY}?relay=wss%3A%2F%2Frelay.example`,
    );

    // Several things ask on first use (adopt, signEvent's own check, warmers).
    // Each used to fire its own request — and a signer that prompts per request
    // showed the user two or three approval dialogs for one login.
    const all = Promise.all([signer.getPublicKey(), signer.getPublicKey(), signer.getPublicKey()]);
    answer(PUBKEY);
    expect(await all).toEqual([PUBKEY, PUBKEY, PUBKEY]);
    expect(bunker.getPublicKey).toHaveBeenCalledTimes(1);
  });

  it("a FAILED lookup is retryable rather than cached", async () => {
    const bunker = fakeBunker();
    bunker.getPublicKey
      .mockRejectedValueOnce(new Error("signer offline"))
      .mockResolvedValueOnce(PUBKEY);
    parseBunkerInput.mockResolvedValue({
      pubkey: PUBKEY,
      relays: ["wss://relay.example"],
      secret: null,
    });
    fromBunker.mockReturnValue(bunker);
    const signer = await Nip46Signer.fromBunkerUri(
      `bunker://${PUBKEY}?relay=wss%3A%2F%2Frelay.example`,
    );
    await expect(signer.getPublicKey()).rejects.toThrow(/signer offline/);
    await expect(signer.getPublicKey()).resolves.toBe(PUBKEY);
  });
});

/**
 * A tab that goes hidden and never comes back must not leave the request — or
 * the visibilitychange listener the foreground deadline owns — pending forever.
 */
describe("the foreground deadline still has a wall-clock ceiling", () => {
  it("rejects a request whose tab never returns to the foreground", async () => {
    let state: DocumentVisibilityState = "visible";
    const doc = new EventTarget() as Document;
    Object.defineProperty(doc, "visibilityState", { get: () => state });
    vi.stubGlobal("document", doc);
    vi.useFakeTimers();
    try {
      const bunker = fakeBunker();
      parseBunkerInput.mockResolvedValue({
        pubkey: PUBKEY,
        relays: ["wss://relay.example"],
        secret: null,
      });
      fromBunker.mockReturnValue(bunker);
      const signer = await Nip46Signer.fromBunkerUri(
        `bunker://${PUBKEY}?relay=wss%3A%2F%2Frelay.example`,
      );
      bunker.nip44Encrypt.mockReturnValue(neverSettles());
      const settled = signer.nip44Encrypt(PUBKEY, "hello").then(
        () => "resolved",
        () => "rejected",
      );
      state = "hidden";
      doc.dispatchEvent(new Event("visibilitychange"));
      // Hours of hidden time: the foreground clock is paused, the ceiling is not.
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(await settled).toBe("rejected");
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

/**
 * A signer that queues approvals (Clave, Amber without a pre-granted
 * permission) answers with silence until the human taps Approve. On a desktop
 * the tab never hides, so the foreground deadline runs out while the phone is
 * still in a pocket — and the reply, when it comes, used to land on a promise
 * nobody awaited, while each poll re-asked under a fresh id and stacked another
 * prompt on the phone. Prod report 2026-09-19: approved on the phone, "waiting
 * for approval" forever on the Mac.
 */
describe("identical RPCs are coalesced and a late reply is not thrown away", () => {
  async function signerWith(bunker = fakeBunker()) {
    parseBunkerInput.mockResolvedValue({
      pubkey: PUBKEY,
      relays: ["wss://relay.example"],
      secret: null,
    });
    fromBunker.mockReturnValue(bunker);
    return {
      signer: await Nip46Signer.fromBunkerUri(`bunker://${PUBKEY}?relay=wss%3A%2F%2Frelay.example`),
      bunker,
    };
  }

  it("joins an identical request already in flight instead of asking the signer again", async () => {
    const { signer, bunker } = await signerWith();
    let resolveFirst!: (v: string) => void;
    bunker.nip44Decrypt.mockReturnValueOnce(new Promise<string>((r) => (resolveFirst = r)));
    const a = signer.nip44Decrypt(PUBKEY, "ciphertext");
    const b = signer.nip44Decrypt(PUBKEY, "ciphertext"); // the next poll, same wrap
    resolveFirst("plaintext");
    expect(await a).toBe("plaintext");
    expect(await b).toBe("plaintext");
    expect(bunker.nip44Decrypt).toHaveBeenCalledTimes(1);
  });

  it("does not coalesce requests that differ in their arguments", async () => {
    const { signer, bunker } = await signerWith();
    bunker.nip44Decrypt.mockResolvedValueOnce("one").mockResolvedValueOnce("two");
    const [a, b] = await Promise.all([
      signer.nip44Decrypt(PUBKEY, "ciphertext-1"),
      signer.nip44Decrypt(PUBKEY, "ciphertext-2"),
    ]);
    expect([a, b]).toEqual(["one", "two"]);
    expect(bunker.nip44Decrypt).toHaveBeenCalledTimes(2);
  });

  it("answers a repeat of a timed-out request from the reply that arrived late", async () => {
    const { signer, bunker } = await signerWith();
    vi.useFakeTimers();
    try {
      let resolveFirst!: (v: string) => void;
      bunker.nip44Decrypt.mockReturnValueOnce(new Promise<string>((r) => (resolveFirst = r)));
      const first = signer.nip44Decrypt(PUBKEY, "ciphertext").then(
        () => "resolved",
        () => "rejected",
      );
      await vi.advanceTimersByTimeAsync(61_000); // the foreground deadline
      expect(await first).toBe("rejected");
      // The user taps Approve on the phone two minutes later.
      await vi.advanceTimersByTimeAsync(120_000);
      resolveFirst("plaintext");
      await vi.advanceTimersByTimeAsync(0);
      // The next poll asks the same question: answered from the record, no prompt.
      expect(await signer.nip44Decrypt(PUBKEY, "ciphertext")).toBe("plaintext");
      expect(bunker.nip44Decrypt).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves an in-flight repeat the moment the earlier attempt's reply lands", async () => {
    // Attempt 1 timed out, attempt 2 (the next poll) is pending on a fresh id, and
    // the user approves the FIRST prompt on their phone. That reply must satisfy
    // attempt 2 — it answers the identical question — rather than being recorded
    // and left for a third attempt that may never come.
    const { signer, bunker } = await signerWith();
    vi.useFakeTimers();
    try {
      let resolveFirst!: (v: string) => void;
      bunker.nip44Decrypt
        .mockReturnValueOnce(new Promise<string>((r) => (resolveFirst = r)))
        .mockReturnValueOnce(new Promise<string>(() => {})); // attempt 2: prompt never tapped
      const first = signer.nip44Decrypt(PUBKEY, "ciphertext").catch(() => "rejected");
      await vi.advanceTimersByTimeAsync(61_000);
      expect(await first).toBe("rejected");
      const second = signer.nip44Decrypt(PUBKEY, "ciphertext");
      await vi.advanceTimersByTimeAsync(0); // the attempt reaches the bunker on a microtask
      expect(bunker.nip44Decrypt).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(5_000);
      resolveFirst("plaintext"); // the late reply to attempt 1
      expect(await second).toBe("plaintext");
    } finally {
      vi.useRealTimers();
    }
  });

  it("forgets a late reply once it is stale", async () => {
    const { signer, bunker } = await signerWith();
    vi.useFakeTimers();
    try {
      let resolveFirst!: (v: string) => void;
      bunker.nip44Decrypt
        .mockReturnValueOnce(new Promise<string>((r) => (resolveFirst = r)))
        .mockResolvedValueOnce("fresh");
      const first = signer.nip44Decrypt(PUBKEY, "ciphertext").catch(() => "rejected");
      await vi.advanceTimersByTimeAsync(61_000);
      expect(await first).toBe("rejected");
      resolveFirst("plaintext");
      await vi.advanceTimersByTimeAsync(16 * 60_000); // past LATE_REPLY_TTL_MS
      expect(await signer.nip44Decrypt(PUBKEY, "ciphertext")).toBe("fresh");
      expect(bunker.nip44Decrypt).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies the same to sign_event, keyed by the exact template", async () => {
    const { signer, bunker } = await signerWith();
    const template = { kind: 13, created_at: 123, content: "sealed", tags: [] as string[][] };
    const signed = { ...template, pubkey: PUBKEY, id: "00".repeat(32), sig: "00".repeat(64) };
    let resolveFirst!: (v: typeof signed) => void;
    bunker.signEvent.mockReturnValueOnce(new Promise<typeof signed>((r) => (resolveFirst = r)));
    const a = signer.signEvent(template);
    const b = signer.signEvent({ ...template });
    resolveFirst(signed);
    expect(await a).toEqual(signed);
    expect(await b).toEqual(signed);
    expect(bunker.signEvent).toHaveBeenCalledTimes(1);
  });
});
