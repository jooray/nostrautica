/**
 * At-rest encryption of the coordinator's event-key columns (F1,
 * ENCRYPTION-AND-PRIVACY.md): round-trip, transparent startup migration of
 * legacy plaintext rows, and idempotency of that migration.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSecretKey } from "nostr-tools/pure";
import { bytesToHex } from "@nostrautica/protocol";
import { Store, acquireDaemonLock, inspectDatabaseReadOnly, SCHEMA_VERSION } from "./db.js";

const ENC_PREFIX = "nip44:";

function rawEventRow(store: Store, coordinate: string): { inbox_nsec: string; eck_json: string } {
  return (store as any).db
    .prepare("SELECT inbox_nsec, eck_json FROM events WHERE coordinate = ?")
    .get(coordinate);
}

const COORD = "31923:aaaa:test-event";
const INBOX_NSEC = bytesToHex(generateSecretKey());
const ECK_JSON = JSON.stringify([{ id: 1, key: "c2VjcmV0LWVjay1ieXRlcy1oZXJlLTMyISEhISEhISE=" }]);

function upsert(store: Store, coordinate = COORD): void {
  store.upsertEvent({
    coordinate,
    configJson: "{}",
    inboxNsec: INBOX_NSEC,
    eckJson: ECK_JSON,
    configRelays: JSON.stringify(["wss://test"]),
    now: 1,
  });
}

describe("Store at-rest key encryption (F1)", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function tmpDbPath(): string {
    const dir = mkdtempSync(join(tmpdir(), "nostrautica-store-"));
    tmpDirs.push(dir);
    return join(dir, "test.sqlite");
  }

  it("encrypts on write, decrypts on read (round-trip)", () => {
    const sk = generateSecretKey();
    const store = new Store(":memory:", sk);
    upsert(store);

    // Raw columns are ciphertext with the marker prefix; secrets never appear.
    const raw = rawEventRow(store, COORD);
    expect(raw.inbox_nsec.startsWith(ENC_PREFIX)).toBe(true);
    expect(raw.eck_json.startsWith(ENC_PREFIX)).toBe(true);
    expect(raw.inbox_nsec).not.toContain(INBOX_NSEC);
    expect(raw.eck_json).not.toContain("c2VjcmV0");

    // Read paths return plaintext.
    const row = store.getEvent(COORD);
    expect(row?.inbox_nsec).toBe(INBOX_NSEC);
    expect(row?.eck_json).toBe(ECK_JSON);
    expect(store.allEvents()[0]?.inbox_nsec).toBe(INBOX_NSEC);
    store.close();
  });

  it("migrates legacy plaintext rows in place on startup, one-way and idempotent", () => {
    const path = tmpDbPath();

    // A pre-fix store (no identity key) persists the keys in plaintext.
    const legacy = new Store(path);
    upsert(legacy);
    expect(rawEventRow(legacy, COORD).inbox_nsec).toBe(INBOX_NSEC);
    legacy.close();

    // Reopening with the identity key re-encrypts the row in place…
    const sk = generateSecretKey();
    const migrated = new Store(path, sk);
    const raw1 = rawEventRow(migrated, COORD);
    expect(raw1.inbox_nsec.startsWith(ENC_PREFIX)).toBe(true);
    expect(raw1.eck_json.startsWith(ENC_PREFIX)).toBe(true);
    // …and reads keep working transparently.
    expect(migrated.getEvent(COORD)?.inbox_nsec).toBe(INBOX_NSEC);
    expect(migrated.getEvent(COORD)?.eck_json).toBe(ECK_JSON);
    migrated.close();

    // Idempotent: a second startup leaves the already-encrypted row untouched
    // (NIP-44 is randomized — a re-encryption would change the ciphertext).
    const again = new Store(path, sk);
    const raw2 = rawEventRow(again, COORD);
    expect(raw2.inbox_nsec).toBe(raw1.inbox_nsec);
    expect(raw2.eck_json).toBe(raw1.eck_json);
    expect(again.getEvent(COORD)?.inbox_nsec).toBe(INBOX_NSEC);
    again.close();
  });

  it("migrates only the plaintext rows in a mixed table", () => {
    const path = tmpDbPath();
    const sk = generateSecretKey();

    const first = new Store(path, sk);
    upsert(first, "31923:aaaa:already-encrypted");
    const encryptedBefore = rawEventRow(first, "31923:aaaa:already-encrypted");
    first.close();

    const legacy = new Store(path); // plaintext writer (no key)
    upsert(legacy, "31923:bbbb:legacy");
    legacy.close();

    const store = new Store(path, sk);
    // The already-encrypted row is byte-identical (skipped by the migration)…
    expect(rawEventRow(store, "31923:aaaa:already-encrypted")).toEqual(encryptedBefore);
    // …the legacy row is now encrypted, and both decrypt correctly.
    expect(rawEventRow(store, "31923:bbbb:legacy").inbox_nsec.startsWith(ENC_PREFIX)).toBe(true);
    expect(store.getEvent("31923:aaaa:already-encrypted")?.inbox_nsec).toBe(INBOX_NSEC);
    expect(store.getEvent("31923:bbbb:legacy")?.inbox_nsec).toBe(INBOX_NSEC);
    store.close();
  });

  it("refuses to reveal encrypted rows without the identity key", () => {
    const path = tmpDbPath();
    const sk = generateSecretKey();
    const writer = new Store(path, sk);
    upsert(writer);
    writer.close();

    const keyless = new Store(path);
    expect(() => keyless.getEvent(COORD)).toThrow(/no identity key/);
    keyless.close();
  });
});

describe("pipeline artifacts + job status (audit H7 / Q12)", () => {
  it("content-addresses an artifact and encrypts its output at rest (H7)", () => {
    const sk = generateSecretKey();
    const store = new Store(":memory:", sk);
    const output = { summary: "sensitive attendee portrait", skills: ["zk"] };
    store.putArtifact({ stage: "ai_profile", inputsHash: "hash-1", provider: "venice", model: "m", output, now: 1 });

    // Read path returns the plaintext object…
    expect(store.getArtifact("ai_profile", "hash-1")).toEqual(output);
    expect(store.getArtifact("ai_profile", "missing")).toBeUndefined();
    // …but the raw column holds NIP-44 ciphertext, not the attendee text.
    const raw = (store as any).db
      .prepare("SELECT output_json FROM pipeline_artifacts WHERE stage = ? AND inputs_hash = ?")
      .get("ai_profile", "hash-1") as { output_json: string };
    expect(raw.output_json.startsWith("nip44:")).toBe(true);
    expect(raw.output_json).not.toContain("sensitive");

    // insert-or-ignore: a duplicate key does not overwrite (concurrent-dup safety).
    store.putArtifact({ stage: "ai_profile", inputsHash: "hash-1", provider: "venice", model: "m", output: { summary: "changed" }, now: 2 });
    expect(store.getArtifact("ai_profile", "hash-1")).toEqual(output);
    store.close();
  });

  it("records and queries organizer-visible poison status (Q12)", () => {
    const store = new Store();
    store.recordJobStatus({
      coordinate: "31923:aaaa:ev", stage: "process_attendee", pubkey: "b".repeat(64),
      state: "poison", attempts: 5, error_category: "media_fetch", retryable: 1, updated_at: 10,
    });
    const rows = store.poisonStatuses("31923:aaaa:ev");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stage: "process_attendee", state: "poison", error_category: "media_fetch" });
    // A later success clears it (upsert on the same key).
    store.recordJobStatus({
      coordinate: "31923:aaaa:ev", stage: "process_attendee", pubkey: "b".repeat(64),
      state: "cleared", attempts: 5, error_category: "media_fetch", retryable: 0, updated_at: 20,
    });
    expect(store.poisonStatuses("31923:aaaa:ev")).toHaveLength(0);
    store.close();
  });

  it("clearPoisonStatuses recovers every poisoned stage for an attendee (COORD-15)", () => {
    const store = new Store();
    const pk = "b".repeat(64);
    for (const stage of ["process_attendee", "match_recompute"]) {
      store.recordJobStatus({
        coordinate: "31923:aaaa:ev", stage, pubkey: pk,
        state: "poison", attempts: 5, error_category: "processing_error", retryable: 1, updated_at: 10,
      });
    }
    // Another attendee's poison is untouched.
    store.recordJobStatus({
      coordinate: "31923:aaaa:ev", stage: "process_attendee", pubkey: "c".repeat(64),
      state: "poison", attempts: 5, error_category: "processing_error", retryable: 1, updated_at: 10,
    });
    expect(store.clearPoisonStatuses("31923:aaaa:ev", pk)).toBe(2);
    const remaining = store.poisonStatuses("31923:aaaa:ev");
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.pubkey).toBe("c".repeat(64));
    store.close();
  });
});

describe("chat-key binding ownership (audit COORD-10)", () => {
  const CO = "31923:aaaa:ev";
  const A = "a".repeat(64);
  const B = "b".repeat(64);
  const KEY = "c".repeat(64);

  it("a chat_pubkey bound to account A cannot be re-pointed to account B", () => {
    const store = new Store();
    expect(store.upsertChatKey({ coordinate: CO, accountPubkey: A, chatPubkey: KEY, now: 1 })).toBe(true);
    // The steal attempt is refused and the binding is untouched.
    expect(store.upsertChatKey({ coordinate: CO, accountPubkey: B, chatPubkey: KEY, now: 2 })).toBe(false);
    const row = store.getChatKey(CO, KEY)!;
    expect(row.account_pubkey).toBe(A);
    expect(row.updated_at).toBe(1);
    // The OWNER may update its own binding (idempotent re-attest).
    expect(store.upsertChatKey({ coordinate: CO, accountPubkey: A, chatPubkey: KEY, clientId: "dev-1", now: 3 })).toBe(true);
    expect(store.getChatKey(CO, KEY)!.client_id).toBe("dev-1");
    store.close();
  });

  it("one account binds MULTIPLE distinct device keys (multi-device), each with its label", () => {
    const store = new Store();
    const KEY2 = "d".repeat(64);
    // Device 1 and device 2 (fresh storage → different keys) both bind to account A.
    expect(
      store.upsertChatKey({ coordinate: CO, accountPubkey: A, chatPubkey: KEY, label: "Chrome on macOS", now: 1 }),
    ).toBe(true);
    expect(
      store.upsertChatKey({ coordinate: CO, accountPubkey: A, chatPubkey: KEY2, label: "Firefox on Android", now: 2 }),
    ).toBe(true);
    const keys = store.chatKeysForAccount(CO, A);
    expect(keys.map((k) => k.chat_pubkey).sort()).toEqual([KEY, KEY2].sort());
    expect(store.getChatKey(CO, KEY)!.label).toBe("Chrome on macOS");
    expect(store.getChatKey(CO, KEY2)!.label).toBe("Firefox on Android");
    expect(keys.every((k) => k.status === "active")).toBe(true);
    store.close();
  });
});

describe("invite claim atomicity (audit COORD-25)", () => {
  it("the INSERT is the claim: first writer wins, a rival loses, same-attendee is idempotent", () => {
    const store = new Store();
    const invite = "i".repeat(64);
    const alice = "a".repeat(64);
    const bob = "b".repeat(64);
    expect(store.claimInvite("31923:aaaa:ev", invite, alice, 1)).toBe(true);
    expect(store.claimInvite("31923:aaaa:ev", invite, bob, 2)).toBe(false); // lost the race
    expect(store.claimInvite("31923:aaaa:ev", invite, alice, 3)).toBe(true); // idempotent re-delivery
    store.close();
  });
});

describe("TTL pruning (audit COORD-24 / P0-1)", () => {
  it("prunes old consumed key packages but RETAINS seen_rumors (replay guard)", () => {
    const store = new Store();
    const DAY = 24 * 60 * 60 * 1000;
    const now = 100 * DAY;
    store.markRumorSeen("old-rumor", now - 40 * DAY);
    store.markRumorSeen("fresh-rumor", now - 5 * DAY);
    store.markKpConsumed("31923:aaaa:ev", "old-kp", now - 90 * DAY);
    store.markKpConsumed("31923:aaaa:ev", "fresh-kp", now - 1 * DAY);

    // Only the stale key package is pruned; seen_rumors are kept so a since:0
    // inbox rescan can't resurrect an old command past the old 30-day TTL (P0-1).
    expect(store.pruneOldData(now)).toBe(1);
    expect(store.isRumorSeen("old-rumor")).toBe(true); // retained (was pruned pre-fix)
    expect(store.isRumorSeen("fresh-rumor")).toBe(true);
    expect(store.isKpConsumed("31923:aaaa:ev", "old-kp")).toBe(false);
    expect(store.isKpConsumed("31923:aaaa:ev", "fresh-kp")).toBe(true);
    store.close();
  });

  it("expires dead inbox rate buckets and terminal job rows (audit R4)", () => {
    const store = new Store();
    const db = (store as any).db;
    const DAY = 24 * 60 * 60 * 1000;
    const now = 100 * DAY;
    // Inbox rate buckets: a currently-active sender + a long-dead one.
    store.bumpInboxRate("31923:x:e", "fresh-sender", now, 60_000);
    db.prepare("INSERT INTO inbox_rate (coordinate, pubkey, window_start, count) VALUES (?, ?, ?, ?)").run(
      "31923:x:e",
      "stale-sender",
      now - 2 * 60 * 60 * 1000, // 2h old (windows are 60s)
      5,
    );
    // Jobs: old terminal (done/poison) + a fresh terminal + a pending one.
    const insJob = db.prepare(
      "INSERT INTO jobs (type, dedupe_key, payload, state, claimed_at) VALUES (?, ?, ?, ?, ?)",
    );
    insJob.run("t", "k-old-done", "{}", "done", now - 40 * DAY);
    insJob.run("t", "k-old-poison", "{}", "poison", now - 40 * DAY);
    insJob.run("t", "k-fresh-done", "{}", "done", now - 1 * DAY);
    insJob.run("t", "k-pending", "{}", "pending", now - 40 * DAY);

    store.pruneOldData(now);

    const rateSenders = (db.prepare("SELECT pubkey FROM inbox_rate").all() as { pubkey: string }[]).map((r) => r.pubkey);
    expect(rateSenders).toContain("fresh-sender");
    expect(rateSenders).not.toContain("stale-sender"); // dead window GC'd

    const jobKeys = (db.prepare("SELECT dedupe_key FROM jobs").all() as { dedupe_key: string }[]).map((r) => r.dedupe_key);
    expect(jobKeys).not.toContain("k-old-done"); // terminal + old → GC'd
    expect(jobKeys).not.toContain("k-old-poison");
    expect(jobKeys).toContain("k-fresh-done"); // terminal but recent → kept
    expect(jobKeys).toContain("k-pending"); // non-terminal → never age-expired
    store.close();
  });
});

describe("talk transcript compare-and-set (audit P0-7)", () => {
  function seedTalk(store: Store, x: string, revision: number, now: number) {
    store.upsertTalk({
      coordinate: "c",
      pubkey: "p",
      talkD: "d",
      title: "t",
      description: "",
      speakersJson: "[]",
      mediaJson: JSON.stringify({ x }),
      lang: "en",
      revision,
      mediaX: x,
      now,
    });
  }

  it("discards a stale transcript when the talk's media changed since STT started", () => {
    const store = new Store();
    seedTalk(store, "X1", 1, 1);
    // STT for the current media (X1) writes successfully.
    expect(
      store.setTalkTranscript("c", "p", "d", JSON.stringify({ x: "X1", text: "one" }), 2, "X1"),
    ).toBe(true);
    expect(JSON.parse(store.getTalk("c", "p", "d")!.transcript_json!).text).toBe("one");

    // Re-record: a new revision with new media X2 (upsertTalk drops the transcript).
    seedTalk(store, "X2", 2, 3);
    expect(store.getTalk("c", "p", "d")!.transcript_json).toBeNull();

    // A slow STT result for the OLD media X1 finishing now must be discarded.
    expect(
      store.setTalkTranscript("c", "p", "d", JSON.stringify({ x: "X1", text: "stale" }), 4, "X1"),
    ).toBe(false);
    expect(store.getTalk("c", "p", "d")!.transcript_json).toBeNull(); // not re-attached
    store.close();
  });

  it("rejects an out-of-order lower talk revision (P0-2 interim guard)", () => {
    const store = new Store();
    const put = (revision: number, x: string) =>
      store.upsertTalk({
        coordinate: "c",
        pubkey: "p",
        talkD: "d",
        title: `rev${revision}`,
        description: "",
        speakersJson: "[]",
        mediaJson: JSON.stringify({ x }),
        lang: "en",
        revision,
        mediaX: x,
        now: revision,
      });
    expect(put(2, "X2")).toBe(true);
    store.setTalkStatus("c", "p", "d", "published", 10, 10);
    // A delayed revision 0 must NOT overwrite revision 2 or reset moderation.
    expect(put(0, "X0")).toBe(false);
    const talk = store.getTalk("c", "p", "d")!;
    expect(talk.revision).toBe(2);
    expect(talk.title).toBe("rev2");
    expect(talk.status).toBe("published"); // moderation not reset by the stale write
    // A genuine higher revision still applies (and resets to pending).
    expect(put(3, "X3")).toBe(true);
    expect(store.getTalk("c", "p", "d")!.status).toBe("pending");
    store.close();
  });

  it("rejects an equal-revision talk with different content, no-ops on identical (NIP §3.3)", () => {
    const store = new Store();
    const put = (revision: number, title: string, x: string) =>
      store.upsertTalk({
        coordinate: "c", pubkey: "p", talkD: "d",
        title, description: "", speakersJson: "[]",
        mediaJson: JSON.stringify({ x }), lang: "en",
        revision, mediaX: x, now: revision,
      });
    expect(put(1, "original", "X1")).toBe(true);
    // Same revision, DIFFERENT content → rejected, stored talk untouched.
    expect(put(1, "tampered", "X2")).toBe(false);
    expect(store.getTalk("c", "p", "d")!.title).toBe("original");
    // Same revision, IDENTICAL content → idempotent no-op (still rejected as a write).
    expect(put(1, "original", "X1")).toBe(false);
    expect(store.getTalk("c", "p", "d")!.title).toBe("original");
    // Higher revision with the tampered content → accepted.
    expect(put(2, "tampered", "X2")).toBe(true);
    expect(store.getTalk("c", "p", "d")!.title).toBe("tampered");
    store.close();
  });
});

describe("durable monotonic-publish watermark (NIP §3.2, reliability tail)", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function tmpDbPath(): string {
    const dir = mkdtempSync(join(tmpdir(), "nostrautica-wm-"));
    tmpDirs.push(dir);
    return join(dir, "test.sqlite");
  }

  it("is strictly increasing per address and survives a restart", () => {
    const path = tmpDbPath();
    const store = new Store(path);
    const addr = "31605:blinded-d";
    // Same wall-clock second → strictly increasing.
    expect(store.nextPublishCreatedAt(addr, 1000)).toBe(1000);
    expect(store.nextPublishCreatedAt(addr, 1000)).toBe(1001);
    expect(store.nextPublishCreatedAt(addr, 1000)).toBe(1002);
    // A different address is independent.
    expect(store.nextPublishCreatedAt("31604:other", 1000)).toBe(1000);
    store.close();

    // Restart: a fresh Store on the same file keeps monotonicity even when the
    // wall clock has NOT advanced past the last-published second.
    const store2 = new Store(path);
    expect(store2.nextPublishCreatedAt(addr, 1000)).toBe(1003);
    store2.close();
  });
});

describe("single-daemon lock (reliability tail)", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function tmpDbPath(): string {
    const dir = mkdtempSync(join(tmpdir(), "nostrautica-lock-"));
    tmpDirs.push(dir);
    return join(dir, "test.sqlite");
  }

  it("a second daemon on the same store fails fast with a clear error", () => {
    const path = tmpDbPath();
    const lock = acquireDaemonLock(path);
    expect(() => acquireDaemonLock(path)).toThrow(/already running/i);
    // Released → a new daemon can acquire it.
    lock.release();
    const lock2 = acquireDaemonLock(path);
    lock2.release();
  });

  it(":memory: takes no lock (private connection)", () => {
    const a = acquireDaemonLock(":memory:");
    const b = acquireDaemonLock(":memory:");
    a.release();
    b.release();
  });
});

// ── O3: numbered, transactional schema migrations ─────────────────────────────
describe("schema migrations (audit O3)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function tmpDb(): string {
    const dir = mkdtempSync(join(tmpdir(), "nostrautica-mig-"));
    dirs.push(dir);
    return join(dir, "coordinator.sqlite");
  }

  it("a fresh database is stamped at SCHEMA_VERSION with the remediation tables", () => {
    const path = tmpDb();
    const store = new Store(path);
    expect(store.schemaVersion()).toBe(SCHEMA_VERSION);
    const info = inspectDatabaseReadOnly(path);
    expect(info.userVersion).toBe(SCHEMA_VERSION);
    expect(info.schemaTooNew).toBe(false);
    store.close();
  });

  it("upgrades a version-1 fixture and adds the version-2 tables", async () => {
    const path = tmpDb();
    // A pre-versioning database: only the events table, stamped user_version = 1
    // (the historical single-version marker).
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(path);
    raw.exec("CREATE TABLE events (coordinate TEXT PRIMARY KEY, config_json TEXT, inbox_nsec TEXT, eck_json TEXT, config_relays TEXT, updated_at INTEGER)");
    raw.exec("PRAGMA user_version = 1");
    raw.close();

    // Opening with the current binary migrates it up to SCHEMA_VERSION.
    const store = new Store(path);
    expect(store.schemaVersion()).toBe(SCHEMA_VERSION);
    // The version-2 remediation tables now exist and are usable.
    expect(store.attendeeCount("31923:x:e")).toBe(0);
    store.bumpInboxRate("31923:x:e", "", 0, 60_000); // inbox_rate exists
    store.recordTranscriptRef("blob", "31923:x:e", "pk", 0); // transcript_refs exists
    store.close();
  });

  it("re-keys invite_usage per redeemer, keeping the codes already spent (v5)", async () => {
    const path = tmpDb();
    // A pre-v5 database: one row per CODE, so it cannot represent two redeemers.
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(path);
    raw.exec(
      `CREATE TABLE invite_usage (coordinate TEXT NOT NULL, invite_pubkey TEXT NOT NULL,
         used_by TEXT NOT NULL, used_at INTEGER NOT NULL,
         PRIMARY KEY (coordinate, invite_pubkey))`,
    );
    raw
      .prepare("INSERT INTO invite_usage (coordinate, invite_pubkey, used_by, used_at) VALUES (?, ?, ?, ?)")
      .run("31923:e:x", "code1", "alice", 10);
    raw.exec("PRAGMA user_version = 4");
    raw.close();

    const store = new Store(path);
    expect(store.schemaVersion()).toBe(SCHEMA_VERSION);
    // The spent single-use code stays spent — the migration must not re-open it.
    expect(store.inviteRedemptions("31923:e:x", "code1")).toBe(1);
    expect(store.claimInvite("31923:e:x", "code1", "bob", 20, 1)).toBe(false);
    expect(store.claimInvite("31923:e:x", "code1", "alice", 20, 1)).toBe(true); // idempotent
    // And the new shape can now hold several redeemers of one code.
    expect(store.claimInvite("31923:e:x", "code2", "alice", 20, 2)).toBe(true);
    expect(store.claimInvite("31923:e:x", "code2", "bob", 20, 2)).toBe(true);
    expect(store.claimInvite("31923:e:x", "code2", "carol", 20, 2)).toBe(false);
    expect(store.inviteRedemptions("31923:e:x", "code2")).toBe(2);
    store.close();
  });

  it("REFUSES to open a database written by a newer binary", async () => {
    const path = tmpDb();
    const store = new Store(path);
    store.close();
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(path);
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 5}`);
    raw.close();
    expect(() => new Store(path)).toThrow(/newer coordinator/i);
  });

  it("migrates v2 membership watermarks onto the unified member: subject (audit R2)", async () => {
    const path = tmpDb();
    // A version-2 database (baseline shape) with the OLD split membership subjects:
    // organizer approve/revoke under `pubkey:<pk>`, withdrawals under `withdraw:<pk>`.
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(path);
    raw.exec(
      `CREATE TABLE command_watermarks (coordinate TEXT NOT NULL, subject TEXT NOT NULL,
         created_at INTEGER NOT NULL, rumor_id TEXT NOT NULL,
         state TEXT NOT NULL DEFAULT 'complete', progress_json TEXT,
         PRIMARY KEY (coordinate, subject))`,
    );
    const ins = raw.prepare(
      "INSERT INTO command_watermarks (coordinate, subject, created_at, rumor_id, state, progress_json) VALUES (?, ?, ?, ?, ?, ?)",
    );
    // Attendee ALICE: an approve@100 and a LATER withdrawal@200 collide onto member:alice;
    // the newer withdrawal (created_at 200) must WIN and carry its progress.
    ins.run("31923:e:x", "pubkey:alice", 100, "r-approve", "complete", null);
    ins.run("31923:e:x", "withdraw:alice", 200, "r-withdraw", "pending", '{"eckRotation":1}');
    // Attendee BOB: only an approve — renamed, unchanged.
    ins.run("31923:e:x", "pubkey:bob", 50, "r-bob", "complete", null);
    // A non-membership subject (talk:) is left untouched.
    ins.run("31923:e:x", "talk:carol:t1", 10, "r-talk", "complete", null);
    raw.exec("PRAGMA user_version = 2");
    raw.close();

    const store = new Store(path);
    expect(store.schemaVersion()).toBe(SCHEMA_VERSION);
    // ALICE: the two split rows merged to member:alice, the NEWER withdrawal winning.
    const alice = store.getCommandWatermark("31923:e:x", "member:alice");
    expect(alice).toMatchObject({ created_at: 200, rumor_id: "r-withdraw", state: "pending", progress_json: '{"eckRotation":1}' });
    expect(store.getCommandWatermark("31923:e:x", "pubkey:alice")).toBeUndefined();
    expect(store.getCommandWatermark("31923:e:x", "withdraw:alice")).toBeUndefined();
    // BOB: renamed onto member:bob.
    expect(store.getCommandWatermark("31923:e:x", "member:bob")).toMatchObject({ created_at: 50, rumor_id: "r-bob" });
    // The talk: subject is untouched.
    expect(store.getCommandWatermark("31923:e:x", "talk:carol:t1")).toMatchObject({ rumor_id: "r-talk" });
    store.close();
  });

  it("quarantines a legacy unreferenced pipeline artifact and GCs it after the grace window (audit R11)", async () => {
    const path = tmpDb();
    // A v2-shaped DB: an OLD pipeline_artifacts (no quarantined_at column) holding a
    // row with NO artifact_refs — exactly the pre-v2 legacy artifact the ref-counted
    // purge can never reach, so it would survive forever.
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(path);
    raw.exec(
      `CREATE TABLE pipeline_artifacts (stage TEXT NOT NULL, inputs_hash TEXT NOT NULL,
         provider TEXT NOT NULL, model TEXT NOT NULL, output_json TEXT NOT NULL,
         created_at INTEGER NOT NULL, PRIMARY KEY (stage, inputs_hash))`,
    );
    raw
      .prepare(
        "INSERT INTO pipeline_artifacts (stage, inputs_hash, provider, model, output_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("ai_profile", "legacyhash", "venice", "m", "{}", 1);
    raw.exec("PRAGMA user_version = 1");
    raw.close();

    const store = new Store(path);
    expect(store.schemaVersion()).toBe(SCHEMA_VERSION);
    const db = (store as any).db;
    const q = db
      .prepare("SELECT quarantined_at FROM pipeline_artifacts WHERE stage='ai_profile' AND inputs_hash='legacyhash'")
      .get() as { quarantined_at: number | null };
    expect(q.quarantined_at).not.toBeNull(); // migration quarantined the orphan

    // A prune within the grace window keeps it (recently quarantined).
    store.pruneOldData(q.quarantined_at! + 1000);
    expect((db.prepare("SELECT COUNT(*) AS n FROM pipeline_artifacts").get() as { n: number }).n).toBe(1);

    // After the grace window elapses, a still-unreferenced orphan is GC'd.
    store.pruneOldData(q.quarantined_at! + 31 * 24 * 60 * 60 * 1000);
    expect((db.prepare("SELECT COUNT(*) AS n FROM pipeline_artifacts").get() as { n: number }).n).toBe(0);
    store.close();
  });

  it("a live event reclaims a quarantined legacy artifact via a cache-hit ref (audit R11)", async () => {
    const path = tmpDb();
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(path);
    raw.exec(
      `CREATE TABLE pipeline_artifacts (stage TEXT NOT NULL, inputs_hash TEXT NOT NULL,
         provider TEXT NOT NULL, model TEXT NOT NULL, output_json TEXT NOT NULL,
         created_at INTEGER NOT NULL, PRIMARY KEY (stage, inputs_hash))`,
    );
    raw
      .prepare(
        "INSERT INTO pipeline_artifacts (stage, inputs_hash, provider, model, output_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("ai_profile", "legacyhash", "venice", "m", "{}", 1);
    raw.exec("PRAGMA user_version = 1");
    raw.close();

    const store = new Store(path);
    const db = (store as any).db;
    // A live event uses the artifact via a cache hit → records ownership, clearing
    // the quarantine. The GC must then NEVER delete it even long after the window.
    store.recordArtifactRef("ai_profile", "legacyhash", { coordinate: "31923:e:live", pubkey: "alice" }, 5);
    const q = db
      .prepare("SELECT quarantined_at FROM pipeline_artifacts WHERE inputs_hash='legacyhash'")
      .get() as { quarantined_at: number | null };
    expect(q.quarantined_at).toBeNull(); // reclaimed
    store.pruneOldData(1000 * 24 * 60 * 60 * 1000); // way past any window
    expect((db.prepare("SELECT COUNT(*) AS n FROM pipeline_artifacts").get() as { n: number }).n).toBe(1);
    store.close();
  });

  it("cross-event cache-hit refcounting: a shared artifact survives until every owner purges (audit R11)", () => {
    const store = new Store();
    const c1 = "31923:e:one";
    const c2 = "31923:e:two";
    store.upsertAttendee({ coordinate: c1, pubkey: "alice", status: "approved", now: 1 });
    store.upsertAttendee({ coordinate: c2, pubkey: "alice", status: "approved", now: 1 });
    // Event 1 GENERATES the artifact (records ownership).
    store.putArtifact({
      stage: "ai_profile",
      inputsHash: "shared",
      provider: "venice",
      model: "m",
      output: { summary: "x" },
      now: 1,
      owner: { coordinate: c1, pubkey: "alice" },
    });
    // Event 2 gets a CACHE HIT and records its own ownership (the R11 fix).
    store.recordArtifactRef("ai_profile", "shared", { coordinate: c2, pubkey: "alice" }, 2);
    const db = (store as any).db;
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM artifact_refs WHERE inputs_hash='shared'").get() as { n: number }).n,
    ).toBe(2);

    // Purging event 1 must NOT delete the artifact — event 2 still owns it.
    store.purgeEventArtifacts(c1);
    expect(store.getArtifact("ai_profile", "shared")).toEqual({ summary: "x" });
    // Purging event 2 (the last owner) finally deletes it.
    store.purgeEventArtifacts(c2);
    expect(store.getArtifact("ai_profile", "shared")).toBeUndefined();
    store.close();
  });
});

// ── O2: doctor's read-only inspection leaves the file byte-identical ──────────
describe("read-only inspection (audit O2)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("inspecting an OLD-schema database does not mutate it (byte-identical)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nostrautica-doctor-"));
    dirs.push(dir);
    const path = join(dir, "old.sqlite");
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(path);
    raw.exec("CREATE TABLE events (coordinate TEXT PRIMARY KEY, inbox_nsec TEXT, eck_json TEXT)");
    raw.exec("PRAGMA user_version = 1");
    raw.close();
    const before = readFileSync(path);
    const info = inspectDatabaseReadOnly(path);
    expect(info.userVersion).toBe(1); // reported, NOT upgraded
    expect(info.integrity).toBe("ok");
    const after = readFileSync(path);
    expect(after.equals(before)).toBe(true); // no migration ran
  });
});

// ── C3: inbox rate accounting + population caps ───────────────────────────────
describe("inbox rate accounting + population caps (audit C3)", () => {
  it("counts per-sender rumors within a window and resets across windows", () => {
    const store = new Store();
    const c = "31923:x:e";
    expect(store.bumpInboxRate(c, "alice", 1000, 60_000)).toBe(1);
    expect(store.bumpInboxRate(c, "alice", 1500, 60_000)).toBe(2);
    expect(store.bumpInboxRate(c, "alice", 2000, 60_000)).toBe(3);
    // A later window (past the 60s boundary) resets to 1.
    expect(store.bumpInboxRate(c, "alice", 120_000, 60_000)).toBe(1);
    // Distinct sender has its own bucket.
    expect(store.bumpInboxRate(c, "bob", 120_000, 60_000)).toBe(1);
  });

  it("reports attendee population counts", () => {
    const store = new Store();
    const c = "31923:x:e";
    store.upsertAttendee({ coordinate: c, pubkey: "a", status: "pending", now: 1 });
    store.upsertAttendee({ coordinate: c, pubkey: "b", status: "approved", now: 1 });
    store.upsertAttendee({ coordinate: c, pubkey: "d", status: "pending", now: 1 });
    expect(store.attendeeCount(c)).toBe(3);
    expect(store.pendingAttendeeCount(c)).toBe(2);
  });
});

// ── C5: reference-counted deletion of shared derived artifacts ────────────────
describe("reference-counted purge (audit C5)", () => {
  it("keeps a shared transcript/summary/artifact alive for another event", () => {
    const store = new Store();
    const A = "31923:x:eventA";
    const B = "31923:x:eventB";
    // Same attendee 'pk' shares a deduplicated transcript + summary + artifact
    // across two events.
    store.putTranscript("blobX", "hello", 1, "en", { coordinate: A, pubkey: "pk" });
    store.putTranscript("blobX", "hello", 1, "en", { coordinate: B, pubkey: "pk" });
    store.putSummary("pk", "ih", "sum", 1, { coordinate: A });
    store.putSummary("pk", "ih", "sum", 1, { coordinate: B });
    store.putArtifact({ stage: "ai_profile", inputsHash: "ph", provider: "p", model: "m", output: { a: 1 }, now: 1, owner: { coordinate: A, pubkey: "pk" } });
    store.putArtifact({ stage: "ai_profile", inputsHash: "ph", provider: "p", model: "m", output: { a: 1 }, now: 1, owner: { coordinate: B, pubkey: "pk" } });
    // Give each event an attendee row referencing the profile media blob.
    store.upsertAttendee({ coordinate: A, pubkey: "pk", status: "approved", profileJson: JSON.stringify({ __media: [{ x: "blobX" }] }), now: 1 });
    store.upsertAttendee({ coordinate: B, pubkey: "pk", status: "approved", profileJson: JSON.stringify({ __media: [{ x: "blobX" }] }), now: 1 });

    // Purge the attendee from event A only.
    store.purgeAttendeeArtifacts(A, "pk");
    expect(store.getAttendee(A, "pk")).toBeUndefined();
    // Event B's copies survive (still referenced by B).
    expect(store.getTranscript("blobX")).toBe("hello");
    expect(store.getSummary("pk", "ih")).toBe("sum");
    expect(store.getArtifact("ai_profile", "ph")).toEqual({ a: 1 });

    // Now purge B: the last reference is gone, so the payloads are deleted.
    store.purgeAttendeeArtifacts(B, "pk");
    expect(store.getTranscript("blobX")).toBeUndefined();
    expect(store.getSummary("pk", "ih")).toBeUndefined();
    expect(store.getArtifact("ai_profile", "ph")).toBeUndefined();
  });

  it("purgeEventArtifacts removes all local rows for an event", () => {
    const store = new Store();
    const c = "31923:x:e";
    store.upsertAttendee({ coordinate: c, pubkey: "pk", status: "approved", profileJson: JSON.stringify({ __media: [{ x: "b1" }] }), now: 1 });
    store.putTranscript("b1", "t", 1, "en", { coordinate: c, pubkey: "pk" });
    store.putSummary("pk", "ih", "s", 1, { coordinate: c });
    store.addUsage(c, "pk", { bytes: 10, calls: 1 }, 1);
    store.bumpInboxRate(c, "pk", 1, 60_000);
    store.purgeEventArtifacts(c);
    expect(store.getAttendee(c, "pk")).toBeUndefined();
    expect(store.getTranscript("b1")).toBeUndefined();
    expect(store.getSummary("pk", "ih")).toBeUndefined();
    expect(store.getEventUsage(c)).toEqual({ bytes: 0, durationSec: 0, calls: 0 });
  });
});

/**
 * The job queue's memory of finished work (production incident 2026-07-24). The
 * dedupe key is what stops a re-delivered rumor or a mid-pipeline restart from
 * paying twice — but a TERMINAL row keeps that key for 30 days, so the same key
 * asked for again is discarded permanently. That is correct for a redelivery and
 * catastrophic for a recompute, which deliberately throws the results away first.
 */
describe("job enqueue outcomes and the recompute memo reset", () => {
  const coordinate = "31923:eid:my-event";

  it("reports whether a row was created, and the existing state when it wasn't", () => {
    const store = new Store();
    expect(store.enqueueJob("work", "k", { coordinate })).toBe("enqueued");
    expect(store.enqueueJob("work", "k", { coordinate })).toBe("pending");
    const claimed = store.claimNextJob(1000, "A", 60_000)!;
    expect(store.enqueueJob("work", "k", { coordinate })).toBe("running");
    store.completeJob(claimed.id, "A");
    // The one that used to be invisible: the work is NOT queued and never will be.
    expect(store.enqueueJob("work", "k", { coordinate })).toBe("done");
  });

  it("clearMatchJobMemo frees a finished scoring key so the same batch can re-run", () => {
    const store = new Store();
    store.enqueueJob("score_batch", "batch:x", { coordinate });
    const j = store.claimNextJob(1000, "A", 60_000)!;
    store.completeJob(j.id, "A");
    expect(store.enqueueJob("score_batch", "batch:x", { coordinate })).toBe("done");

    expect(store.clearMatchJobMemo(coordinate)).toBe(1);
    expect(store.enqueueJob("score_batch", "batch:x", { coordinate })).toBe("enqueued");
  });

  it("only forgets TERMINAL matching rows — live work and other stages are untouched", () => {
    const store = new Store();
    // Live matching work: still pending/parked, must keep coalescing.
    store.enqueueJob("score_batch", "live", { coordinate });
    store.enqueueJob("publish_matches", "parked", { coordinate });
    const parked = store.claimNextJob(1000, "A", 60_000)!;
    store.claimNextJob(1000, "B", 60_000); // claim the other so parkJob targets the right row
    store.parkJob(parked.id, "budget", "A");
    // A finished job from a DIFFERENT stage: re-running it would re-bill STT.
    store.enqueueJob("process_attendee", "proc:done", { coordinate });
    const proc = store.claimNextJob(2000, "C", 60_000)!;
    store.completeJob(proc.id, "C");
    // A finished matching row for ANOTHER event must not be swept either.
    store.enqueueJob("score_batch", "other-event", { coordinate: "31923:eid:other" });
    const other = store.claimNextJob(3000, "D", 60_000)!;
    store.completeJob(other.id, "D");

    expect(store.clearMatchJobMemo(coordinate)).toBe(0);
    expect(store.enqueueJob("process_attendee", "proc:done", { coordinate })).toBe("done");
    expect(store.enqueueJob("score_batch", "other-event", { coordinate: "31923:eid:other" })).toBe("done");
  });

  // Jobs 51 and 70 in production: process_attendee POISONED in July on a
  // translation shape fixed on 2026-07-30, and no operator action could re-run
  // them. recompute deliberately skips process_attendee (so it never re-bills
  // STT), and reprocess's own enqueue hit the poisoned row's dedupe key and was
  // silently discarded. Two attendees had no profile for two weeks.
  it("clearAttendeeJobMemo frees a POISONED profile job so reprocess can revive it", () => {
    const store = new Store();
    const pubkey = "a".repeat(64);
    store.enqueueJob("process_attendee", `proc:${coordinate}:${pubkey}:manual`, { coordinate, pubkey });
    const j = store.claimNextJob(1000, "A", 60_000)!;
    store.failJob(j.id, 5, 0, "translation contract", true, "A"); // poisoned
    // The state reprocess was stuck in: pressing the button changes nothing.
    expect(store.enqueueJob("process_attendee", `proc:${coordinate}:${pubkey}:manual`, { coordinate, pubkey })).toBe(
      "poison",
    );

    expect(store.clearAttendeeJobMemo(coordinate, pubkey)).toBe(1);
    expect(store.enqueueJob("process_attendee", `proc:${coordinate}:${pubkey}:manual`, { coordinate, pubkey })).toBe(
      "enqueued",
    );
  });

  it("clearAttendeeJobMemo touches only that attendee's terminal rows", () => {
    const store = new Store();
    const mine = "a".repeat(64);
    const theirs = "b".repeat(64);
    // Another attendee's finished row — re-running it would re-bill their STT.
    store.enqueueJob("process_attendee", "proc:theirs", { coordinate, pubkey: theirs });
    const other = store.claimNextJob(1000, "A", 60_000)!;
    store.completeJob(other.id, "A");
    // My own LIVE row must keep coalescing rather than being duplicated.
    store.enqueueJob("process_attendee", "proc:mine-live", { coordinate, pubkey: mine });

    expect(store.clearAttendeeJobMemo(coordinate, mine)).toBe(0);
    expect(store.enqueueJob("process_attendee", "proc:theirs", { coordinate, pubkey: theirs })).toBe("done");
    expect(store.enqueueJob("process_attendee", "proc:mine-live", { coordinate, pubkey: mine })).toBe("pending");
  });

  it("jobStateCounts groups the queue by state", () => {
    const store = new Store();
    store.enqueueJob("a", "1", { coordinate });
    store.enqueueJob("a", "2", { coordinate });
    const c = store.claimNextJob(1000, "A", 60_000)!;
    expect(store.jobStateCounts()).toEqual({ pending: 1, running: 1 });
    store.completeJob(c.id, "A");
    expect(store.jobStateCounts()).toEqual({ pending: 1, done: 1 });
  });
});

/**
 * prod 2026-08-04: the coordinator's serialized MLS client state is a protected
 * value that grows ~2.5 KB per device. At 25 devices it crossed NIP-44's
 * 65,535-byte plaintext ceiling, and from then on every invite to that group died
 * inside GroupSession.save() — AFTER the Add commit had already been published to
 * the group relays. The coordinator republished commits it could not remember and
 * rolled back to the stale on-disk epoch on each restart; 13 devices were locked
 * out of a chat that looked healthy to everyone already in it.
 */
describe("Store at-rest values larger than one NIP-44 plaintext", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** Shaped like serialized MLS state: repeated framing around random key material. */
  function mlsLikeState(devices: number): string {
    let out = "";
    for (let i = 0; i < devices; i++) {
      out += JSON.stringify({
        leaf: i,
        capabilities: { versions: [1], ciphersuites: [1], extensions: [1, 2, 3], proposals: [] },
        extensions: [{ type: 62193, critical: true }],
        signaturePublicKey: bytesToHex(generateSecretKey()),
        encryptionKey: bytesToHex(generateSecretKey()),
        pathSecret: bytesToHex(generateSecretKey()),
      });
    }
    return out;
  }

  function rawKv(store: Store, namespace: string, key: string): string {
    return (store as any).db
      .prepare("SELECT v FROM marmot_kv WHERE namespace = ? AND k = ?")
      .get(namespace, key).v;
  }

  it("round-trips a value well past the 65,535-byte ceiling that used to throw", () => {
    const store = new Store(":memory:", generateSecretKey());
    // ~50 devices' worth: comfortably over the ceiling, where every write threw.
    const state = mlsLikeState(400);
    expect(Buffer.byteLength(state, "utf8")).toBeGreaterThan(65535);

    store.marmotKvSet("group-state", "gid", state);
    expect(store.marmotKvGet("group-state", "gid")).toBe(state);
  });

  it("keeps growing past the point where even the packed form needs several chunks", () => {
    const store = new Store(":memory:", generateSecretKey());
    // DISTINCT random keys, not one repeated: a repeated string brotli-compresses
    // to a single chunk and would quietly prove nothing. This forces the
    // multi-chunk path, so the ceiling is gone rather than merely deferred by
    // compression.
    let huge = "";
    for (let i = 0; i < 8_000; i++) huge += bytesToHex(generateSecretKey());
    expect(Buffer.byteLength(huge, "utf8")).toBeGreaterThan(500_000);

    store.marmotKvSet("group-state", "huge", huge);
    expect(store.marmotKvGet("group-state", "huge")).toBe(huge);
    expect(rawKv(store, "group-state", "huge").split(".").length).toBeGreaterThan(1);
  });

  it("stores the oversized value encrypted, compressed, and under its own prefix", () => {
    const store = new Store(":memory:", generateSecretKey());
    const state = mlsLikeState(400);
    store.marmotKvSet("group-state", "gid", state);

    const raw = rawKv(store, "group-state", "gid");
    expect(raw.startsWith("nip44z:")).toBe(true);
    // Not a prefix of the classic marker, so old rows can never be misread.
    expect(raw.startsWith("nip44:")).toBe(false);
    // Secrets are not sitting in the column.
    expect(raw).not.toContain(state.slice(0, 64));
    // Brotli earns its place: the row is smaller than the plaintext it holds,
    // which single-shot NIP-44 (base64 + padding) could never be.
    expect(raw.length).toBeLessThan(state.length);
  });

  it("leaves small values on the classic single-shot format", () => {
    const store = new Store(":memory:", generateSecretKey());
    store.marmotKvSet("key-package", "kp", "a small value");

    const raw = rawKv(store, "key-package", "kp");
    expect(raw.startsWith(ENC_PREFIX)).toBe(true);
    expect(raw.startsWith("nip44z:")).toBe(false);
    expect(store.marmotKvGet("key-package", "kp")).toBe("a small value");
  });

  it("still reads rows written before the packed format existed", () => {
    // The fix must need no migration: every row already on disk is classic.
    const sk = generateSecretKey();
    const store = new Store(":memory:", sk);
    store.marmotKvSet("group-state", "legacy", "written by the old binary");
    expect(rawKv(store, "group-state", "legacy").startsWith(ENC_PREFIX)).toBe(true);
    expect(store.marmotKvGet("group-state", "legacy")).toBe("written by the old binary");
  });
});
