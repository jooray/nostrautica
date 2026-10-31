import { describe, it, expect } from "vitest";
import { generateSecretKey, finalizeEvent } from "nostr-tools/pure";
import { Store } from "../store/db.js";
import { MarmotAdmin, INGEST_FAILURE_LOG_EVERY_MS } from "./admin.js";
import type { ChatMls, IngestReport } from "./mls.js";

/**
 * Audit R-5: MarmotAdmin.ingest and handleKeyPackageEvent never throw, and say
 * what happened. The coordinator's watcher calls both with `.catch(() => {})`,
 * which used to make every inbound membership change, fork and failure invisible.
 */
const COORD = "31923:" + "e".repeat(64) + ":devcon";
const A = "a1".repeat(32);
const B = "b2".repeat(32);
const C = "c3".repeat(32);

type Ev = { id: string; pubkey: string; kind: number; tags: string[][] };

function emptyReport(over: Partial<IngestReport> = {}): IngestReport {
  return { epochBefore: 4, epochAfter: 4, commits: [], autoCommits: [], forks: [], failures: [], removedSelf: false, ...over };
}

/** Just enough ChatMls for ensureGroup + ingest + the 30443 path. */
function fakeMls(ingest: (events: Ev[]) => Promise<IngestReport | void>, over: Partial<ChatMls> = {}): ChatMls {
  return {
    createGroup: async () => ({ mlsGroupIdHex: "mls-1", nostrGroupIdHex: "ng-1" }),
    isEligible: async () => true,
    isMember: async () => false,
    invite: async () => {},
    removePubkeys: async () => {},
    ingest: async (_g, events) => ingest(events as Ev[]),
    getRelays: async () => [],
    ensureRelays: async () => {},
    getAdmins: async () => [],
    setAdmins: async () => {},
    getAvatar: async () => "",
    setAvatar: async () => false,
    sendText: async () => {},
    destroyGroup: async () => {},
    ...over,
  };
}

async function setup(mls: ChatMls, clock = { now: 1_000_000 }) {
  const store = new Store(":memory:", generateSecretKey());
  const logs: string[] = [];
  const admin = new MarmotAdmin({
    store,
    mls,
    now: () => clock.now,
    coordinatorPubkey: "c".repeat(64),
    fetchKeyPackages: async () => [],
    log: (m) => logs.push(m),
  });
  await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
  return { admin, logs, store, clock };
}

const event445 = () =>
  finalizeEvent({ kind: 445, created_at: 1_700_000_000, tags: [["h", "ng-1"]], content: "x" }, generateSecretKey()) as unknown as Ev;

describe("MarmotAdmin.ingest logging (audit R-5)", () => {
  it("logs every applied inbound commit with its epochs, committer and membership change", async () => {
    const { admin, logs } = await setup(
      fakeMls(async () =>
        emptyReport({
          epochAfter: 6,
          commits: [
            { fromEpoch: 4, toEpoch: 5, committer: A, added: [B], removed: [C] },
            { fromEpoch: 5, toEpoch: 6, added: [], removed: [] },
          ],
        }),
      ),
    );
    await admin.ingest(COORD, [event445()]);
    expect(logs).toContain(`[chat] ${COORD}: epoch 4→5 by a1a1a1a1: +add b2b2b2b2, −remove c3c3c3c3`);
    expect(logs).toContain(`[chat] ${COORD}: epoch 5→6 by an unknown leaf: no membership change`);
  });

  it("logs auto-committed self_removes, forks, and the coordinator's own removal", async () => {
    const { admin, logs } = await setup(
      fakeMls(async () =>
        emptyReport({
          autoCommits: [
            { removed: [B], published: true },
            { removed: [C], published: false },
          ],
          forks: [{ epoch: 3, eventId: "f".repeat(64), adopted: false }],
          removedSelf: true,
        }),
      ),
    );
    await admin.ingest(COORD, [event445()]);
    expect(logs).toContain(`[chat] ${COORD}: auto-committed the self_remove of b2b2b2b2`);
    expect(logs.some((l) => l.includes("self_remove of c3c3c3c3 — publish failed"))).toBe(true);
    expect(logs.some((l) => l.startsWith(`[chat] FORK? competing commit at epoch 3 in ${COORD}`))).toBe(true);
    expect(logs.some((l) => l.includes("REMOVED THE COORDINATOR"))).toBe(true);
  });

  it("never throws: an ingest failure is logged with its cause chain", async () => {
    const { admin, logs } = await setup(
      fakeMls(async () => {
        throw new Error("Failed to load group", { cause: new Error("Pending publication does not match canonical parent") });
      }),
    );
    await expect(admin.ingest(COORD, [event445()])).resolves.toBeUndefined();
    expect(logs).toContain(
      `[chat] ${COORD}: ingest failed: Failed to load group <- Pending publication does not match canonical parent`,
    );
  });

  it("rate-limits failure lines per group, and reports how many it held back", async () => {
    const clock = { now: 1_000_000 };
    const { admin, logs } = await setup(
      fakeMls(async () => emptyReport({ failures: ["undecryptable 445 deadbeef: no key"] })),
      clock,
    );
    for (let i = 0; i < 5; i++) await admin.ingest(COORD, [event445()]);
    expect(logs.filter((l) => l.includes("undecryptable"))).toHaveLength(1);
    clock.now += INGEST_FAILURE_LOG_EVERY_MS;
    await admin.ingest(COORD, [event445()]);
    const lines = logs.filter((l) => l.includes("undecryptable"));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/\(\+4 more since the last report\)$/);
  });
});

describe("MarmotAdmin.handleKeyPackageEvent (audit R-5)", () => {
  it("never throws: a failure is logged with its cause chain", async () => {
    const { admin, logs, store } = await setup(
      fakeMls(async () => {}, {
        isMember: async () => {
          throw new Error("group did not load", { cause: new Error("disk I/O error") });
        },
      }),
    );
    store.upsertAttendee({ coordinate: COORD, pubkey: "d".repeat(64), status: "approved", now: 1 });
    store.upsertChatKey({ coordinate: COORD, accountPubkey: "d".repeat(64), chatPubkey: A, now: 1 });
    const kp = { id: "9".repeat(64), pubkey: A, kind: 30443, tags: [] };
    await expect(admin.handleKeyPackageEvent(COORD, kp)).resolves.toBeUndefined();
    expect(logs.some((l) => /handling 30443 99999999 from a1a1a1a1 .* failed: group did not load <- disk I\/O error/.test(l))).toBe(
      true,
    );
  });
});
