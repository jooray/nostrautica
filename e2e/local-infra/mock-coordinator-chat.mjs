/**
 * Mock coordinator with the REAL Marmot admin bot wired in (unlike
 * mock-coordinator.mjs, which omits chatMls entirely). Used for the live Marmot
 * group-chat verification pass (feature-verification 2026-07-16, deliverable A):
 * two app-side browser contexts publish 30443 key packages + 21607 attestations,
 * this process creates the MLS group, adds them, and 445 messages should round-trip.
 *
 * Usage: NOSTRAUTICA_COORDINATOR_DB=/tmp/coord-chat.sqlite \
 *        node e2e/local-infra/mock-coordinator-chat.mjs
 * Prints its npub on startup — attach that in Admin (same as mock-coordinator.mjs).
 */
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { npubEncode } from "nostr-tools/nip19";

const DIST = new URL("../../packages/coordinator/dist/", import.meta.url);
const { Store } = await import(new URL("store/db.js", DIST));
const { NostrClient } = await import(new URL("nostr/client.js", DIST));
const { Coordinator } = await import(new URL("coordinator.js", DIST));
const { MockStt, MockLlm } = await import(new URL("providers/mock.js", DIST));
const { makeChatNetwork } = await import(new URL("chat/network.js", DIST));
const { createMarmotClientMls } = await import(new URL("chat/mls.js", DIST));
const { setRelayConnectPolicy } = await import(new URL("net/relay-guard.js", DIST));

// C4 (audit): the coordinator refuses ws:// and loopback/private relay hosts unless
// the operator opts in — the connect-time SSRF guard (relay-guard) refuses the
// socket, and sanitizeRelayUrls drops the URL from config-derived relay lists (which
// would also starve chat key-package discovery + welcome delivery, silently making
// every attendee hang on "Setting up your secure chat…"). The local e2e stack IS a
// ws://localhost relay, so flip BOTH knobs for this dev double: setRelayConnectPolicy
// for the guard, and relayPolicy on the Coordinator for the sanitizer. Equivalent to
// `security.allow_insecure_urls = true` in a real coordinator.toml.
setRelayConnectPolicy({ allowInsecure: true });
const RELAY_POLICY = { allowInsecure: true };

const RELAY = process.env.MOCK_RELAY ?? "ws://localhost:7777";
const DB = process.env.NOSTRAUTICA_COORDINATOR_DB ?? "/tmp/mock-coord-chat.sqlite";

const skHex = process.env.MOCK_COORD_SK;
const coordSk = skHex ? Buffer.from(skHex, "hex") : generateSecretKey();
const coordPk = getPublicKey(coordSk);
console.log("[mock-coordinator-chat] npub", npubEncode(coordPk));
console.log("[mock-coordinator-chat] hex-sk", Buffer.from(coordSk).toString("hex"));

function handler({ schemaName, user }) {
  if (schemaName === "ai_profile") {
    // Output must vary with input (attendee identity / submitted content) —
    // profile_hash is computed from THIS output and gates match_recompute
    // dedup; a constant canned reply would make every attendee's post-intro
    // reprocess collide with their pre-intro placeholder run and never re-run.
    const u = (user || "").toLowerCase();
    const tag = u.includes("design")
      ? "design"
      : u.includes("rust") || u.includes("embedded")
        ? "engineering"
        : u.includes("privacy")
          ? "privacy"
          : "general";
    return {
      summary: `An event attendee interested in privacy technology (${tag}).`,
      skills: [tag],
      interests: ["privacy"],
      offers: ["enthusiasm"],
      seeks: ["interesting people"],
    };
  }
  if (schemaName === "nostr_summary") {
    return { summary: "Posts regularly about privacy technology." };
  }
  if (schemaName === "profile_translation") {
    return { source_lang: "en", needs_translation: false };
  }
  if (schemaName === "pair_score") {
    return {
      score: 0.72,
      similarity: 0.5,
      complementarity: 0.6,
      reasoning_for_a: "Worth meeting — your interests overlap.",
      reasoning_for_b: "Worth meeting — your interests overlap.",
    };
  }
  if (schemaName === "batch_score" || schemaName === "reverse_batch_score") {
    // Count "--- CANDIDATE n ---" / "--- TARGET n ---" markers to know how many
    // entries the batch expects, and answer every one of them.
    const n = (user.match(/^--- (CANDIDATE|TARGET) \d+ ---$/gm) ?? []).length;
    const matches = [];
    for (let i = 1; i <= n; i++) {
      matches.push({
        index: i,
        score: 0.7,
        similarity: 0.5,
        complementarity: 0.55,
        reasoning_for_target: "You should meet them — your interests and goals line up well for this event.",
      });
    }
    return { matches };
  }
  return {};
}

const stt = new MockStt({ default: "Hi, I'm here to meet people." });
const llm = new MockLlm(handler);

const store = new Store(DB, coordSk);
const client = new NostrClient([RELAY]);

const chatNetwork = makeChatNetwork({ transport: client, defaultRelays: [RELAY] });
const { mls: chatMls } = createMarmotClientMls({ store, coordSk, network: chatNetwork });
await chatMls.loadAll().catch((e) => console.warn("[chat] loadAll failed:", e));

const coordinator = new Coordinator({
  store,
  transport: client,
  coordSk,
  llm,
  stt,
  sttModel: "mock",
  summaryModel: { provider: "mock", model: "mock-cheap" },
  matchModel: { provider: "mock", model: "mock-strong" },
  embedModel: { provider: "mock", model: "mock-embed" },
  translateModel: { provider: "mock", model: "mock-translate" },
  defaultRelays: [RELAY],
  relayPolicy: RELAY_POLICY,
  transcribe: async () => "Hi, I'm here to meet people building privacy technology.",
  topK: 20,
  chatMls,
});

await coordinator.start();
console.log("[mock-coordinator-chat] running — attach the npub above in Admin (chat=marmot events)");

let stopped = false;
const shutdown = () => {
  stopped = true;
  coordinator.stop();
  client.close();
  store.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

while (!stopped) {
  await coordinator.jobs.drain();
  await new Promise((r) => setTimeout(r, 500));
}
