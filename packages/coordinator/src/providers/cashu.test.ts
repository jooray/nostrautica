/**
 * Cashu payment journal durability (spec §9.4, audit finding H8). Cashu proofs
 * are bearer money; the old wallet-file-only path lost the sent proofs on a crash
 * between send and settle. The journal records every reservation before its proofs
 * leave the wallet, so a restart accounts for every proof: banked change survives,
 * and reserved-but-unsettled proofs are quarantined (never re-added to the wallet
 * → no double-spend, never dropped → no loss).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSecretKey } from "nostr-tools/pure";
import { getEncodedTokenV4, MintOperationError } from "@cashu/cashu-ts";
import { Store } from "../store/db.js";
import { CashuPayment, guardedMintRequest } from "./cashu.js";

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

  it("overlapping reservations never spend the same proofs or swap each other's ids (R-49)", async () => {
    const store = new Store(":memory:");
    const walletPath = tmpPath("w.json");
    const payment = new CashuPayment({ mintUrl: MINT, walletDbPath: walletPath, journal: store, defaultAmountSats: 4 });
    const wellFormed = ["s-sent-1", "s-sent-2", "s-change-1"].map((secret, i) => ({
      ...CHANGE_ENC[0],
      amount: 4,
      secret,
      C: `0${i}`.repeat(32),
    }));
    (payment as any).save({ mint: MINT, proofs: wellFormed });
    (payment as any).loaded = true;
    // A mint swap that the first caller abandons mid-flight: it is still running
    // when the second reservation starts.
    let releaseFirst!: () => void;
    const seen: string[][] = [];
    (payment as any).wallet = {
      send: async (_amount: number, proofs: typeof wellFormed) => {
        seen.push(proofs.map((p) => p.secret));
        if (seen.length === 1) await new Promise<void>((r) => (releaseFirst = r));
        return { send: [proofs[0]], keep: proofs.slice(1) };
      },
    };
    const a = payment.reserve({});
    const b = payment.reserve({});
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toHaveLength(1); // b waits for a's swap instead of reading the same file
    releaseFirst();
    const [ra, rb] = await Promise.all([a, b]);
    expect(seen[1]).toEqual(["s-sent-2", "s-change-1"]); // a's spent proof is gone
    expect(ra.headers["X-Cashu"]).not.toBe(rb.headers["X-Cashu"]);

    // Each handle closes its own reservation.
    await rb.settle(new Headers());
    await ra.fail();
    const states = store.cashuNonterminal().map((e) => e.state);
    expect(states).toEqual(["ambiguous"]);
    store.close();
  });

  it("replaces the wallet file atomically and leaves no temp file behind (R-51)", () => {
    const walletPath = tmpPath("wallet.json");
    const payment = new CashuPayment({ mintUrl: MINT, walletDbPath: walletPath });
    writeFileSync(`${walletPath}.tmp`, "stale leftover from a crash", { mode: 0o644 });
    (payment as any).save({ mint: MINT, proofs: SENT });
    // The old inode is replaced, not truncated in place: a reader holding the old
    // file never sees a half-written one.
    const before = statSync(walletPath).ino;
    (payment as any).save({ mint: MINT, proofs: CHANGE });
    expect(statSync(walletPath).ino).not.toBe(before);
    expect(existsSync(`${walletPath}.tmp`)).toBe(false);
    expect((payment as any).load().proofs).toEqual(CHANGE);
    expect(statSync(walletPath).mode & 0o777).toBe(0o600);
  });

  it("refuses to treat a corrupt wallet file as empty, and names it (R-51)", () => {
    const walletPath = tmpPath("wallet.json");
    writeFileSync(walletPath, '{"mint":"https://mint.example","proofs":[{"am', { mode: 0o600 });
    const payment = new CashuPayment({ mintUrl: MINT, walletDbPath: walletPath });
    expect(() => (payment as any).load()).toThrow(walletPath);
    // …and nothing overwrote the damaged original, which may still be recoverable.
    expect(readFileSync(walletPath, "utf8")).toContain('"proofs":[{"am');
  });

  it("mint traffic goes through the DNS-pinning guard: a rebinding mint is refused (R-50)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const lookupFn = vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]) as any;
    const payment = new CashuPayment({
      mintUrl: "https://rebinding-mint.example",
      walletDbPath: tmpPath("w.json"),
      net: { lookupFn },
    });
    await expect(payment.fund("cashuBo2FteBtodHRwczovL21pbnQuZXhhbXBsZWF1Y3NhdA")).rejects.toThrow(/blocked/);
    expect(lookupFn).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("the guarded mint request keeps cashu-ts's wire shape and error classes", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ keysets: [] }))
      .mockResolvedValueOnce(Response.json({ code: 11001, detail: "Token already spent" }, { status: 400 }));
    vi.stubGlobal("fetch", fetchSpy);
    const request = guardedMintRequest({ allowInsecure: true }) as any;
    await expect(request({ endpoint: "https://m/v1/keysets", method: "GET" })).resolves.toEqual({ keysets: [] });
    const swap = request({ endpoint: "https://m/v1/swap", method: "POST", requestBody: { inputs: [] } });
    await expect(swap).rejects.toBeInstanceOf(MintOperationError);
    const [, init] = fetchSpy.mock.calls[1];
    expect(init.body).toBe('{"inputs":[]}');
    expect(init.headers["Content-Type"]).toBe("application/json");
    vi.unstubAllGlobals();
  });

  it("the wallet file is written owner-only (mode 0600)", () => {
    const walletPath = tmpPath("wallet.json");
    const payment = new CashuPayment({ mintUrl: MINT, walletDbPath: walletPath });
    (payment as any).save({ mint: MINT, proofs: [] });
    const mode = statSync(walletPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
