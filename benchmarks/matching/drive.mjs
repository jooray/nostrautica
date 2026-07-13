/**
 * Driver: runs a list of (mode) configs SEQUENTIALLY (to respect Venice rate
 * limits) by shelling out to run.mjs. Everything is cached, so this is safe to
 * re-run — it only fills gaps. Pass a phase name.
 *
 *   node drive.mjs iterate    # subset: all models x {BP0,BP1,BP2} x {K5,K10} + pairwise P0
 *   node drive.mjs iterate2   # subset: all models x BP3 (host-voice reasoning) x {K5,K10}
 *   node drive.mjs finalists  # full 190: finalist models x best prompt x {K1(pairwise),5,10,15,19} + seed2 for K10
 */
import { spawnSync } from "node:child_process";

export const MODELS = [
  "zai-org-glm-5-2",            // production
  "zai-org-glm-4.7-flash",      // latest GLM flash
  "z-ai-glm-5-turbo",           // GLM turbo
  "gemini-3-flash-preview",     // Gemini 3 Flash
  "deepseek-v4-flash",          // DeepSeek V4 (cheap)
  // "deepseek-v4-pro" RULED OUT by maintainer on latency (~16s p50 / 23s p95 per call); partial subset numbers kept in results/ for context.
  "mistral-small-3-2-24b-instruct", // cheap mid-tier
  "qwen3-235b-a22b-instruct-2507",  // strong+cheap mid-tier
];

function run(argsArr) {
  const label = argsArr.join(" ");
  process.stdout.write(`\n>>> node run.mjs ${label}\n`);
  const r = spawnSync("node", ["run.mjs", ...argsArr], { stdio: ["ignore", "inherit", "inherit"], cwd: "." });
  if (r.status !== 0) process.stdout.write(`!!! FAILED: ${label} (status ${r.status})\n`);
}

const phase = process.argv[2];

if (phase === "iterate") {
  for (const m of MODELS) {
    run(["--pairwise", "--model", m, "--subset"]);
    for (const prompt of ["BP0", "BP1", "BP2"]) {
      for (const k of ["5", "10"]) {
        run(["--model", m, "--prompt", prompt, "--k", k, "--subset", "--seed", "1"]);
      }
    }
  }
} else if (phase === "iterate2") {
  // BP3 (host-voice user-facing reasoning, per product requirement) — all models, subset.
  for (const m of MODELS) {
    for (const k of ["5", "10"]) {
      run(["--model", m, "--prompt", "BP3", "--k", k, "--subset", "--seed", "1"]);
    }
  }
} else if (phase === "finalists") {
  const FINALISTS = (process.argv[3] || "").split(",").filter(Boolean);
  const PROMPT = process.argv[4] || "BP1";
  if (!FINALISTS.length) { console.error("usage: drive.mjs finalists m1,m2 PROMPT"); process.exit(1); }
  for (const m of FINALISTS) {
    run(["--pairwise", "--model", m]);                                   // K=1 full
    for (const k of ["5", "10", "15", "19"]) {
      run(["--model", m, "--prompt", PROMPT, "--k", k, "--seed", "1"]);  // full
    }
    // second seed at K=10 for position-bias / stability
    run(["--model", m, "--prompt", PROMPT, "--k", "10", "--seed", "2"]);
  }
} else {
  console.error("phase must be 'iterate' or 'finalists'");
  process.exit(1);
}
console.log("\n=== driver done ===");
