/**
 * Cashu payment journal durability (spec §9.4, audit finding H8). Cashu proofs
 * are bearer money; the old wallet-file-only path lost the sent proofs on a crash
 * between send and settle. The journal records every reservation before its proofs
 * leave the wallet, so a restart accounts for every proof: banked change survives,
 * and reserved-but-unsettled proofs are quarantined (never re-added to the wallet
 * → no double-spend, never dropped → no loss).
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSecretKey } from "nostr-tools/pure";
import { getEncodedTokenV4 } from "@cashu/cashu-ts";
import { Store } from "../store/db.js";
import { CashuPayment } from "./cashu.js";

const MINT = "https://mint.example";
const SENT = [
  { id: "00a", amount: 4, secret: "s-sent-1", C: "c1" },
  { id: "00a", amount: 4, secret: "s-sent-2", C: "c2" },
];
const CHANGE = [{ id: "00a", amount: 1, secret: "s-change-1", C: "c3" }];
/** CHANGE with a well-formed keyset id + C (hex) for token encoding round-trips. */
const CHANGE_ENC = [{ id: "00a1b2c3d4e5f607", amount: 1, secret: "s-change-1", C: "ab".repeat(32) }];

describe("H8 — Cashu journal durability", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function tmpDbPath(): string {
    const dir = mkdtempSync(join(tmpdir(), "nostrautica-cashu-"));
    tmpDirs.push(dir);
    return join(dir, "test.sqlite");
  }

  it("a reservation survives a crash between redeem and settle (no silent loss)", () => {
    const path = tmpDbPath();

    // ── redeem: proofs are reserved and journaled before leaving the wallet ──
    const before = new Store(path);
    const isNew = before.cashuReserve("req-1", MINT, 8, SENT);
    expect(isNew).toBe(true);
    before.close(); // simulate a crash: settle() never runs.

    // ── restart: the reservation and its proofs are still on disk ──
    const after = new Store(path);
    const entry = after.cashuJournalEntry("req-1");
    expect(entry).toBeDefined();
    expect(entry!.state).toBe("in_flight");
    expect(entry!.amount).toBe(8);
    // The sent proofs — bearer money — are recoverable, not lost.
    expect(entry!.sent_proofs).toEqual(SENT);
    expect(after.cashuNonterminal().map((e) => e.request_id)).toEqual(["req-1"]);
    after.close();
  });

  it("settle banks the change durably and closes the reservation", () => {
    const path = tmpDbPath();
    const s1 = new Store(path);
    s1.cashuReserve("req-2", MINT, 8, SENT);
    s1.cashuSettle("req-2", CHANGE);
    s1.close();

    const s2 = new Store(path);
    const entry = s2.cashuJournalEntry("req-2");
    expect(entry!.state).toBe("settled");
    expect(entry!.change_proofs).toEqual(CHANGE);
    // Settled reservations are terminal — not surfaced for reconciliation.
    expect(s2.cashuNonterminal()).toEqual([]);
    s2.close();
  });

  it("reserve is idempotent across provider retries (a stable id never reserves twice)", () => {
    const store = new Store(":memory:");
    expect(store.cashuReserve("req-3", MINT, 8, SENT)).toBe(true);
    expect(store.cashuReserve("req-3", MINT, 8, SENT)).toBe(false);
    expect(store.cashuNonterminal()).toHaveLength(1);
    store.close();
  });

  it("settle is idempotent (a duplicate settle is a no-op)", () => {
    const store = new Store(":memory:");
    store.cashuReserve("req-4", MINT, 8, SENT);
    store.cashuSettle("req-4", CHANGE);
    store.cashuSettle("req-4", []); // must not wipe the banked change
    expect(store.cashuJournalEntry("req-4")!.change_proofs).toEqual(CHANGE);
    store.close();
  });

  it("startup reconcile quarantines interrupted (in_flight) reservations as ambiguous", () => {
    const path = tmpDbPath();
    const seed = new Store(path);
    seed.cashuReserve("req-5", MINT, 8, SENT);
    seed.close(); // crash before settle

    // On restart, CashuPayment reconciles: in_flight → ambiguous (quarantined).
    const store = new Store(path);
    const payment = new CashuPayment({ mintUrl: MINT, walletDbPath: join(tmpdir(), "unused.json"), journal: store });
    expect(payment.reconcileJournal()).toBe(1);

    const entry = store.cashuJournalEntry("req-5")!;
    expect(entry.state).toBe("ambiguous");
    // Ambiguous proofs stay recorded (not lost) and are not re-added to any
    // available balance (not double-spent) until a mint check resolves them.
    expect(entry.sent_proofs).toEqual(SENT);
    // A second reconcile is a no-op (only in_flight rows are quarantined).
    expect(payment.reconcileJournal()).toBe(0);
    store.close();
  });

  it("encrypts proof secrets at rest when an identity key is configured", () => {
    const path = tmpDbPath();
    const sk = generateSecretKey();
    const store = new Store(path, sk);
    store.cashuReserve("req-6", MINT, 8, SENT);

    // Raw column is ciphertext — the proof secret never appears in plaintext.
    const raw = (store as any).db
      .prepare("SELECT sent_proofs FROM cashu_journal WHERE request_id = ?")
      .get("req-6") as { sent_proofs: string };
    expect(raw.sent_proofs.startsWith("nip44:")).toBe(true);
    expect(raw.sent_proofs).not.toContain("s-sent-1");
    // Read path transparently decrypts.
    expect(store.cashuJournalEntry("req-6")!.sent_proofs).toEqual(SENT);
    store.close();
  });
});

describe("COORD-5 — Cashu request-failure + settle ordering", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function tmpPath(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), "nostrautica-cashu5-"));
    tmpDirs.push(dir);
    return join(dir, name);
  }

  it("fail() quarantines the in-flight reservation as ambiguous (proofs neither lost nor re-credited)", async () => {
    const store = new Store(":memory:");
    store.cashuReserve("req-f1", MINT, 8, SENT);
    const payment = new CashuPayment({ mintUrl: MINT, walletDbPath: tmpPath("w.json"), journal: store });
    (payment as any).pendingRequestId = "req-f1"; // a prepare() happened

    await payment.fail();
    expect((payment as any).pendingRequestId).toBeUndefined();
    const entry = store.cashuJournalEntry("req-f1")!;
    expect(entry.state).toBe("ambiguous");
    expect(entry.sent_proofs).toEqual(SENT); // still recorded, never re-credited
    store.close();
  });

  it("settle() journals the change proofs BEFORE redeeming them into the wallet", async () => {
    const store = new Store(":memory:");
    store.cashuReserve("req-s1", MINT, 8, SENT);
    const payment = new CashuPayment({ mintUrl: MINT, walletDbPath: tmpPath("w.json"), journal: store });
    (payment as any).pendingRequestId = "req-s1";
    (payment as any).loaded = true; // skip the mint keyset fetch (offline test)

    // A well-formed change token; the mint is unreachable, so wallet.receive
    // throws — but the change must ALREADY be in the durable journal.
    const changeToken = getEncodedTokenV4({ mint: MINT, proofs: CHANGE_ENC as any });
    await payment.settle(new Headers({ "X-Cashu": changeToken }));

    const entry = store.cashuJournalEntry("req-s1")!;
    expect(entry.state).toBe("settled");
    expect(entry.change_proofs).toEqual(CHANGE_ENC); // survived the receive crash
    store.close();
  });

  it("settle() with no change closes the reservation", async () => {
    const store = new Store(":memory:");
    store.cashuReserve("req-s2", MINT, 8, SENT);
    const payment = new CashuPayment({ mintUrl: MINT, walletDbPath: tmpPath("w.json"), journal: store });
    (payment as any).pendingRequestId = "req-s2";
    await payment.settle(new Headers());
    expect(store.cashuJournalEntry("req-s2")!.state).toBe("settled");
    store.close();
  });

  it("the wallet file is written owner-only (mode 0600)", () => {
    const walletPath = tmpPath("wallet.json");
    const payment = new CashuPayment({ mintUrl: MINT, walletDbPath: walletPath });
    (payment as any).save({ mint: MINT, proofs: [] });
    const mode = statSync(walletPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
