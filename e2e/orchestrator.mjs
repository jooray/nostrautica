/**
 * E2E orchestrator (§13.7 Option A). Brings up exactly the local infrastructure a
 * selected tier needs, health-probes each piece with a timeout, runs the tier's
 * Playwright specs, and ALWAYS tears everything down (signal-safe, no orphans).
 *
 * Tiers (each a superset of the previous):
 *   smoke        preview only — the static PWA loads, no relay/blossom.
 *   integration  + nak/relay + Blossom + HTTPS proxy (the record/upload path).
 *   chat         + a coordinator with the real Marmot admin bot (a provider double).
 *   full         everything above, all specs.
 *
 * The defining property (audit D-11): if a selected tier's infrastructure can't
 * start or fails its health probe, SETUP FAILS LOUDLY (exit 1) — it is never a
 * silent Playwright skip. A tier that starts clean then runs its specs.
 *
 * Gotchas this encodes (CLAUDE.md "Local test infrastructure"):
 *   #1  PUBLIC_CSP_EXTRA_CONNECT is set on the `vite preview` process at RUN time
 *       (the preview server re-renders the CSP shell per request).
 *   #2  Blossom is fronted by an HTTPS proxy and BLOSSOM_PUBLIC_BASE_URL points at
 *       it, so the https-only media descriptor schema accepts upload URLs.
 *   #3  The relay prefers `nak serve` when nak is on PATH; otherwise it falls back
 *       to the in-repo in-memory relay. Only ONE relay ever binds 7777, and only
 *       ONE Blossom ever binds 3000 (no double-bind, §13.7).
 *
 * Usage:  node e2e/orchestrator.mjs <smoke|integration|chat|full> [-- <playwright args>]
 */
import { spawn, execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createConnection } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { WebSocket } from "ws";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

const TIERS = ["smoke", "integration", "chat", "full"];
const argv = process.argv.slice(2);
const tier = argv[0];
const passthroughIdx = argv.indexOf("--");
const playwrightArgs = passthroughIdx >= 0 ? argv.slice(passthroughIdx + 1) : [];

if (!TIERS.includes(tier)) {
  console.error(`usage: node e2e/orchestrator.mjs <${TIERS.join("|")}> [-- <playwright args>]`);
  process.exit(2);
}

// Which infra each tier needs, and which spec dirs it runs.
const NEEDS = {
  smoke: { relay: false, blossom: false, coordinator: false },
  integration: { relay: true, blossom: true, coordinator: false },
  chat: { relay: true, blossom: true, coordinator: true },
  full: { relay: true, blossom: true, coordinator: true },
}[tier];
const SPEC_DIRS =
  tier === "smoke" ? ["tests/smoke"] : ["tests/smoke", "tests/integration"];

const PORTS = { preview: 4173, relay: 7777, blossom: 3000, proxy: 8443 };
const TLS_DIR = "/tmp/nostrautica-tls";

/** Children we started, torn down in reverse on exit. */
const children = [];
let tearingDown = false;

function log(msg) {
  console.log(`[e2e] ${msg}`);
}
function fail(msg) {
  console.error(`[e2e] SETUP FAILED: ${msg}`);
  teardown(1);
}

/**
 * Spawn a tracked infra child in its OWN process group (`detached: true`) so
 * teardown can signal the whole group — a `pnpm` wrapper does not forward
 * SIGTERM to the `vite`/`node` grandchild it spawns, and killing only the
 * wrapper would orphan the real server on its port (the exact "no orphans"
 * hazard, §13.7). Teardown kills `-pid` (the group).
 */
function spawnTracked(name, cmd, args, opts = {}) {
  const { infra = true, ...spawnOpts } = opts;
  const child = spawn(cmd, args, { detached: true, stdio: ["ignore", "inherit", "inherit"], ...spawnOpts });
  const entry = { name, child, exitedEarly: false };
  children.push(entry);
  child.on("exit", (code, signal) => {
    // A tracked INFRA process exiting before teardown is a setup failure (e.g.
    // EADDRINUSE) — record it so the health phase can fail LOUDLY instead of
    // limping on against a half-dead stack or, worse, a foreign server that
    // happens to hold the port. The Playwright runner (infra:false) is exempt:
    // its exit is the normal end of the run.
    if (infra && !tearingDown) {
      entry.exitedEarly = true;
      console.error(`[e2e] ${name} exited early (code ${code}, signal ${signal})`);
    }
  });
  return child;
}

/** SIGTERM a child's whole process group, falling back to the child itself. */
function killGroup(child, signal) {
  try {
    process.kill(-child.pid, signal); // negative pid = the process group
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Start a component only if it isn't already serving: probe first, reuse a
 * healthy existing instance (Playwright's reuseExistingServer philosophy — and
 * what keeps us from ever double-binding a port, §13.7), otherwise spawn + track.
 * Returns true if we started it (so the caller knows to fail on an early exit).
 */
async function ensureComponent(name, isUp, start) {
  if (await isUp()) {
    log(`reusing existing ${name}`);
    return false;
  }
  start();
  return true;
}

/** True if any tracked child has exited before teardown (a startup failure). */
function anyChildDied() {
  const dead = children.find((c) => c.exitedEarly);
  if (dead) fail(`${dead.name} exited during startup (see the error above)`);
  return !!dead;
}

function teardown(code) {
  if (tearingDown) return;
  tearingDown = true;
  const alive = children.filter((c) => c.child.exitCode === null && c.child.signalCode === null);
  for (const { name, child } of alive.reverse()) {
    killGroup(child, "SIGTERM");
    log(`stopped ${name}`);
  }
  // Escalate to SIGKILL for anything that ignored SIGTERM, then hard-exit so no
  // orphan (server on a bound port) ever lingers into the next run. These timers
  // MUST NOT be unref'd — an unref'd timer lets Node drain the loop and exit 0
  // before process.exit(code) runs, swallowing a failing test's exit code.
  setTimeout(() => {
    for (const { child } of children) {
      if (child.exitCode === null && child.signalCode === null) killGroup(child, "SIGKILL");
    }
    setTimeout(() => process.exit(code), 200);
  }, 1500);
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.error(`[e2e] received ${sig} — tearing down`);
    teardown(130);
  });
}

// ── health probes ─────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pollUntil(label, fn, { timeoutMs = 30_000, intervalMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return true;
    } catch (e) {
      lastErr = e;
    }
    await sleep(intervalMs);
  }
  fail(`${label} not healthy within ${timeoutMs}ms${lastErr ? ` (${lastErr.message ?? lastErr})` : ""}`);
  return false;
}

function tcpOpen(port) {
  return new Promise((res) => {
    const s = createConnection({ port, host: "127.0.0.1" }, () => {
      s.destroy();
      res(true);
    });
    s.on("error", () => res(false));
    s.setTimeout(2000, () => {
      s.destroy();
      res(false);
    });
  });
}

function httpOk(url, { https = false } = {}) {
  return new Promise((res) => {
    const req = (https ? httpsRequest : httpRequest)(
      url,
      { method: "GET", rejectUnauthorized: false, timeout: 3000 },
      (r) => {
        r.resume();
        res(r.statusCode !== undefined); // any response means the server is up
      },
    );
    req.on("error", () => res(false));
    req.on("timeout", () => {
      req.destroy();
      res(false);
    });
    req.end();
  });
}

function wsOpen(url) {
  return new Promise((res) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => {
      ws.terminate();
      res(false);
    }, 3000);
    ws.on("open", () => {
      clearTimeout(t);
      ws.close();
      res(true);
    });
    ws.on("error", () => {
      clearTimeout(t);
      res(false);
    });
  });
}

// ── build ───────────────────────────────────────────────────────────────────
function haveBinary(bin) {
  return spawnSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" }).status === 0;
}

function build() {
  if (process.env.E2E_SKIP_BUILD === "1") {
    log("E2E_SKIP_BUILD=1 — skipping build (the existing build MUST already point at local infra)");
    return;
  }
  // The local preview build MUST NOT carry BASE_PATH=/app — the specs use "/#/".
  const env = { ...process.env };
  delete env.BASE_PATH;
  // Point the whole app at the local relay + Blossom at BUILD time (relays.ts
  // reads these VITE_* vars via import.meta.env), so create/join/upload traffic
  // never touches public infrastructure. Only the relay tiers need it; the smoke
  // build talks to nothing.
  if (NEEDS.relay) {
    env.VITE_NOSTRAUTICA_RELAYS = `ws://127.0.0.1:${PORTS.relay}`;
    env.VITE_NOSTRAUTICA_BLOSSOM = `https://localhost:${PORTS.proxy}`;
  }
  log(`building the app (BASE_PATH unset${NEEDS.relay ? ", relay/blossom → local" : ""})…`);
  execFileSync("pnpm", ["--filter", "@nostrautica/app", "build"], {
    cwd: REPO_ROOT,
    env,
    stdio: "inherit",
  });
  if (NEEDS.coordinator) {
    log("building the coordinator (chat/full tier)…");
    execFileSync("pnpm", ["--filter", "@nostrautica/coordinator", "build"], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
  }
}

// ── infra ─────────────────────────────────────────────────────────────────────
function ensureTlsCert() {
  if (existsSync(`${TLS_DIR}/key.pem`) && existsSync(`${TLS_DIR}/cert.pem`)) return;
  mkdirSync(TLS_DIR, { recursive: true });
  log("generating a throwaway self-signed TLS cert for the Blossom proxy…");
  execFileSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", `${TLS_DIR}/key.pem`, "-out", `${TLS_DIR}/cert.pem`,
      "-days", "7", "-subj", "/CN=localhost",
    ],
    { stdio: "ignore" },
  );
}

function startRelay() {
  // Prefer `nak serve` (gotcha #3), but honor an explicit override and fall back
  // to the purpose-built in-repo relay when nak isn't on PATH. Set
  // E2E_RELAY_IMPL=local to force the in-repo relay (its filter/fan-out semantics
  // are exactly what the multi-round-trip specs were written against).
  const impl = process.env.E2E_RELAY_IMPL;
  const useNak = impl === "nak" || (impl !== "local" && haveBinary("nak"));
  if (useNak) {
    log("relay: nak serve (gotcha #3)");
    spawnTracked("relay(nak)", "nak", ["serve", "--port", String(PORTS.relay)]);
  } else {
    log("relay: in-repo in-memory relay");
    spawnTracked("relay(local)", "node", [resolve(HERE, "local-infra/relay.mjs"), String(PORTS.relay)]);
  }
}

function startBlossom() {
  // Gotcha #2: the returned upload URLs must be the https proxy origin.
  const blossomEnv = { ...process.env, BLOSSOM_PUBLIC_BASE_URL: `https://localhost:${PORTS.proxy}` };
  spawnTracked("blossom", "node", [resolve(HERE, "local-infra/blossom.mjs"), String(PORTS.blossom)], { env: blossomEnv });
}

function startProxy() {
  spawnTracked("https-proxy", "node", [resolve(HERE, "local-infra/https-proxy.mjs")], {
    env: { ...process.env, PROXY_TARGET_PORT: String(PORTS.blossom), PROXY_LISTEN_PORT: String(PORTS.proxy) },
  });
}

function startCoordinator() {
  const db = `/tmp/nostrautica-e2e-coord-${tier}.sqlite`;
  // Wipe any prior run's DB so the double starts clean.
  for (const suffix of ["", "-wal", "-shm", "-journal", ".lock"]) {
    try {
      spawnSync("rm", ["-f", db + suffix]);
    } catch {
      /* ignore */
    }
  }
  const script = tier === "chat" ? "local-infra/mock-coordinator-chat.mjs" : "local-infra/mock-coordinator.mjs";
  const env = { ...process.env, NOSTRAUTICA_COORDINATOR_DB: db, MOCK_RELAY: `ws://localhost:${PORTS.relay}` };
  spawnTracked("coordinator", "node", [resolve(HERE, script)], { env });
}

// ── run ─────────────────────────────────────────────────────────────────────
async function main() {
  log(`tier: ${tier}`);
  build();

  // Start each component only if it isn't already up (reuse-if-healthy → never a
  // double-bind). Blossom's proxy needs its cert regardless.
  // Preview is owned by Playwright's `webServer` (playwright.config.ts) — a single
  // owner, so it's never double-bound: the orchestrator builds the app, and the
  // Playwright run below starts `vite preview` with PUBLIC_CSP_EXTRA_CONNECT set
  // at run time (gotcha #1). The orchestrator owns only the non-preview infra.
  if (NEEDS.relay) await ensureComponent("relay", () => wsOpen(`ws://127.0.0.1:${PORTS.relay}`), startRelay);
  if (NEEDS.blossom) {
    ensureTlsCert();
    await ensureComponent("blossom", () => tcpOpen(PORTS.blossom), startBlossom);
    await ensureComponent("https-proxy", () => httpOk(`https://127.0.0.1:${PORTS.proxy}/`, { https: true }), startProxy);
  }

  // Health-probe each piece; a probe failure OR a child that died at startup is a
  // LOUD setup failure — never a silent skip (audit D-11).
  if (anyChildDied()) return;
  if (NEEDS.relay) await pollUntil("relay", () => wsOpen(`ws://127.0.0.1:${PORTS.relay}`));
  if (NEEDS.blossom) {
    await pollUntil("blossom", () => tcpOpen(PORTS.blossom));
    await pollUntil("blossom https proxy", () => httpOk(`https://127.0.0.1:${PORTS.proxy}/`, { https: true }));
  }
  if (anyChildDied() || tearingDown) return; // a probe or a child already failed

  // The coordinator double has no health port; start it after the relay is up and
  // confirm it stays alive briefly (an immediate exit = setup failure).
  if (NEEDS.coordinator) {
    startCoordinator();
    await sleep(2500);
    const coord = children.find((c) => c.name === "coordinator")?.child;
    if (!coord || coord.exitCode !== null) return fail("coordinator double exited during startup");
    log("coordinator double is up");
  }

  log(`infrastructure healthy — running Playwright (${SPEC_DIRS.join(", ")})`);
  const env = {
    ...process.env,
    // Specs gate on this; the orchestrator only reaches here with the relay UP, so
    // setting it means the integration specs RUN (they never silently skip a tier).
    NOSTRAUTICA_E2E_RELAY: `ws://127.0.0.1:${PORTS.relay}`,
    NOSTRAUTICA_URL: `http://127.0.0.1:${PORTS.preview}`,
    BLOSSOM_PUBLIC_BASE_URL: `https://localhost:${PORTS.proxy}`,
  };
  // Tracked so a SIGINT to the orchestrator also tears down the Playwright group.
  const pw = spawnTracked("playwright", "pnpm", ["exec", "playwright", "test", ...SPEC_DIRS, ...playwrightArgs], {
    cwd: HERE,
    env,
    stdio: "inherit",
    infra: false,
  });
  pw.on("exit", (code) => {
    log(`Playwright exited with code ${code ?? 1}`);
    teardown(code ?? 1);
  });
  pw.on("error", (e) => fail(`could not launch Playwright: ${e.message}`));
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
