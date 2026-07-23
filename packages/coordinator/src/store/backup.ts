/**
 * Coordinator backup / restore / verify primitives (§13.2 Option A).
 *
 * A backup is two files that travel together:
 *   - `<dest>`            — a self-contained SQLite snapshot produced by
 *                           `VACUUM INTO` (crash-consistent even against a live
 *                           daemon, thanks to WAL snapshot isolation).
 *   - `<dest>.meta.json`  — signed-off metadata: schema version, coordinator
 *                           pubkey, release/git revision, installed-event count,
 *                           and the snapshot's SHA-256 checksum.
 *
 * The metadata plus a decryption proof (every custodied `E_inbox`/ECK row must
 * decrypt under the loaded identity) is what turns a raw file copy into a
 * *verified* recovery artifact: restoring a snapshot whose protected rows can't
 * be decrypted by the identity you still hold would silently strand every event.
 *
 * These functions never publish, never call a provider, and never touch the
 * network — they are pure filesystem + SQLite + local-crypto operations.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { selfDecrypt } from "@nostrautica/protocol";
import { Store, SCHEMA_VERSION, AT_REST_ENC_PREFIX } from "./db.js";

export const BACKUP_FORMAT = "nostrautica-coordinator-backup" as const;

export interface BackupMetadata {
  format: typeof BACKUP_FORMAT;
  /** SQLite `user_version` of the snapshot. */
  schemaVersion: number;
  /** Coordinator identity pubkey (hex) whose key decrypts the protected rows. */
  coordinatorPubkey: string;
  /** Product release identity (git describe/SHA or package version fallback). */
  releaseId: string;
  /** Coordinator package version at backup time. */
  packageVersion: string;
  /** Number of installed events (custodied E_inbox/ECK rows) in the snapshot. */
  installedEventCount: number;
  /** SHA-256 of the snapshot file (hex). */
  checksumSha256: string;
  /** True if no daemon held the store lock at backup time (fully quiesced). */
  quiesced: boolean;
  /** ISO-8601 timestamp the backup was taken. */
  createdAt: string;
}

/** The metadata sidecar path for a snapshot file. */
export function metaPathFor(snapshotPath: string): string {
  return `${snapshotPath}.meta.json`;
}

/** SHA-256 (hex) of a file's bytes. */
export function fileChecksum(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Decryption proof over a raw (unopened-as-Store) snapshot: read every
 * `events` row and confirm its protected columns decrypt under `identitySk`
 * to the expected shapes. Non-mutating — it opens the file read-only and never
 * runs migrations, so the snapshot's checksum stays valid. Throws on the first
 * row that fails. Returns the number of rows proven.
 */
function proveDecrypts(snapshotPath: string, identitySk: Uint8Array): number {
  const db = new DatabaseSync(snapshotPath, { readOnly: true });
  try {
    const rows = db.prepare("SELECT coordinate, inbox_nsec, eck_json FROM events").all() as {
      coordinate: string;
      inbox_nsec: string;
      eck_json: string;
    }[];
    for (const row of rows) {
      const nsec = decryptColumn(row.inbox_nsec, identitySk);
      if (!/^[0-9a-f]{64}$/i.test(nsec)) {
        throw new Error(`event ${row.coordinate}: decrypted inbox_nsec is not 32-byte hex`);
      }
      JSON.parse(decryptColumn(row.eck_json, identitySk));
    }
    return rows.length;
  } finally {
    db.close();
  }
}

function decryptColumn(value: string, identitySk: Uint8Array): string {
  if (!value.startsWith(AT_REST_ENC_PREFIX)) return value; // legacy plaintext row
  return selfDecrypt(identitySk, value.slice(AT_REST_ENC_PREFIX.length));
}

/** Integrity + schema + event-count read over a raw snapshot (non-mutating). */
function inspectSnapshot(snapshotPath: string): {
  integrity: string;
  schemaVersion: number;
  installedEventCount: number;
} {
  const db = new DatabaseSync(snapshotPath, { readOnly: true });
  try {
    const ic = db.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[];
    const msgs = ic.map((r) => r.integrity_check);
    const integrity = msgs.length === 1 && msgs[0] === "ok" ? "ok" : msgs.join("; ");
    const uv = db.prepare("PRAGMA user_version").get() as { user_version: number };
    const n = db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number };
    return { integrity, schemaVersion: uv.user_version, installedEventCount: n.n };
  } finally {
    db.close();
  }
}

export interface CreateBackupOpts {
  /** The LIVE store to snapshot (its own connection runs `VACUUM INTO`). */
  srcStore: Store;
  /** Where to write the snapshot; must not already exist. */
  destPath: string;
  /** Coordinator identity secret (drives the decryption proof). */
  identitySk: Uint8Array;
  /** Coordinator identity pubkey (hex) recorded in metadata. */
  coordinatorPubkey: string;
  releaseId: string;
  packageVersion: string;
  /** Whether the daemon was quiesced (no lock held) at backup time. */
  quiesced: boolean;
  now?: () => number;
}

/**
 * Take a verified backup: integrity-check the source, prove its protected rows
 * decrypt, snapshot via `VACUUM INTO`, then re-verify the snapshot independently
 * (integrity, decryption proof) and write the metadata sidecar. Throws — leaving
 * no partial artifact promoted — if any check fails.
 */
export function createBackup(opts: CreateBackupOpts): BackupMetadata {
  if (existsSync(opts.destPath)) {
    throw new Error(`refusing to overwrite existing file: ${opts.destPath}`);
  }
  const srcIntegrity = opts.srcStore.integrityCheck();
  if (srcIntegrity !== "ok") {
    throw new Error(`source database failed integrity_check: ${srcIntegrity}`);
  }
  // Prove the source decrypts under the loaded identity BEFORE snapshotting — a
  // wrong identity is caught here rather than producing a useless backup.
  opts.srcStore.verifyProtectedRowsDecrypt();

  opts.srcStore.backupTo(opts.destPath);

  const snap = inspectSnapshot(opts.destPath);
  if (snap.integrity !== "ok") {
    throw new Error(`snapshot failed integrity_check: ${snap.integrity}`);
  }
  const decryptedRows = proveDecrypts(opts.destPath, opts.identitySk);
  if (decryptedRows !== snap.installedEventCount) {
    throw new Error(
      `snapshot decryption proof covered ${decryptedRows} of ${snap.installedEventCount} event rows`,
    );
  }
  const meta: BackupMetadata = {
    format: BACKUP_FORMAT,
    schemaVersion: snap.schemaVersion,
    coordinatorPubkey: opts.coordinatorPubkey,
    releaseId: opts.releaseId,
    packageVersion: opts.packageVersion,
    installedEventCount: snap.installedEventCount,
    checksumSha256: fileChecksum(opts.destPath),
    quiesced: opts.quiesced,
    createdAt: new Date(opts.now?.() ?? Date.now()).toISOString(),
  };
  writeFileSync(metaPathFor(opts.destPath), JSON.stringify(meta, null, 2) + "\n");
  return meta;
}

export interface VerifyResult {
  meta: BackupMetadata;
  integrity: string;
  schemaVersion: number;
  installedEventCount: number;
  checksumOk: boolean;
  decryptedRows: number;
  /** True if the snapshot's schema is newer than this binary understands. */
  schemaTooNew: boolean;
  /** True if `expectedPubkey` was supplied and matches the metadata. */
  pubkeyOk: boolean | null;
}

export interface VerifyOpts {
  /** Path to the snapshot file (its `.meta.json` sidecar must sit beside it). */
  filePath: string;
  identitySk: Uint8Array;
  /** Optional: assert the metadata's coordinator pubkey equals this. */
  expectedPubkey?: string;
}

/**
 * Verify a backup without publishing, spending, or calling any provider: parse
 * the metadata, recompute and compare the checksum, run `integrity_check`,
 * check the schema isn't newer than this binary, and prove every protected row
 * decrypts under the supplied identity. Throws only on unreadable inputs;
 * otherwise returns a structured result the caller renders and decides on.
 */
export function verifyBackup(opts: VerifyOpts): VerifyResult {
  if (!existsSync(opts.filePath)) throw new Error(`snapshot not found: ${opts.filePath}`);
  const metaPath = metaPathFor(opts.filePath);
  if (!existsSync(metaPath)) throw new Error(`metadata sidecar not found: ${metaPath}`);
  const meta = JSON.parse(readFileSync(metaPath, "utf8")) as BackupMetadata;
  if (meta.format !== BACKUP_FORMAT) {
    throw new Error(`unrecognized backup format: ${String(meta.format)}`);
  }
  const snap = inspectSnapshot(opts.filePath);
  const checksumOk = fileChecksum(opts.filePath) === meta.checksumSha256;
  const decryptedRows = proveDecrypts(opts.filePath, opts.identitySk);
  return {
    meta,
    integrity: snap.integrity,
    schemaVersion: snap.schemaVersion,
    installedEventCount: snap.installedEventCount,
    checksumOk,
    decryptedRows,
    schemaTooNew: snap.schemaVersion > SCHEMA_VERSION,
    pubkeyOk: opts.expectedPubkey === undefined ? null : opts.expectedPubkey === meta.coordinatorPubkey,
  };
}

/** True if a verify result passed every safety gate (safe to restore/rely on). */
export function verifyPassed(v: VerifyResult): boolean {
  return (
    v.integrity === "ok" &&
    v.checksumOk &&
    !v.schemaTooNew &&
    v.decryptedRows === v.installedEventCount &&
    v.pubkeyOk !== false
  );
}

export interface RestoreOpts {
  /** The verified snapshot to install. */
  filePath: string;
  /** The live database path the daemon will open. */
  targetPath: string;
  identitySk: Uint8Array;
  expectedPubkey?: string;
  /** Overwrite an existing target database. */
  force?: boolean;
}

/**
 * Install a verified snapshot as the coordinator's live database. Refuses to run
 * unless every verify gate passes, refuses a snapshot from a newer schema, and
 * refuses to overwrite an existing target without `force`. The caller MUST hold
 * the single-daemon lock on `targetPath` (i.e. no daemon is running) before
 * calling — this function copies bytes and does not itself fence a live daemon.
 */
export function restoreBackup(opts: RestoreOpts): VerifyResult {
  const v = verifyBackup({
    filePath: opts.filePath,
    identitySk: opts.identitySk,
    expectedPubkey: opts.expectedPubkey,
  });
  if (v.schemaTooNew) {
    throw new Error(
      `refusing restore: snapshot schema v${v.schemaVersion} is newer than this binary (v${SCHEMA_VERSION}) — upgrade the coordinator first`,
    );
  }
  if (!verifyPassed(v)) {
    const why = [
      v.integrity !== "ok" ? `integrity=${v.integrity}` : null,
      !v.checksumOk ? "checksum mismatch" : null,
      v.decryptedRows !== v.installedEventCount ? "decryption proof incomplete" : null,
      v.pubkeyOk === false ? "coordinator pubkey mismatch" : null,
    ]
      .filter(Boolean)
      .join(", ");
    throw new Error(`refusing restore: verification failed (${why})`);
  }
  if (existsSync(opts.targetPath) && !opts.force) {
    throw new Error(
      `refusing to overwrite existing database at ${opts.targetPath} without --force`,
    );
  }
  // Drop any stale rollback/WAL sidecars of the target so the restored snapshot
  // is opened clean, not merged with a previous database's journal.
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try {
      rmSync(opts.targetPath + suffix);
    } catch {
      /* absent — fine */
    }
  }
  copyFileSync(opts.filePath, opts.targetPath);
  return v;
}
