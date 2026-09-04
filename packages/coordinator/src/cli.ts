/**
 * Coordinator operator CLI (§13.2): `backup`, `verify-backup`, `restore`, and
 * `doctor` subcommands on the coordinator binary. All four are read-mostly
 * lifecycle tools — none publish, spend, or subscribe. `main.ts` dispatches here
 * when argv[2] is one of these verbs; anything else stays the daemon entry.
 *
 * Exit codes: 0 = success/all-clear, 1 = a check failed or the operation was
 * refused (so shell/systemd/`ExecStartPre` can gate on it).
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { getPublicKey } from "nostr-tools/pure";
import { npubEncode } from "nostr-tools/nip19";
import { loadConfig, resolveIdentity, veniceApiKey, spendExposure, type UnknownConfigKey } from "./config.js";
import {
  Store,
  acquireDaemonLock,
  inspectDatabaseReadOnly,
  inspectPipelineReadOnly,
  SCHEMA_VERSION,
  type DaemonLock,
  type PipelineInspection,
} from "./store/db.js";
import { GuardedWebSocket, setRelayConnectPolicy } from "./net/relay-guard.js";
import { createBackup, verifyBackup, restoreBackup, metaPathFor, verifyPassed } from "./store/backup.js";
import { verifyFfmpeg } from "./pipeline/audio.js";
import { VeniceLlm } from "./providers/venice.js";
import { ApiKeyPayment } from "./providers/payment.js";
import { releaseId } from "./release.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

/** The set of verbs cli.ts owns; anything else is a config path for the daemon. */
export const CLI_SUBCOMMANDS = ["backup", "verify-backup", "restore", "doctor"] as const;
export type CliSubcommand = (typeof CLI_SUBCOMMANDS)[number];

export function isCliSubcommand(arg: string | undefined): arg is CliSubcommand {
  return !!arg && (CLI_SUBCOMMANDS as readonly string[]).includes(arg);
}

function dbPath(): string {
  return process.env.NOSTRAUTICA_COORDINATOR_DB ?? "coordinator.sqlite";
}

function configPathFromArgs(args: string[]): string {
  const i = args.indexOf("--config");
  const val = i >= 0 ? args[i + 1] : undefined;
  if (val) return val;
  return process.env.NOSTRAUTICA_COORDINATOR_CONFIG ?? "coordinator.toml";
}

interface Identity {
  sk: Uint8Array;
  pubkey: string;
}

function loadIdentity(configPath: string): Identity {
  const config = loadConfig(configPath);
  const sk = resolveIdentity(config);
  return { sk, pubkey: getPublicKey(sk) };
}

// ── backup ───────────────────────────────────────────────────────────────────
function cmdBackup(args: string[]): number {
  const dest = args.find((a) => !a.startsWith("--") && a !== configPathFromArgs(args));
  if (!dest) {
    console.error("usage: nostrautica-coordinator backup <dest.sqlite> [--config coordinator.toml]");
    return 1;
  }
  const configPath = configPathFromArgs(args);
  const { sk, pubkey } = loadIdentity(configPath);
  const db = dbPath();

  // Detect whether a daemon is live: if we can take the single-daemon lock, the
  // process is stopped and the backup is fully quiesced. If we can't, the daemon
  // is running — WAL snapshot isolation still yields a crash-consistent copy, so
  // proceed but record `quiesced: false` in the metadata.
  let lock: DaemonLock | undefined;
  let quiesced = false;
  try {
    lock = acquireDaemonLock(db);
    quiesced = true;
  } catch {
    console.log("[backup] a daemon appears to be running — taking a live WAL-consistent snapshot");
  }

  if (!existsSync(db)) {
    console.error(`[backup] FAILED: no database at ${db} — nothing to back up`);
    lock?.release();
    return 1;
  }

  // `{ migrate: false }` is the whole point of this line (§13.2 + the runbook's
  // "back up the coordinator DB BEFORE a schema migration").
  //
  // A plain `new Store(db, sk)` runs `migrate()` and the legacy-plaintext encryption
  // pass in its constructor. On the box, the deploy rsyncs SOURCE and then restarts,
  // so an operator's binary is routinely NEWER than the file on disk — and taking a
  // backup would then apply a ONE-WAY schema migration (afterwards no older binary
  // will open the file at all) to the database a RUNNING OLDER DAEMON is using, with
  // no pre-migration snapshot, which is precisely the artifact the operator was
  // trying to create. `doctor` was given `inspectDatabaseReadOnly` for this exact
  // reason; `backup` never got the same treatment.
  //
  // Opened read-WRITE, not `readOnly: true`: SQLite cannot open a WAL database
  // read-only unless it can use the `-shm`, and `VACUUM INTO` still has to read a
  // consistent snapshot. What matters is that nothing here MUTATES it.
  const store = new Store(db, sk, { migrate: false });
  try {
    const onDisk = store.schemaVersion();
    if (onDisk < SCHEMA_VERSION) {
      console.log(
        `[backup] on-disk schema is v${onDisk}, this binary is v${SCHEMA_VERSION} — snapshotting v${onDisk} AS-IS ` +
          "(no migration applied). This is your pre-migration rollback point; the daemon migrates on its next start.",
      );
    }
    const meta = createBackup({
      srcStore: store,
      destPath: dest,
      identitySk: sk,
      coordinatorPubkey: pubkey,
      releaseId: releaseId(),
      packageVersion: pkg.version,
      quiesced,
    });
    console.log(`[backup] wrote ${dest} (+ ${metaPathFor(dest)})`);
    console.log(`  coordinator   ${npubEncode(pubkey)}`);
    console.log(`  release       ${meta.releaseId}`);
    console.log(`  schema        v${meta.schemaVersion}`);
    console.log(`  events        ${meta.installedEventCount}`);
    console.log(`  checksum      ${meta.checksumSha256}`);
    console.log(`  quiesced      ${meta.quiesced}`);
    console.log("[backup] OK");
    return 0;
  } catch (e) {
    console.error(`[backup] FAILED: ${e instanceof Error ? e.message : e}`);
    return 1;
  } finally {
    store.close();
    lock?.release();
  }
}

// ── verify-backup ──────────────────────────────────────────────────────────────
function cmdVerifyBackup(args: string[]): number {
  const configPath = configPathFromArgs(args);
  const file = args.find((a) => !a.startsWith("--") && a !== configPath);
  if (!file) {
    console.error("usage: nostrautica-coordinator verify-backup <file.sqlite> [--config coordinator.toml]");
    return 1;
  }
  const { sk, pubkey } = loadIdentity(configPath);
  try {
    const v = verifyBackup({ filePath: file, identitySk: sk, expectedPubkey: pubkey });
    console.log(`[verify] ${file}`);
    console.log(`  format        ${v.meta.format}`);
    console.log(`  release       ${v.meta.releaseId}`);
    console.log(`  taken         ${v.meta.createdAt} (quiesced=${v.meta.quiesced})`);
    console.log(`  integrity     ${v.integrity}`);
    console.log(`  schema        v${v.schemaVersion}${v.schemaTooNew ? ` (NEWER than this binary v${SCHEMA_VERSION})` : ""}`);
    console.log(`  checksum      ${v.checksumOk ? "match (corruption check)" : "MISMATCH"}`);
    console.log(`  authenticity  ${v.authOk ? "verified (HMAC)" : v.authPresent ? "INVALID (tampered/wrong identity)" : "UNSIGNED (legacy backup)"}`);
    console.log(`  decryption    ${v.decryptedRows}/${v.installedEventCount} event rows`);
    console.log(`  pubkey        ${v.pubkeyOk === null ? "n/a" : v.pubkeyOk ? "match" : "MISMATCH"}`);
    const ok = verifyPassed(v, { allowUnsigned: args.includes("--allow-unsigned") });
    console.log(ok ? "[verify] OK" : "[verify] FAILED");
    return ok ? 0 : 1;
  } catch (e) {
    console.error(`[verify] FAILED: ${e instanceof Error ? e.message : e}`);
    return 1;
  }
}

// ── restore ──────────────────────────────────────────────────────────────────
function cmdRestore(args: string[]): number {
  const configPath = configPathFromArgs(args);
  const force = args.includes("--force");
  const allowUnsigned = args.includes("--allow-unsigned");
  const file = args.find((a) => !a.startsWith("--") && a !== configPath);
  if (!file) {
    console.error("usage: nostrautica-coordinator restore <file.sqlite> [--force] [--allow-unsigned] [--config coordinator.toml]");
    return 1;
  }
  const { sk, pubkey } = loadIdentity(configPath);
  const db = dbPath();

  // Refuse onto a running daemon: hold the single-daemon lock for the duration.
  let lock: DaemonLock;
  try {
    lock = acquireDaemonLock(db);
  } catch {
    console.error(`[restore] REFUSED: a coordinator daemon is running on ${db} — stop it first`);
    return 1;
  }
  try {
    const v = restoreBackup({
      filePath: file,
      targetPath: db,
      identitySk: sk,
      expectedPubkey: pubkey,
      force,
      allowUnsigned,
    });
    console.log(`[restore] installed ${file} → ${db}`);
    console.log(`  release       ${v.meta.releaseId}`);
    console.log(`  events        ${v.installedEventCount}`);
    console.log("[restore] OK — start the daemon to resume");
    return 0;
  } catch (e) {
    console.error(`[restore] ${e instanceof Error ? e.message : e}`);
    return 1;
  } finally {
    lock.release();
  }
}

// ── doctor ───────────────────────────────────────────────────────────────────
/**
 * `GuardedWebSocket`, not a raw `ws.WebSocket` (audit C4 consistency). This was the
 * ONE relay connection in the codebase that was not address-pinned: every other one
 * goes through the guarded implementation nostr-tools was handed in `nostr/client.ts`.
 * The URLs are operator-authored, so the exposure was small — but a doctor run is
 * exactly when an operator is pasting a relay URL they are unsure about, and "the
 * health check connects to hosts the daemon would refuse" is a difference nobody
 * should have to remember. `setRelayConnectPolicy` is called by the caller first so
 * a dev config's `allow_insecure_urls` still reaches a local `nak serve`.
 */
async function checkRelay(url: string, timeoutMs = 4000): Promise<boolean> {
  return await new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    const ws = new GuardedWebSocket(url);
    const t = setTimeout(() => finish(false), timeoutMs);
    t.unref?.();
    ws.on("open", () => finish(true));
    ws.on("error", () => finish(false));
  });
}

/** `3d 4h` / `12m` / `40s` — a duration an operator reads without doing arithmetic. */
function fmtAge(ms: number): string {
  if (!Number.isFinite(ms)) return "unknown";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** One rendered doctor line. `fail` is the only level that moves the exit code. */
export interface DoctorCheck {
  level: "ok" | "warn" | "fail";
  label: string;
  detail: string;
}

/** A poisoned row this old is stale enough that nobody is watching it (see below). */
export const STALE_POISON_MS = 24 * 60 * 60 * 1000;

/**
 * Render the PIPELINE half of a doctor run.
 *
 * `doctor` checked config, identity, database integrity, ffmpeg, relays and the
 * provider — every one of them a question about whether the daemon CAN work — and
 * then printed "all checks passed" while two attendees had been sitting poisoned
 * since mid-July. Seven weeks. Nothing in the tool would ever have said so; the only
 * place that state existed was a `job_status` row and a 21606 notice in an organizer's
 * app. These are the questions about whether it IS working.
 *
 * Nothing here FAILS the run. An old poisoned job is a thing an operator must be told
 * about, not a reason to block an `ExecStartPre` and refuse to start the daemon —
 * that would turn one stuck attendee into a total outage. Warnings are the right
 * severity precisely because the summary line already distinguishes them from "ok".
 *
 * Pure and exported so the rendering is testable without a live database.
 */
export function pipelineChecks(
  p: PipelineInspection,
  opts: { now: number; daemonRunning: boolean },
): DoctorCheck[] {
  const out: DoctorCheck[] = [];
  const c = p.counts;
  const pending = c.pending ?? 0;
  const running = c.running ?? 0;
  const waiting = c.waiting ?? 0;
  const poison = c.poison ?? 0;
  const done = c.done ?? 0;

  out.push({
    level: "ok",
    label: "daemon",
    detail: opts.daemonRunning
      ? "a coordinator holds the single-daemon lock (running)"
      : "no daemon holds the single-daemon lock — the coordinator is NOT running on this database",
  });

  out.push({
    level: "ok",
    label: "job queue",
    detail: `${pending} pending, ${running} running, ${waiting} waiting (parked), ${poison} poisoned, ${done} done`,
  });

  if (p.oldestPending) {
    const j = p.oldestPending;
    const overdueMs = opts.now - j.next_run_at;
    if (overdueMs >= 0) {
      // Runnable and still sitting there. With a live daemon that drains every
      // second, anything beyond a couple of minutes means the loop is blocked by a
      // handler that never returns — the 2026-07-24 shape.
      out.push({
        level: opts.daemonRunning && overdueMs > 5 * 60_000 ? "warn" : "ok",
        label: "oldest pending job",
        detail: `${j.type} #${j.id} has been runnable for ${fmtAge(overdueMs)} (attempt ${j.attempts + 1})`,
      });
    } else {
      out.push({
        level: "ok",
        label: "oldest pending job",
        detail: `${j.type} #${j.id} backing off, next run in ${fmtAge(-overdueMs)} (attempt ${j.attempts + 1})`,
      });
    }
  }

  if (p.oldestRunning) {
    const j = p.oldestRunning;
    const age = j.claimed_at === null ? null : opts.now - j.claimed_at;
    const leaseExpired = j.lease_until !== null && j.lease_until <= opts.now;
    out.push({
      level: leaseExpired || !opts.daemonRunning ? "warn" : "ok",
      label: "running job",
      detail:
        `${j.type} #${j.id}${age === null ? "" : ` claimed ${fmtAge(age)} ago`}` +
        (j.lease_until === null
          ? " (no lease)"
          : leaseExpired
            ? ` — lease EXPIRED ${fmtAge(opts.now - j.lease_until)} ago, the worker is gone and the row is stranded`
            : ` (lease valid for another ${fmtAge(j.lease_until - opts.now)})`),
    });
  }

  if (waiting > 0) {
    out.push({
      level: "warn",
      label: "parked jobs",
      detail: `${waiting} job(s) in 'waiting' — blocked on billing/budget; an organizer reprocess/recompute after an unblock resumes them`,
    });
  }

  // Poisoned QUEUE rows. Anything older than a day has plainly not been noticed by
  // anyone, which is the entire failure mode this check exists for.
  if (poison > 0) {
    const stale = p.poisonJobs.filter((j) => j.claimed_at !== null && opts.now - j.claimed_at > STALE_POISON_MS);
    out.push({
      level: "warn",
      label: "poisoned jobs",
      detail:
        `${poison} job(s) in 'poison' — terminal, nothing will re-run them` +
        (stale.length > 0 ? `; ${stale.length} older than a day (unnoticed)` : ""),
    });
    for (const j of p.poisonJobs) {
      const age = j.claimed_at === null ? "unknown age" : `${fmtAge(opts.now - j.claimed_at)} ago`;
      out.push({
        level: "warn",
        label: `  poison #${j.id}`,
        detail:
          `${j.type} after ${j.attempts} attempt(s), ${age}` +
          (j.coordinate ? ` — ${j.coordinate}` : "") +
          (j.pubkey ? ` / ${j.pubkey.slice(0, 8)}…` : "") +
          (j.last_error ? `: ${j.last_error.slice(0, 160)}` : ""),
      });
    }
  }

  // The organizer-visible half (audit Q12): what the event's status notice shows.
  for (const st of p.poisonStatuses) {
    const age = opts.now - st.updated_at;
    out.push({
      level: "warn",
      label: "  poison status",
      detail:
        `${st.stage} on ${st.coordinate}${st.pubkey ? ` / ${st.pubkey.slice(0, 8)}…` : ""} ` +
        `(${st.error_category}, ${st.attempts} attempt(s)) — ${fmtAge(age)} ago` +
        (age > STALE_POISON_MS ? " [STALE: over a day old]" : ""),
    });
  }

  out.push({
    level: p.lastCompletedStartedAt === null && (pending > 0 || running > 0) ? "warn" : "ok",
    label: "last completed job",
    detail:
      p.lastCompletedStartedAt === null
        ? "none — this pipeline has never completed a job"
        : `started ${fmtAge(opts.now - p.lastCompletedStartedAt)} ago`,
  });

  return out;
}

async function cmdDoctor(args: string[]): Promise<number> {
  const configPath = configPathFromArgs(args);
  let failures = 0;
  let warnings = 0;
  const pass = (label: string, detail = "") => console.log(`  [ok]   ${label}${detail ? ` — ${detail}` : ""}`);
  const fail = (label: string, detail = "") => {
    failures++;
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ""}`);
  };
  const warn = (label: string, detail = "") => {
    warnings++;
    console.log(`  [warn] ${label}${detail ? ` — ${detail}` : ""}`);
  };

  console.log(`[doctor] nostrautica-coordinator ${releaseId()} (schema v${SCHEMA_VERSION})`);

  // 1. config parse. Unknown keys are collected rather than left to `loadConfig`'s
  // own console.warn, so they land in doctor's report format — a mistyped or renamed
  // key (`pricing.free_organizers` → `pricing.free_eids`) is a setting the operator
  // believes is in effect and is not.
  let config: ReturnType<typeof loadConfig> | undefined;
  const unknownKeys: UnknownConfigKey[] = [];
  try {
    config = loadConfig(configPath, { onUnknownKeys: (ks) => unknownKeys.push(...ks) });
    pass("config parse", configPath);
  } catch (e) {
    fail("config parse", e instanceof Error ? e.message : String(e));
    console.log("[doctor] cannot continue without a parseable config");
    return 1;
  }
  if (unknownKeys.length > 0) {
    warn(
      "config unknown key(s)",
      `${unknownKeys.map((u) => u.path).join(", ")} — not in the schema, IGNORED (typo or renamed setting?)`,
    );
  }

  // Spend exposure (audit SEC-7). Mirrors the startup gate exactly, including the
  // escape hatch: doctor must agree with whether the daemon will actually boot,
  // or it is worse than not checking.
  const exposure = spendExposure(config);
  if (!exposure) {
    pass("spend exposure", "daemon-wide budget bounded (or installs restricted)");
  } else if (config.security.allow_unbounded_spend) {
    warn("spend exposure", `${exposure} — allowed by security.allow_unbounded_spend`);
  } else {
    fail("spend exposure", `${exposure} — the daemon will REFUSE TO START`);
  }

  // 2. identity load
  let identity: Identity | undefined;
  try {
    const sk = resolveIdentity(config);
    identity = { sk, pubkey: getPublicKey(sk) };
    pass("identity load", npubEncode(identity.pubkey));
  } catch (e) {
    fail("identity load", e instanceof Error ? e.message : String(e));
  }

  // 3. database integrity — genuinely READ-ONLY (audit O2). `doctor` must never
  // migrate/encrypt/upgrade the database (it can run as an ExecStartPre before a
  // rollback decision), so it opens a read-only SQLite connection and inspects the
  // schema/user_version/decryptability WITHOUT constructing the migrating Store.
  const db = dbPath();
  if (!existsSync(db)) {
    warn("database", `${db} does not exist yet (first run?)`);
  } else if (identity) {
    try {
      const info = inspectDatabaseReadOnly(db, identity.sk);
      if (info.integrity === "ok") {
        pass("database integrity", `${info.installedEventCount} event(s), schema v${info.userVersion}`);
      } else {
        fail("database integrity", info.integrity);
      }
      if (info.schemaTooNew) {
        fail("schema version", `on-disk v${info.userVersion} is NEWER than this binary (v${SCHEMA_VERSION}) — upgrade the coordinator`);
      }
      pass("protected-row decryption", `${info.decryptedRows ?? 0} event row(s) decrypt under the identity`);
    } catch (e) {
      fail("database", e instanceof Error ? e.message : String(e));
    }
  }

  // 4. ffmpeg present
  try {
    await verifyFfmpeg();
    pass("ffmpeg/ffprobe");
  } catch {
    fail("ffmpeg/ffprobe", "not found on PATH — install ffmpeg (and ffprobe)");
  }

  // 5. relay reachability summary. The connect policy has to be installed before the
  // first guarded connection, or a dev config's local relay is refused by the guard.
  setRelayConnectPolicy({ allowInsecure: config.security.allow_insecure_urls });
  const relays = config.relays.default;
  let reachable = 0;
  for (const url of relays) {
    if (await checkRelay(url)) reachable++;
  }
  if (relays.length === 0) warn("relays", "no default relays configured");
  else if (reachable === relays.length) pass("relays", `${reachable}/${relays.length} reachable`);
  else if (reachable > 0) warn("relays", `${reachable}/${relays.length} reachable`);
  else fail("relays", `0/${relays.length} reachable`);

  // 6. provider auth check (read-only): a Venice key must list models.
  const apiKey = veniceApiKey(config);
  const referencesVenice = (["summary", "match", "embed", "translate"] as const).some(
    (r) => config!.models[r].provider === "venice",
  );
  if (apiKey && (referencesVenice || config.stt.provider === "venice-stt")) {
    try {
      const venice = new VeniceLlm({ payment: new ApiKeyPayment(apiKey), baseUrl: config.providers.venice?.base_url, requirePrivate: false });
      const models = await venice.models();
      pass("Venice auth", `${models.length} model(s) listed`);
    } catch (e) {
      fail("Venice auth", e instanceof Error ? e.message : String(e));
    }
  } else if (referencesVenice) {
    fail("Venice auth", "a role routes to Venice but no API key is configured");
  }
  if ((["summary", "match", "embed", "translate"] as const).some((r) => config!.models[r].provider === "routstr")) {
    if (config.providers.routstr?.node_url) pass("Routstr config", config.providers.routstr.node_url);
    else fail("Routstr config", "a role routes to Routstr but providers.routstr.node_url is unset");
  }

  // 7. pipeline / queue state — see `pipelineChecks` for why this exists.
  if (existsSync(db)) {
    // Whether a daemon is live, by the same probe `backup`/`restore` use. Taken and
    // released immediately: doctor must never hold the lock against a starting daemon.
    let daemonRunning = true;
    try {
      acquireDaemonLock(db).release();
      daemonRunning = false;
    } catch {
      /* a daemon holds it */
    }
    try {
      const pipeline = inspectPipelineReadOnly(db);
      for (const chk of pipelineChecks(pipeline, { now: Date.now(), daemonRunning })) {
        if (chk.level === "fail") fail(chk.label, chk.detail);
        else if (chk.level === "warn") warn(chk.label, chk.detail);
        else pass(chk.label, chk.detail);
      }
    } catch (e) {
      // A warn, not a fail: an unreadable database has ALREADY failed check 3 above,
      // and the pipeline report is diagnosis rather than a health gate — it must never
      // be the thing that turns an `ExecStartPre` into a refusal to start the daemon.
      warn("pipeline", e instanceof Error ? e.message : String(e));
    }
  }

  // Say "all checks passed" only when they all did. A run that lists two stale
  // poison warnings and then signs off with "all checks passed" is the same
  // reassurance-over-accuracy that let those two attendees sit unnoticed for seven
  // weeks — the whole reason the pipeline checks above exist. Warnings still do not
  // affect the exit code: this must never turn one stuck attendee into a refused
  // service start.
  const summary =
    failures > 0
      ? `[doctor] ${failures} check(s) FAILED` + (warnings > 0 ? `, ${warnings} warning(s)` : "")
      : warnings > 0
        ? `[doctor] no failures, but ${warnings} warning(s) need attention`
        : "[doctor] all checks passed";
  console.log(summary);
  return failures === 0 ? 0 : 1;
}

/** Dispatch an operator subcommand; resolves to a process exit code. */
export async function runCli(subcommand: CliSubcommand, args: string[]): Promise<number> {
  switch (subcommand) {
    case "backup":
      return cmdBackup(args);
    case "verify-backup":
      return cmdVerifyBackup(args);
    case "restore":
      return cmdRestore(args);
    case "doctor":
      return cmdDoctor(args);
  }
}
