/**
 * Backup / verify / restore (§13.2 Option A): a snapshot round-trips, its
 * metadata records the truth, a wrong identity is rejected, corruption and
 * checksum tampering are caught, a newer schema is refused, and restore refuses
 * to overwrite without --force.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { bytesToHex } from "@nostrautica/protocol";
import { Store } from "./db.js";
import {
  createBackup,
  verifyBackup,
  verifyPassed,
  restoreBackup,
  metaPathFor,
  fileChecksum,
  type BackupMetadata,
} from "./backup.js";

const COORD = "31923:aaaa:test-event";
const ECK_JSON = JSON.stringify([{ id: 1, key: "c2VjcmV0LWVjay1ieXRlcy1oZXJlLTMyISEhISEhISE=" }]);

function seed(store: Store, coordinate = COORD): void {
  store.upsertEvent({
    coordinate,
    configJson: "{}",
    inboxNsec: bytesToHex(generateSecretKey()),
    eckJson: ECK_JSON,
    configRelays: JSON.stringify(["wss://test"]),
    now: 1,
  });
}

describe("coordinator backup/restore (§13.2)", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), "nostrautica-backup-"));
    tmpDirs.push(dir);
    return dir;
  }
  function backupFixture(events = 2): {
    dir: string;
    src: string;
    dest: string;
    sk: Uint8Array;
    pubkey: string;
    meta: BackupMetadata;
  } {
    const dir = tmp();
    const src = join(dir, "coordinator.sqlite");
    const dest = join(dir, "backup.sqlite");
    const sk = generateSecretKey();
    const pubkey = getPublicKey(sk);
    const store = new Store(src, sk);
    for (let i = 0; i < events; i++) seed(store, `${COORD}-${i}`);
    const meta = createBackup({
      srcStore: store,
      destPath: dest,
      identitySk: sk,
      coordinatorPubkey: pubkey,
      releaseId: "vtest",
      packageVersion: "0.1.0",
      quiesced: true,
    });
    store.close();
    return { dir, src, dest, sk, pubkey, meta };
  }

  it("writes a snapshot + metadata sidecar that verifies clean", () => {
    const { dest, sk, pubkey, meta } = backupFixture(3);
    expect(existsSync(dest)).toBe(true);
    expect(existsSync(metaPathFor(dest))).toBe(true);
    expect(meta.installedEventCount).toBe(3);
    expect(meta.coordinatorPubkey).toBe(pubkey);
    expect(meta.checksumSha256).toBe(fileChecksum(dest));

    const v = verifyBackup({ filePath: dest, identitySk: sk, expectedPubkey: pubkey });
    expect(verifyPassed(v)).toBe(true);
    expect(v.integrity).toBe("ok");
    expect(v.checksumOk).toBe(true);
    expect(v.decryptedRows).toBe(3);
    expect(v.pubkeyOk).toBe(true);
    expect(v.schemaTooNew).toBe(false);
  });

  it("rejects verification under the wrong identity", () => {
    const { dest } = backupFixture(1);
    const wrong = generateSecretKey();
    // A wrong identity cannot decrypt the protected rows — the proof throws.
    expect(() => verifyBackup({ filePath: dest, identitySk: wrong })).toThrow();
  });

  it("flags a coordinator-pubkey mismatch without throwing", () => {
    const { dest, sk } = backupFixture(1);
    const meta = JSON.parse(readFileSync(metaPathFor(dest), "utf8")) as BackupMetadata;
    meta.coordinatorPubkey = getPublicKey(generateSecretKey());
    writeFileSync(metaPathFor(dest), JSON.stringify(meta));
    // The recorded pubkey no longer matches the identity that still decrypts the
    // rows: verify surfaces pubkeyOk=false (and checksum still matches the file).
    const v = verifyBackup({ filePath: dest, identitySk: sk, expectedPubkey: getPublicKey(sk) });
    expect(v.pubkeyOk).toBe(false);
    expect(verifyPassed(v)).toBe(false);
  });

  it("catches a corrupted snapshot via checksum mismatch", () => {
    const { dest, sk, pubkey } = backupFixture(1);
    const bytes = readFileSync(dest);
    bytes[bytes.length - 1] ^= 0xff; // flip a byte in the DB page tail
    writeFileSync(dest, bytes);
    const v = verifyBackup({ filePath: dest, identitySk: sk, expectedPubkey: pubkey });
    expect(v.checksumOk).toBe(false);
    expect(verifyPassed(v)).toBe(false);
  });

  it("refuses to restore a snapshot from a newer schema", async () => {
    const { dir, dest, sk, pubkey } = backupFixture(1);
    // Simulate a snapshot taken by a FUTURE binary by bumping the on-disk
    // user_version past what this build understands.
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(dest);
    raw.exec("PRAGMA user_version = 9999");
    raw.close();
    const v = verifyBackup({ filePath: dest, identitySk: sk, expectedPubkey: pubkey });
    expect(v.schemaTooNew).toBe(true);
    const target = join(dir, "restored.sqlite");
    expect(() =>
      restoreBackup({ filePath: dest, targetPath: target, identitySk: sk, expectedPubkey: pubkey }),
    ).toThrow(/newer/);
    expect(existsSync(target)).toBe(false);
  });

  it("restore refuses to overwrite an existing db without --force, honors --force", () => {
    const { dir, dest, sk, pubkey } = backupFixture(2);
    const target = join(dir, "restored.sqlite");
    // First restore into a fresh path succeeds.
    const v1 = restoreBackup({ filePath: dest, targetPath: target, identitySk: sk, expectedPubkey: pubkey });
    expect(v1.installedEventCount).toBe(2);
    expect(existsSync(target)).toBe(true);

    // Second restore onto the now-existing target is refused without --force.
    expect(() =>
      restoreBackup({ filePath: dest, targetPath: target, identitySk: sk, expectedPubkey: pubkey }),
    ).toThrow(/--force/);

    // With --force it overwrites, and the restored db opens + decrypts cleanly.
    const v2 = restoreBackup({
      filePath: dest,
      targetPath: target,
      identitySk: sk,
      expectedPubkey: pubkey,
      force: true,
    });
    expect(v2.installedEventCount).toBe(2);
    const reopened = new Store(target, sk);
    expect(reopened.installedEventCount()).toBe(2);
    expect(reopened.verifyProtectedRowsDecrypt()).toBe(2);
    reopened.close();
  });

  it("createBackup refuses to overwrite an existing dest", () => {
    const { dest, sk, pubkey } = backupFixture(1);
    const store = new Store(":memory:", sk);
    seed(store);
    expect(() =>
      createBackup({
        srcStore: store,
        destPath: dest,
        identitySk: sk,
        coordinatorPubkey: pubkey,
        releaseId: "vtest",
        packageVersion: "0.1.0",
        quiesced: true,
      }),
    ).toThrow(/overwrite/);
    store.close();
  });
});
