/**
 * Coordinator daemon entry point (spec §9). Loads config, resolves identity,
 * builds the provider layer, wires the Coordinator to a real Nostr transport, and
 * runs the job loop. ffmpeg is verified at startup.
 */
import { getPublicKey } from "nostr-tools/pure";
import { npubEncode } from "nostr-tools/nip19";
import { loadConfig, resolveIdentity, veniceApiKey } from "./config.js";
import { Store } from "./store/db.js";
import { NostrClient } from "./nostr/client.js";
import { Coordinator, type Transport } from "./coordinator.js";
import { verifyFfmpeg } from "./pipeline/audio.js";
import { ApiKeyPayment } from "./providers/payment.js";
import { VeniceLlm, VeniceStt } from "./providers/venice.js";
import type { LlmProvider, SttProvider } from "./providers/types.js";

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

  // Providers (v1: Venice).
  const apiKey = veniceApiKey(config);
  if (!apiKey) throw new Error("No Venice API key (set the configured env var)");
  const payment = new ApiKeyPayment(apiKey);
  const veniceOpts = {
    payment,
    baseUrl: config.providers.venice?.base_url,
    requirePrivate: config.providers.venice?.require_private ?? true,
  };
  const llm: LlmProvider = new VeniceLlm(veniceOpts);
  const stt: SttProvider =
    config.stt.provider === "venice-stt"
      ? new VeniceStt(veniceOpts)
      : (() => {
          throw new Error("local-whisper STT not built in this daemon (set stt.provider = venice-stt)");
        })();

  const store = new Store(dbPath);
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
    defaultRelays: config.relays.default,
    prefilter: {
      threshold: config.matching.prefilter_threshold,
      topM: config.matching.prefilter_top_m,
      randomN: config.matching.prefilter_random,
    },
    topK: config.matching.top_k,
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
