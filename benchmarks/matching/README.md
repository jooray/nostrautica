# Matching-quality benchmark

Finds the best model + prompt + **batch size** for Nostrautica's pair scorer
(`packages/coordinator/src/matching/scoring.ts`). Because production scoring is
O(N²), the benchmark measures **batched** scoring: one LLM call = one *target*
persona + K *candidate* personas, model returns per-candidate
`{similarity, complementarity, score, reasoning_for_target}` (directional; the
reverse reasoning comes from the candidate's own batch). K=1 == the pairwise
production shape, kept as a quality-ceiling reference.

## Files
- `personas.mjs` — 20 fictional cypherpunk-conference personas in the real
  `ai_profile` shape (`{summary, skills, interests, offers, seeks}`) + intro
  transcripts + self-profiles. This is the fixture the models see.
- `gold-pairs.json` — **ground truth** (10 strong + 12 medium intended pairs +
  weak-negative notes). NEVER shown to scoring models. Used for recall/rank eval.
- `prompts.mjs` — `P0_PAIRWISE` (exact production prompt) + batched prompts
  `BP0` (naive port), `BP1` (rubric anchors + independence + anti-flattery),
  `BP2` (BP1 + few-shot), `BP3` (BP1 rubric + HOST-VOICE user-facing reasoning:
  second person, concrete conversation hook, zero analytical framing — the
  reasoning text is shown directly to attendees). Batched output schema.
  Every prompt template includes an event block (title + description + topics);
  in production this comes from the event's 31923 title/summary via
  `matcher.ts` → `EventContextForScoring`.
- `lib.mjs` — Venice client (mirrors `venice.ts` quirks: `disable_thinking`,
  `include_venice_system_prompt:false`, strict `json_schema`, score clamping),
  seeded RNG, on-disk cache, bounded-concurrency pool, pricing table.
- `run.mjs` — scores all 20 targets for one (model, prompt, K, seed[, subset]);
  writes `results/<label>.json`. Every batch call cached in `cache/calls/`.
- `drive.mjs` — runs the config matrix sequentially (rate-limit friendly, cached
  so re-runnable). Phases: `iterate` (subset), `finalists` (full 190).
- `evaluate.mjs` — computes recall@1/@3, strong/medium/weak separation, ordering
  accuracy, score discrimination, position bias, format-fail/missing, latency, $.
- `build-blind.mjs` — samples reasonings, strips identity, shuffles →
  `blind-reasonings.json` (judged) + `blind-key.json` (unblinded after).

## Reproduce
```
export VENICE_API_KEY=...
node drive.mjs iterate                       # subset rounds (all models × BP0-BP2 × K)
node drive.mjs iterate2                      # subset round: BP3 (host-voice) × all models
node evaluate.mjs                            # ranked table
node drive.mjs finalists <m1,m2> BP1         # full 190-pair finalist runs (K=1,5,10,15,19)
node evaluate.mjs
node build-blind.mjs <result files...>       # then judge blind-reasonings.json
```
Blind judging rubric (1-5, per reasoning): specific to BOTH personas' details;
actionable (know what to talk about); no invented facts; PLUS product criteria:
(a) addressed to the reader in second person, (b) names a concrete conversation
hook, (c) zero analytical framing — "scoresplaining" ("this pair scores high
because…", similarity/complementarity talk) is penalized hard.
Eval subset = all gold pairs + stratified random negatives to 60 pairs, seed
`20260713` (fixed for every run). Candidate order is shuffled per (target, seed)
to average out / measure position bias.

See `../../docs/MATCHING-BENCHMARK.md` for the writeup and recommendation.

## Judging artifacts
- `blind-reasonings.json` — 75 identity-stripped, shuffled reasonings (5 runs × 15).
- `blind-scores.json` — the blind 1-5 judgments (rubric in file header), recorded
  before unblinding.
- `blind-key.json` — the unblinding key (model/prompt/gold label per item).
Verdict + full writeup: `../../docs/MATCHING-BENCHMARK.md`.

Note: `deepseek-v4-pro` was ruled out mid-benchmark on latency (maintainer call);
`z-ai-glm-5-turbo` failed 116/120 pairwise strict-schema calls. Partial results
for both remain in `results/`.
