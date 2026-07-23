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
 * on every open. It exists so the backup/restore tooling (store/backup.ts) can
 * refuse to restore a snapshot taken by a NEWER binary onto an older one: the
 * on-disk shape would carry columns/semantics this build can't honor. Bump this
 * whenever a migration changes the durable shape in a way a downgrade can't
 * tolerate. Historic databases open at `user_version = 0` and are transparently
 * brought up to the current value by the in-constructor migrations.
 */
export const SCHEMA_VERSION = 1;

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

export type JobState = "pending" | "running" | "done" | "poison";

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
  media_json: string;
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
CREATE TABLE IF NOT EXISTS invite_usage (
  coordinate TEXT NOT NULL,
  invite_pubkey TEXT NOT NULL,
  used_by TEXT NOT NULL,
  used_at INTEGER NOT NULL,
  PRIMARY KEY (coordinate, invite_pubkey)
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
  PRIMARY KEY (stage, inputs_hash)
);
-- Prerecorded talks (spec F2, audit U11). One row per (coordinate, speaker, talk_d).
-- media_json is the kind:"talk" descriptor; transcript_json is filled by process_talk;
-- status drives organizer moderation (pending → published/rejected); revision supports
-- editing (a bumped revision replaces the previous 31610 at publish time).
CREATE TABLE IF NOT EXISTS talks (
  coordinate TEXT NOT NULL,
  pubkey TEXT NOT NULL,
  talk_d TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  speakers_json TEXT NOT NULL DEFAULT '[]',
  media_json TEXT NOT NULL,
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
-- Per-subject admin-command watermark (NIP §3.4): the (created_at, rumor_id) of the
-- last applied 21604 command per (coordinate, subject). A command strictly older
-- than the watermark under the §3.1 comparator is rejected, so approve/revoke
-- interleavings resolve deterministically per subject instead of by arrival order.
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
    this.db.exec(SCHEMA);
    // Migration: add the directional-reasoning column to older DBs.
    try {
      this.db.exec("ALTER TABLE pairs ADD COLUMN reasoning_b TEXT");
    } catch {
      /* column already exists */
    }
    // Migration: directional scoring (batched matcher, spec §16.2). Each direction
    // (a→b, b→a) is scored independently, so the a→b score/similarity/complementarity
    // live in the base columns and the b→a values in the *_b columns. Older rows have
    // NULL *_b columns; pairsFor() COALESCEs them back to the shared value.
    for (const col of ["score_b", "similarity_b", "complementarity_b"]) {
      try {
        this.db.exec(`ALTER TABLE pairs ADD COLUMN ${col} REAL`);
      } catch {
        /* column already exists */
      }
    }
    // Migration (H1): job-lease columns on older DBs. Must run BEFORE the lease
    // index is created (the index references lease_until).
    for (const col of ["claimed_at INTEGER", "lease_until INTEGER", "worker_token TEXT"]) {
      try {
        this.db.exec(`ALTER TABLE jobs ADD COLUMN ${col}`);
      } catch {
        /* column already exists */
      }
    }
    // Migration (Q10): revision-tracking columns on older attendee rows.
    // Migration (F1): transcripts_json on attendees; lang on transcripts.
    // Migration (F3): correction_json on attendees (ai_profile correction/hide).
    // Migration (B1 2026-07-16): display_name — match reasoning needs real names.
    // Migration (P0-2 2026-07-22): profile submission ordering key (latest-wins).
    // Migration (wire-v2 §3.3): rev-primary ordering keys for 21601 submissions and
    // 21608 corrections (profile_rev / correction_rev/created_at/rumor_id).
    for (const col of ["source_revision TEXT", "ai_source_revision TEXT", "transcripts_json TEXT", "correction_json TEXT", "display_name TEXT", "profile_created_at INTEGER", "profile_rumor_id TEXT", "profile_rev INTEGER", "correction_rev INTEGER", "correction_created_at INTEGER", "correction_rumor_id TEXT"]) {
      try {
        this.db.exec(`ALTER TABLE attendees ADD COLUMN ${col}`);
      } catch {
        /* column already exists */
      }
    }
    try {
      this.db.exec("ALTER TABLE transcripts ADD COLUMN lang TEXT");
    } catch {
      /* column already exists */
    }
    // Migration (COORD-7): the ECK version a talk's 31610 was published under,
    // so post-rotation deletion addresses the OLD blinded d (and republish can
    // move the entry to the new ECK).
    try {
      this.db.exec("ALTER TABLE talks ADD COLUMN published_eck_id INTEGER");
    } catch {
      /* column already exists */
    }
    // Migration (wire-v2 §3.3): canonical content hash for equal-revision rejection.
    try {
      this.db.exec("ALTER TABLE talks ADD COLUMN content_hash TEXT");
    } catch {
      /* column already exists */
    }
    // Migration (COORD-24): consumption timestamps for TTL pruning. Existing rows
    // backfill to 0, so the first prune after upgrade sweeps them (they're all
    // older than any 30-day window by definition of being legacy).
    try {
      this.db.exec("ALTER TABLE marmot_consumed_kps ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0");
    } catch {
      /* column already exists */
    }
    // Migration (wire-v2 §3.5): the install generation on older event rows.
    try {
      this.db.exec("ALTER TABLE events ADD COLUMN gen INTEGER NOT NULL DEFAULT 0");
    } catch {
      /* column already exists */
    }
    // Migration (wire-v2 §10.2): per-device chat-key label on older binding rows.
    try {
      this.db.exec("ALTER TABLE marmot_chat_keys ADD COLUMN label TEXT");
    } catch {
      /* column already exists */
    }
    // Migration (wire-v2 §6.2): per-direction icebreakers on cached pair rows.
    // JSON arrays (≤ 3 strings), addressed to `a` and `b` respectively — parallel
    // to reasoning/reasoning_b. NULL on legacy rows (no icebreakers surfaced).
    for (const col of ["icebreakers_json TEXT", "icebreakers_b_json TEXT"]) {
      try {
        this.db.exec(`ALTER TABLE pairs ADD COLUMN ${col}`);
      } catch {
        /* column already exists */
      }
    }
    // Migration (wire-v2 §6.2): retention-expired terminal flag on the events row.
    // Once the retention sweep has deleted an event's member records + parked paid
    // processing, this stays set across restarts so a re-install of the same event
    // row never resumes paid work before the next sweep tick re-detects expiry.
    try {
      this.db.exec("ALTER TABLE events ADD COLUMN retention_expired INTEGER NOT NULL DEFAULT 0");
    } catch {
      /* column already exists */
    }
    // Migration (wire-v2 §3.2): durable monotonic-publish watermark per replaceable
    // address, so restarts keep created_at monotonic instead of relying on the wall
    // clock having advanced past everything published before the restart.
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS publish_watermarks (
        address TEXT PRIMARY KEY,
        last_created_at INTEGER NOT NULL
      )`,
    );
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs (state, next_run_at, lease_until)");
    // Record the logical schema version so the backup/restore tooling can reason
    // about downgrade safety. The in-place migrations above have already brought
    // the durable shape up to SCHEMA_VERSION, so stamping it here is correct.
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
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

  // ── admin-command per-subject watermarks (NIP §3.4) ───────────────────────
  /** The last applied command's (created_at, rumor_id) for a (coordinate, subject). */
  getCommandWatermark(coordinate: string, subject: string): { created_at: number; rumor_id: string } | undefined {
    return this.db
      .prepare("SELECT created_at, rumor_id FROM command_watermarks WHERE coordinate = ? AND subject = ?")
      .get(coordinate, subject) as { created_at: number; rumor_id: string } | undefined;
  }
  /** Record the watermark of the just-applied command for a (coordinate, subject). */
  setCommandWatermark(coordinate: string, subject: string, createdAt: number, rumorId: string): void {
    this.db
      .prepare(
        `INSERT INTO command_watermarks (coordinate, subject, created_at, rumor_id) VALUES (?, ?, ?, ?)
         ON CONFLICT(coordinate, subject) DO UPDATE SET created_at = excluded.created_at, rumor_id = excluded.rumor_id`,
      )
      .run(coordinate, subject, createdAt, rumorId);
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
  putTranscript(blobSha256: string, text: string, now: number, lang?: string): void {
    this.db
      .prepare("INSERT OR REPLACE INTO transcripts (blob_sha256, text, lang, created_at) VALUES (?, ?, ?, ?)")
      .run(blobSha256, text, lang ?? null, now);
  }

  // ── nostr summaries (cache by pubkey + inputs hash) ───────────────────────
  getSummary(pubkey: string, inputsHash: string): string | undefined {
    const row = this.db
      .prepare("SELECT summary FROM nostr_summaries WHERE pubkey = ? AND inputs_hash = ?")
      .get(pubkey, inputsHash) as { summary: string } | undefined;
    return row?.summary;
  }
  putSummary(pubkey: string, inputsHash: string, summary: string, now: number): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO nostr_summaries (pubkey, inputs_hash, summary, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(pubkey, inputsHash, summary, now);
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
    mediaJson: string;
    lang: string;
    revision: number;
    /** New media sha256 (x); when it differs from the stored one the transcript is dropped. */
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
        `INSERT INTO talks (coordinate, pubkey, talk_d, title, description, speakers_json, media_json, transcript_json, lang, revision, content_hash, status, published_at, updated_at)
         VALUES (:coordinate, :pubkey, :talkD, :title, :description, :speakersJson, :mediaJson, :transcriptJson, :lang, :revision, :contentHash, 'pending', COALESCE((SELECT published_at FROM talks WHERE coordinate = :coordinate AND pubkey = :pubkey AND talk_d = :talkD), 0), :now)
         ON CONFLICT(coordinate, pubkey, talk_d) DO UPDATE SET
           title = excluded.title,
           description = excluded.description,
           speakers_json = excluded.speakers_json,
           media_json = excluded.media_json,
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
    // Collect every media ciphertext hash (`x`) this attendee submitted, so the
    // corresponding STT transcript rows can be deleted. Transcripts are keyed by
    // `descriptor.x` (see transcribe.ts). Sources: the attendee's stored profile
    // media (`profile_json.__media`) and their talk media (`talks.media_json`).
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
      const delTranscript = this.db.prepare("DELETE FROM transcripts WHERE blob_sha256 = ?");
      for (const x of blobHashes) delTranscript.run(x);
      this.db.prepare("DELETE FROM talks WHERE coordinate = ? AND pubkey = ?").run(coordinate, pubkey);
      this.db.prepare("DELETE FROM submissions WHERE coordinate = ? AND pubkey = ?").run(coordinate, pubkey);
      this.db.prepare("DELETE FROM nostr_summaries WHERE pubkey = ?").run(pubkey);
      this.db.prepare("DELETE FROM attendees WHERE coordinate = ? AND pubkey = ?").run(coordinate, pubkey);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
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
  claimInvite(coordinate: string, invitePubkey: string, usedBy: string, now: number): boolean {
    const info = this.db
      .prepare(
        "INSERT INTO invite_usage (coordinate, invite_pubkey, used_by, used_at) VALUES (?, ?, ?, ?) ON CONFLICT(coordinate, invite_pubkey) DO NOTHING",
      )
      .run(coordinate, invitePubkey, usedBy, now);
    if (info.changes > 0) return true; // we won the claim
    const existing = this.db
      .prepare("SELECT used_by FROM invite_usage WHERE coordinate = ? AND invite_pubkey = ?")
      .get(coordinate, invitePubkey) as { used_by: string } | undefined;
    return existing?.used_by === usedBy; // idempotent for the same attendee
  }

  // ── jobs ──────────────────────────────────────────────────────────────────
  /** Enqueue a job (idempotent on dedupe_key: a duplicate is silently ignored). */
  enqueueJob(type: string, dedupeKey: string, payload: unknown): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO jobs (type, dedupe_key, payload, state, next_run_at) VALUES (?, ?, ?, 'pending', 0)",
      )
      .run(type, dedupeKey, JSON.stringify(payload));
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
  parkJob(id: number, reason: string, workerToken?: string): boolean {
    const sql =
      "UPDATE jobs SET state = 'waiting', last_error = ?, worker_token = NULL, lease_until = NULL WHERE id = ?" +
      (workerToken ? " AND worker_token = ?" : "");
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
  }): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO pipeline_artifacts (stage, inputs_hash, provider, model, output_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(row.stage, row.inputsHash, row.provider, row.model, this.protect(JSON.stringify(row.output)), row.now);
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
    return Number(kps.changes);
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
