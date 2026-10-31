import { describe, it, expect } from "vitest";
import { NostrClient, PublishFailedError, type NostrEvent } from "./client.js";

/**
 * Per-relay publish outcomes (audit K-7). A total failure has to say HOW each
 * relay failed, because "it refused" and "we never heard back" mean opposite
 * things to marmot: the first is safe to roll back, the second may already be
 * on the relay and in members' hands.
 */
const EVENT = {
  id: "e".repeat(64),
  pubkey: "a".repeat(64),
  kind: 445,
  created_at: 1,
  tags: [["h", "g"]],
  content: "",
  sig: "s",
} as unknown as NostrEvent;

function withPool(client: NostrClient, pool: Record<string, unknown>): void {
  (client as any).pool = { close() {}, ...pool };
}

const failLater = (ms: number, err: unknown): Promise<never> =>
  new Promise((_r, rej) => setTimeout(() => rej(err), ms));

describe("NostrClient.publish per-relay outcomes (audit K-7)", () => {
  it("classifies every relay when none acked: refusal, timeout, transport", async () => {
    const relays = ["wss://a.example", "wss://b.example", "wss://c.example", "wss://d.example"];
    const client = new NostrClient(relays);
    withPool(client, {
      publish: () => [
        failLater(1, new Error("blocked: not on the allowlist")),
        failLater(2, new Error("publish timed out")),
        failLater(3, "connection failure: Error: connection timed out"),
        failLater(4, new Error("relay connection closed")),
      ],
    });
    const err = await client.publish(EVENT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublishFailedError);
    const byUrl = Object.fromEntries((err as PublishFailedError).outcomes.map((o) => [o.url, o.status]));
    expect(byUrl).toEqual({
      "wss://a.example": "rejected",
      "wss://b.example": "timeout",
      "wss://c.example": "transport",
      "wss://d.example": "transport",
    });
    // The message is unchanged: it is what the log and the organizer's notice show.
    expect((err as Error).message).toMatch(/failed on all 4 relay\(s\) — wss:\/\/a\.example: blocked/);
  });

  it("names the relays that had acked when it resolves", async () => {
    const client = new NostrClient(["wss://a.example", "wss://b.example"]);
    withPool(client, {
      publish: () => [Promise.resolve("ok"), new Promise(() => {})],
    });
    await expect(client.publish(EVENT)).resolves.toEqual({ replaced: false, acked: ["wss://a.example"] });
  });

  it("applies a per-call OK timeout to this publish only, and puts the relay's own back", async () => {
    const seen: number[] = [];
    const relay = {
      publishTimeout: 4400,
      publish(this: { publishTimeout: number }) {
        // nostr-tools arms its timer from this field synchronously, here.
        seen.push(this.publishTimeout);
        return Promise.resolve("ok");
      },
    };
    const client = new NostrClient(["wss://a.example"]);
    let poolPublishCalled = false;
    withPool(client, {
      ensureRelay: async () => relay,
      publish: () => {
        poolPublishCalled = true;
        return [Promise.resolve("ok")];
      },
    });
    await expect(client.publish(EVENT, undefined, { timeoutMs: 15_000 })).resolves.toMatchObject({
      acked: ["wss://a.example"],
    });
    expect(seen).toEqual([15_000]);
    expect(relay.publishTimeout).toBe(4400);
    expect(poolPublishCalled).toBe(false);

    // Without the option it is nostr-tools' own pool.publish, as before.
    await client.publish(EVENT);
    expect(poolPublishCalled).toBe(true);
  });

  it("a connect failure on the per-call path is a transport failure", async () => {
    const client = new NostrClient(["wss://a.example"]);
    withPool(client, {
      ensureRelay: async () => {
        throw new Error("connection timed out");
      },
    });
    const err = await client.publish(EVENT, undefined, { timeoutMs: 15_000 }).catch((e: unknown) => e);
    expect((err as PublishFailedError).outcomes).toEqual([
      { url: "wss://a.example", status: "transport", reason: "connection failure: Error: connection timed out" },
    ]);
  });
});
