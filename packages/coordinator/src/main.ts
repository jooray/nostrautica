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
} from "./config.js";
import { Store } from "./store/db.js";
import { NostrClient } from "./nostr/client.js";
import { buildCoordinatorAnnounce } from "./nostr/publisher.js";
import { Coordinator, type Transport } from "./coordinator.js";
import { verifyFfmpeg } from "./pipeline/audio.js";
import { verifyModelPrivacy } from "./providers/privacy.js";
import { ApiKeyPayment } from "./providers/payment.js";
import { VeniceLlm, VeniceStt } from "./providers/venice.js";
import { RoutstrLlm } from "./providers/routstr.js";
import { CashuPayment } from "./providers/cashu.js";
import type { LlmProvider, SttProvider } from "./providers/types.js";
import { makeChatNetwork } from "./chat/network.js";
import { createMarmotClientMls } from "./chat/mls.js";

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

  // Event keys (E_inbox nsec, ECKs) are encrypted at rest under the coordinator
  // identity key; legacy plaintext rows are migrated in place on first start.
  // Built before the provider layer so it can back the Cashu payment journal
  // (audit H8): proof reservations must be durable across a crash.
  const store = new Store(dbPath, coordSk);

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
        // Durable journal (audit H8): reservations survive a crash mid-request.
        journal: store,
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

  const client = new NostrClient(config.relays.default);

  // Marmot group-chat admin bot (§4): a MarmotClient run off coordSk with its MLS
  // state in encrypted SQLite. Constructed unconditionally, but wholly inert on
  // events without `chat=marmot` (no group is created and no watcher subscribed).
  const chatNetwork = makeChatNetwork({
    transport: client as unknown as import("./chat/network.js").ChatNetworkTransport,
    defaultRelays: config.relays.default,
  });
  const { mls: chatMls } = createMarmotClientMls({ store, coordSk, network: chatNetwork });
  await chatMls.loadAll().catch((e) => console.warn("[chat] loadAll failed:", e));

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
    chatMls,
  });

  await coordinator.start();

  // Publish the public discovery announcement (kind 31611) so organizers can pick
  // this coordinator instead of pasting its npub (docs/COORDINATOR-DISCOVERY-PLAN.md).
  // Replaceable — republished on every boot so config edits propagate.
  if (config.coordinator.announce) {
    try {
      const announce = buildCoordinatorAnnounce(coordSk, buildAnnounceContent(config));
      await client.publish(announce as any, config.relays.default);
      console.log(
        `[coordinator] announced as "${config.coordinator.name}" (kind 31611, pricing=${config.pricing.model})`,
      );
    } catch (e) {
      console.warn("[coordinator] announce publish failed:", e instanceof Error ? e.message : e);
    }
  }

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
