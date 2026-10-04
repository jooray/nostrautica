import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { SimplePool } from "nostr-tools/pool";
import { NostrClient, OrphanSafePool } from "./client.js";
import { GuardedWebSocket, setRelayConnectPolicy } from "../net/relay-guard.js";

/**
 * A relay that answers the first handshake, then stalls every later one past the
 * pool's connect timeout — what relay.damus.io looked like from the coordinator
 * when the orphans piled up. Counts every TCP connection it is offered.
 */
async function stallingRelay(stallMs: number) {
  let accepted = 0;
  let connections = 0;
  const http: Server = createServer();
  http.on("connection", () => connections++);
  const wss = new WebSocketServer({
    server: http,
    verifyClient: (_info, cb) => (accepted++ === 0 ? cb(true) : setTimeout(() => cb(true), stallMs)),
  });
  const sockets = new Set<WebSocket>();
  wss.on("connection", (ws) => {
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
    ws.on("message", (m) => {
      const [type, id] = JSON.parse(String(m));
      if (type === "REQ") ws.send(JSON.stringify(["EOSE", id]));
    });
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  return {
    url: `ws://127.0.0.1:${(http.address() as AddressInfo).port}`,
    /** Drop every established socket, as a rate-limiting relay does. */
    kick: () => sockets.forEach((s) => s.terminate()),
    get open() {
      return sockets.size;
    },
    get connections() {
      return connections;
    },
    close: () => new Promise<void>((r) => { sockets.forEach((s) => s.terminate()); wss.close(); http.close(() => r()); }),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The pools under comparison, built the way NostrClient builds its own (same
// WebSocket class, same reconnect and ping) with test-sized timeouts. The guard
// refuses 127.0.0.1 unless the dev-only insecure policy is on.
const opts = { enableReconnect: true, enablePing: true, maxWaitForConnection: 100, websocketImplementation: GuardedWebSocket } as const;
beforeAll(() => setRelayConnectPolicy({ allowInsecure: true }));
afterAll(() => setRelayConnectPolicy({ allowInsecure: false }));

describe("OrphanSafePool", () => {
  const cleanup: (() => unknown)[] = [];
  afterEach(async () => {
    for (const f of cleanup.splice(0)) await f();
  });

  /**
   * The production failure: a relay drops, its reconnect is under way, and a caller
   * asks for it again. That caller's connect times out, the pool forgets the relay,
   * and the relay finishes its reconnect outside the pool and stays connected
   * forever. Run with `SimplePool` this ends with an open socket nobody owns.
   */
  async function orphanScenario(pool: SimplePool) {
    const relay = await stallingRelay(300);
    cleanup.push(() => relay.close(), () => pool.destroy());

    const r = await pool.ensureRelay(relay.url);
    // A backoff wide enough that the next call lands in the gap between reconnect
    // attempts: an in-flight connect is shared and carries no timeout of its own.
    (r as unknown as { resubscribeBackoff: number[] }).resubscribeBackoff = [400];
    relay.kick();
    await sleep(50); // dropped, and waiting out its reconnect backoff

    await expect(pool.ensureRelay(relay.url, { connectionTimeout: 100 })).rejects.toBeDefined();
    await sleep(1200); // the 400 ms reconnect plus its 300 ms stalled handshake, with margin
    return { relay, pooled: pool.listConnectionStatus().size };
  }

  it("closes a relay that ensureRelay gave up on, instead of leaving it connected outside the pool", async () => {
    const { relay, pooled } = await orphanScenario(new OrphanSafePool(opts));
    expect(pooled).toBe(0);
    expect(relay.open).toBe(0);
  });

  it("control: a plain SimplePool leaks that relay (the bug this class exists for)", async () => {
    const { relay, pooled } = await orphanScenario(new SimplePool(opts));
    expect(pooled).toBe(0);
    expect(relay.open).toBe(1);
  });

  it("a closing relay only removes its own map entry, never its replacement's", async () => {
    const relay = await stallingRelay(0);
    const pool = new OrphanSafePool(opts);
    cleanup.push(() => relay.close(), () => pool.destroy());

    const first = await pool.ensureRelay(relay.url);
    const key = [...pool.relays.keys()][0]!;
    pool.relays.delete(key); // as nostr-tools does when it gives up on one
    const second = await pool.ensureRelay(relay.url);
    expect(second).not.toBe(first);

    first.close(); // the stale relay going away
    expect(pool.relays.get(key)).toBe(second);
  });
});

describe("GuardedWebSocket under a connect timeout", () => {
  it("does not throw an uncaught error when nostr-tools abandons a connecting socket", async () => {
    // nostr-tools closes the socket and detaches onerror in one tick; ws emits the
    // aborted handshake's error on the next. Without a listener of its own that
    // error is uncaught, and lifecycle.ts makes an uncaught exception fatal.
    const relay = await stallingRelay(300);
    const pool = new SimplePool(opts);
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.on("uncaughtException", onUncaught);
    try {
      // stallingRelay answers its first handshake at once; spend it.
      await pool.ensureRelay(relay.url);
      pool.close([relay.url]);
      await expect(pool.ensureRelay(relay.url, { connectionTimeout: 100 })).rejects.toBeDefined();
      await sleep(100);
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
      pool.destroy();
      await relay.close();
    }
  });
});

describe("NostrClient's own pool", () => {
  it("connects through GuardedWebSocket, not Node's global WebSocket", async () => {
    // The tests above hand the pool its WebSocket class. Production does not:
    // this checks the pool exactly as NostrClient builds it. 0.8.1 shipped a pool
    // that fell back to undici's global WebSocket and crash-looped.
    const client = new NostrClient([]);
    const pool = (client as unknown as { pool: { _WebSocket: unknown } }).pool;
    expect(pool._WebSocket).toBe(GuardedWebSocket);

    // And end to end: a real connect through the client's pool reaches the relay
    // with a GuardedWebSocket.
    const relay = await stallingRelay(0);
    try {
      const r = await (client as unknown as { pool: SimplePool }).pool.ensureRelay(relay.url);
      expect((r as unknown as { ws: unknown }).ws).toBeInstanceOf(GuardedWebSocket);
    } finally {
      client.close();
      (client as unknown as { pool: SimplePool }).pool.destroy();
      await relay.close();
    }
  });
});
