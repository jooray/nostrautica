/**
 * At-rest encryption of the coordinator's event-key columns (F1,
 * ENCRYPTION-AND-PRIVACY.md): round-trip, transparent startup migration of
 * legacy plaintext rows, and idempotency of that migration.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSecretKey } from "nostr-tools/pure";
import { bytesToHex } from "@nostrautica/protocol";
import { Store } from "./db.js";

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
