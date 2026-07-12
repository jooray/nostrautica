/**
 * Coordinator persistence (spec §9.1). Uses Node's built-in synchronous SQLite
 * (`node:sqlite`, Node ≥ 22.5) — same embedded-SQLite semantics the spec intends
 * with better-sqlite3, without a fragile native build.
 *
 * Every expensive artifact (transcripts, summaries, profiles, pair scores) is
 * keyed by a content hash of its inputs, so the DB is a cache/queue whose loss
 * re-costs money but can never corrupt correctness: a wiped DB re-derives
 * everything from relays + providers.
 */
import { DatabaseSync } from "node:sqlite";

export type JobState = "pending" | "running" | "done" | "poison";

export interface JobRow {
  id: number;
  type: string;
  dedupe_key: string;
  payload: string;
  state: JobState;
  attempts: number;
  next_run_at: number;
  last_error: string | null;
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
  last_error TEXT
);
CREATE TABLE IF NOT EXISTS transcripts (
  blob_sha256 TEXT PRIMARY KEY,
  text TEXT NOT NULL,
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
  reasoning TEXT NOT NULL,
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
`;

export class Store {
  private db: DatabaseSync;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
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
      .run(row.coordinate, row.configJson, row.inboxNsec, row.eckJson, row.configRelays, row.now);
  }

  getEvent(coordinate: string):
    | { coordinate: string; config_json: string; inbox_nsec: string; eck_json: string; config_relays: string }
    | undefined {
    return this.db.prepare("SELECT * FROM events WHERE coordinate = ?").get(coordinate) as any;
  }

  allEvents(): { coordinate: string; inbox_nsec: string; config_relays: string }[] {
    return this.db.prepare("SELECT coordinate, inbox_nsec, config_relays FROM events").all() as any;
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
    now: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO attendees (coordinate, pubkey, role, status, profile_json, ai_profile_json, profile_hash, updated_at)
         VALUES (:coordinate, :pubkey, COALESCE(:role, 'attendee'), COALESCE(:status, 'pending'),
                 :profileJson, :aiProfileJson, :profileHash, :now)
         ON CONFLICT(coordinate, pubkey) DO UPDATE SET
           role = COALESCE(:role, attendees.role),
           status = COALESCE(:status, attendees.status),
           profile_json = COALESCE(:profileJson, attendees.profile_json),
           ai_profile_json = COALESCE(:aiProfileJson, attendees.ai_profile_json),
           profile_hash = COALESCE(:profileHash, attendees.profile_hash),
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
        now: row.now,
      });
  }

  getAttendee(coordinate: string, pubkey: string): any {
    return this.db
      .prepare("SELECT * FROM attendees WHERE coordinate = ? AND pubkey = ?")
      .get(coordinate, pubkey);
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
  putTranscript(blobSha256: string, text: string, now: number): void {
    this.db
      .prepare("INSERT OR REPLACE INTO transcripts (blob_sha256, text, created_at) VALUES (?, ?, ?)")
      .run(blobSha256, text, now);
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

  // ── pairs (cache by inputs hash) ──────────────────────────────────────────
  getPair(coordinate: string, a: string, b: string):
    | { inputs_hash: string; score: number; similarity: number; complementarity: number; reasoning: string }
    | undefined {
    const [x, y] = a < b ? [a, b] : [b, a];
    return this.db
      .prepare("SELECT * FROM pairs WHERE coordinate = ? AND a = ? AND b = ?")
      .get(coordinate, x, y) as any;
  }
  putPair(row: {
    coordinate: string;
    a: string;
    b: string;
    inputsHash: string;
    score: number;
    similarity: number;
    complementarity: number;
    reasoning: string;
    now: number;
  }): void {
    const [x, y] = row.a < row.b ? [row.a, row.b] : [row.b, row.a];
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
  }
  /** Drop all cached pair scores for an event (forces a full re-score). */
  clearPairs(coordinate: string): void {
    this.db.prepare("DELETE FROM pairs WHERE coordinate = ?").run(coordinate);
  }

  pairsFor(coordinate: string, pubkey: string): {
    other: string;
    score: number;
    similarity: number;
    complementarity: number;
    reasoning: string;
  }[] {
    return this.db
      .prepare(
        `SELECT CASE WHEN a = ? THEN b ELSE a END AS other, score, similarity, complementarity, reasoning
         FROM pairs WHERE coordinate = ? AND (a = ? OR b = ?)`,
      )
      .all(pubkey, coordinate, pubkey, pubkey) as any;
  }

  // ── invite usage (first-come, single-use) ─────────────────────────────────
  /** Record usage; returns true if this is the first use of the invite pubkey. */
  claimInvite(coordinate: string, invitePubkey: string, usedBy: string, now: number): boolean {
    const existing = this.db
      .prepare("SELECT used_by FROM invite_usage WHERE coordinate = ? AND invite_pubkey = ?")
      .get(coordinate, invitePubkey) as { used_by: string } | undefined;
    if (existing) return existing.used_by === usedBy; // idempotent for the same attendee
    this.db
      .prepare("INSERT INTO invite_usage (coordinate, invite_pubkey, used_by, used_at) VALUES (?, ?, ?, ?)")
      .run(coordinate, invitePubkey, usedBy, now);
    return true;
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

  claimNextJob(now: number): JobRow | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM jobs WHERE state = 'pending' AND next_run_at <= ? ORDER BY id LIMIT 1",
      )
      .get(now) as JobRow | undefined;
    if (!row) return undefined;
    this.db.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(row.id);
    return row;
  }

  completeJob(id: number): void {
    this.db.prepare("UPDATE jobs SET state = 'done' WHERE id = ?").run(id);
  }

  failJob(id: number, attempts: number, nextRunAt: number, error: string, poison: boolean): void {
    this.db
      .prepare("UPDATE jobs SET state = ?, attempts = ?, next_run_at = ?, last_error = ? WHERE id = ?")
      .run(poison ? "poison" : "pending", attempts, nextRunAt, error, id);
  }

  pendingJobCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM jobs WHERE state IN ('pending','running')").get() as any).c;
  }
  poisonJobs(): JobRow[] {
    return this.db.prepare("SELECT * FROM jobs WHERE state = 'poison'").all() as any;
  }
}
