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
import { selfEncrypt, selfDecrypt } from "@nostrautica/protocol";

/** Prefix marking a column value as NIP-44-encrypted under the identity key. */
const ENC_PREFIX = "nip44:";

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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  coordinate TEXT PRIMARY KEY,
  config_json TEXT NOT NULL,
  inbox_nsec TEXT NOT NULL,
  eck_json TEXT NOT NULL,
  config_relays TEXT NOT NULL,
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
    for (const col of ["source_revision TEXT", "ai_source_revision TEXT", "transcripts_json TEXT", "correction_json TEXT", "display_name TEXT"]) {
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
    // Migration (COORD-24): consumption timestamps for TTL pruning. Existing rows
    // backfill to 0, so the first prune after upgrade sweeps them (they're all
    // older than any 30-day window by definition of being legacy).
    try {
      this.db.exec("ALTER TABLE marmot_consumed_kps ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0");
    } catch {
      /* column already exists */
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs (state, next_run_at, lease_until)");
    // Migration (F1): encrypt any legacy plaintext event-key rows in place.
    if (this.identitySk) this.encryptPlaintextKeyRows();
  }

  close(): void {
    this.db.close();
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
    now: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO events (coordinate, config_json, inbox_nsec, eck_json, config_relays, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(coordinate) DO UPDATE SET
           config_json = excluded.config_json,
           inbox_nsec = excluded.inbox_nsec,
           eck_json = excluded.eck_json,
           config_relays = excluded.config_relays,
           updated_at = excluded.updated_at`,
      )
      .run(
        row.coordinate,
        row.configJson,
        this.protect(row.inboxNsec),
        this.protect(row.eckJson),
        row.configRelays,
        row.now,
      );
  }

  getEvent(coordinate: string):
    | { coordinate: string; config_json: string; inbox_nsec: string; eck_json: string; config_relays: string }
    | undefined {
    const row = this.db.prepare("SELECT * FROM events WHERE coordinate = ?").get(coordinate) as any;
    if (!row) return undefined;
    return { ...row, inbox_nsec: this.reveal(row.inbox_nsec), eck_json: this.reveal(row.eck_json) };
  }

  allEvents(): { coordinate: string; inbox_nsec: string; config_relays: string }[] {
    const rows = this.db
      .prepare("SELECT coordinate, inbox_nsec, config_relays FROM events")
      .all() as any[];
    return rows.map((r) => ({ ...r, inbox_nsec: this.reveal(r.inbox_nsec) }));
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
    now: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO attendees (coordinate, pubkey, role, status, profile_json, ai_profile_json, profile_hash, source_revision, ai_source_revision, transcripts_json, correction_json, display_name, updated_at)
         VALUES (:coordinate, :pubkey, COALESCE(:role, 'attendee'), COALESCE(:status, 'pending'),
                 :profileJson, :aiProfileJson, :profileHash, :sourceRevision, :aiSourceRevision, :transcriptsJson, :correctionJson, :displayName, :now)
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
  }): void {
    const existing = this.getTalk(row.coordinate, row.pubkey, row.talkD);
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
        `INSERT INTO talks (coordinate, pubkey, talk_d, title, description, speakers_json, media_json, transcript_json, lang, revision, status, published_at, updated_at)
         VALUES (:coordinate, :pubkey, :talkD, :title, :description, :speakersJson, :mediaJson, :transcriptJson, :lang, :revision, 'pending', COALESCE((SELECT published_at FROM talks WHERE coordinate = :coordinate AND pubkey = :pubkey AND talk_d = :talkD), 0), :now)
         ON CONFLICT(coordinate, pubkey, talk_d) DO UPDATE SET
           title = excluded.title,
           description = excluded.description,
           speakers_json = excluded.speakers_json,
           media_json = excluded.media_json,
           transcript_json = excluded.transcript_json,
           lang = excluded.lang,
           revision = excluded.revision,
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
        now: row.now,
      });
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

  setTalkTranscript(coordinate: string, pubkey: string, talkD: string, transcriptJson: string, now: number): void {
    this.db
      .prepare("UPDATE talks SET transcript_json = ?, updated_at = ? WHERE coordinate = ? AND pubkey = ? AND talk_d = ?")
      .run(transcriptJson, now, coordinate, pubkey, talkD);
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
    now: number;
  }): void {
    const [x, y] = row.from < row.to ? [row.from, row.to] : [row.to, row.from];
    const fromIsX = row.from === x;
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
          `INSERT INTO pairs (coordinate, a, b, inputs_hash, score, similarity, complementarity, reasoning, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(coordinate, a, b) DO UPDATE SET
             inputs_hash = excluded.inputs_hash, score = excluded.score,
             similarity = excluded.similarity, complementarity = excluded.complementarity,
             reasoning = excluded.reasoning, created_at = excluded.created_at`,
        )
        .run(row.coordinate, x, y, row.inputsHash, row.score, row.similarity, row.complementarity, row.reasoning, row.now);
    } else {
      // b→a direction: write the *_b columns. On INSERT the base (a→b) columns are
      // not yet known — seed them so the NOT NULL constraints hold; the a→b batch
      // overwrites them later.
      this.db
        .prepare(
          `INSERT INTO pairs (coordinate, a, b, inputs_hash, score, similarity, complementarity, reasoning, score_b, similarity_b, complementarity_b, reasoning_b, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?)
           ON CONFLICT(coordinate, a, b) DO UPDATE SET
             inputs_hash = excluded.inputs_hash, score_b = excluded.score_b,
             similarity_b = excluded.similarity_b, complementarity_b = excluded.complementarity_b,
             reasoning_b = excluded.reasoning_b, created_at = excluded.created_at`,
        )
        .run(
          row.coordinate, x, y, row.inputsHash,
          row.score, row.similarity, row.complementarity, // seed base cols for NOT NULL
          row.score, row.similarity, row.complementarity, row.reasoning, row.now,
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

  pairsFor(coordinate: string, pubkey: string): {
    other: string;
    score: number;
    similarity: number;
    complementarity: number;
    reasoning: string;
  }[] {
    // Return pubkey's OWN directional view: when pubkey is the stored `a`, the base
    // columns are its outbound (a→b) score/reasoning; when it is `b`, the *_b
    // columns. Scores COALESCE to the shared value for legacy pairwise rows (which
    // set reasoning_b but not score_b); reasoning must NOT fall back — a NULL
    // reasoning_b means the b→a direction was never scored.
    const rows = this.db
      .prepare(
        `SELECT CASE WHEN a = ? THEN b ELSE a END AS other,
                CASE WHEN a = ? THEN score ELSE COALESCE(score_b, score) END AS score,
                CASE WHEN a = ? THEN similarity ELSE COALESCE(similarity_b, similarity) END AS similarity,
                CASE WHEN a = ? THEN complementarity ELSE COALESCE(complementarity_b, complementarity) END AS complementarity,
                CASE WHEN a = ? THEN reasoning ELSE reasoning_b END AS reasoning
         FROM pairs WHERE coordinate = ? AND (a = ? OR b = ?)`,
      )
      .all(pubkey, pubkey, pubkey, pubkey, pubkey, coordinate, pubkey, pubkey) as any[];
    // Only surface directions that have actually been scored (non-empty reasoning);
    // a row seeded by the reverse direction has an empty/NULL value here.
    return rows.filter((r) => r.reasoning != null && r.reasoning !== "");
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

  // ── TTL pruning (audit COORD-24) ──────────────────────────────────────────
  /**
   * Drop dedupe rows older than `maxAgeMs` (default 30 days): `seen_rumors`
   * (by seen_at) and `marmot_consumed_kps` (by created_at). Both are idempotency
   * ledgers whose entries are useless once the gift-wrap backfill window (days,
   * not months) has passed. Run at startup + daily. Returns rows deleted.
   */
  pruneOldData(now: number, maxAgeMs = 30 * 24 * 60 * 60 * 1000): number {
    const cutoff = now - maxAgeMs;
    const rumors = this.db.prepare("DELETE FROM seen_rumors WHERE seen_at < ?").run(cutoff);
    const kps = this.db.prepare("DELETE FROM marmot_consumed_kps WHERE created_at < ?").run(cutoff);
    return Number(rumors.changes) + Number(kps.changes);
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
    status?: "active" | "revoked";
    now: number;
  }): boolean {
    const existing = this.getChatKey(row.coordinate, row.chatPubkey);
    if (existing && existing.account_pubkey !== row.accountPubkey) return false;
    this.db
      .prepare(
        `INSERT INTO marmot_chat_keys (coordinate, account_pubkey, chat_pubkey, client_id, status, updated_at)
         VALUES (:coordinate, :accountPubkey, :chatPubkey, :clientId, COALESCE(:status, 'active'), :now)
         ON CONFLICT(coordinate, chat_pubkey) DO UPDATE SET
           client_id = COALESCE(excluded.client_id, marmot_chat_keys.client_id),
           status = COALESCE(:status, marmot_chat_keys.status),
           updated_at = excluded.updated_at`,
      )
      .run({
        coordinate: row.coordinate,
        accountPubkey: row.accountPubkey,
        chatPubkey: row.chatPubkey,
        clientId: row.clientId ?? null,
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
