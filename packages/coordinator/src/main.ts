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
  roleRequiresPrivate,
  type CoordinatorConfig,
} from "./config.js";
import { Store } from "./store/db.js";
import { NostrClient } from "./nostr/client.js";
import { Coordinator, type Transport } from "./coordinator.js";
import { verifyFfmpeg } from "./pipeline/audio.js";
import { ApiKeyPayment } from "./providers/payment.js";
import { VeniceLlm, VeniceStt } from "./providers/venice.js";
import { RoutstrLlm } from "./providers/routstr.js";
import { CashuPayment } from "./providers/cashu.js";
import type { LlmProvider, SttProvider } from "./providers/types.js";

/**
 * Enforce the per-role privacy policy (spec §16.2) against the live GET /models
 * list. A role whose model is listed as NOT private while the role requires
 * private is a hard error; an unlisted model id is only a warning (ids are
 * volatile per spec §15, and embedding models may be listed under another type).
 */
async function verifyModelPrivacy(llm: LlmProvider, config: CoordinatorConfig): Promise<void> {
  let all;
  try {
    all = await llm.models();
  } catch (err) {
    console.warn(`[coordinator] could not verify model privacy (GET /models failed): ${err}`);
    return;
  }
  const byId = new Map(all.map((m) => [m.id, m]));
  for (const role of ["summary", "match", "embed", "translate"] as const) {
    const ref = config.models[role];
    if (ref.provider !== "venice") continue;
    const info = byId.get(ref.model);
    if (!info) {
      console.warn(`[coordinator] models.${role} "${ref.model}" not found in GET /models — cannot verify privacy tier`);
      continue;
    }
    const wantPrivate = roleRequiresPrivate(config, role);
    if (wantPrivate && !info.private) {
      throw new Error(
        `models.${role} "${ref.model}" is not a Venice private/TEE-tier model. ` +
          `Pick a private model, or explicitly accept the trade-off with models.${role}.require_private = false`,
      );
    }
    if (!wantPrivate && !info.private) {
      console.warn(
        `[coordinator] models.${role} "${ref.model}" is NOT private-tier (require_private=false accepted): prompts leave the TEE boundary`,
      );
    }
  }
}

async function main(): Promise<void> {
  const configPath = process.argv[2] ?? "coordinator.toml";
  const config = loadConfig(configPath);
  const dbPath = process.env.NOSTRAUTICA_COORDINATOR_DB ?? "coordinator.sqlite";

  await verifyFfmpeg().catch(() => {
    throw new Error("ffmpeg not found — install ffmpeg (and ffprobe) and retry");
  });

  const coordSk = resolveIdentity(config);
  const coordPubkey = getPublicKey(coordSk);
  console.log(`[coordinator] identity ${npubEncode(coordPubkey)}`);

  // STT stays on Venice/local — Routstr has no STT today (spec §9.4).
  const apiKey = veniceApiKey(config);
  const veniceOpts = apiKey
    ? {
        payment: new ApiKeyPayment(apiKey),
        baseUrl: config.providers.venice?.base_url,
        // Privacy is enforced PER ROLE by verifyModelPrivacy() below (a role may
        // relax it via models.<role>.require_private = false, spec §16.2), so the
        // adapter must return the unfiltered list here.
        requirePrivate: false,
      }
    : undefined;

  // LLM: Routstr (Cashu-paid) if configured (v2 flag), else Venice (v1).
  let llm: LlmProvider;
  const nodeUrl = config.providers.routstr?.node_url;
  if (nodeUrl) {
    const r = config.providers.routstr!;
    llm = new RoutstrLlm({
      nodeUrl,
      payment: new CashuPayment({
        mintUrl: r.mint ?? "",
        walletDbPath: r.wallet_db ?? "cashu-wallet.json",
      }),
    });
    console.log(`[coordinator] LLM: Routstr ${nodeUrl} (Cashu)`);
  } else {
    if (!veniceOpts) throw new Error("No Venice API key and no Routstr node configured");
    llm = new VeniceLlm(veniceOpts);
    console.log("[coordinator] LLM: Venice");
    await verifyModelPrivacy(llm, config);
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

  // Event keys (E_inbox nsec, ECKs) are encrypted at rest under the coordinator
  // identity key; legacy plaintext rows are migrated in place on first start.
  const store = new Store(dbPath, coordSk);
  const client = new NostrClient(config.relays.default);

  const coordinator = new Coordinator({
    store,
    transport: client as unknown as Transport,
    coordSk,
    llm,
    stt,
    sttModel: config.stt.model,
    summaryModel: config.models.summary,
    matchModel: config.models.match,
    embedModel: config.models.embed,
    translateModel: config.models.translate,
    defaultRelays: config.relays.default,
    prefilter: {
      threshold: config.matching.prefilter_threshold,
      topM: config.matching.prefilter_top_m,
      randomN: config.matching.prefilter_random,
    },
    topK: config.matching.top_k,
    batchSize: config.matching.batch_size,
  });

  await coordinator.start();
  console.log("[coordinator] running — watching for installs, submissions, admin commands");

  // Job loop: drain runnable jobs, then idle briefly.
  let stopped = false;
  const shutdown = () => {
    stopped = true;
    coordinator.stop();
    client.close();
    store.close();
    console.log("[coordinator] stopped");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  while (!stopped) {
    await coordinator.jobs.drain();
    await new Promise((r) => setTimeout(r, 1000));
  }
}

main().catch((err) => {
  console.error("[coordinator] fatal:", err);
  process.exit(1);
});
