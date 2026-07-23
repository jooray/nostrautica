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
import { WebSocket } from "ws";
import { getPublicKey } from "nostr-tools/pure";
import { npubEncode } from "nostr-tools/nip19";
import { loadConfig, resolveIdentity, veniceApiKey } from "./config.js";
import { Store, acquireDaemonLock, SCHEMA_VERSION, type DaemonLock } from "./store/db.js";
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

  const store = new Store(db, sk);
  try {
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
    console.log(`  checksum      ${v.checksumOk ? "match" : "MISMATCH"}`);
    console.log(`  decryption    ${v.decryptedRows}/${v.installedEventCount} event rows`);
    console.log(`  pubkey        ${v.pubkeyOk === null ? "n/a" : v.pubkeyOk ? "match" : "MISMATCH"}`);
    const ok = verifyPassed(v);
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
  const file = args.find((a) => !a.startsWith("--") && a !== configPath);
  if (!file) {
    console.error("usage: nostrautica-coordinator restore <file.sqlite> [--force] [--config coordinator.toml]");
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
    const ws = new WebSocket(url);
    const t = setTimeout(() => finish(false), timeoutMs);
    t.unref?.();
    ws.on("open", () => finish(true));
    ws.on("error", () => finish(false));
  });
}

async function cmdDoctor(args: string[]): Promise<number> {
  const configPath = configPathFromArgs(args);
  let failures = 0;
  const pass = (label: string, detail = "") => console.log(`  [ok]   ${label}${detail ? ` — ${detail}` : ""}`);
  const fail = (label: string, detail = "") => {
    failures++;
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ""}`);
  };
  const warn = (label: string, detail = "") => console.log(`  [warn] ${label}${detail ? ` — ${detail}` : ""}`);

  console.log(`[doctor] nostrautica-coordinator ${releaseId()} (schema v${SCHEMA_VERSION})`);

  // 1. config parse
  let config: ReturnType<typeof loadConfig> | undefined;
  try {
    config = loadConfig(configPath);
    pass("config parse", configPath);
  } catch (e) {
    fail("config parse", e instanceof Error ? e.message : String(e));
    console.log("[doctor] cannot continue without a parseable config");
    return 1;
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

  // 3. database integrity (read-only)
  const db = dbPath();
  if (!existsSync(db)) {
    warn("database", `${db} does not exist yet (first run?)`);
  } else if (identity) {
    try {
      const store = new Store(db, identity.sk);
      try {
        const ic = store.integrityCheck();
        if (ic === "ok") pass("database integrity", `${store.installedEventCount()} event(s), schema v${store.schemaVersion()}`);
        else fail("database integrity", ic);
        const proven = store.verifyProtectedRowsDecrypt();
        pass("protected-row decryption", `${proven} event row(s) decrypt under the identity`);
      } finally {
        store.close();
      }
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

  // 5. relay reachability summary
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

  console.log(failures === 0 ? "[doctor] all checks passed" : `[doctor] ${failures} check(s) FAILED`);
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
