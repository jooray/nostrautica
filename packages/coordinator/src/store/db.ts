/**
 * Coordinator persistence (spec §9.1). Uses Node's built-in synchronous SQLite
 * (`node:sqlite`, Node ≥ 22.5) — same embedded-SQLite semantics the spec intends
 * with better-sqlite3, without a fragile native build.
 *
 * Every expensive artifact (transcripts, summaries, profiles, pair scores) is
 * keyed by a content hash of its inputs, so the DB is a cache/queue whose loss
 * re-costs money but can never corrupt correctness: a wiped DB re-derives
 * everything from relays + providers.
 *
 * Key material at rest (ENCRYPTION-AND-PRIVACY.md F1): the per-event secrets the
 * coordinator custodies (`inbox_nsec`, `eck_json`) are encrypted with NIP-44
 * self-encryption under the coordinator's own identity key before they touch
 * SQLite, and transparently decrypted on read. Encrypted values carry the
 * `nip44:` prefix (plaintext hex/JSON can never start with that, so detection is
 * unambiguous). On startup any legacy plaintext rows are re-encrypted in place —
 * one-way, idempotent, logged.
 */
import { DatabaseSync } from "node:sqlite";
import { selfEncrypt, selfDecrypt, sha256Hex, utf8ToBytes } from "@nostrautica/protocol";

/** Prefix marking a column value as NIP-44-encrypted under the identity key. */
const ENC_PREFIX = "nip44:";

/**
 * The store's logical schema version, written to SQLite's `PRAGMA user_version`
 * at the end of every read-write open. It exists so a coordinator refuses to open
 * (and the backup/restore tooling refuses to restore) a database written by a
 * NEWER binary: the on-disk shape would carry columns/semantics this build can't
 * honor. Bump this — and add a matching numbered entry to {@link MIGRATIONS} —
 * whenever a migration changes the durable shape at a downgrade-incompatible
 * boundary (audit O3).
 *
 * History (audit O3): v1 originally spanned MANY additive migrations all labelled
 * version 1, so an older binary that also accepted version 1 could not tell that a
 * newer binary had modified the database. From v2 on, every downgrade-incompatible
 * boundary advances `user_version` through an ordered, transactional migration, and
 * an open refuses a database whose `user_version` exceeds this constant.
 */
export const SCHEMA_VERSION = 5;

/**
 * An ordered, transactional schema migration (audit O3). `up` runs inside a
 * `BEGIN IMMEDIATE` transaction and, on success, `user_version` is advanced to
 * `version`. `up` MUST be idempotent (re-runnable) — a database interrupted between
 * a migration's DDL and its `user_version` stamp re-runs the whole migration on the
 * next open.
 */
interface Migration {
  version: number;
  up: (db: DatabaseSync) => void;
}

/**
 * The historical (pre-versioning) baseline shape (audit O3). Every statement is
 * idempotent — `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE … ADD COLUMN` guarded
 * by a try/catch on "column already exists". It is applied UNCONDITIONALLY on every
 * read-write open so the physical column set is guaranteed for ANY historical
 * database regardless of the exact `user_version` it was stamped at — including the
 * many pre-v2 databases stamped `user_version = 1` whose column completeness depends
 * on which of these ALTERs a past binary happened to run. The numbered migrations
 * below carry the version-advancing (downgrade-incompatible) boundaries on top.
 */
function applyBaselineDDL(db: DatabaseSync): void {
  db.exec(SCHEMA);
  // Migration: add the directional-reasoning column to older DBs.
  try {
    db.exec("ALTER TABLE pairs ADD COLUMN reasoning_b TEXT");
  } catch {
    /* column already exists */
  }
  // Migration: directional scoring (batched matcher, spec §16.2). Each direction
  // (a→b, b→a) is scored independently, so the a→b score/similarity/complementarity
  // live in the base columns and the b→a values in the *_b columns. Older rows have
  // NULL *_b columns; pairsFor() COALESCEs them back to the shared value.
  for (const col of ["score_b", "similarity_b", "complementarity_b"]) {
    try {
      db.exec(`ALTER TABLE pairs ADD COLUMN ${col} REAL`);
    } catch {
      /* column already exists */
    }
  }
  // Migration (H1): job-lease columns on older DBs. Must run BEFORE the lease
  // index is created (the index references lease_until).
  for (const col of ["claimed_at INTEGER", "lease_until INTEGER", "worker_token TEXT"]) {
    try {
      db.exec(`ALTER TABLE jobs ADD COLUMN ${col}`);
    } catch {
      /* column already exists */
    }
  }
  // Migration (Q10/F1/F3/B1/P0-2/wire-v2 §3.3): attendee revision + ordering columns.
  for (const col of ["source_revision TEXT", "ai_source_revision TEXT", "transcripts_json TEXT", "correction_json TEXT", "display_name TEXT", "profile_created_at INTEGER", "profile_rumor_id TEXT", "profile_rev INTEGER", "correction_rev INTEGER", "correction_created_at INTEGER", "correction_rumor_id TEXT"]) {
    try {
      db.exec(`ALTER TABLE attendees ADD COLUMN ${col}`);
    } catch {
      /* column already exists */
    }
  }
  try {
    db.exec("ALTER TABLE transcripts ADD COLUMN lang TEXT");
  } catch {
    /* column already exists */
  }
  // Migration (COORD-7): the ECK version a talk's 31610 was published under.
  try {
    db.exec("ALTER TABLE talks ADD COLUMN published_eck_id INTEGER");
  } catch {
    /* column already exists */
  }
  // Migration (wire-v2 §3.3): canonical content hash for equal-revision rejection.
  try {
    db.exec("ALTER TABLE talks ADD COLUMN content_hash TEXT");
  } catch {
    /* column already exists */
  }
  // Migration (2026-07-24): external talk sources + per-talk matching opt-in.
  for (const col of [
    "external_url TEXT",
    "external_kind TEXT",
    "source_type TEXT",
    "process_for_matching INTEGER NOT NULL DEFAULT 1",
  ]) {
    try {
      db.exec(`ALTER TABLE talks ADD COLUMN ${col}`);
    } catch {
      /* column already exists */
    }
  }
  // Migration (COORD-24): consumption timestamps for TTL pruning.
  try {
    db.exec("ALTER TABLE marmot_consumed_kps ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0");
  } catch {
    /* column already exists */
  }
  // Migration (wire-v2 §3.5): the install generation on older event rows.
  try {
    db.exec("ALTER TABLE events ADD COLUMN gen INTEGER NOT NULL DEFAULT 0");
  } catch {
    /* column already exists */
  }
  // Migration (wire-v2 §10.2): per-device chat-key label on older binding rows.
  try {
    db.exec("ALTER TABLE marmot_chat_keys ADD COLUMN label TEXT");
  } catch {
    /* column already exists */
  }
  // Migration (wire-v2 §6.2): per-direction icebreakers on cached pair rows.
  for (const col of ["icebreakers_json TEXT", "icebreakers_b_json TEXT"]) {
    try {
      db.exec(`ALTER TABLE pairs ADD COLUMN ${col}`);
    } catch {
      /* column already exists */
    }
  }
  // Migration (wire-v2 §6.2): retention-expired terminal flag on the events row.
  try {
    db.exec("ALTER TABLE events ADD COLUMN retention_expired INTEGER NOT NULL DEFAULT 0");
  } catch {
    /* column already exists */
  }
  // Migration (audit C1): durable command-operation state (coord-1).
  for (const col of ["state TEXT NOT NULL DEFAULT 'complete'", "progress_json TEXT"]) {
    try {
      db.exec(`ALTER TABLE command_watermarks ADD COLUMN ${col}`);
    } catch {
      /* column already exists */
    }
  }
  // Migration (audit C9): the CANDIDATE relay set of an in-progress handover (coord-1).
  try {
    db.exec("ALTER TABLE events ADD COLUMN pending_relays TEXT");
  } catch {
    /* column already exists */
  }
  // Migration (wire-v2 §3.2): durable monotonic-publish watermark per address.
  db.exec(
    `CREATE TABLE IF NOT EXISTS publish_watermarks (
      address TEXT PRIMARY KEY,
      last_created_at INTEGER NOT NULL
    )`,
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs (state, next_run_at, lease_until)");
}

/**
 * Downgrade-incompatible schema additions for the audit-C3/C5/C10 remediation
 * (audit O3, version 2). Idempotent — safe to re-run against a database that has
 * already reached (or partially reached) version 2.
 *
 *  - C3: durable per-sender / per-event inbox rate accounting.
 *  - C5: ownership/reference records for content-addressed derived artifacts
 *    (transcripts, pipeline artifacts, nostr summaries) so a reference-counted
 *    deletion can drop a subject's data without harming another event that shares
 *    the same deduplicated payload.
 */
function applyRemediationDDL(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inbox_rate (
      coordinate TEXT NOT NULL,
      pubkey TEXT NOT NULL,          -- '' = event-wide bucket
      window_start INTEGER NOT NULL,
      count INTEGER NOT NULL,
      PRIMARY KEY (coordinate, pubkey)
    );
    CREATE TABLE IF NOT EXISTS transcript_refs (
      blob_sha256 TEXT NOT NULL,
      coordinate TEXT NOT NULL,
      pubkey TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (blob_sha256, coordinate, pubkey)
    );
    CREATE TABLE IF NOT EXISTS artifact_refs (
      stage TEXT NOT NULL,
      inputs_hash TEXT NOT NULL,
      coordinate TEXT NOT NULL,
      pubkey TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (stage, inputs_hash, coordinate, pubkey)
    );
    CREATE TABLE IF NOT EXISTS summary_refs (
      pubkey TEXT NOT NULL,
      inputs_hash TEXT NOT NULL,
      coordinate TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (pubkey, inputs_hash, coordinate)
    );
  `);
}

/**
 * Unify the membership command-watermark subject (audit R2, version 3). Organizer
 * approve/revoke used subject `pubkey:<pk>` while attendee withdrawals used
 * `withdraw:<pk>` — two INDEPENDENT watermarks for the same attendee's membership, so
 * a delayed old withdrawal ordered only against other withdrawals and could undo a
 * newer reapproval (and purge data). From v3 both flows use one `member:<pk>` subject
 * so every membership transition orders against the others.
 *
 * This migration rewrites existing rows onto the unified subject. Where an attendee
 * has BOTH a `pubkey:<pk>` and a `withdraw:<pk>` row (which would collide on the
 * unified PRIMARY KEY), it keeps the one that WINS the §3.1 comparator — higher
 * `created_at`, then the lexically-LOWER `rumor_id` on a tie — i.e. the effective
 * last membership decision, carrying its `state`/`progress_json` so an in-progress
 * ECK rotation still resumes. Downgrade-incompatible: an older binary would read the
 * old subjects and lose the unification, so it advances `user_version`.
 */
function applyMembershipSubjectMerge(db: DatabaseSync): void {
  const rows = db
    .prepare(
      "SELECT coordinate, subject, created_at, rumor_id, state, progress_json FROM command_watermarks WHERE subject LIKE 'pubkey:%' OR subject LIKE 'withdraw:%'",
    )
    .all() as {
    coordinate: string;
    subject: string;
    created_at: number;
    rumor_id: string;
    state: string | null;
    progress_json: string | null;
  }[];
  const winners = new Map<
    string,
    { coordinate: string; subject: string; created_at: number; rumor_id: string; state: string | null; progress_json: string | null }
  >();
  for (const r of rows) {
    const pk = r.subject.slice(r.subject.indexOf(":") + 1);
    const newSubject = `member:${pk}`;
    const key = `${r.coordinate} ${newSubject}`;
    const cur = winners.get(key);
    const wins =
      !cur ||
      r.created_at > cur.created_at ||
      (r.created_at === cur.created_at && r.rumor_id < cur.rumor_id);
    if (wins) winners.set(key, { ...r, subject: newSubject });
  }
  db.prepare("DELETE FROM command_watermarks WHERE subject LIKE 'pubkey:%' OR subject LIKE 'withdraw:%'").run();
  const ins = db.prepare(
    "INSERT INTO command_watermarks (coordinate, subject, created_at, rumor_id, state, progress_json) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const w of winners.values()) {
    ins.run(w.coordinate, w.subject, w.created_at, w.rumor_id, w.state ?? "complete", w.progress_json ?? null);
  }
}

/**
 * Quarantine legacy pipeline artifacts with no ownership ref (audit R11, version 4).
 * Schema v2 introduced `artifact_refs` for reference-counted deletion but never
 * backfilled the `pipeline_artifacts` that already existed — those pre-v2 rows have
 * NO ref, so a purge (which discovers artifacts only through `artifact_refs`) can
 * never reach them and they survive forever (unbounded growth + attendee-derived
 * text retained past retention). This migration:
 *   1. adds the `quarantined_at` column (guarded — earlier partial runs / new DBs
 *      already have it via the baseline DDL);
 *   2. stamps `quarantined_at = now` on every artifact that has no `artifact_refs`
 *      row, so pruneOldData can GC it after a grace window.
 * It is NON-destructive: a live event still using such an artifact re-touches it via
 * a cache hit (see `recordArtifactRef`), which clears the quarantine before the GC
 * window elapses, so nothing an active event needs is lost.
 */
function applyArtifactLegacyQuarantine(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(pipeline_artifacts)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "quarantined_at")) {
    db.exec("ALTER TABLE pipeline_artifacts ADD COLUMN quarantined_at INTEGER");
  }
  const now = Date.now();
  const hasRefs = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'artifact_refs'")
    .get();
  if (hasRefs) {
    db.prepare(
      `UPDATE pipeline_artifacts SET quarantined_at = ?
         WHERE quarantined_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM artifact_refs r
             WHERE r.stage = pipeline_artifacts.stage AND r.inputs_hash = pipeline_artifacts.inputs_hash
           )`,
    ).run(now);
  } else {
    // A database old enough to have no artifact_refs table at all has no ownership
    // records whatsoever → every existing artifact is legacy.
    db.prepare("UPDATE pipeline_artifacts SET quarantined_at = ? WHERE quarantined_at IS NULL").run(now);
  }
}

/** The ordered numbered migrations (audit O3). Version 1 is the historical baseline
 *  (applied unconditionally by {@link applyBaselineDDL}); version 2 is the audit
 *  remediation batch; version 3 unifies the membership command subject (audit R2);
 *  version 4 quarantines legacy unreferenced pipeline artifacts (audit R11). */
/**
 * v5: re-key `invite_usage` on (coordinate, invite_pubkey, used_by).
 *
 * Single-use invites only ever needed to know THAT a code was spent, so one row
 * per code sufficed. A reusable code needs to know how many DISTINCT people have
 * redeemed it, which the old primary key cannot represent — a second redeemer's
 * insert simply conflicted away.
 *
 * SQLite cannot alter a primary key in place, so this is the copy/rename dance.
 * Idempotent: the rebuild only runs when the old key is still in place, detected
 * by asking the table itself rather than trusting `user_version` (a database
 * interrupted between the DDL and its version stamp re-runs the whole thing).
 * Existing rows carry over unchanged — every one of them is a spent single-use
 * code, and under the new key it stays exactly that.
 */
function applyInviteUsagePerRedeemer(db: DatabaseSync): void {
  const key = db.prepare("PRAGMA table_info(invite_usage)").all() as { name: string; pk: number }[];
  // Already three-column keyed (fresh DB built from SCHEMA, or a re-run).
  if (key.filter((c) => c.pk > 0).length === 3) return;
  db.exec(`
    CREATE TABLE invite_usage_v5 (
      coordinate TEXT NOT NULL,
      invite_pubkey TEXT NOT NULL,
      used_by TEXT NOT NULL,
      used_at INTEGER NOT NULL,
      PRIMARY KEY (coordinate, invite_pubkey, used_by)
    );
    INSERT OR IGNORE INTO invite_usage_v5 (coordinate, invite_pubkey, used_by, used_at)
      SELECT coordinate, invite_pubkey, used_by, used_at FROM invite_usage;
    DROP TABLE invite_usage;
    ALTER TABLE invite_usage_v5 RENAME TO invite_usage;
  `);
}

const MIGRATIONS: Migration[] = [
  { version: 2, up: applyRemediationDDL },
  { version: 3, up: applyMembershipSubjectMerge },
  { version: 4, up: applyArtifactLegacyQuarantine },
  { version: 5, up: applyInviteUsagePerRedeemer },
];

/**
 * Bring a database up to {@link SCHEMA_VERSION} (audit O3). Refuses a database
 * written by a NEWER binary (its `user_version` exceeds ours — opening it could
 * silently mis-handle columns/semantics this build doesn't know about), applies the
 * idempotent baseline shape, then runs every pending numbered migration in its own
 * transaction, advancing `user_version` at each boundary. Read-only inspection
 * (doctor, audit O2) must NOT go through here — it uses {@link inspectDatabaseReadOnly}.
 */
function migrate(db: DatabaseSync): void {
  const uv = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (uv > SCHEMA_VERSION) {
    throw new Error(
      `database schema v${uv} was written by a NEWER coordinator than this binary (v${SCHEMA_VERSION}); refusing to open — upgrade the coordinator (or restore a matching backup) before starting`,
    );
  }
  applyBaselineDDL(db);
  for (const m of MIGRATIONS) {
    if (m.version <= uv) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      m.up(db);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec("COMMIT");
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* no active txn */
      }
      throw e;
    }
  }
  // Stamp the current version even when there were no pending migrations (a fresh
  // database whose baseline already matches, or one already at SCHEMA_VERSION).
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

/**
 * Read-only database inspection (audit O2): open the file with a READ-ONLY SQLite
 * connection and report its integrity, schema version, and (optionally) protected-row
 * decryptability WITHOUT constructing the migrating {@link Store}. `doctor` uses this
 * so an `ExecStartPre` health check can never migrate/encrypt/upgrade the database
 * before startup or a rollback decision is made — the file is left byte-identical.
 */
export function inspectDatabaseReadOnly(
  path: string,
  identitySk?: Uint8Array,
): {
  integrity: string;
  userVersion: number;
  schemaTooNew: boolean;
  installedEventCount: number;
  /** Number of event rows proven to decrypt under `identitySk`, or null if not checked. */
  decryptedRows: number | null;
} {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const ic = db.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[];
    const msgs = ic.map((r) => r.integrity_check);
    const integrity = msgs.length === 1 && msgs[0] === "ok" ? "ok" : msgs.join("; ");
    const uv = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    let installedEventCount = 0;
    try {
      installedEventCount = (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
    } catch {
      /* no events table yet (pre-install database) */
    }
    let decryptedRows: number | null = null;
    if (identitySk) {
      decryptedRows = 0;
      const rows = db.prepare("SELECT coordinate, inbox_nsec, eck_json FROM events").all() as {
        coordinate: string;
        inbox_nsec: string;
        eck_json: string;
      }[];
      for (const row of rows) {
        const nsec = row.inbox_nsec.startsWith(ENC_PREFIX)
          ? selfDecrypt(identitySk, row.inbox_nsec.slice(ENC_PREFIX.length))
          : row.inbox_nsec;
        if (!/^[0-9a-f]{64}$/i.test(nsec)) {
          throw new Error(`event ${row.coordinate}: decrypted inbox_nsec is not 32-byte hex`);
        }
        const eck = row.eck_json.startsWith(ENC_PREFIX)
          ? selfDecrypt(identitySk, row.eck_json.slice(ENC_PREFIX.length))
          : row.eck_json;
        JSON.parse(eck);
        decryptedRows++;
      }
    }
    return {
      integrity,
      userVersion: uv,
      schemaTooNew: uv > SCHEMA_VERSION,
      installedEventCount,
      decryptedRows,
    };
  } finally {
    db.close();
  }
}

/** The at-rest encryption prefix, exported for the backup tool's decryption proof. */
export const AT_REST_ENC_PREFIX = ENC_PREFIX;

/** Handle to an acquired single-daemon lock; call `release` on shutdown. */
export interface DaemonLock {
  release(): void;
}

/**
 * Acquire an exclusive single-daemon lock for a store path (reliability tail): two
 * coordinator daemons sharing one SQLite database would both claim jobs and both
 * publish, racing the monotonic-publish watermark and the seen-rumor ledger. A
 * dedicated `${dbPath}.lock` SQLite file is opened in EXCLUSIVE locking mode and a
 * marker row written, which takes and HOLDS a file-level exclusive lock for the
 * connection's lifetime. A second daemon's acquire then fails fast (SQLITE_BUSY)
 * with a clear error instead of silently double-running. Returns a handle whose
 * `release` drops the lock (closes the connection). The `:memory:` store takes no
 * lock (each connection is private — nothing to contend).
 */
export function acquireDaemonLock(dbPath: string): DaemonLock {
  if (dbPath === ":memory:") return { release() {} };
  const lockPath = `${dbPath}.lock`;
  const db = new DatabaseSync(lockPath);
  try {
    db.exec("PRAGMA locking_mode = EXCLUSIVE");
    db.exec("CREATE TABLE IF NOT EXISTS daemon_lock (id INTEGER PRIMARY KEY, pid INTEGER, acquired_at INTEGER)");
    // The write forces SQLite to take the RESERVED→EXCLUSIVE lock; under
    // locking_mode=EXCLUSIVE the connection keeps it until close, so a second
    // daemon's write throws SQLITE_BUSY.
    db.exec("BEGIN EXCLUSIVE");
    db.prepare("INSERT OR REPLACE INTO daemon_lock (id, pid, acquired_at) VALUES (1, ?, ?)").run(
      process.pid,
      Date.now(),
    );
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    throw new Error(
      `another coordinator daemon is already running on ${dbPath} (single-daemon lock held): ${e instanceof Error ? e.message : e}`,
    );
  }
  return {
    release() {
      try {
        db.close();
      } catch {
        /* already closed */
      }
    },
  };
}

/** `waiting` is the billing/budget PARK state (H-2) — `claimNextJob` never claims it. */
export type JobState = "pending" | "running" | "waiting" | "done" | "poison";

/**
 * What an `enqueueJob` call actually did: `"enqueued"` when a row was created, or
 * the state of the EXISTING row whose dedupe key suppressed it. Callers log the
 * terminal cases — a `done`/`poison` collision means requested work will NOT run,
 * which is silent, permanent, and was the 2026-07-24 production incident.
 */
export type EnqueueOutcome = "enqueued" | JobState;

/** Job types that make up the matching stage (used by the recompute memo reset). */
export const MATCH_JOB_TYPES = [
  "match_recompute",
  "score_batch",
  "score_reverse_batch",
  "publish_matches",
] as const;

/** A Cashu payment reservation in the durable journal (audit finding H8). */
export type CashuJournalState = "in_flight" | "settled" | "ambiguous";
export interface CashuJournalRow {
  request_id: string;
  mint: string;
  state: CashuJournalState;
  amount: number;
  /** Proofs reserved for and sent to the provider (decrypted). */
  sent_proofs: unknown[];
  /** Change proofs banked at settle, if any (decrypted). */
  change_proofs: unknown[] | null;
  created_at: number;
  updated_at: number;
}

export interface JobRow {
  id: number;
  type: string;
  dedupe_key: string;
  payload: string;
  state: JobState;
  attempts: number;
  next_run_at: number;
  last_error: string | null;
  /** Lease bookkeeping (audit H1): NULL until first claimed. */
  claimed_at: number | null;
  lease_until: number | null;
  worker_token: string | null;
}

/** A stored attendee row (audit Q11: typed instead of `any` at the pipeline boundary). */
export interface AttendeeRow {
  coordinate: string;
  pubkey: string;
  role: string;
  status: string;
  profile_json: string | null;
  ai_profile_json: string | null;
  profile_hash: string | null;
  source_revision: string | null;
  ai_source_revision: string | null;
  // Published transcripts (audit A1, spec F1): MediaTranscript[] JSON, one entry
  // per STT-transcribed media blob, surfaced on the directory entry.
  transcripts_json: string | null;
  // Attendee's ai_profile correction/hide (F3, audit U9): ProfileCorrectionContent
  // JSON. Authoritative until the attendee changes it, and re-applied at publish
  // time on top of a freshly generated ai_profile — so it SURVIVES reprocessing.
  correction_json: string | null;
  // Display name from the join request (B1): match reasoning must be able to
  // call people by their actual names — profiles alone carry no name.
  display_name: string | null;
  // Ordering key of the currently-stored profile submission. NIP §3.3 makes the
  // application `rev` the primary key; (rev, created_at, rumor_id) is the total
  // order the coordinator accepts strictly-greater keys under (higher rev wins;
  // equal rev → higher created_at; equal both → lexicographically lowest id).
  // v1's created_at-only interim guard (P0-2) is replaced by this. Null on rows
  // written before a first ordered submission.
  profile_rev: number | null;
  profile_created_at: number | null;
  profile_rumor_id: string | null;
  // Ordering key of the applied 21608 correction (NIP §3.3), same total order as
  // the profile submission — a stale (out-of-order older) correction is rejected.
  correction_rev: number | null;
  correction_created_at: number | null;
  correction_rumor_id: string | null;
  updated_at: number;
}

/** A stored talk row (spec F2, audit U11). */
export interface TalkRow {
  coordinate: string;
  pubkey: string;
  talk_d: string;
  title: string;
  description: string;
  speakers_json: string;
  /** kind:"talk" media descriptor as JSON, or the JSON literal 'null' for external talks. */
  media_json: string;
  /** External (off-Blossom) talk video URL — YouTube or direct mp4 — or null. */
  external_url: string | null;
  /** "youtube" | "video" for an external talk, else null. */
  external_kind: string | null;
  /** "recording" | "upload" | "external" (null on legacy rows). */
  source_type: string | null;
  /** 1 if the speaker opted this talk into coordinator STT + matching, else 0. */
  process_for_matching: number;
  transcript_json: string | null;
  lang: string;
  revision: number;
  // Canonical content hash of the applied talk (NIP §3.3): a submission with a
  // revision EQUAL to the stored one but a DIFFERENT content hash is rejected
  // (a content change requires a revision bump); equal revision + identical hash
  // is an idempotent no-op. See `talkContentHash`.
  content_hash: string | null;
  status: "pending" | "published" | "rejected";
  published_at: number;
  /**
   * The ECK version id the live 31610 was published under (audit COORD-7). The
   * blinded `d` derives from the ECK, so deletion must address the entry under
   * the ECK it was PUBLISHED with — after a rotation that's not the current one.
   */
  published_eck_id: number | null;
  updated_at: number;
}

/** An MLS group the coordinator administers for a chat-enabled event (§4.3). */
export interface MarmotGroupRow {
  coordinate: string;
  mls_group_id: string;
  nostr_group_id: string;
  created_at: number;
  status: "active" | "frozen";
}

/** An authenticated account⇄chat-key binding from a 21607 attestation (§3.3). */
export interface MarmotChatKeyRow {
  coordinate: string;
  account_pubkey: string;
  chat_pubkey: string;
  client_id: string | null;
  label: string | null;
  status: "active" | "revoked";
  updated_at: number;
}

/** A poisoned/cleared job surfaced to the organizer (audit Q12). */
export interface JobStatusRow {
  coordinate: string;
  stage: string;
  pubkey: string | null;
  state: "poison" | "cleared";
  attempts: number;
  error_category: string;
  retryable: number;
  updated_at: number;
}

/**
 * Persisted billing state machine per installation (spec §9, D5, §13.4). The
 * principal is TYPED (kind "eid" today — the event identity — extensible to a
 * personal/organization principal without a wire change). `state` is the durable
 * enforcement verdict `evaluating → ok | grace | blocked` re-evaluated at install,
 * attendee-count change, submission revision, job claim, and before provider spend.
 */
export interface BillingStateRow {
  coordinate: string;
  principal_kind: string;
  principal_id: string;
  state: "evaluating" | "ok" | "grace" | "blocked";
  reason: string | null;
  grace_until: number | null;
  updated_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  coordinate TEXT PRIMARY KEY,
  config_json TEXT NOT NULL,
  inbox_nsec TEXT NOT NULL,
  eck_json TEXT NOT NULL,
  config_relays TEXT NOT NULL,
  gen INTEGER NOT NULL DEFAULT 0,   -- the install generation this event was granted at (NIP §3.5)
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS attendees (
  coordinate TEXT NOT NULL,
  pubkey TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'attendee',
  status TEXT NOT NULL DEFAULT 'pending',
  profile_json TEXT,
  ai_profile_json TEXT,
  profile_hash TEXT,
  -- Revision consistency (audit Q10): source_revision hashes the current authored
  -- submission; ai_source_revision records which submission the stored ai_profile
  -- was derived from. A directory entry only surfaces ai_profile when they match,
  -- so a new submission never publishes authored fields beside a stale AI profile.
  source_revision TEXT,
  ai_source_revision TEXT,
  transcripts_json TEXT,
  correction_json TEXT,
  display_name TEXT,
  profile_rev INTEGER,
  profile_created_at INTEGER,
  profile_rumor_id TEXT,
  correction_rev INTEGER,
  correction_created_at INTEGER,
  correction_rumor_id TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (coordinate, pubkey)
);
CREATE TABLE IF NOT EXISTS submissions (
  rumor_id TEXT PRIMARY KEY,
  coordinate TEXT NOT NULL,
  pubkey TEXT NOT NULL,
  media_json TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_run_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  claimed_at INTEGER,
  lease_until INTEGER,
  worker_token TEXT
);
CREATE TABLE IF NOT EXISTS transcripts (
  blob_sha256 TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  lang TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS nostr_summaries (
  pubkey TEXT NOT NULL,
  inputs_hash TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (pubkey, inputs_hash)
);
CREATE TABLE IF NOT EXISTS pairs (
  coordinate TEXT NOT NULL,
  a TEXT NOT NULL,
  b TEXT NOT NULL,
  inputs_hash TEXT NOT NULL,
  score REAL NOT NULL,
  similarity REAL NOT NULL,
  complementarity REAL NOT NULL,
  reasoning TEXT NOT NULL,      -- addressed to a (the lexically-smaller pubkey)
  reasoning_b TEXT,             -- addressed to b (the lexically-larger pubkey)
  created_at INTEGER NOT NULL,
  PRIMARY KEY (coordinate, a, b)
);
-- One row per (code, redeemer), so a multi-use code can be counted rather than
-- merely claimed. A pre-v5 database keys this (coordinate, invite_pubkey);
-- applyInviteUsagePerRedeemer migrates it.
CREATE TABLE IF NOT EXISTS invite_usage (
  coordinate TEXT NOT NULL,
  invite_pubkey TEXT NOT NULL,
  used_by TEXT NOT NULL,
  used_at INTEGER NOT NULL,
  PRIMARY KEY (coordinate, invite_pubkey, used_by)
);
CREATE TABLE IF NOT EXISTS seen_rumors (
  rumor_id TEXT PRIMARY KEY,
  seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cashu_journal (
  request_id TEXT PRIMARY KEY,
  mint TEXT NOT NULL,
  state TEXT NOT NULL,           -- 'in_flight' | 'settled' | 'ambiguous'
  amount INTEGER NOT NULL,
  sent_proofs TEXT NOT NULL,     -- JSON array of the proofs reserved & sent (may be encrypted)
  change_proofs TEXT,            -- JSON array of change proofs banked at settle (may be encrypted)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- Expensive derived artifacts, content-addressed by stage + canonical-input hash
-- (audit H7). A crash between generating a profile/translation and publishing it
-- never re-bills the model: the finished artifact is looked up by its input hash.
-- output_json may be at-rest-encrypted (it holds attendee-derived text).
CREATE TABLE IF NOT EXISTS pipeline_artifacts (
  stage TEXT NOT NULL,
  inputs_hash TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  output_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  -- Set (unix ms) when the artifact is a LEGACY orphan with no ownership ref
  -- (audit R11): pre-v2 artifacts predate artifact_refs, so a ref-counted purge
  -- would never find them. The v4 migration quarantines every unreferenced artifact;
  -- recording an ownership ref (creation or cache hit) clears it, and pruneOldData
  -- GCs artifacts still quarantined + unreferenced after a grace window. NULL = a
  -- normally-owned artifact.
  quarantined_at INTEGER,
  PRIMARY KEY (stage, inputs_hash)
);
-- Prerecorded talks (spec F2, audit U11). One row per (coordinate, speaker, talk_d).
-- media_json is the kind:"talk" descriptor (the JSON literal 'null' for external
-- talks); transcript_json is filled by process_talk (only when process_for_matching
-- is set and the media is on Blossom); status drives organizer moderation (pending →
-- published/rejected); revision supports editing (a bumped revision replaces the
-- previous 31610 at publish time). external_url/external_kind (2026-07-24) carry a
-- YouTube/mp4 talk hosted off-Blossom — the coordinator never fetches these (SSRF),
-- so they are view-only and never transcribed/matched.
CREATE TABLE IF NOT EXISTS talks (
  coordinate TEXT NOT NULL,
  pubkey TEXT NOT NULL,
  talk_d TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  speakers_json TEXT NOT NULL DEFAULT '[]',
  media_json TEXT NOT NULL,
  external_url TEXT,
  external_kind TEXT,
  source_type TEXT,
  process_for_matching INTEGER NOT NULL DEFAULT 0,
  transcript_json TEXT,
  lang TEXT NOT NULL DEFAULT 'en',
  revision INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  published_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (coordinate, pubkey, talk_d)
);
-- Poisoned/cleared pipeline jobs surfaced to the organizer (audit Q12). One row
-- per (coordinate, stage, pubkey); a later success clears it.
CREATE TABLE IF NOT EXISTS job_status (
  coordinate TEXT NOT NULL,
  stage TEXT NOT NULL,
  pubkey TEXT,
  state TEXT NOT NULL,           -- 'poison' | 'cleared'
  attempts INTEGER NOT NULL,
  error_category TEXT NOT NULL,
  retryable INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (coordinate, stage, pubkey)
);
-- ── Marmot group chat (MARMOT-GROUP-CHAT §4.3) ─────────────────────────────────
-- The coordinator is the MLS admin bot: it owns one group per chat-enabled event
-- and holds unlosable MLS state (§4.3 breaks the "DB loss only re-costs money"
-- property — losing these rows orphans the group's only admin). Every secret-
-- bearing column is at-rest-encrypted under the coordinator identity key exactly
-- like inbox_nsec/eck_json (the protect/reveal NIP-44 scheme).

-- One MLS group per chat-enabled event. mls_group_id is marmot's internal group
-- handle (hex); nostr_group_id is the random 32-byte routing id (hex, the 445 h tag).
CREATE TABLE IF NOT EXISTS marmot_groups (
  coordinate TEXT PRIMARY KEY,
  mls_group_id TEXT NOT NULL,
  nostr_group_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'   -- 'active' | 'frozen' (chat tag removed §9 Q4)
);
-- The MarmotClient's GenericKeyValueStore namespaces (group state / key-package
-- private material / invites / rewind), one physical row per (namespace,key). The
-- v blob is at-rest-encrypted — it holds MLS private key material and group
-- secrets, the same secret class as inbox_nsec.
CREATE TABLE IF NOT EXISTS marmot_kv (
  namespace TEXT NOT NULL,
  k TEXT NOT NULL,
  v TEXT NOT NULL,               -- serialized value, NIP-44-encrypted at rest
  PRIMARY KEY (namespace, k)
);
-- account_pubkey ⇄ chat_pubkey bindings from authenticated kind-21607 attestations
-- (§3.3). A local-key attendee has no row (their account key IS the chat identity);
-- NIP-46/NIP-07 attendees have one row per attested device key. status='revoked'
-- (21607 op:revoke or account revoke) drops the key from the authorized add set.
CREATE TABLE IF NOT EXISTS marmot_chat_keys (
  coordinate TEXT NOT NULL,
  account_pubkey TEXT NOT NULL,
  chat_pubkey TEXT NOT NULL,
  client_id TEXT,
  label TEXT,                             -- human device label from the 21607 add (NIP §10.2)
  status TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'revoked'
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (coordinate, chat_pubkey)
);
-- Idempotency ledger for consumed key packages (§4.2): a 30443 event id is added
-- to a group exactly once, so a re-delivered key package never re-invites.
CREATE TABLE IF NOT EXISTS marmot_consumed_kps (
  coordinate TEXT NOT NULL,
  kp_event_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (coordinate, kp_event_id)
);
-- Per-subject command watermark (NIP §3.4): the (created_at, rumor_id) of the last
-- FULLY applied command per (coordinate, subject), plus a pending/complete state and
-- resume progress_json (audit C1). A command strictly older than the watermark under
-- the §3.1 comparator is rejected, so transitions resolve deterministically per
-- subject instead of by arrival order. Membership transitions — organizer
-- approve/revoke AND attendee withdrawal — share ONE subject member:<pk> (audit R2,
-- schema v3) so a delayed old withdrawal orders against a newer reapproval instead of
-- against an independent watermark.
CREATE TABLE IF NOT EXISTS command_watermarks (
  coordinate TEXT NOT NULL,
  subject TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  rumor_id TEXT NOT NULL,
  PRIMARY KEY (coordinate, subject)
);
-- Coordinator install generation state (NIP §3.5): the highest generation ever
-- installed OR detached for a coordinate, plus a durable detach tombstone. A fresh
-- 21603 grant must carry a gen strictly greater than high_gen (so a replayed
-- historical install can never re-install), and a detach tombstones the row.
CREATE TABLE IF NOT EXISTS install_state (
  coordinate TEXT PRIMARY KEY,
  high_gen INTEGER NOT NULL DEFAULT 0,
  tombstoned INTEGER NOT NULL DEFAULT 0,   -- 1 once detached (custody deleted)
  detached_at INTEGER
);
-- Persisted billing state machine per installation (NIP §9, D5, §13.4). The
-- principal is typed (kind 'eid' = the event identity today; extensible to a
-- personal/organization principal later WITHOUT a wire change). state is the
-- durable enforcement verdict evaluating→ok|grace|blocked; a 'blocked' event stops
-- paid provider work but never revoke/detach/roster repair/status publication.
CREATE TABLE IF NOT EXISTS billing_state (
  coordinate TEXT PRIMARY KEY,
  principal_kind TEXT NOT NULL DEFAULT 'eid',
  principal_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'evaluating',
  reason TEXT,
  grace_until INTEGER,
  updated_at INTEGER NOT NULL
);
-- Durable per-attendee / per-event usage accounting (spec §8 budgets, H-2):
-- actual downloaded ciphertext BYTES, decoded media DURATION (probed via ffprobe,
-- not the attendee-declared value), and provider spend attempts (CALLS). Budgets
-- gate paid processing as an abuse ceiling. pubkey='' = event-scoped spend.
CREATE TABLE IF NOT EXISTS usage (
  coordinate TEXT NOT NULL,
  pubkey TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  duration_sec INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (coordinate, pubkey)
);
`;

export class Store {
  private db: DatabaseSync;
  /** Coordinator identity secret; when set, event-key columns are encrypted at rest. */
  private readonly identitySk?: Uint8Array;

  constructor(path = ":memory:", identitySk?: Uint8Array) {
    this.identitySk = identitySk;
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    // Refuse a newer database, apply the idempotent baseline shape, and run every
    // pending numbered migration transactionally (audit O3). Doctor's read-only
    // inspection (audit O2) deliberately does NOT come through here.
    migrate(this.db);
    // Migration (F1): encrypt any legacy plaintext event-key rows in place.
    if (this.identitySk) this.encryptPlaintextKeyRows();
  }

  close(): void {
    this.db.close();
  }

  // ── backup / integrity primitives (store/backup.ts, §13.2) ─────────────────
  /** The schema version recorded in this database (SQLite `user_version`). */
  schemaVersion(): number {
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    return row.user_version;
  }

  /**
   * Run `PRAGMA integrity_check` and return "ok" or a joined description of the
   * problems SQLite reports. A healthy database returns the single row "ok".
   */
  integrityCheck(): string {
    const rows = this.db.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[];
    const msgs = rows.map((r) => r.integrity_check);
    return msgs.length === 1 && msgs[0] === "ok" ? "ok" : msgs.join("; ");
  }

  /**
   * Write a consistent snapshot of this database to `destPath` via `VACUUM INTO`.
   * Under WAL, the vacuum reads a single committed snapshot even while the daemon
   * keeps writing, so the copy is crash-consistent without stopping the process.
   * `destPath` must not already exist (SQLite refuses to overwrite). The path is
   * a SQL string literal (no bind slot for VACUUM INTO), so single quotes are
   * doubled to keep it safe.
   */
  backupTo(destPath: string): void {
    const literal = destPath.replace(/'/g, "''");
    this.db.exec(`VACUUM INTO '${literal}'`);
  }

  /** Count of installed events (rows carrying custodied E_inbox/ECK material). */
  installedEventCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number };
    return row.n;
  }

  /**
   * Prove every protected event-key row decrypts under the loaded identity: read
   * each `inbox_nsec`/`eck_json`, decrypt it, and confirm the plaintext is the
   * expected shape (nsec → 32-byte hex, eck_json → parseable JSON). Throws on the
   * first row that fails. Returns the number of rows verified. A store opened
   * without an identity key throws immediately (it cannot prove anything).
   */
  verifyProtectedRowsDecrypt(): number {
    if (!this.identitySk) throw new Error("no identity key: cannot verify protected rows decrypt");
    const rows = this.db.prepare("SELECT coordinate, inbox_nsec, eck_json FROM events").all() as {
      coordinate: string;
      inbox_nsec: string;
      eck_json: string;
    }[];
    for (const row of rows) {
      const nsec = this.reveal(row.inbox_nsec);
      if (!/^[0-9a-f]{64}$/i.test(nsec)) {
        throw new Error(`event ${row.coordinate}: decrypted inbox_nsec is not 32-byte hex`);
      }
      const eck = this.reveal(row.eck_json);
      JSON.parse(eck); // throws if the decrypted ECK custody isn't valid JSON
    }
    return rows.length;
  }

  // ── at-rest protection of event-key columns (F1) ──────────────────────────
  /** Encrypt a sensitive column value for storage (no-op without an identity key). */
  private protect(value: string): string {
    if (!this.identitySk) return value;
    return ENC_PREFIX + selfEncrypt(this.identitySk, value);
  }

  /** Decrypt a sensitive column value read from storage (plaintext passes through). */
  private reveal(value: string): string {
    if (!value.startsWith(ENC_PREFIX)) return value; // legacy plaintext row
    if (!this.identitySk) {
      throw new Error("store holds encrypted event keys but no identity key was provided");
    }
    return selfDecrypt(this.identitySk, value.slice(ENC_PREFIX.length));
  }

  /**
   * One-way, idempotent startup migration: any events row whose `inbox_nsec` /
   * `eck_json` is still plaintext is re-encrypted in place. Already-encrypted
   * rows are left untouched, so running this on every startup is safe.
   */
  private encryptPlaintextKeyRows(): void {
    const rows = this.db
      .prepare("SELECT coordinate, inbox_nsec, eck_json FROM events")
      .all() as { coordinate: string; inbox_nsec: string; eck_json: string }[];
    let migrated = 0;
    for (const row of rows) {
      if (row.inbox_nsec.startsWith(ENC_PREFIX) && row.eck_json.startsWith(ENC_PREFIX)) continue;
      this.db
        .prepare("UPDATE events SET inbox_nsec = ?, eck_json = ? WHERE coordinate = ?")
        .run(
          this.protect(this.reveal(row.inbox_nsec)),
          this.protect(this.reveal(row.eck_json)),
          row.coordinate,
        );
      migrated++;
    }
    if (migrated > 0) {
      console.log(`[store] migrated ${migrated} plaintext event-key row(s) to at-rest encryption`);
    }
  }

  // ── rumor dedupe ──────────────────────────────────────────────────────────
  /** Returns true if this rumor id is new (and records it); false if seen. */
  markRumorSeen(rumorId: string, now: number): boolean {
    const existing = this.db.prepare("SELECT 1 FROM seen_rumors WHERE rumor_id = ?").get(rumorId);
    if (existing) return false;
    this.db
      .prepare("INSERT INTO seen_rumors (rumor_id, seen_at) VALUES (?, ?)")
      .run(rumorId, now);
    return true;
  }

  /** Read-only seen check (audit COORD-2): seen is recorded only AFTER handling. */
  isRumorSeen(rumorId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM seen_rumors WHERE rumor_id = ?").get(rumorId);
  }

  // ── durable inbox rate accounting (audit C3) ──────────────────────────────
  /**
   * Fixed-window rate accounting for the public inbox (audit C3): atomically bump
   * and return the count of inbound rumors for a (coordinate, pubkey) bucket in the
   * current `windowMs` window (`pubkey === ""` is the event-wide bucket). A new
   * window resets the count to 1. Durable so a burst survives restart accounting
   * instead of resetting the ledger every boot. The caller compares the returned
   * count against the configured per-window cap and drops the rumor when over.
   */
  bumpInboxRate(coordinate: string, pubkey: string, now: number, windowMs: number): number {
    const windowStart = windowMs > 0 ? now - (now % windowMs) : now;
    const row = this.db
      .prepare("SELECT window_start, count FROM inbox_rate WHERE coordinate = ? AND pubkey = ?")
      .get(coordinate, pubkey) as { window_start: number; count: number } | undefined;
    const count = row && row.window_start === windowStart ? row.count + 1 : 1;
    this.db
      .prepare(
        `INSERT INTO inbox_rate (coordinate, pubkey, window_start, count) VALUES (?, ?, ?, ?)
         ON CONFLICT(coordinate, pubkey) DO UPDATE SET window_start = excluded.window_start, count = excluded.count`,
      )
      .run(coordinate, pubkey, windowStart, count);
    return count;
  }

  /** Count of attendee rows for an event (audit C3 population cap: pending + approved
   *  + revoked). Used to bound roster growth below the 2,000 protocol cap. */
  attendeeCount(coordinate: string): number {
    return (
      this.db.prepare("SELECT COUNT(*) AS n FROM attendees WHERE coordinate = ?").get(coordinate) as { n: number }
    ).n;
  }

  /** Count of non-approved (pending) attendee rows for an event (audit C3). */
  pendingAttendeeCount(coordinate: string): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM attendees WHERE coordinate = ? AND status = 'pending'")
        .get(coordinate) as { n: number }
    ).n;
  }

  // ── events (installed via 21603) ──────────────────────────────────────────
  upsertEvent(row: {
    coordinate: string;
    configJson: string;
    inboxNsec: string;
    eckJson: string;
    configRelays: string;
    /** Install generation this event was granted at (NIP §3.5); keeps its value when omitted. */
    gen?: number;
    now: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO events (coordinate, config_json, inbox_nsec, eck_json, config_relays, gen, updated_at)
         VALUES (:coordinate, :configJson, :inboxNsec, :eckJson, :configRelays, COALESCE(:gen, 0), :now)
         ON CONFLICT(coordinate) DO UPDATE SET
           config_json = excluded.config_json,
           inbox_nsec = excluded.inbox_nsec,
           eck_json = excluded.eck_json,
           config_relays = excluded.config_relays,
           gen = COALESCE(:gen, events.gen),
           updated_at = excluded.updated_at`,
      )
      .run({
        coordinate: row.coordinate,
        configJson: row.configJson,
        inboxNsec: this.protect(row.inboxNsec),
        eckJson: this.protect(row.eckJson),
        configRelays: row.configRelays,
        gen: row.gen ?? null,
        now: row.now,
      });
  }

  getEvent(coordinate: string):
    | { coordinate: string; config_json: string; inbox_nsec: string; eck_json: string; config_relays: string; gen: number }
    | undefined {
    const row = this.db.prepare("SELECT * FROM events WHERE coordinate = ?").get(coordinate) as any;
    if (!row) return undefined;
    return { ...row, inbox_nsec: this.reveal(row.inbox_nsec), eck_json: this.reveal(row.eck_json), gen: row.gen ?? 0 };
  }

  allEvents(): { coordinate: string; inbox_nsec: string; config_relays: string; gen: number }[] {
    const rows = this.db
      .prepare("SELECT coordinate, inbox_nsec, config_relays, gen FROM events")
      .all() as any[];
    return rows.map((r) => ({ ...r, inbox_nsec: this.reveal(r.inbox_nsec), gen: r.gen ?? 0 }));
  }

  /** Delete an event's stored custody (E_inbox/ECK) row — detach disposes of key
   *  custody per decision D6. The install_state tombstone survives to bar re-install. */
  deleteEvent(coordinate: string): void {
    this.db.prepare("DELETE FROM events WHERE coordinate = ?").run(coordinate);
  }

  // ── retention-expiry terminal flag (NIP §6.2) ─────────────────────────────
  /** True once the retention sweep has expired this event (records deleted, paid
   *  processing parked). Survives restarts so paid work never resumes pre-sweep. */
  isRetentionExpired(coordinate: string): boolean {
    const row = this.db.prepare("SELECT retention_expired FROM events WHERE coordinate = ?").get(coordinate) as
      | { retention_expired: number }
      | undefined;
    return !!row && row.retention_expired === 1;
  }

  /** Mark an event retention-expired (idempotent). */
  markRetentionExpired(coordinate: string): void {
    this.db.prepare("UPDATE events SET retention_expired = 1 WHERE coordinate = ?").run(coordinate);
  }

  /** Lift an event's retention expiry (organizer extended/removed the policy). */
  clearRetentionExpired(coordinate: string): void {
    this.db.prepare("UPDATE events SET retention_expired = 0 WHERE coordinate = ?").run(coordinate);
  }

  // ── relay-handover candidate set (audit C9) ───────────────────────────────
  /** Record the CANDIDATE relay set of an in-progress make-before-break handover,
   *  kept separate from config_relays (last-known-good) until it is proven reachable. */
  setPendingRelays(coordinate: string, relays: string[]): void {
    this.db.prepare("UPDATE events SET pending_relays = ? WHERE coordinate = ?").run(JSON.stringify(relays), coordinate);
  }
  /** The candidate relay set of a pending handover, or undefined when none. */
  getPendingRelays(coordinate: string): string[] | undefined {
    const row = this.db.prepare("SELECT pending_relays FROM events WHERE coordinate = ?").get(coordinate) as
      | { pending_relays: string | null }
      | undefined;
    if (!row?.pending_relays) return undefined;
    try {
      const v = JSON.parse(row.pending_relays);
      return Array.isArray(v) ? (v as string[]) : undefined;
    } catch {
      return undefined;
    }
  }
  /** Clear a pending handover's candidate set (promoted, or abandoned). */
  clearPendingRelays(coordinate: string): void {
    this.db.prepare("UPDATE events SET pending_relays = NULL WHERE coordinate = ?").run(coordinate);
  }
  /** Coordinates that currently have a pending relay handover (restart resume). */
  coordinatesWithPendingRelays(): string[] {
    const rows = this.db
      .prepare("SELECT coordinate FROM events WHERE pending_relays IS NOT NULL")
      .all() as { coordinate: string }[];
    return rows.map((r) => r.coordinate);
  }

  // ── durable monotonic-publish watermark (NIP §3.2) ────────────────────────
  /**
   * Bump and return the `created_at` for a replaceable publish at `address`
   * (`${kind}:${d}`): `max(now, last_published_for_address + 1)`, persisted so a
   * restart keeps §3.2 monotonicity even if the wall clock hasn't advanced past what
   * was published before the restart (clock skew, a relay that clamps timestamps, or
   * successive publishes within one second straddling the restart). Atomic under the
   * single-daemon write lock.
   */
  nextPublishCreatedAt(address: string, now: number): number {
    const row = this.db.prepare("SELECT last_created_at FROM publish_watermarks WHERE address = ?").get(address) as
      | { last_created_at: number }
      | undefined;
    const next = row ? Math.max(now, row.last_created_at + 1) : now;
    this.db
      .prepare(
        `INSERT INTO publish_watermarks (address, last_created_at) VALUES (?, ?)
         ON CONFLICT(address) DO UPDATE SET last_created_at = excluded.last_created_at`,
      )
      .run(address, next);
    return next;
  }

  // ── admin-command per-subject operation state (NIP §3.4 + audit C1) ────────
  /**
   * The current command operation for a (coordinate, subject): its ordering key
   * (created_at, rumor_id), completion `state`, and any resume `progress_json`. The
   * recorded command is the newest one accepted for the subject; `state` says
   * whether its effect chain has FULLY completed. A stale/older DISTINCT command is
   * rejected against this; the SAME rumor may resume while `state` is 'pending'.
   */
  getCommandWatermark(
    coordinate: string,
    subject: string,
  ): { created_at: number; rumor_id: string; state: string; progress_json: string | null } | undefined {
    return this.db
      .prepare("SELECT created_at, rumor_id, state, progress_json FROM command_watermarks WHERE coordinate = ? AND subject = ?")
      .get(coordinate, subject) as
      | { created_at: number; rumor_id: string; state: string; progress_json: string | null }
      | undefined;
  }
  /**
   * Record the watermark of a fully-applied command (state 'complete'). Kept for
   * back-compat with callers that apply a command atomically; the resumable path
   * uses {@link beginCommandOp} + {@link completeCommandOp} instead.
   */
  setCommandWatermark(coordinate: string, subject: string, createdAt: number, rumorId: string): void {
    this.db
      .prepare(
        `INSERT INTO command_watermarks (coordinate, subject, created_at, rumor_id, state, progress_json) VALUES (?, ?, ?, ?, 'complete', NULL)
         ON CONFLICT(coordinate, subject) DO UPDATE SET created_at = excluded.created_at, rumor_id = excluded.rumor_id, state = 'complete', progress_json = NULL`,
      )
      .run(coordinate, subject, createdAt, rumorId);
  }
  /**
   * Mark a command's effect chain as STARTED but not yet complete (audit C1). Sets
   * the operation to this (created_at, rumor_id) with state 'pending'. Progress is
   * PRESERVED when the same rumor is resuming (so a mid-rotation ECK id survives a
   * retry) and RESET when a different (newer) command takes the subject over.
   */
  beginCommandOp(coordinate: string, subject: string, createdAt: number, rumorId: string, _now: number): void {
    this.db
      .prepare(
        `INSERT INTO command_watermarks (coordinate, subject, created_at, rumor_id, state, progress_json) VALUES (?, ?, ?, ?, 'pending', NULL)
         ON CONFLICT(coordinate, subject) DO UPDATE SET
           created_at = excluded.created_at,
           rumor_id = excluded.rumor_id,
           state = 'pending',
           progress_json = CASE WHEN command_watermarks.rumor_id = excluded.rumor_id THEN command_watermarks.progress_json ELSE NULL END`,
      )
      .run(coordinate, subject, createdAt, rumorId);
  }
  /** Mark the current command operation for a subject as fully complete (audit C1).
   *  No-op if a different rumor has since taken the subject over. */
  completeCommandOp(coordinate: string, subject: string, rumorId: string): void {
    this.db
      .prepare("UPDATE command_watermarks SET state = 'complete' WHERE coordinate = ? AND subject = ? AND rumor_id = ?")
      .run(coordinate, subject, rumorId);
  }
  /** The parsed resume progress for a subject's current operation (audit C1). */
  getCommandOpProgress(coordinate: string, subject: string): Record<string, unknown> {
    const row = this.getCommandWatermark(coordinate, subject);
    if (!row?.progress_json) return {};
    try {
      const v = JSON.parse(row.progress_json);
      return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  /** Persist resume progress for a subject's current operation, only while it is
   *  still the recorded rumor (audit C1: ECK-rotation state machine). */
  setCommandOpProgress(coordinate: string, subject: string, rumorId: string, progress: Record<string, unknown>): void {
    this.db
      .prepare("UPDATE command_watermarks SET progress_json = ? WHERE coordinate = ? AND subject = ? AND rumor_id = ?")
      .run(JSON.stringify(progress), coordinate, subject, rumorId);
  }

  // ── install generation / detach tombstone (NIP §3.5) ──────────────────────
  /** The highest generation ever installed OR detached for a coordinate (0 if none). */
  installHighGen(coordinate: string): number {
    const row = this.db
      .prepare("SELECT high_gen FROM install_state WHERE coordinate = ?")
      .get(coordinate) as { high_gen: number } | undefined;
    return row?.high_gen ?? 0;
  }
  /** Whether the coordinate is currently detach-tombstoned (custody deleted). */
  isInstallTombstoned(coordinate: string): boolean {
    const row = this.db
      .prepare("SELECT tombstoned FROM install_state WHERE coordinate = ?")
      .get(coordinate) as { tombstoned: number } | undefined;
    return !!row && row.tombstoned === 1;
  }
  /** Record a (re)install at `gen`: bump the high-water mark and clear any tombstone. */
  recordInstalledGen(coordinate: string, gen: number): void {
    this.db
      .prepare(
        `INSERT INTO install_state (coordinate, high_gen, tombstoned, detached_at) VALUES (?, ?, 0, NULL)
         ON CONFLICT(coordinate) DO UPDATE SET high_gen = MAX(install_state.high_gen, excluded.high_gen), tombstoned = 0, detached_at = NULL`,
      )
      .run(coordinate, gen);
  }
  /** Durably tombstone a detached install: bump the high-water mark to `gen`. */
  tombstoneInstall(coordinate: string, gen: number, detachedAt: number): void {
    this.db
      .prepare(
        `INSERT INTO install_state (coordinate, high_gen, tombstoned, detached_at) VALUES (?, ?, 1, ?)
         ON CONFLICT(coordinate) DO UPDATE SET high_gen = MAX(install_state.high_gen, excluded.high_gen), tombstoned = 1, detached_at = excluded.detached_at`,
      )
      .run(coordinate, gen, detachedAt);
  }

  /** Cancel every pending/running job for an event (detach: stop pending paid work). */
  cancelJobsForEvent(coordinate: string): number {
    // Jobs carry the coordinate in their JSON payload; match on it and drop the
    // non-terminal ones so a detached event's queued work never runs.
    const info = this.db
      .prepare(
        "DELETE FROM jobs WHERE state IN ('pending','running') AND json_extract(payload, '$.coordinate') = ?",
      )
      .run(coordinate);
    return Number(info.changes);
  }

  // ── attendees ─────────────────────────────────────────────────────────────
  /**
   * Upsert an attendee. Only fields explicitly provided are updated on conflict;
   * omitting a field leaves its stored value intact (so a profile submission does
   * NOT reset an already-approved status). Uses named params referenced directly
   * (not `excluded`) so a null bind means "keep existing".
   */
  upsertAttendee(row: {
    coordinate: string;
    pubkey: string;
    role?: string;
    status?: string;
    profileJson?: string | null;
    aiProfileJson?: string | null;
    profileHash?: string | null;
    sourceRevision?: string | null;
    aiSourceRevision?: string | null;
    transcriptsJson?: string | null;
    correctionJson?: string | null;
    displayName?: string | null;
    /** Ordering key of this profile submission (NIP §3.3); written only with a profile. */
    profileRev?: number | null;
    profileCreatedAt?: number | null;
    profileRumorId?: string | null;
    /** Ordering key of this correction (NIP §3.3); written only with a correction. */
    correctionRev?: number | null;
    correctionCreatedAt?: number | null;
    correctionRumorId?: string | null;
    now: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO attendees (coordinate, pubkey, role, status, profile_json, ai_profile_json, profile_hash, source_revision, ai_source_revision, transcripts_json, correction_json, display_name, profile_rev, profile_created_at, profile_rumor_id, correction_rev, correction_created_at, correction_rumor_id, updated_at)
         VALUES (:coordinate, :pubkey, COALESCE(:role, 'attendee'), COALESCE(:status, 'pending'),
                 :profileJson, :aiProfileJson, :profileHash, :sourceRevision, :aiSourceRevision, :transcriptsJson, :correctionJson, :displayName, :profileRev, :profileCreatedAt, :profileRumorId, :correctionRev, :correctionCreatedAt, :correctionRumorId, :now)
         ON CONFLICT(coordinate, pubkey) DO UPDATE SET
           role = COALESCE(:role, attendees.role),
           status = COALESCE(:status, attendees.status),
           profile_json = COALESCE(:profileJson, attendees.profile_json),
           ai_profile_json = COALESCE(:aiProfileJson, attendees.ai_profile_json),
           profile_hash = COALESCE(:profileHash, attendees.profile_hash),
           source_revision = COALESCE(:sourceRevision, attendees.source_revision),
           ai_source_revision = COALESCE(:aiSourceRevision, attendees.ai_source_revision),
           transcripts_json = COALESCE(:transcriptsJson, attendees.transcripts_json),
           correction_json = COALESCE(:correctionJson, attendees.correction_json),
           display_name = COALESCE(:displayName, attendees.display_name),
           profile_rev = COALESCE(:profileRev, attendees.profile_rev),
           profile_created_at = COALESCE(:profileCreatedAt, attendees.profile_created_at),
           profile_rumor_id = COALESCE(:profileRumorId, attendees.profile_rumor_id),
           correction_rev = COALESCE(:correctionRev, attendees.correction_rev),
           correction_created_at = COALESCE(:correctionCreatedAt, attendees.correction_created_at),
           correction_rumor_id = COALESCE(:correctionRumorId, attendees.correction_rumor_id),
           updated_at = :now`,
      )
      .run({
        coordinate: row.coordinate,
        pubkey: row.pubkey,
        role: row.role ?? null,
        status: row.status ?? null,
        profileJson: row.profileJson ?? null,
        aiProfileJson: row.aiProfileJson ?? null,
        profileHash: row.profileHash ?? null,
        sourceRevision: row.sourceRevision ?? null,
        aiSourceRevision: row.aiSourceRevision ?? null,
        transcriptsJson: row.transcriptsJson ?? null,
        correctionJson: row.correctionJson ?? null,
        displayName: row.displayName ?? null,
        profileRev: row.profileRev ?? null,
        profileCreatedAt: row.profileCreatedAt ?? null,
        profileRumorId: row.profileRumorId ?? null,
        correctionRev: row.correctionRev ?? null,
        correctionCreatedAt: row.correctionCreatedAt ?? null,
        correctionRumorId: row.correctionRumorId ?? null,
        now: row.now,
      });
  }

  getAttendee(coordinate: string, pubkey: string): AttendeeRow | undefined {
    return this.db
      .prepare("SELECT * FROM attendees WHERE coordinate = ? AND pubkey = ?")
      .get(coordinate, pubkey) as AttendeeRow | undefined;
  }

  /**
   * Compare-and-set commit of a completed AI pipeline run (audit C2). The
   * ai_profile / profile_hash / transcripts are written ONLY when the attendee's
   * current `source_revision` still equals the revision the run was derived from
   * (`expectedSourceRevision`). If a newer submission landed while the STT/LLM
   * calls were in flight, the row's source_revision has already advanced and this
   * write matches 0 rows — the stale result is discarded instead of overwriting the
   * newer submission's data (and its enqueue of matching is skipped by the caller).
   * `IS` (not `=`) so a NULL expected/stored revision compares correctly on legacy
   * rows. Returns true iff the row was updated.
   */
  commitAiProfile(row: {
    coordinate: string;
    pubkey: string;
    aiProfileJson: string;
    profileHash: string;
    aiSourceRevision: string | null;
    transcriptsJson: string;
    expectedSourceRevision: string | null;
    now: number;
  }): boolean {
    const info = this.db
      .prepare(
        `UPDATE attendees SET
           ai_profile_json = :aiProfileJson,
           profile_hash = :profileHash,
           ai_source_revision = :aiSourceRevision,
           transcripts_json = :transcriptsJson,
           updated_at = :now
         WHERE coordinate = :coordinate AND pubkey = :pubkey
           AND source_revision IS :expectedSourceRevision`,
      )
      .run({
        coordinate: row.coordinate,
        pubkey: row.pubkey,
        aiProfileJson: row.aiProfileJson,
        profileHash: row.profileHash,
        aiSourceRevision: row.aiSourceRevision,
        transcriptsJson: row.transcriptsJson,
        expectedSourceRevision: row.expectedSourceRevision,
        now: row.now,
      });
    return Number(info.changes) > 0;
  }

  approvedAttendees(coordinate: string): {
    pubkey: string;
    role: string;
    ai_profile_json: string | null;
    profile_hash: string | null;
  }[] {
    return this.db
      .prepare(
        "SELECT pubkey, role, ai_profile_json, profile_hash FROM attendees WHERE coordinate = ? AND status = 'approved'",
      )
      .all(coordinate) as any;
  }

  // ── transcripts (cache by blob sha256) ────────────────────────────────────
  getTranscript(blobSha256: string): string | undefined {
    const row = this.db
      .prepare("SELECT text FROM transcripts WHERE blob_sha256 = ?")
      .get(blobSha256) as { text: string } | undefined;
    return row?.text;
  }
  /** Transcript text + STT-detected language (spec F1), for publishing on 31603. */
  getTranscriptRow(blobSha256: string): { text: string; lang: string | null } | undefined {
    return this.db
      .prepare("SELECT text, lang FROM transcripts WHERE blob_sha256 = ?")
      .get(blobSha256) as { text: string; lang: string | null } | undefined;
  }
  /**
   * Cache a transcript keyed by its content-addressed blob hash (dedupe), and — when
   * an `owner` is given — record an ownership reference (audit C5). The transcript
   * PAYLOAD is deduplicated across events; the `transcript_refs` rows record WHICH
   * (event, attendee) depend on it, so a reference-counted purge can drop one
   * subject's data without deleting a payload another event still references.
   */
  putTranscript(
    blobSha256: string,
    text: string,
    now: number,
    lang?: string,
    owner?: { coordinate: string; pubkey: string },
  ): void {
    this.db
      .prepare("INSERT OR REPLACE INTO transcripts (blob_sha256, text, lang, created_at) VALUES (?, ?, ?, ?)")
      .run(blobSha256, text, lang ?? null, now);
    if (owner) {
      this.db
        .prepare(
          "INSERT OR IGNORE INTO transcript_refs (blob_sha256, coordinate, pubkey, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(blobSha256, owner.coordinate, owner.pubkey, now);
    }
  }

  /** Record an ownership reference to a content-addressed transcript (audit C5)
   *  without rewriting the payload — used by the pipeline once a blob is transcribed
   *  (or injected) so a purge can reference-count it. Idempotent. */
  recordTranscriptRef(blobSha256: string, coordinate: string, pubkey: string, now: number): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO transcript_refs (blob_sha256, coordinate, pubkey, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(blobSha256, coordinate, pubkey, now);
  }

  // ── nostr summaries (cache by pubkey + inputs hash) ───────────────────────
  getSummary(pubkey: string, inputsHash: string): string | undefined {
    const row = this.db
      .prepare("SELECT summary FROM nostr_summaries WHERE pubkey = ? AND inputs_hash = ?")
      .get(pubkey, inputsHash) as { summary: string } | undefined;
    return row?.summary;
  }
  putSummary(
    pubkey: string,
    inputsHash: string,
    summary: string,
    now: number,
    owner?: { coordinate: string },
  ): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO nostr_summaries (pubkey, inputs_hash, summary, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(pubkey, inputsHash, summary, now);
    // Record which event references this per-account summary (audit C5) so a purge
    // deletes it only when no OTHER event still references the same (pubkey, inputs).
    if (owner) {
      this.db
        .prepare(
          "INSERT OR IGNORE INTO summary_refs (pubkey, inputs_hash, coordinate, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(pubkey, inputsHash, owner.coordinate, now);
    }
  }

  // ── talks (spec F2) ───────────────────────────────────────────────────────
  /**
   * Insert or update a submitted talk. A (re)submission carries the current
   * metadata + media and resets status to 'pending' (needs moderation) — the
   * previously published 31610 stays live on relays until a new talk_publish
   * replaces it. The transcript is preserved unless the media hash changed.
   */
  upsertTalk(row: {
    coordinate: string;
    pubkey: string;
    talkD: string;
    title: string;
    description: string;
    speakersJson: string;
    /** kind:"talk" descriptor JSON, or the JSON literal 'null' for external talks. */
    mediaJson: string;
    externalUrl?: string | null;
    externalKind?: string | null;
    sourceType?: string | null;
    processForMatching?: boolean;
    lang: string;
    revision: number;
    /** Content fingerprint (media sha256 x, or the external URL); when it differs from
     *  the stored one the transcript is dropped (a re-recorded/replaced talk). */
    mediaX: string;
    now: number;
  }): boolean {
    const existing = this.getTalk(row.coordinate, row.pubkey, row.talkD);
    const contentHash = talkContentHash({
      mediaX: row.mediaX,
      title: row.title,
      description: row.description,
      speakersJson: row.speakersJson,
      lang: row.lang,
    });
    // Reject an out-of-order lower revision (NIP §3.3): relays can deliver history
    // out of order, and without this a delayed revision 0 would overwrite a live
    // revision 2 and reset its moderation status to 'pending'.
    if (existing && row.revision < existing.revision) return false;
    // Equal-revision rejection (NIP §3.3): a submission whose revision EQUALS the
    // stored one but whose content DIFFERS is rejected — a content change requires
    // a revision bump. Equal revision + identical content is an idempotent no-op
    // (the identical rumor is already deduped upstream; this catches a distinct
    // rumor carrying the same revision). Legacy rows with a null content_hash can't
    // be compared, so they fall through and re-apply once (then carry a hash).
    if (existing && row.revision === existing.revision && existing.content_hash != null) {
      return false;
    }
    let keepTranscript: string | null = existing?.transcript_json ?? null;
    if (existing) {
      try {
        const prevX = (JSON.parse(existing.media_json) as { x?: string }).x;
        if (prevX !== row.mediaX) keepTranscript = null; // re-recorded talk → stale transcript
      } catch {
        keepTranscript = null;
      }
    }
    this.db
      .prepare(
        `INSERT INTO talks (coordinate, pubkey, talk_d, title, description, speakers_json, media_json, external_url, external_kind, source_type, process_for_matching, transcript_json, lang, revision, content_hash, status, published_at, updated_at)
         VALUES (:coordinate, :pubkey, :talkD, :title, :description, :speakersJson, :mediaJson, :externalUrl, :externalKind, :sourceType, :processForMatching, :transcriptJson, :lang, :revision, :contentHash, 'pending', COALESCE((SELECT published_at FROM talks WHERE coordinate = :coordinate AND pubkey = :pubkey AND talk_d = :talkD), 0), :now)
         ON CONFLICT(coordinate, pubkey, talk_d) DO UPDATE SET
           title = excluded.title,
           description = excluded.description,
           speakers_json = excluded.speakers_json,
           media_json = excluded.media_json,
           external_url = excluded.external_url,
           external_kind = excluded.external_kind,
           source_type = excluded.source_type,
           process_for_matching = excluded.process_for_matching,
           transcript_json = excluded.transcript_json,
           lang = excluded.lang,
           revision = excluded.revision,
           content_hash = excluded.content_hash,
           status = 'pending',
           updated_at = excluded.updated_at`,
      )
      .run({
        coordinate: row.coordinate,
        pubkey: row.pubkey,
        talkD: row.talkD,
        title: row.title,
        description: row.description,
        speakersJson: row.speakersJson,
        mediaJson: row.mediaJson,
        externalUrl: row.externalUrl ?? null,
        externalKind: row.externalKind ?? null,
        sourceType: row.sourceType ?? null,
        processForMatching: row.processForMatching ? 1 : 0,
        transcriptJson: keepTranscript,
        lang: row.lang,
        revision: row.revision,
        contentHash,
        now: row.now,
      });
    return true;
  }

  getTalk(coordinate: string, pubkey: string, talkD: string): TalkRow | undefined {
    return this.db
      .prepare("SELECT * FROM talks WHERE coordinate = ? AND pubkey = ? AND talk_d = ?")
      .get(coordinate, pubkey, talkD) as TalkRow | undefined;
  }

  /** Distinct talks (by `talk_d`) a speaker has submitted for an event (audit
   *  COORD-4: caps unlimited talk submissions, one paid STT job per talk_d).
   *  Excludes 'rejected' talks: the organizer already said no to those, so
   *  they must free the speaker's quota back up rather than permanently
   *  occupying a slot with no way to submit a replacement. */
  countTalksBySpeaker(coordinate: string, pubkey: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM talks WHERE coordinate = ? AND pubkey = ? AND status != 'rejected'")
      .get(coordinate, pubkey) as { n: number };
    return row.n;
  }

  /**
   * Attach a transcript to a talk, but only if the row's current media still
   * matches the media the transcript was produced from (audit P0-7). `expectedX`
   * is the media sha256 the STT ran against; a newer talk revision that
   * re-recorded the media changes the row's `media_json.x`, so a slow STT result
   * for the OLD recording finishing after the new one lands is discarded rather
   * than attached to the wrong media. Returns true if the transcript was written.
   */
  setTalkTranscript(
    coordinate: string,
    pubkey: string,
    talkD: string,
    transcriptJson: string,
    now: number,
    expectedX?: string,
  ): boolean {
    const info =
      expectedX === undefined
        ? this.db
            .prepare("UPDATE talks SET transcript_json = ?, updated_at = ? WHERE coordinate = ? AND pubkey = ? AND talk_d = ?")
            .run(transcriptJson, now, coordinate, pubkey, talkD)
        : this.db
            .prepare(
              "UPDATE talks SET transcript_json = ?, updated_at = ? WHERE coordinate = ? AND pubkey = ? AND talk_d = ? AND json_extract(media_json, '$.x') = ?",
            )
            .run(transcriptJson, now, coordinate, pubkey, talkD, expectedX);
    return info.changes > 0;
  }

  setTalkStatus(
    coordinate: string,
    pubkey: string,
    talkD: string,
    status: "pending" | "published" | "rejected",
    publishedAt: number,
    now: number,
    /** The ECK version id the 31610 was published under (COORD-7); recorded on publish. */
    publishedEckId?: number | null,
  ): void {
    this.db
      .prepare("UPDATE talks SET status = ?, published_at = ?, published_eck_id = COALESCE(?, published_eck_id), updated_at = ? WHERE coordinate = ? AND pubkey = ? AND talk_d = ?")
      .run(status, publishedAt, publishedEckId ?? null, now, coordinate, pubkey, talkD);
  }

  /** Every 'published' talk of an event (COORD-7: republish under a rotated ECK). */
  publishedTalksForEvent(coordinate: string): TalkRow[] {
    return this.db
      .prepare("SELECT * FROM talks WHERE coordinate = ? AND status = 'published'")
      .all(coordinate) as unknown as TalkRow[];
  }

  /** Transcript texts of a speaker's talks (spec §9.2): fed into their ai_profile. */
  talkTranscriptsForSpeaker(coordinate: string, pubkey: string): string[] {
    const rows = this.db
      .prepare("SELECT transcript_json FROM talks WHERE coordinate = ? AND pubkey = ? AND transcript_json IS NOT NULL")
      .all(coordinate, pubkey) as { transcript_json: string }[];
    const out: string[] = [];
    for (const r of rows) {
      try {
        const tr = JSON.parse(r.transcript_json) as { text?: string };
        if (tr.text) out.push(tr.text);
      } catch {
        /* skip malformed */
      }
    }
    return out;
  }

  // ── pairs (cache by inputs hash) ──────────────────────────────────────────
  // Scoring is DIRECTIONAL (spec §16.2, batched matcher): the from→to direction
  // lives in the base columns when from is the lexically-smaller pubkey, else in
  // the *_b columns. A row is created by whichever direction is scored first; the
  // other direction fills its own columns later without clobbering.
  getPair(coordinate: string, a: string, b: string):
    | { inputs_hash: string; score: number; similarity: number; complementarity: number; reasoning: string }
    | undefined {
    const [x, y] = a < b ? [a, b] : [b, a];
    return this.db
      .prepare("SELECT * FROM pairs WHERE coordinate = ? AND a = ? AND b = ?")
      .get(coordinate, x, y) as any;
  }

  /**
   * The stored state of the `from → to` direction: whether it has been scored for
   * the given inputs_hash. Returns undefined if no row exists at all, and
   * `scored:false` if a row exists (from the reverse direction) but this direction
   * is still empty. Used by the matcher to select only unscored directed pairs.
   */
  getPairDirection(coordinate: string, from: string, to: string):
    | { inputs_hash: string; scored: boolean; score: number; reasoning: string | null }
    | undefined {
    const [x, y] = from < to ? [from, to] : [to, from];
    const row = this.db
      .prepare("SELECT * FROM pairs WHERE coordinate = ? AND a = ? AND b = ?")
      .get(coordinate, x, y) as any;
    if (!row) return undefined;
    const fromIsX = from === x;
    const reasoning = fromIsX ? row.reasoning : row.reasoning_b;
    const score = fromIsX ? row.score : (row.score_b ?? row.score);
    // A NULL/empty directional reasoning means that direction was never scored (the
    // row exists only because the reverse direction populated it).
    const scored = reasoning != null && reasoning !== "";
    return { inputs_hash: row.inputs_hash, scored, score, reasoning };
  }

  putPair(row: {
    coordinate: string;
    a: string;
    b: string;
    inputsHash: string;
    score: number;
    similarity: number;
    complementarity: number;
    reasoningForA: string; // addressed to row.a
    reasoningForB: string; // addressed to row.b
    now: number;
  }): void {
    // Convenience: write both directions at once (pairwise path / tests). Uses the
    // same directional columns as putPairDirection.
    this.putPairDirection({
      coordinate: row.coordinate,
      from: row.a,
      to: row.b,
      inputsHash: row.inputsHash,
      score: row.score,
      similarity: row.similarity,
      complementarity: row.complementarity,
      reasoning: row.reasoningForA,
      now: row.now,
    });
    this.putPairDirection({
      coordinate: row.coordinate,
      from: row.b,
      to: row.a,
      inputsHash: row.inputsHash,
      score: row.score,
      similarity: row.similarity,
      complementarity: row.complementarity,
      reasoning: row.reasoningForB,
      now: row.now,
    });
  }

  /**
   * Persist ONE direction (from → to). Creates the pair row if absent and fills
   * only this direction's score/similarity/complementarity/reasoning columns,
   * preserving whatever the reverse direction already wrote. A changed inputs_hash
   * resets the whole row (both directions must be re-scored).
   */
  putPairDirection(row: {
    coordinate: string;
    from: string;
    to: string;
    inputsHash: string;
    score: number;
    similarity: number;
    complementarity: number;
    reasoning: string;
    /** ≤ 3 conversation starters addressed to `from` (NIP §6.2). */
    icebreakers?: string[];
    now: number;
  }): void {
    const [x, y] = row.from < row.to ? [row.from, row.to] : [row.to, row.from];
    const fromIsX = row.from === x;
    const icebreakersJson = row.icebreakers && row.icebreakers.length > 0 ? JSON.stringify(row.icebreakers) : null;
    const existing = this.db
      .prepare("SELECT inputs_hash FROM pairs WHERE coordinate = ? AND a = ? AND b = ?")
      .get(row.coordinate, x, y) as { inputs_hash: string } | undefined;
    // Stale row (profile changed): drop it so both directions re-score cleanly.
    if (existing && existing.inputs_hash !== row.inputsHash) {
      this.db
        .prepare("DELETE FROM pairs WHERE coordinate = ? AND a = ? AND b = ?")
        .run(row.coordinate, x, y);
    }
    if (fromIsX) {
      this.db
        .prepare(
          `INSERT INTO pairs (coordinate, a, b, inputs_hash, score, similarity, complementarity, reasoning, icebreakers_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(coordinate, a, b) DO UPDATE SET
             inputs_hash = excluded.inputs_hash, score = excluded.score,
             similarity = excluded.similarity, complementarity = excluded.complementarity,
             reasoning = excluded.reasoning, icebreakers_json = excluded.icebreakers_json,
             created_at = excluded.created_at`,
        )
        .run(row.coordinate, x, y, row.inputsHash, row.score, row.similarity, row.complementarity, row.reasoning, icebreakersJson, row.now);
    } else {
      // b→a direction: write the *_b columns. On INSERT the base (a→b) columns are
      // not yet known — seed them so the NOT NULL constraints hold; the a→b batch
      // overwrites them later.
      this.db
        .prepare(
          `INSERT INTO pairs (coordinate, a, b, inputs_hash, score, similarity, complementarity, reasoning, score_b, similarity_b, complementarity_b, reasoning_b, icebreakers_b_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?)
           ON CONFLICT(coordinate, a, b) DO UPDATE SET
             inputs_hash = excluded.inputs_hash, score_b = excluded.score_b,
             similarity_b = excluded.similarity_b, complementarity_b = excluded.complementarity_b,
             reasoning_b = excluded.reasoning_b, icebreakers_b_json = excluded.icebreakers_b_json,
             created_at = excluded.created_at`,
        )
        .run(
          row.coordinate, x, y, row.inputsHash,
          row.score, row.similarity, row.complementarity, // seed base cols for NOT NULL
          row.score, row.similarity, row.complementarity, row.reasoning, icebreakersJson, row.now,
        );
    }
  }
  /** Drop all cached pair scores for an event (forces a full re-score). */
  clearPairs(coordinate: string): void {
    this.db.prepare("DELETE FROM pairs WHERE coordinate = ?").run(coordinate);
  }

  /** Drop every cached pair involving `pubkey` (audit H3: exclude a revoked attendee). */
  clearPairsInvolving(coordinate: string, pubkey: string): void {
    this.db
      .prepare("DELETE FROM pairs WHERE coordinate = ? AND (a = ? OR b = ?)")
      .run(coordinate, pubkey, pubkey);
  }

  /**
   * Full purge of an attendee's stored derived artifacts (NIP §6.3 21610,
   * `delete_data: true`). Removes the coordinator's private DB copies of everything
   * derived from the attendee's submission — the attendee row (profile, ai_profile,
   * transcripts_json, correction), their submissions, their per-account nostr
   * summary, their talks, and the content-addressed STT transcripts for every media
   * blob they submitted (intro + talk media). Cached pair scores are already dropped
   * by `clearPairsInvolving` on the revoke path. Idempotent.
   *
   * `delete_data: false` withdrawals do NOT call this — those artifacts are retained
   * so a later re-approval avoids reprocessing spend (chiefly re-running STT).
   */
  purgeAttendeeArtifacts(coordinate: string, pubkey: string): void {
    // Collect every media ciphertext hash (`x`) this attendee submitted, so LEGACY
    // transcript rows (written before ownership refs existed, audit C5) can still be
    // attributed and dropped. Sources: the attendee's stored profile media
    // (`profile_json.__media`) and their talk media (`talks.media_json`).
    const blobHashes = new Set<string>();
    const att = this.db
      .prepare("SELECT profile_json FROM attendees WHERE coordinate = ? AND pubkey = ?")
      .get(coordinate, pubkey) as { profile_json: string | null } | undefined;
    if (att?.profile_json) {
      try {
        const media = (JSON.parse(att.profile_json) as { __media?: { x?: string }[] }).__media ?? [];
        for (const m of media) if (typeof m.x === "string") blobHashes.add(m.x);
      } catch {
        /* malformed stored JSON — nothing to collect */
      }
    }
    const talkRows = this.db
      .prepare("SELECT media_json FROM talks WHERE coordinate = ? AND pubkey = ?")
      .all(coordinate, pubkey) as { media_json: string }[];
    for (const t of talkRows) {
      try {
        const x = (JSON.parse(t.media_json) as { x?: string }).x;
        if (typeof x === "string") blobHashes.add(x);
      } catch {
        /* ignore */
      }
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.purgeSubjectInTxn(coordinate, pubkey, blobHashes);
      this.db.prepare("DELETE FROM attendees WHERE coordinate = ? AND pubkey = ?").run(coordinate, pubkey);
      // The withdrawing attendee's chat-device bindings are their PII (audit R12):
      // remove them too. The command_watermark for `member:<pk>` is deliberately KEPT
      // — it is the replay bar that stops a re-delivered old withdrawal from undoing a
      // later reapproval (audit R2); the event is still live, so it is security state.
      this.db.prepare("DELETE FROM marmot_chat_keys WHERE coordinate = ? AND account_pubkey = ?").run(coordinate, pubkey);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /**
   * Full event-wide local purge (audit C5 + R12): remove EVERY coordinator-held
   * derived copy AND every event-scoped personal identifier for an event. Used by the
   * retention sweep (NIP §6.2) so "delete member data after the event" actually
   * deletes the local plaintext, not just the relay records. Idempotent.
   *
   * Explicit, TESTED retention table inventory (audit R12 — every event-scoped table
   * has a documented disposition; a new table MUST be classified here):
   *
   *   DELETED (attendee-derived data or personal identifiers):
   *     - attendees                          profiles / ai_profiles / corrections
   *     - submissions, talks                 per-subject (via purgeSubjectInTxn)
   *     - transcripts / pipeline_artifacts / nostr_summaries   reference-counted:
   *                                          a payload another event still references
   *                                          SURVIVES; this event's refs are dropped
   *     - transcript_refs / artifact_refs / summary_refs       ownership rows
   *     - pairs, job_status, usage, inbox_rate, invite_usage   derived/accounting
   *     - command_watermarks                 subjects carry attendee pubkeys + rumor
   *                                          ids (R12). Safe post-expiry: the event is
   *                                          terminal and retention_expired gates every
   *                                          future inbox rumor, so replay protection
   *                                          no longer depends on these rows.
   *     - jobs (ALL states incl. terminal/waiting)   payloads carry attendee pubkeys
   *                                          (R12); cancelJobsForEvent only drops
   *                                          pending/running, so poison/waiting rows
   *                                          would otherwise leak identities.
   *     - marmot_chat_keys                   attendee account/chat pubkeys + device
   *                                          bindings (R12)
   *     - marmot_consumed_kps                consumed key-package event ids (R12)
   *     - marmot_groups                      the event's MLS group row (coordinate-keyed)
   *
   *   RETAINED (minimal security / replay state, justified — audit R12):
   *     - install_state                      detach tombstone + install generation
   *                                          high-water mark: a security replay bar
   *                                          (a replayed historical grant must never
   *                                          re-install). Carries no attendee data.
   *     - billing_state                      the event-identity billing principal + its
   *                                          verdict — an operator/billing decision,
   *                                          not attendee data.
   *     - seen_rumors                        the durable dedupe/replay ledger (global,
   *                                          not coordinate-scoped); pruning it would
   *                                          re-open replay windows. Holds rumor IDS
   *                                          only, no attendee content.
   *     - marmot_kv                          the coordinator's OWN MLS key material /
   *                                          group secrets, namespaced by group handle
   *                                          not by coordinate. Not attendee PII; a
   *                                          clean coordinate-scoped delete isn't
   *                                          available here (see handoff).
   */
  purgeEventArtifacts(coordinate: string): void {
    const pubkeys = (
      this.db.prepare("SELECT DISTINCT pubkey FROM attendees WHERE coordinate = ?").all(coordinate) as {
        pubkey: string;
      }[]
    ).map((r) => r.pubkey);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const pubkey of pubkeys) {
        const blobHashes = new Set<string>();
        const att = this.db
          .prepare("SELECT profile_json FROM attendees WHERE coordinate = ? AND pubkey = ?")
          .get(coordinate, pubkey) as { profile_json: string | null } | undefined;
        if (att?.profile_json) {
          try {
            const media = (JSON.parse(att.profile_json) as { __media?: { x?: string }[] }).__media ?? [];
            for (const m of media) if (typeof m.x === "string") blobHashes.add(m.x);
          } catch {
            /* malformed */
          }
        }
        const talkRows = this.db
          .prepare("SELECT media_json FROM talks WHERE coordinate = ? AND pubkey = ?")
          .all(coordinate, pubkey) as { media_json: string }[];
        for (const t of talkRows) {
          try {
            const x = (JSON.parse(t.media_json) as { x?: string }).x;
            if (typeof x === "string") blobHashes.add(x);
          } catch {
            /* ignore */
          }
        }
        this.purgeSubjectInTxn(coordinate, pubkey, blobHashes);
      }
      // Event-scoped derived + accounting tables (see the inventory above). Billing/
      // install-generation state is deliberately retained (a detach/re-install
      // decision, not attendee data).
      this.db.prepare("DELETE FROM attendees WHERE coordinate = ?").run(coordinate);
      this.db.prepare("DELETE FROM pairs WHERE coordinate = ?").run(coordinate);
      this.db.prepare("DELETE FROM job_status WHERE coordinate = ?").run(coordinate);
      this.db.prepare("DELETE FROM usage WHERE coordinate = ?").run(coordinate);
      this.db.prepare("DELETE FROM inbox_rate WHERE coordinate = ?").run(coordinate);
      this.db.prepare("DELETE FROM invite_usage WHERE coordinate = ?").run(coordinate);
      // Personal identifiers the pre-R12 purge missed:
      this.db.prepare("DELETE FROM command_watermarks WHERE coordinate = ?").run(coordinate);
      // ALL job states (terminal/waiting too) — payloads carry attendee pubkeys.
      this.db
        .prepare("DELETE FROM jobs WHERE json_extract(payload, '$.coordinate') = ?")
        .run(coordinate);
      this.db.prepare("DELETE FROM marmot_chat_keys WHERE coordinate = ?").run(coordinate);
      this.db.prepare("DELETE FROM marmot_consumed_kps WHERE coordinate = ?").run(coordinate);
      this.db.prepare("DELETE FROM marmot_groups WHERE coordinate = ?").run(coordinate);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /**
   * Reference-counted deletion of one subject's (coordinate, pubkey) derived
   * artifacts, WITHIN an already-open transaction (audit C5). Deletes the subject's
   * talks, submissions, and ownership-ref rows, then drops each content-addressed
   * payload (transcript / pipeline artifact / nostr summary) only when NO ownership
   * reference to it remains — so a payload another event still references survives.
   * `legacyBlobs` are media hashes attributed to the subject from their stored
   * profile/talk media, covering transcripts written before refs existed.
   */
  private purgeSubjectInTxn(coordinate: string, pubkey: string, legacyBlobs: Set<string>): void {
    // ── transcripts ──
    const ownedBlobs = new Set<string>(legacyBlobs);
    for (const r of this.db
      .prepare("SELECT blob_sha256 FROM transcript_refs WHERE coordinate = ? AND pubkey = ?")
      .all(coordinate, pubkey) as { blob_sha256: string }[]) {
      ownedBlobs.add(r.blob_sha256);
    }
    this.db.prepare("DELETE FROM transcript_refs WHERE coordinate = ? AND pubkey = ?").run(coordinate, pubkey);
    const transcriptRefCount = this.db.prepare(
      "SELECT COUNT(*) AS n FROM transcript_refs WHERE blob_sha256 = ?",
    );
    const delTranscript = this.db.prepare("DELETE FROM transcripts WHERE blob_sha256 = ?");
    for (const x of ownedBlobs) {
      if ((transcriptRefCount.get(x) as { n: number }).n === 0) delTranscript.run(x);
    }
    // ── pipeline artifacts ──
    const ownedArtifacts = this.db
      .prepare("SELECT stage, inputs_hash FROM artifact_refs WHERE coordinate = ? AND pubkey = ?")
      .all(coordinate, pubkey) as { stage: string; inputs_hash: string }[];
    this.db.prepare("DELETE FROM artifact_refs WHERE coordinate = ? AND pubkey = ?").run(coordinate, pubkey);
    const artifactRefCount = this.db.prepare(
      "SELECT COUNT(*) AS n FROM artifact_refs WHERE stage = ? AND inputs_hash = ?",
    );
    const delArtifact = this.db.prepare("DELETE FROM pipeline_artifacts WHERE stage = ? AND inputs_hash = ?");
    for (const a of ownedArtifacts) {
      if ((artifactRefCount.get(a.stage, a.inputs_hash) as { n: number }).n === 0) {
        delArtifact.run(a.stage, a.inputs_hash);
      }
    }
    // ── nostr summaries (per-account, keyed by pubkey + inputs_hash) ──
    // Delete only this event's ref, then drop the payload when no other event
    // references it — fixing the pre-C5 global-by-pubkey deletion that damaged other
    // events. Legacy summaries (no ref rows) are dropped for this pubkey.
    const ownedSummaries = this.db
      .prepare("SELECT inputs_hash FROM summary_refs WHERE coordinate = ? AND pubkey = ?")
      .all(coordinate, pubkey) as { inputs_hash: string }[];
    this.db.prepare("DELETE FROM summary_refs WHERE coordinate = ? AND pubkey = ?").run(coordinate, pubkey);
    const summaryRefCount = this.db.prepare(
      "SELECT COUNT(*) AS n FROM summary_refs WHERE pubkey = ? AND inputs_hash = ?",
    );
    const delSummary = this.db.prepare("DELETE FROM nostr_summaries WHERE pubkey = ? AND inputs_hash = ?");
    for (const s of ownedSummaries) {
      if ((summaryRefCount.get(pubkey, s.inputs_hash) as { n: number }).n === 0) {
        delSummary.run(pubkey, s.inputs_hash);
      }
    }
    // Legacy summaries with no surviving ref anywhere: drop this pubkey's rows that
    // are referenced by NO event at all.
    this.db
      .prepare(
        `DELETE FROM nostr_summaries WHERE pubkey = ? AND inputs_hash NOT IN
           (SELECT inputs_hash FROM summary_refs WHERE pubkey = ?)`,
      )
      .run(pubkey, pubkey);
    // ── the subject's own rows ──
    this.db.prepare("DELETE FROM talks WHERE coordinate = ? AND pubkey = ?").run(coordinate, pubkey);
    this.db.prepare("DELETE FROM submissions WHERE coordinate = ? AND pubkey = ?").run(coordinate, pubkey);
  }

  pairsFor(coordinate: string, pubkey: string): {
    other: string;
    score: number;
    similarity: number;
    complementarity: number;
    reasoning: string;
    icebreakers?: string[];
  }[] {
    // Return pubkey's OWN directional view: when pubkey is the stored `a`, the base
    // columns are its outbound (a→b) score/reasoning; when it is `b`, the *_b
    // columns. Scores COALESCE to the shared value for legacy pairwise rows (which
    // set reasoning_b but not score_b); reasoning must NOT fall back — a NULL
    // reasoning_b means the b→a direction was never scored. Icebreakers follow the
    // same directional selection as reasoning.
    const rows = this.db
      .prepare(
        `SELECT CASE WHEN a = ? THEN b ELSE a END AS other,
                CASE WHEN a = ? THEN score ELSE COALESCE(score_b, score) END AS score,
                CASE WHEN a = ? THEN similarity ELSE COALESCE(similarity_b, similarity) END AS similarity,
                CASE WHEN a = ? THEN complementarity ELSE COALESCE(complementarity_b, complementarity) END AS complementarity,
                CASE WHEN a = ? THEN reasoning ELSE reasoning_b END AS reasoning,
                CASE WHEN a = ? THEN icebreakers_json ELSE icebreakers_b_json END AS icebreakers_json
         FROM pairs WHERE coordinate = ? AND (a = ? OR b = ?)`,
      )
      .all(pubkey, pubkey, pubkey, pubkey, pubkey, pubkey, coordinate, pubkey, pubkey) as any[];
    // Only surface directions that have actually been scored (non-empty reasoning);
    // a row seeded by the reverse direction has an empty/NULL value here.
    return rows
      .filter((r) => r.reasoning != null && r.reasoning !== "")
      .map((r) => {
        let icebreakers: string[] | undefined;
        if (r.icebreakers_json) {
          try {
            const parsed = JSON.parse(r.icebreakers_json);
            if (Array.isArray(parsed) && parsed.every((s) => typeof s === "string")) icebreakers = parsed;
          } catch {
            /* malformed stored JSON — drop icebreakers, keep the match */
          }
        }
        return {
          other: r.other,
          score: r.score,
          similarity: r.similarity,
          complementarity: r.complementarity,
          reasoning: r.reasoning,
          ...(icebreakers ? { icebreakers } : {}),
        };
      });
  }

  // ── invite usage (first-come, single-use) ─────────────────────────────────
  /**
   * Record usage; returns true if this is the first use of the invite pubkey.
   * Atomic (audit COORD-25): the INSERT ... ON CONFLICT DO NOTHING is the claim —
   * the PRIMARY KEY serializes concurrent claimants, so two simultaneous joins
   * with the same invite can't both win the SELECT-then-INSERT race.
   */
  /**
   * Claim one redemption of an invite code for `usedBy`, up to `maxUses`
   * DISTINCT redeemers (0 = unlimited). Returns whether this attendee holds a
   * redemption afterwards.
   *
   * Re-claiming for the SAME attendee is idempotent and never consumes a second
   * slot — a re-delivered join request must not be able to exhaust a shared
   * code, and the join handler re-runs on exactly that path.
   */
  claimInvite(
    coordinate: string,
    invitePubkey: string,
    usedBy: string,
    now: number,
    maxUses = 1,
  ): boolean {
    const held = this.db
      .prepare("SELECT 1 FROM invite_usage WHERE coordinate = ? AND invite_pubkey = ? AND used_by = ?")
      .get(coordinate, invitePubkey, usedBy);
    if (held) return true; // already redeemed by this attendee
    if (maxUses !== 0) {
      const { n } = this.db
        .prepare("SELECT COUNT(*) AS n FROM invite_usage WHERE coordinate = ? AND invite_pubkey = ?")
        .get(coordinate, invitePubkey) as { n: number };
      if (n >= maxUses) return false; // spent
    }
    const info = this.db
      .prepare(
        "INSERT INTO invite_usage (coordinate, invite_pubkey, used_by, used_at) VALUES (?, ?, ?, ?) ON CONFLICT(coordinate, invite_pubkey, used_by) DO NOTHING",
      )
      .run(coordinate, invitePubkey, usedBy, now);
    return info.changes > 0;
  }

  /** How many distinct attendees have redeemed this code. */
  inviteRedemptions(coordinate: string, invitePubkey: string): number {
    const { n } = this.db
      .prepare("SELECT COUNT(*) AS n FROM invite_usage WHERE coordinate = ? AND invite_pubkey = ?")
      .get(coordinate, invitePubkey) as { n: number };
    return n;
  }

  // ── jobs ──────────────────────────────────────────────────────────────────
  /**
   * Enqueue a job. Idempotent on `dedupe_key` (UNIQUE): a duplicate does not
   * create a second row — that is what keeps a re-delivered rumor or a restart
   * mid-pipeline from paying twice.
   *
   * It RETURNS what happened, because "silently ignored" was too silent. Terminal
   * rows (`done`/`poison`) are kept for 30 days, so an enqueue that collides with
   * one is discarded permanently and invisibly. That is exactly how an organizer
   * recompute could wipe the cached pair scores (`clearPairs`) and then enqueue
   * scoring work whose dedupe keys matched the previous run's finished rows: the
   * batches were logged as dispatched, no row was created, nothing ever ran, and
   * not one line said so (production incident 2026-07-24).
   */
  enqueueJob(type: string, dedupeKey: string, payload: unknown): EnqueueOutcome {
    const info = this.db
      .prepare(
        "INSERT OR IGNORE INTO jobs (type, dedupe_key, payload, state, next_run_at) VALUES (?, ?, ?, 'pending', 0)",
      )
      .run(type, dedupeKey, JSON.stringify(payload));
    if (Number(info.changes) > 0) return "enqueued";
    const row = this.db.prepare("SELECT state FROM jobs WHERE dedupe_key = ?").get(dedupeKey) as
      | { state: JobState }
      | undefined;
    // No row despite the ignore (deleted between statements) — report it as queued;
    // the caller's next enqueue of the same key will insert normally.
    return row?.state ?? "enqueued";
  }

  /**
   * Drop the TERMINAL (`done`/`poison`) matching-stage job rows for one event, so
   * their content-addressed dedupe keys stop suppressing a re-enqueue of the same
   * work. Called on the organizer `recompute` path next to `clearPairs`: that
   * command means "forget the cached results and redo them", which has to include
   * the job queue's memory of having already done them, or the recompute deletes
   * every score and re-creates none (production incident 2026-07-24).
   *
   * Deliberately narrow. Only matching-stage rows, and only terminal ones —
   * `pending`/`running`/`waiting` rows are live work that must keep coalescing, and
   * `process_attendee` is left alone so a recompute never re-runs STT.
   */
  clearMatchJobMemo(coordinate: string): number {
    const placeholders = MATCH_JOB_TYPES.map(() => "?").join(",");
    const info = this.db
      .prepare(
        `DELETE FROM jobs
           WHERE state IN ('done','poison')
             AND type IN (${placeholders})
             AND json_extract(payload, '$.coordinate') = ?`,
      )
      .run(...MATCH_JOB_TYPES, coordinate);
    return Number(info.changes);
  }

  /**
   * Drop the TERMINAL (`done`/`poison`) `process_attendee` rows for ONE attendee,
   * so their dedupe keys stop suppressing a re-enqueue. The reprocess counterpart
   * of {@link clearMatchJobMemo}.
   *
   * Without it an organizer's "reprocess" is a one-shot that silently stops
   * working: `enqueueJob` is INSERT OR IGNORE on `dedupe_key`, so once a row for
   * this attendee is terminal every later press is discarded — including, and
   * most importantly, when the row is POISONED. Two attendees had their
   * `process_attendee` poison in July on a translation shape that has since been
   * fixed, and no operator action could re-run them: recompute deliberately
   * leaves `process_attendee` alone (so it never re-runs STT), and reprocess's
   * own enqueue hit the poisoned key and vanished. Their profiles were
   * unrecoverable through the UI.
   *
   * Narrow on purpose: one attendee, terminal rows only. `pending`/`running`/
   * `waiting` rows are live work that must keep coalescing.
   */
  clearAttendeeJobMemo(coordinate: string, pubkey: string): number {
    const info = this.db
      .prepare(
        `DELETE FROM jobs
           WHERE state IN ('done','poison')
             AND type = 'process_attendee'
             AND json_extract(payload, '$.coordinate') = ?
             AND json_extract(payload, '$.pubkey') = ?`,
      )
      .run(coordinate, pubkey);
    return Number(info.changes);
  }

  /** Row count per job state (queue-depth reporting). Absent states are omitted. */
  jobStateCounts(): Partial<Record<JobState, number>> {
    const rows = this.db.prepare("SELECT state, COUNT(*) AS c FROM jobs GROUP BY state").all() as {
      state: JobState;
      c: number;
    }[];
    const out: Partial<Record<JobState, number>> = {};
    for (const r of rows) out[r.state] = Number(r.c);
    return out;
  }

  /**
   * Atomically claim the next runnable job under a lease (audit H1). A job is
   * runnable when it is `pending` (and its backoff `next_run_at` has elapsed) OR
   * `running` with an expired lease — the latter is how a job stranded by a crash
   * is recovered without human intervention. The claimer stamps its own random
   * `worker_token` + a `lease_until`; only that token may later complete/retry the
   * job, so a worker that lost its lease (a slow job whose lease expired and was
   * re-claimed elsewhere) can never overwrite the new owner's result.
   *
   * Runs in a `BEGIN IMMEDIATE` transaction so two workers (or processes) never
   * claim the same row. Attempts are NOT incremented here — lease expiry or a
   * crash must not consume a retry; only a classified failure (`failJob`) does.
   */
  claimNextJob(now: number, workerToken: string, leaseMs = 5 * 60_000): JobRow | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(
          `SELECT * FROM jobs
             WHERE (state = 'pending' AND next_run_at <= ?)
                OR (state = 'running' AND lease_until IS NOT NULL AND lease_until <= ?)
             ORDER BY id LIMIT 1`,
        )
        .get(now, now) as JobRow | undefined;
      if (!row) {
        this.db.exec("COMMIT");
        return undefined;
      }
      this.db
        .prepare(
          "UPDATE jobs SET state = 'running', claimed_at = ?, lease_until = ?, worker_token = ? WHERE id = ?",
        )
        .run(now, now + leaseMs, workerToken, row.id);
      this.db.exec("COMMIT");
      return { ...row, state: "running", claimed_at: now, lease_until: now + leaseMs, worker_token: workerToken };
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* no active txn */
      }
      throw e;
    }
  }

  /** Extend a held lease (audit H1 heartbeat). No-op if the token no longer owns it. */
  heartbeatJob(id: number, workerToken: string, leaseUntil: number): boolean {
    const info = this.db
      .prepare("UPDATE jobs SET lease_until = ? WHERE id = ? AND worker_token = ? AND state = 'running'")
      .run(leaseUntil, id, workerToken);
    return info.changes > 0;
  }

  /** Complete a job — only the lease owner may (audit H1). Returns false if lost. */
  completeJob(id: number, workerToken?: string): boolean {
    const info = workerToken
      ? this.db.prepare("UPDATE jobs SET state = 'done', worker_token = NULL, lease_until = NULL WHERE id = ? AND worker_token = ?").run(id, workerToken)
      : this.db.prepare("UPDATE jobs SET state = 'done', worker_token = NULL, lease_until = NULL WHERE id = ?").run(id);
    return info.changes > 0;
  }

  /** Fail a job (retry or poison) — only the lease owner may (audit H1). */
  failJob(id: number, attempts: number, nextRunAt: number, error: string, poison: boolean, workerToken?: string): boolean {
    const sql = "UPDATE jobs SET state = ?, attempts = ?, next_run_at = ?, last_error = ?, worker_token = NULL, lease_until = NULL WHERE id = ?"
      + (workerToken ? " AND worker_token = ?" : "");
    const args: unknown[] = [poison ? "poison" : "pending", attempts, nextRunAt, error, id];
    if (workerToken) args.push(workerToken);
    const info = (this.db.prepare(sql).run(...(args as any)));
    return info.changes > 0;
  }

  /**
   * Reset jobs whose lease expired back to `pending` (audit H1 startup/periodic
   * sweep). `claimNextJob` already treats an expired-running job as claimable, so
   * this is mainly to make recovery prompt and observable at startup. Returns the
   * number of jobs reclaimed.
   */
  reclaimExpiredLeases(now: number): number {
    const info = this.db
      .prepare(
        "UPDATE jobs SET state = 'pending', worker_token = NULL, lease_until = NULL WHERE state = 'running' AND lease_until IS NOT NULL AND lease_until <= ?",
      )
      .run(now);
    return Number(info.changes);
  }

  pendingJobCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM jobs WHERE state IN ('pending','running')").get() as any).c;
  }
  poisonJobs(): JobRow[] {
    return this.db.prepare("SELECT * FROM jobs WHERE state = 'poison'").all() as any;
  }

  /**
   * Park a claimed job in the distinct `waiting` state (spec §9 billing/budget
   * gates, H-2). Unlike a failure this does NOT consume a retry, set a backoff, or
   * ever poison — `claimNextJob` never claims a `waiting` row, so blocked paid work
   * is COALESCED (parked once) instead of retry-spinning against a hard budget/
   * billing block. `resumeWaitingJobs` re-enqueues it when the block clears. Only
   * the lease owner may park. Returns true if this worker still owned the job.
   */
  /**
   * Move a job to `waiting`. `resetAttempts` additionally clears the retry
   * counter, for a park that happens at the END of the retry tail rather than
   * before it: `resumeWaitingJobs` puts the row back to `pending` without
   * touching `attempts`, so a job parked with its counter already at the limit
   * would burn one more paid call and land straight back here on every resume.
   */
  parkJob(id: number, reason: string, workerToken?: string, opts?: { resetAttempts?: boolean }): boolean {
    const sql =
      `UPDATE jobs SET state = 'waiting', last_error = ?, worker_token = NULL, lease_until = NULL${
        opts?.resetAttempts ? ", attempts = 0" : ""
      } WHERE id = ?` + (workerToken ? " AND worker_token = ?" : "");
    const args: unknown[] = [reason, id];
    if (workerToken) args.push(workerToken);
    return this.db.prepare(sql).run(...(args as any)).changes > 0;
  }

  /**
   * Re-enqueue parked (`waiting`) jobs for one coordinate back to `pending`
   * (billing unblocked, or a budget raised via config reload + organizer
   * reprocess/recompute). Matches on the coordinate embedded in the job payload.
   * Returns the number of jobs resumed.
   */
  resumeWaitingJobs(coordinate: string): number {
    const info = this.db
      .prepare(
        "UPDATE jobs SET state = 'pending', next_run_at = 0, last_error = NULL WHERE state = 'waiting' AND payload LIKE ?",
      )
      .run(`%"coordinate":"${coordinate}"%`);
    return Number(info.changes);
  }

  /** Count parked jobs for a coordinate (test/observability helper). */
  waitingJobCount(coordinate?: string): number {
    if (coordinate === undefined) {
      return (this.db.prepare("SELECT COUNT(*) AS c FROM jobs WHERE state = 'waiting'").get() as any).c;
    }
    return (
      this.db
        .prepare("SELECT COUNT(*) AS c FROM jobs WHERE state = 'waiting' AND payload LIKE ?")
        .get(`%"coordinate":"${coordinate}"%`) as any
    ).c;
  }

  /**
   * Supersede a superseded submission's still-pending/parked pipeline jobs (H-2):
   * a new submission revision cancels the OLDER revision's `process_attendee` (and
   * any parked variant) so the coordinator never pays to download+STT+profile a
   * recording the attendee has already replaced. `prefix` matches the per-attendee
   * dedupe-key namespace (`proc:<coordinate>:<pubkey>:`); `keepKey` is the new
   * revision's key (never deleted). Running jobs are left alone — the lease/
   * compare-and-set logic already discards their stale writes. Returns count deleted.
   */
  supersedePendingJobs(prefix: string, keepKey: string): number {
    const info = this.db
      .prepare(
        "DELETE FROM jobs WHERE state IN ('pending','waiting') AND dedupe_key LIKE ? AND dedupe_key != ?",
      )
      .run(`${prefix.replace(/[%_]/g, "\\$&")}%`, keepKey);
    return Number(info.changes);
  }

  // ── durable usage accounting (spec §8 budgets, H-2) ───────────────────────
  // Per-attendee and per-event cumulative actual usage: downloaded ciphertext
  // BYTES, decoded media DURATION (probed, not declared), and provider spend
  // attempts (CALLS). Budgets gate paid processing (abuse ceiling, not a product
  // limit). pubkey = '' rows are event-scoped spend not tied to one attendee.
  addUsage(
    coordinate: string,
    pubkey: string,
    delta: { bytes?: number; durationSec?: number; calls?: number },
    now: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO usage (coordinate, pubkey, bytes, duration_sec, calls, updated_at)
         VALUES (:coordinate, :pubkey, :bytes, :duration_sec, :calls, :now)
         ON CONFLICT(coordinate, pubkey) DO UPDATE SET
           bytes = bytes + excluded.bytes,
           duration_sec = duration_sec + excluded.duration_sec,
           calls = calls + excluded.calls,
           updated_at = excluded.updated_at`,
      )
      .run({
        coordinate,
        pubkey,
        bytes: delta.bytes ?? 0,
        duration_sec: delta.durationSec ?? 0,
        calls: delta.calls ?? 0,
        now,
      });
  }

  /** Cumulative usage for one attendee (defaults to zeros when none recorded). */
  getUsage(coordinate: string, pubkey: string): { bytes: number; durationSec: number; calls: number } {
    const row = this.db
      .prepare("SELECT bytes, duration_sec, calls FROM usage WHERE coordinate = ? AND pubkey = ?")
      .get(coordinate, pubkey) as { bytes: number; duration_sec: number; calls: number } | undefined;
    return { bytes: row?.bytes ?? 0, durationSec: row?.duration_sec ?? 0, calls: row?.calls ?? 0 };
  }

  /** Cumulative usage summed across every attendee for one event. */
  getEventUsage(coordinate: string): { bytes: number; durationSec: number; calls: number } {
    const row = this.db
      .prepare(
        "SELECT COALESCE(SUM(bytes),0) AS bytes, COALESCE(SUM(duration_sec),0) AS duration_sec, COALESCE(SUM(calls),0) AS calls FROM usage WHERE coordinate = ?",
      )
      .get(coordinate) as { bytes: number; duration_sec: number; calls: number };
    return { bytes: row.bytes, durationSec: row.duration_sec, calls: row.calls };
  }

  // ── billing state machine (spec §9, D5, §13.4) ────────────────────────────
  getBillingState(coordinate: string): BillingStateRow | undefined {
    return this.db.prepare("SELECT * FROM billing_state WHERE coordinate = ?").get(coordinate) as
      | BillingStateRow
      | undefined;
  }

  /** Upsert the persisted billing state for an installation. */
  setBillingState(row: {
    coordinate: string;
    principalKind: string;
    principalId: string;
    state: BillingStateRow["state"];
    reason?: string | null;
    graceUntil?: number | null;
    now: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO billing_state (coordinate, principal_kind, principal_id, state, reason, grace_until, updated_at)
         VALUES (:coordinate, :principal_kind, :principal_id, :state, :reason, :grace_until, :updated_at)
         ON CONFLICT(coordinate) DO UPDATE SET
           principal_kind = excluded.principal_kind, principal_id = excluded.principal_id,
           state = excluded.state, reason = excluded.reason,
           grace_until = excluded.grace_until, updated_at = excluded.updated_at`,
      )
      .run({
        coordinate: row.coordinate,
        principal_kind: row.principalKind,
        principal_id: row.principalId,
        state: row.state,
        reason: row.reason ?? null,
        grace_until: row.graceUntil ?? null,
        updated_at: row.now,
      });
  }

  // ── Cashu payment journal (audit finding H8) ──────────────────────────────
  // Cashu proofs are bearer money. `CashuPayment` used to remove the sent proofs
  // from its wallet file and only bank the change in settle(); a crash between the
  // two lost the proofs. This journal durably records each reservation so a
  // restart can account for every proof: reserved-but-unsettled proofs are
  // recoverable (quarantined as `ambiguous`, never re-added to the wallet — so no
  // double-spend), and banked change survives the crash. Proof JSON reuses the
  // same at-rest NIP-44 protection as the event-key columns when an identity key
  // is configured.

  /**
   * Durably reserve the proofs sent to a provider for `requestId`, in one txn,
   * before they leave the wallet. Idempotent on `requestId` (a stable id across
   * provider retries never reserves twice). Returns true if a new row was written.
   */
  cashuReserve(requestId: string, mint: string, amount: number, sentProofs: unknown[], now = Date.now()): boolean {
    const existing = this.db
      .prepare("SELECT 1 FROM cashu_journal WHERE request_id = ?")
      .get(requestId);
    if (existing) return false;
    this.db
      .prepare(
        "INSERT INTO cashu_journal (request_id, mint, state, amount, sent_proofs, change_proofs, created_at, updated_at) VALUES (?, ?, 'in_flight', ?, ?, NULL, ?, ?)",
      )
      .run(requestId, mint, amount, this.protect(JSON.stringify(sentProofs)), now, now);
    return true;
  }

  /**
   * Mark a reservation settled and bank its change proofs (the provider accepted
   * the payment). Idempotent: settling an already-settled request is a no-op.
   */
  cashuSettle(requestId: string, changeProofs: unknown[], now = Date.now()): void {
    const row = this.db
      .prepare("SELECT state FROM cashu_journal WHERE request_id = ?")
      .get(requestId) as { state: string } | undefined;
    if (!row || row.state === "settled") return;
    this.db
      .prepare("UPDATE cashu_journal SET state = 'settled', change_proofs = ?, updated_at = ? WHERE request_id = ?")
      .run(this.protect(JSON.stringify(changeProofs)), now, requestId);
  }

  /** Quarantine a reservation whose outcome is unknown (crash/timeout post-send). */
  cashuMarkAmbiguous(requestId: string, now = Date.now()): void {
    this.db
      .prepare("UPDATE cashu_journal SET state = 'ambiguous', updated_at = ? WHERE request_id = ? AND state = 'in_flight'")
      .run(now, requestId);
  }

  private rowToCashuEntry(row: any): CashuJournalRow {
    return {
      request_id: row.request_id,
      mint: row.mint,
      state: row.state,
      amount: row.amount,
      sent_proofs: JSON.parse(this.reveal(row.sent_proofs)),
      change_proofs: row.change_proofs == null ? null : JSON.parse(this.reveal(row.change_proofs)),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  cashuJournalEntry(requestId: string): CashuJournalRow | undefined {
    const row = this.db.prepare("SELECT * FROM cashu_journal WHERE request_id = ?").get(requestId);
    return row ? this.rowToCashuEntry(row) : undefined;
  }

  /** Non-terminal reservations (in_flight/ambiguous) for startup reconciliation. */
  cashuNonterminal(): CashuJournalRow[] {
    return (this.db
      .prepare("SELECT * FROM cashu_journal WHERE state != 'settled' ORDER BY created_at")
      .all() as any[]).map((r) => this.rowToCashuEntry(r));
  }

  // ── content-addressed pipeline artifacts (audit H7) ───────────────────────
  /**
   * Look up a completed artifact by stage + inputs hash. The stored output_json is
   * at-rest-encrypted (it holds attendee-derived text) and revealed transparently.
   */
  getArtifact(stage: string, inputsHash: string): unknown | undefined {
    const row = this.db
      .prepare("SELECT output_json FROM pipeline_artifacts WHERE stage = ? AND inputs_hash = ?")
      .get(stage, inputsHash) as { output_json: string } | undefined;
    if (!row) return undefined;
    return JSON.parse(this.reveal(row.output_json));
  }

  /**
   * Persist a completed artifact keyed by stage + inputs hash (insert-or-ignore so
   * concurrent duplicate jobs converge on one artifact rather than re-billing).
   */
  putArtifact(row: {
    stage: string;
    inputsHash: string;
    provider: string;
    model: string;
    output: unknown;
    now: number;
    /** Ownership reference for reference-counted deletion (audit C5). */
    owner?: { coordinate: string; pubkey: string };
  }): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO pipeline_artifacts (stage, inputs_hash, provider, model, output_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(row.stage, row.inputsHash, row.provider, row.model, this.protect(JSON.stringify(row.output)), row.now);
    if (row.owner) {
      this.recordArtifactRef(row.stage, row.inputsHash, row.owner, row.now);
    }
  }

  /**
   * Record an ownership reference to a content-addressed pipeline artifact WITHOUT
   * rewriting its payload (audit R11). Called on every USE of an artifact — both a
   * fresh generation (via {@link putArtifact}) and a CACHE HIT, so a second event
   * that reuses a shared artifact actually becomes an owner and the ref count is
   * correct at purge time. Also clears any legacy quarantine flag: an artifact that
   * now has a live owner must not be GC'd as an orphan. Idempotent.
   */
  recordArtifactRef(
    stage: string,
    inputsHash: string,
    owner: { coordinate: string; pubkey: string },
    now: number,
  ): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO artifact_refs (stage, inputs_hash, coordinate, pubkey, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(stage, inputsHash, owner.coordinate, owner.pubkey, now);
    this.db
      .prepare("UPDATE pipeline_artifacts SET quarantined_at = NULL WHERE stage = ? AND inputs_hash = ?")
      .run(stage, inputsHash);
  }

  /**
   * Record an ownership reference to a per-account nostr summary on a CACHE HIT
   * (audit R11) — the miss path already records it via {@link putSummary}. Without
   * this a second event reusing a cached summary never becomes an owner, so a purge
   * could delete a summary another event still uses (or leave it unattributed).
   * Idempotent; does not rewrite the summary payload.
   */
  recordSummaryRef(pubkey: string, inputsHash: string, coordinate: string, now: number): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO summary_refs (pubkey, inputs_hash, coordinate, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(pubkey, inputsHash, coordinate, now);
  }

  // ── organizer-visible job status (audit Q12) ──────────────────────────────
  recordJobStatus(row: JobStatusRow): void {
    this.db
      .prepare(
        `INSERT INTO job_status (coordinate, stage, pubkey, state, attempts, error_category, retryable, updated_at)
         VALUES (:coordinate, :stage, :pubkey, :state, :attempts, :error_category, :retryable, :updated_at)
         ON CONFLICT(coordinate, stage, pubkey) DO UPDATE SET
           state = excluded.state, attempts = excluded.attempts,
           error_category = excluded.error_category, retryable = excluded.retryable,
           updated_at = excluded.updated_at`,
      )
      .run({
        coordinate: row.coordinate,
        stage: row.stage,
        pubkey: row.pubkey ?? null,
        state: row.state,
        attempts: row.attempts,
        error_category: row.error_category,
        retryable: row.retryable,
        updated_at: row.updated_at,
      });
  }

  poisonStatuses(coordinate: string): JobStatusRow[] {
    return this.db
      .prepare("SELECT * FROM job_status WHERE coordinate = ? AND state = 'poison'")
      .all(coordinate) as any;
  }

  /**
   * Clear every poison status for an attendee (audit COORD-15): called when their
   * pipeline later SUCCEEDS so the organizer-visible poison state recovers
   * instead of staying red forever.
   */
  clearPoisonStatuses(coordinate: string, pubkey: string): number {
    const info = this.db
      .prepare("UPDATE job_status SET state = 'cleared', updated_at = ? WHERE coordinate = ? AND pubkey = ? AND state = 'poison'")
      .run(Date.now(), coordinate, pubkey);
    return Number(info.changes);
  }

  // ── TTL pruning (audit COORD-24 / P0-1) ───────────────────────────────────
  /**
   * Drop `marmot_consumed_kps` older than `maxAgeMs` (default 30 days). These are
   * event-scoped, single-use key-package receipts safe to age out past the
   * gift-wrap backfill window.
   *
   * `seen_rumors` is deliberately NOT pruned here (audit P0-1 interim guard). The
   * coordinator inbox is re-scanned from `since: 0` on every startup, and fresh
   * event installs backfill full history — an unbounded horizon. Pruning the
   * dedupe ledger at 30 days made any command older than the TTL look new on the
   * next rescan and re-execute (an old revoke rotating the ECK again, an old
   * recompute re-billing a provider). Retaining the ledger trades bounded storage
   * (small rows, low command volume) for correctness. This is a band-aid: the
   * durable fix is a monotonic command/install-generation model (deferred), which
   * would let the ledger be safely bounded again. Run at startup + daily; returns
   * rows deleted.
   */
  pruneOldData(now: number, maxAgeMs = 30 * 24 * 60 * 60 * 1000): number {
    const cutoff = now - maxAgeMs;
    const kps = this.db.prepare("DELETE FROM marmot_consumed_kps WHERE created_at < ?").run(cutoff);
    // Legacy artifact GC (audit R11): drop artifacts the v4 migration quarantined
    // (no ownership ref) that are STILL unreferenced after the grace window — a live
    // event would have re-touched (and un-quarantined) them via a cache hit by now.
    // Bounds unbounded pre-v2 artifact growth and expires attendee-derived text that
    // no current event owns.
    const legacy = this.db
      .prepare(
        `DELETE FROM pipeline_artifacts
           WHERE quarantined_at IS NOT NULL AND quarantined_at < ?
             AND NOT EXISTS (
               SELECT 1 FROM artifact_refs r
               WHERE r.stage = pipeline_artifacts.stage AND r.inputs_hash = pipeline_artifacts.inputs_hash
             )`,
      )
      .run(cutoff);
    // Expire dead inbox rate buckets (audit R4): a (coordinate, sender) row whose last
    // window is long past is only kept alive by having been touched; dropping stale
    // ones bounds the table against a distinct-sender flood. Windows are 60s, so a
    // one-hour retention is generous — a currently-relevant bucket is far newer.
    const rate = this.db
      .prepare("DELETE FROM inbox_rate WHERE window_start < ?")
      .run(now - 60 * 60 * 1000);
    // Expire terminal job rows (audit R4): 'done'/'poison' jobs are kept only briefly
    // (debugging/idempotency) then GC'd, so the queue table can't grow without bound.
    // Re-running a long-past job is safe — its inputs are content-addressed (cached,
    // no re-bill) and its rumor is already in the seen ledger.
    const jobs = this.db
      .prepare("DELETE FROM jobs WHERE state IN ('done', 'poison') AND COALESCE(claimed_at, 0) < ?")
      .run(cutoff);
    return Number(kps.changes) + Number(legacy.changes) + Number(rate.changes) + Number(jobs.changes);
  }

  // ── Marmot group chat (MARMOT-GROUP-CHAT §4.3) ─────────────────────────────
  // The coordinator's MLS admin state. All secret-bearing values (the marmot_kv
  // `v` blobs) reuse the same at-rest NIP-44 protection as the event-key columns.

  /** Record (or update) the group created for a chat-enabled event. */
  upsertMarmotGroup(row: {
    coordinate: string;
    mlsGroupId: string;
    nostrGroupId: string;
    status?: "active" | "frozen";
    now: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO marmot_groups (coordinate, mls_group_id, nostr_group_id, created_at, status)
         VALUES (:coordinate, :mlsGroupId, :nostrGroupId, :now, COALESCE(:status, 'active'))
         ON CONFLICT(coordinate) DO UPDATE SET
           mls_group_id = excluded.mls_group_id,
           nostr_group_id = excluded.nostr_group_id,
           status = COALESCE(:status, marmot_groups.status)`,
      )
      .run({
        coordinate: row.coordinate,
        mlsGroupId: row.mlsGroupId,
        nostrGroupId: row.nostrGroupId,
        status: row.status ?? null,
        now: row.now,
      });
  }

  getMarmotGroup(coordinate: string): MarmotGroupRow | undefined {
    return this.db
      .prepare("SELECT * FROM marmot_groups WHERE coordinate = ?")
      .get(coordinate) as MarmotGroupRow | undefined;
  }

  allMarmotGroups(): MarmotGroupRow[] {
    return this.db.prepare("SELECT * FROM marmot_groups").all() as unknown as MarmotGroupRow[];
  }

  setMarmotGroupStatus(coordinate: string, status: "active" | "frozen"): void {
    this.db.prepare("UPDATE marmot_groups SET status = ? WHERE coordinate = ?").run(status, coordinate);
  }

  // ── marmot_kv: the MarmotClient's key/value stores, encrypted at rest ───────
  /** Read a namespaced value (decrypted); undefined if absent. */
  marmotKvGet(namespace: string, key: string): string | undefined {
    const row = this.db
      .prepare("SELECT v FROM marmot_kv WHERE namespace = ? AND k = ?")
      .get(namespace, key) as { v: string } | undefined;
    return row ? this.reveal(row.v) : undefined;
  }

  /** Write a namespaced value (encrypted at rest). */
  marmotKvSet(namespace: string, key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO marmot_kv (namespace, k, v) VALUES (?, ?, ?)
         ON CONFLICT(namespace, k) DO UPDATE SET v = excluded.v`,
      )
      .run(namespace, key, this.protect(value));
  }

  marmotKvDelete(namespace: string, key: string): void {
    this.db.prepare("DELETE FROM marmot_kv WHERE namespace = ? AND k = ?").run(namespace, key);
  }

  /** All keys in a namespace (for the store's `keys()`/`clear()`). */
  marmotKvKeys(namespace: string): string[] {
    const rows = this.db
      .prepare("SELECT k FROM marmot_kv WHERE namespace = ?")
      .all(namespace) as { k: string }[];
    return rows.map((r) => r.k);
  }

  marmotKvClear(namespace: string): void {
    this.db.prepare("DELETE FROM marmot_kv WHERE namespace = ?").run(namespace);
  }

  // ── marmot_chat_keys: authenticated account⇄chat-key bindings (§3.3) ────────
  /**
   * Record an authenticated chat-key attestation (op:add). Idempotent per key.
   * Ownership is pinned (audit COORD-10): a chat_pubkey already bound to a
   * DIFFERENT account is never re-pointed — the upsert is refused and `false`
   * returned, so an attendee can't steal (or clobber) another account's key
   * binding by attesting the same chat_pubkey. Returns true when recorded.
   */
  upsertChatKey(row: {
    coordinate: string;
    accountPubkey: string;
    chatPubkey: string;
    clientId?: string | null;
    label?: string | null;
    status?: "active" | "revoked";
    now: number;
  }): boolean {
    const existing = this.getChatKey(row.coordinate, row.chatPubkey);
    if (existing && existing.account_pubkey !== row.accountPubkey) return false;
    this.db
      .prepare(
        `INSERT INTO marmot_chat_keys (coordinate, account_pubkey, chat_pubkey, client_id, label, status, updated_at)
         VALUES (:coordinate, :accountPubkey, :chatPubkey, :clientId, :label, COALESCE(:status, 'active'), :now)
         ON CONFLICT(coordinate, chat_pubkey) DO UPDATE SET
           client_id = COALESCE(excluded.client_id, marmot_chat_keys.client_id),
           label = COALESCE(excluded.label, marmot_chat_keys.label),
           status = COALESCE(:status, marmot_chat_keys.status),
           updated_at = excluded.updated_at`,
      )
      .run({
        coordinate: row.coordinate,
        accountPubkey: row.accountPubkey,
        chatPubkey: row.chatPubkey,
        clientId: row.clientId ?? null,
        label: row.label ?? null,
        status: row.status ?? null,
        now: row.now,
      });
    return true;
  }

  getChatKey(coordinate: string, chatPubkey: string): MarmotChatKeyRow | undefined {
    return this.db
      .prepare("SELECT * FROM marmot_chat_keys WHERE coordinate = ? AND chat_pubkey = ?")
      .get(coordinate, chatPubkey) as MarmotChatKeyRow | undefined;
  }

  /** All attested chat keys for one account in an event (any status). */
  chatKeysForAccount(coordinate: string, accountPubkey: string): MarmotChatKeyRow[] {
    return this.db
      .prepare("SELECT * FROM marmot_chat_keys WHERE coordinate = ? AND account_pubkey = ?")
      .all(coordinate, accountPubkey) as unknown as MarmotChatKeyRow[];
  }

  /** Every active chat key in an event (the authorized-author set for the 30443 watcher). */
  activeChatKeys(coordinate: string): MarmotChatKeyRow[] {
    return this.db
      .prepare("SELECT * FROM marmot_chat_keys WHERE coordinate = ? AND status = 'active'")
      .all(coordinate) as unknown as MarmotChatKeyRow[];
  }

  setChatKeyStatus(coordinate: string, chatPubkey: string, status: "active" | "revoked", now: number): void {
    this.db
      .prepare("UPDATE marmot_chat_keys SET status = ?, updated_at = ? WHERE coordinate = ? AND chat_pubkey = ?")
      .run(status, now, coordinate, chatPubkey);
  }

  // ── marmot_consumed_kps: key-package add idempotency (§4.2) ─────────────────
  /** Returns true if this key-package event id is new (and records it); false if consumed. */
  markKpConsumed(coordinate: string, kpEventId: string, now = Date.now()): boolean {
    const existing = this.db
      .prepare("SELECT 1 FROM marmot_consumed_kps WHERE coordinate = ? AND kp_event_id = ?")
      .get(coordinate, kpEventId);
    if (existing) return false;
    this.db
      .prepare("INSERT INTO marmot_consumed_kps (coordinate, kp_event_id, created_at) VALUES (?, ?, ?)")
      .run(coordinate, kpEventId, now);
    return true;
  }

  isKpConsumed(coordinate: string, kpEventId: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM marmot_consumed_kps WHERE coordinate = ? AND kp_event_id = ?")
      .get(coordinate, kpEventId);
  }
}

/**
 * Canonical content hash of a talk submission for NIP §3.3 equal-revision
 * rejection. The simplest canonicalization sufficient to detect a content change:
 * the media ciphertext hash `x`, the title, the description, the co-speaker set
 * (order-independent — sorted), and the language, space-joined and SHA-256'd. Two
 * submissions with the same revision hash equal iff those fields are identical.
 */
export function talkContentHash(fields: {
  mediaX: string;
  title: string;
  description: string;
  /** JSON of the speakers array (parsed + sorted so co-speaker order is irrelevant). */
  speakersJson: string;
  lang: string;
}): string {
  let speakers: string[];
  try {
    const parsed = JSON.parse(fields.speakersJson);
    speakers = Array.isArray(parsed) ? [...parsed].map(String).sort() : [];
  } catch {
    speakers = [];
  }
  const canonical = [fields.mediaX, fields.title, fields.description, speakers.join(","), fields.lang].join(" ");
  return sha256Hex(utf8ToBytes(canonical));
}
