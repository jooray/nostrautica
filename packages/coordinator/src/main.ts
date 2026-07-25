/**
 * Coordinator daemon entry point (spec §9). Loads config, resolves identity,
 * builds the provider layer, wires the Coordinator to a real Nostr transport, and
 * runs the job loop. ffmpeg is verified at startup.
 */
import { getPublicKey } from "nostr-tools/pure";
import { npubEncode } from "nostr-tools/nip19";
import {
  loadConfig,
  resolveIdentity,
  veniceApiKey,
  buildAnnounceContent,
  evaluateBilling,
} from "./config.js";
import { Store, acquireDaemonLock } from "./store/db.js";
import { NostrClient } from "./nostr/client.js";
import { setRelayConnectPolicy } from "./net/relay-guard.js";
import { buildCoordinatorAnnounce } from "./nostr/publisher.js";
import { Coordinator, type Transport } from "./coordinator.js";
import { verifyFfmpeg, sweepStaleTempDirs } from "./pipeline/audio.js";
import { ApiKeyPayment } from "./providers/payment.js";
import { VeniceLlm, VeniceStt } from "./providers/venice.js";
import { RoutstrLlm } from "./providers/routstr.js";
import { CashuPayment } from "./providers/cashu.js";
import { resolveRoleRoutes, disclosureFromRoutes } from "./providers/routes.js";
import type { LlmProvider, SttProvider } from "./providers/types.js";
import { makeChatNetwork } from "./chat/network.js";
import { createMarmotClientMls } from "./chat/mls.js";
import { isCliSubcommand, runCli } from "./cli.js";
import { releaseSummary, coordinatorRelease, provenanceIsKnown } from "./release.js";

async function runDaemon(): Promise<void> {
  // Release provenance (§13.9): tie the running daemon to a specific build.
  console.log(`[coordinator] ${releaseSummary()}`);
  const configPath = process.argv[2] ?? "coordinator.toml";
  const config = loadConfig(configPath);
  const dbPath = process.env.NOSTRAUTICA_COORDINATOR_DB ?? "coordinator.sqlite";

  // Release provenance policy (R23): a production build should be tie-able to a
  // specific source revision. `allow_insecure_urls` is the coordinator's dev knob;
  // outside dev, warn loudly (not fatal — a source-rsync deploy without .git that
  // hasn't set NOSTRAUTICA_GIT_SHA/RELEASE_ID must still be able to (re)start) so an
  // operator notices and injects provenance. The strict throwing form
  // (assertReleaseProvenance) is exercised by the release tests.
  if (!config.security.allow_insecure_urls && !provenanceIsKnown()) {
    console.warn(
      "[coordinator] WARNING: release provenance is unknown (gitSha: unknown, no NOSTRAUTICA_RELEASE_ID) — " +
        "set NOSTRAUTICA_GIT_SHA or NOSTRAUTICA_RELEASE_ID so this daemon can be tied to a build (§13.9, R23)",
    );
  }

  await verifyFfmpeg().catch(() => {
    throw new Error("ffmpeg not found — install ffmpeg (and ffprobe) and retry");
  });

  // Sweep ffmpeg temp dirs a previous crash left behind (audit COORD-23).
  const swept = await sweepStaleTempDirs().catch(() => 0);
  if (swept > 0) console.log(`[coordinator] swept ${swept} stale temp dir(s)`);

  const coordSk = resolveIdentity(config);
  const coordPubkey = getPublicKey(coordSk);
  console.log(`[coordinator] identity ${npubEncode(coordPubkey)}`);

  // Single-daemon lock (reliability tail): fail fast if another daemon already runs
  // on this store — two daemons would race the publish watermark + seen-rumor ledger.
  const daemonLock = acquireDaemonLock(dbPath);

  // Event keys (E_inbox nsec, ECKs) are encrypted at rest under the coordinator
  // identity key; legacy plaintext rows are migrated in place on first start.
  // Built before the provider layer so it can back the Cashu payment journal
  // (audit H8): proof reservations must be durable across a crash.
  const store = new Store(dbPath, coordSk);

  // TTL-prune the dedupe ledgers at boot + daily (audit COORD-24).
  store.pruneOldData(Date.now());
  const pruneTimer = setInterval(() => store.pruneOldData(Date.now()), 24 * 60 * 60 * 1000);
  pruneTimer.unref();

  // STT stays on Venice/local — Routstr has no STT today (spec §9.4).
  const apiKey = veniceApiKey(config);
  // DNS pinning for provider requests (audit R22): resolve + public-only + pin,
  // mirroring blob-fetch SSRF hardening, unless the dev insecure knob is set (local
  // provider). Operator-authored endpoints, so this is trusted-boundary defense in
  // depth against a misconfigured/rebinding hostname, not wire-controlled input.
  const providerNet = { allowInsecure: config.security.allow_insecure_urls };
  const veniceOpts = apiKey
    ? {
        payment: new ApiKeyPayment(apiKey),
        baseUrl: config.providers.venice?.base_url,
        // Privacy is enforced PER ROLE by verifyModelPrivacy() below (a role may
        // relax it via models.<role>.require_private = false, spec §16.2), so the
        // adapter must return the unfiltered list here.
        requirePrivate: false,
        net: providerNet,
      }
    : undefined;

  // Per-role provider routing (audit H-1, §13.5 Option A): construct each provider
  // instance that some role references, then resolve + validate a route per role.
  // Roles may point at Venice or Routstr independently; startup fails closed on an
  // unroutable role or a require_private role whose model isn't a private tier.
  const referencedProviders = new Set(
    (["summary", "match", "embed", "translate"] as const).map((r) => config.models[r].provider),
  );
  const providers: Partial<Record<string, LlmProvider>> = {};

  if (referencedProviders.has("venice")) {
    if (!veniceOpts) throw new Error("a role routes to Venice but no Venice API key is configured");
    providers.venice = new VeniceLlm(veniceOpts);
  }
  if (referencedProviders.has("routstr")) {
    const nodeUrl = config.providers.routstr?.node_url;
    if (!nodeUrl) throw new Error("a role routes to Routstr but providers.routstr.node_url is not set");
    const r = config.providers.routstr!;
    const payment = new CashuPayment({
      mintUrl: r.mint ?? "",
      walletDbPath: r.wallet_db ?? "cashu-wallet.json",
      // Durable journal (audit H8): reservations survive a crash mid-request.
      journal: store,
    });
    // Reconcile interrupted reservations from a previous run (audit COORD-5):
    // reserved-but-unsettled proofs are quarantined as ambiguous, never lost.
    const quarantined = payment.reconcileJournal();
    if (quarantined > 0) {
      console.log(`[coordinator] cashu: quarantined ${quarantined} interrupted reservation(s) as ambiguous`);
    }
    providers.routstr = new RoutstrLlm({ nodeUrl, payment, net: providerNet });
    console.log(`[coordinator] Routstr ${nodeUrl} (Cashu) available for routing`);
  }

  const roles = await resolveRoleRoutes(config, {
    providers,
    logger: console,
    allowUnverified: config.security.allow_unverified_model_privacy,
  });
  for (const role of ["summary", "match", "embed", "translate"] as const) {
    const rt = roles[role];
    console.log(`[coordinator] route ${role} → ${rt.provider} ${rt.model} (${rt.privacy})`);
  }

  const stt: SttProvider =
    config.stt.provider === "venice-stt"
      ? (() => {
          if (!veniceOpts) throw new Error("venice-stt needs a Venice API key");
          return new VeniceStt(veniceOpts);
        })()
      : (() => {
          throw new Error("local-whisper STT not built in this daemon (set stt.provider = venice-stt)");
        })();

  // Relay SSRF policy (audit C4): pin every relay connection to a public-address
  // lookup, and (dev-only) allow insecure/private relays when explicitly configured.
  setRelayConnectPolicy({ allowInsecure: config.security.allow_insecure_urls });
  const relayPolicy = {
    allowlist: config.security.relay_allowlist,
    allowInsecure: config.security.allow_insecure_urls,
  };

  const client = new NostrClient(config.relays.default);

  // Marmot group-chat admin bot (§4): a MarmotClient run off coordSk with its MLS
  // state in encrypted SQLite. Constructed unconditionally, but wholly inert on
  // events without `chat=marmot` (no group is created and no watcher subscribed).
  const chatNetwork = makeChatNetwork({
    transport: client as unknown as import("./chat/network.js").ChatNetworkTransport,
    defaultRelays: config.relays.default,
    // Enforce the operator relay allowlist on untrusted kind-10050 inbox relays
    // discovered for Marmot chat, same as key-package NIP-65 discovery (audit R20).
    relayPolicy,
  });
  const { mls: chatMls } = createMarmotClientMls({ store, coordSk, network: chatNetwork });
  await chatMls.loadAll().catch((e) => console.warn("[chat] loadAll failed:", e));

  const coordinator = new Coordinator({
    store,
    transport: client as unknown as Transport,
    coordSk,
    roles,
    stt,
    sttModel: config.stt.model,
    defaultRelays: config.relays.default,
    prefilter: {
      threshold: config.matching.prefilter_threshold,
      topM: config.matching.prefilter_top_m,
      randomN: config.matching.prefilter_random,
    },
    topK: config.matching.top_k,
    batchSize: config.matching.batch_size,
    chatMls,
    // Install authorization + unsolicited-install caps (audit COORD-3).
    maxEvents: config.security.max_events,
    allowedEidPubkeys: config.security.allowed_eid_pubkeys,
    // Untrusted-relay SSRF policy (audit C4).
    relayPolicy,
    // Billing state machine (spec §9, D5): the coordinator maps this verdict onto
    // the persisted evaluating→ok|grace|blocked machine and enforces it.
    evaluateBilling: (eid, attendeeCount) => evaluateBilling(config, eid, attendeeCount),
    billingGracePeriodSec: config.pricing.grace_period_sec,
    // Usage budgets (spec §8, H-2): abuse ceilings gating paid processing.
    budgets: {
      perAttendeeBytes: config.budgets.per_attendee_bytes,
      perEventBytes: config.budgets.per_event_bytes,
      perAttendeeDurationSec: config.budgets.per_attendee_duration_sec,
      perEventDurationSec: config.budgets.per_event_duration_sec,
      perAttendeeCalls: config.budgets.per_attendee_calls,
      perEventCalls: config.budgets.per_event_calls,
    },
  });

  await coordinator.start();

  // Publish the public discovery announcement (kind 31611) so organizers can pick
  // this coordinator instead of pasting its npub (docs/COORDINATOR-DISCOVERY-PLAN.md).
  // Replaceable — republished on every boot so config edits propagate.
  if (config.coordinator.announce) {
    try {
      const content = buildAnnounceContent(config, disclosureFromRoutes(roles));
      // Release provenance (§13.9): the announce wire schema has no version field,
      // so surface the release id in the existing `about` text (bounded at 2000).
      const relTag = `nostrautica ${coordinatorRelease().releaseId}`;
      content.about = (content.about ? `${content.about}\n\n${relTag}` : relTag).slice(0, 2000);
      const announce = buildCoordinatorAnnounce(coordSk, content);
      await client.publish(announce as any, config.relays.default);
      console.log(
        `[coordinator] announced as "${config.coordinator.name}" (kind 31611, pricing=${config.pricing.model})`,
      );
    } catch (e) {
      console.warn("[coordinator] announce publish failed:", e instanceof Error ? e.message : e);
    }
  }

  console.log("[coordinator] running — watching for installs, submissions, admin commands");

  // Periodic queue report (production incident 2026-07-24). Deliberately on its OWN
  // timer, not inside the drain loop below: a handler that never returns blocks that
  // loop, and a stalled worker is precisely the case the report has to stay visible
  // for. Silent when the queue is empty and nothing is running, so a healthy idle
  // daemon adds no log volume — and a queue that is empty WHILE work was supposedly
  // dispatched is itself the diagnosis.
  const stopQueueReporter = coordinator.jobs.startQueueReporter(60_000);

  // Job loop: drain runnable jobs, then idle briefly.
  let stopped = false;
  let shuttingDown = false;
  let drainPromise: Promise<void> = Promise.resolve();
  /** Max time to await the in-flight job on shutdown before closing anyway. */
  const DRAIN_TIMEOUT_MS = 30_000;

  // Graceful shutdown (reliability tail): stop claiming new jobs, await the active
  // job (bounded), abort subscriptions, then close the transport + store + lock. A
  // SECOND signal forces an immediate exit (a hung job never blocks stop forever).
  const shutdown = async () => {
    if (shuttingDown) {
      console.log("[coordinator] second signal — forcing exit");
      process.exit(1);
    }
    shuttingDown = true;
    stopped = true;
    console.log("[coordinator] draining in-flight work…");
    coordinator.jobs.stopClaiming(); // no new claims; the active job still finishes
    // Bounded graceful drain: give the in-flight handler up to DRAIN_TIMEOUT to
    // finish on its own.
    let drained = false;
    await Promise.race([
      drainPromise.then(() => {
        drained = true;
      }).catch(() => {
        drained = true;
      }),
      new Promise((r) => setTimeout(r, DRAIN_TIMEOUT_MS)),
    ]);
    if (!drained) {
      // The drain window expired with a handler still running (audit C11). Signal it
      // to abort, then AWAIT confirmed cancellation before closing the transport,
      // store, and daemon lock — so the handler can never write/publish against a
      // closed/replaced resource. A handler that ignores the abort would block here;
      // a SECOND SIGINT/SIGTERM forces the immediate exit above.
      console.log("[coordinator] drain timed out — aborting the in-flight handler and awaiting cancellation…");
      coordinator.jobs.abort();
      await drainPromise.catch(() => {});
    }
    stopQueueReporter();
    coordinator.stop();
    client.close();
    store.close();
    daemonLock.release();
    console.log("[coordinator] stopped");
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  while (!stopped) {
    drainPromise = coordinator.jobs.drain();
    await drainPromise;
    if (stopped) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * Entry point. When argv[2] is an operator subcommand (`backup`, `verify-backup`,
 * `restore`, `doctor`) dispatch to the CLI; otherwise argv[2] is the daemon's
 * config path (unchanged) and we run the coordinator loop.
 */
async function main(): Promise<void> {
  const verb = process.argv[2];
  if (isCliSubcommand(verb)) {
    const code = await runCli(verb, process.argv.slice(3));
    process.exit(code);
  }
  await runDaemon();
}

main().catch((err) => {
  console.error("[coordinator] fatal:", err);
  process.exit(1);
});
