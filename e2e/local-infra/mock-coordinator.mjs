/**
 * Mock coordinator for local screenshot/e2e runs (Tier 2 without real API money).
 * Wires the built @nostrautica/coordinator to the local in-memory relay with
 * MockStt/MockLlm providers so the matches screen (31605) can be exercised.
 *
 * Usage: NOSTRAUTICA_COORDINATOR_DB=/tmp/coord.sqlite \
 *        node e2e/local-infra/mock-coordinator.mjs
 * Prints its npub on startup — the organizer attaches that in Admin.
 */
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { npubEncode } from "nostr-tools/nip19";

const DIST = new URL("../../packages/coordinator/dist/", import.meta.url);
const { Store } = await import(new URL("store/db.js", DIST));
const { NostrClient } = await import(new URL("nostr/client.js", DIST));
const { Coordinator } = await import(new URL("coordinator.js", DIST));
const { MockStt, MockLlm } = await import(new URL("providers/mock.js", DIST));

const RELAY = process.env.MOCK_RELAY ?? "ws://localhost:7777";
const DB = process.env.NOSTRAUTICA_COORDINATOR_DB ?? "/tmp/mock-coord.sqlite";

// A fixed identity so re-runs reuse the same npub if you pass a hex secret.
const skHex = process.env.MOCK_COORD_SK;
const coordSk = skHex ? Buffer.from(skHex, "hex") : generateSecretKey();
const coordPk = getPublicKey(coordSk);
console.log("[mock-coordinator] npub", npubEncode(coordPk));
console.log("[mock-coordinator] hex-sk", Buffer.from(coordSk).toString("hex"));

// Deterministic, plausible outputs keyed on schemaName. The `user` text carries
// the attendee's profile, so we can lightly tailor by keyword.
function handler({ user, schemaName }) {
  const u = (user || "").toLowerCase();
  if (schemaName === "ai_profile") {
    if (u.includes("design") || u.includes("illustrat"))
      return {
        summary:
          "A designer and illustrator who makes privacy technology approachable through clear visual communication.",
        skills: ["visual design", "illustration", "branding"],
        interests: ["privacy", "usability", "art"],
        offers: ["design work", "a fresh eye on UX", "illustration"],
        seeks: ["technical collaborators", "a project to make legible"],
      };
    if (u.includes("rust") || u.includes("embedded"))
      return {
        summary:
          "An embedded-systems engineer who writes Rust for microcontrollers and secure-boot chains.",
        skills: ["rust", "embedded systems", "secure boot"],
        interests: ["hardware security", "supply-chain integrity"],
        offers: ["firmware expertise", "hardware prototyping"],
        seeks: ["a hardware co-founder", "a designer for the product"],
      };
    if (u.includes("hardware") || u.includes("mentor") || u.includes("security"))
      return {
        summary:
          "A hardware hacker and long-time Nostr contributor who builds open secure elements and mentors newcomers.",
        skills: ["hardware", "cryptography", "mentoring"],
        interests: ["open hardware", "supply-chain attacks", "community"],
        offers: ["mentorship", "hardware review", "deep security knowledge"],
        seeks: ["newcomers to mentor", "a soldering buddy"],
      };
    return {
      summary: "An event attendee interested in privacy technology.",
      skills: ["general"],
      interests: ["privacy"],
      offers: ["enthusiasm"],
      seeks: ["interesting people"],
    };
  }
  if (schemaName === "nostr_summary") {
    return { summary: "Posts regularly about open hardware, cryptography, and mentoring newcomers to Nostr." };
  }
  // profile.ts's translation step (schema profile_translation.v1) requires
  // source_lang + needs_translation on every response; the double never
  // implemented it, so every process_attendee run retried this step to
  // exhaustion (visible as repeated "failed the profile_translation
  // contract" in the coordinator log even though matching itself succeeded).
  if (schemaName === "profile_translation") {
    return { source_lang: "en", needs_translation: false };
  }
  if (schemaName === "pair_score") {
    // Reward complementarity: designer + engineer + hardware mentor fit together.
    const complementarity = 0.9;
    const similarity = 0.55;
    return {
      score: 0.86,
      similarity,
      complementarity,
      reasoning_for_a:
        "You should meet them — your goals line up with what they bring, and their skills fill exactly the gap you named you're looking for.",
      reasoning_for_b:
        "Worth meeting: they're looking for precisely what you offer, and you'd each cover the other's blind spot for this event.",
    };
  }
  // matcher.ts's actual pipeline scores via batch_score / reverse_batch_score
  // (scoring.ts scoreBatch / scoreReverseBatch), not the single-pair schema
  // above -- this double predates that batching and only ever implemented
  // pair_score, so every real match run failed with "batch response missing
  // N candidate(s)" and retried until it gave up. Both batch schemas share
  // the same response shape ({ matches: [{ index, ... }] }), one entry per
  // "--- CANDIDATE n ---" / "--- TARGET n ---" block in the prompt.
  if (schemaName === "batch_score" || schemaName === "reverse_batch_score") {
    const blocks = [...(user || "").matchAll(/--- (?:CANDIDATE|TARGET) (\d+) ---/g)];
    return {
      matches: blocks.map(([, n]) => ({
        index: Number(n),
        score: 0.86,
        similarity: 0.55,
        complementarity: 0.9,
        reasoning_for_target:
          "You should meet them — your goals line up with what they bring, and their skills fill exactly the gap you named you're looking for.",
        icebreakers: ["What are you working on for this event?"],
      })),
    };
  }
  return {};
}

const stt = new MockStt({
  default:
    "Hi, I'm here to meet people building privacy tech. I care about making it usable and I'm looking for collaborators.",
});
const llm = new MockLlm(handler);

const store = new Store(DB);
const client = new NostrClient([RELAY]);
const modelRef = { provider: "mock", model: "mock-strong" };

const coordinator = new Coordinator({
  store,
  transport: client,
  coordSk,
  llm,
  stt,
  sttModel: "mock",
  summaryModel: { provider: "mock", model: "mock-cheap" },
  matchModel: modelRef,
  embedModel: { provider: "mock", model: "mock-embed" },
  translateModel: { provider: "mock", model: "mock-translate" },
  defaultRelays: [RELAY],
  // Skip Blossom download + ffmpeg entirely — feed a canned transcript per media.
  transcribe: async () =>
    "Hi, I'm here to meet people building privacy technology. I'm looking for collaborators who complement my skills.",
  topK: 20,
});

await coordinator.start();
console.log("[mock-coordinator] running — attach the npub above in Admin");

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

// Job loop — same as main.ts: drain runnable jobs (process_attendee →
// match_recompute → score_pair → publish_matches), then idle briefly.
// Without this, submissions are stored but never processed (no ai_profiles,
// no matches).
while (!stopped) {
  await coordinator.jobs.drain();
  await new Promise((r) => setTimeout(r, 1000));
}
