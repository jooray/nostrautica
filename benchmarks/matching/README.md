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

## Icebreaker attribution benchmark (added 2026-07-24)

The benchmark above measures SCORES and blind-judges `reasoning`. Icebreakers
were added later (NIP §6.2) and were never measured — then shipped a failure a
human spots instantly and no existing metric could see: the reader's own book,
app and code handed back to them as the *other* person's work, and openers
written as third-party briefings ("You're a cypherpunk — she studies X") which
cannot be sent, even though "Introduce us" pastes icebreakers[0] straight into a
DM to that person.

The trick that makes this cheap: `icebreaker-fixture.mjs` gives every persona an
invented artifact it uniquely owns ("Kestrel Mesh", "Tamers of Entropy"), so
"whose is this?" is decided by string match, not by a judge.

- `icebreaker-fixture.mjs` — SIGNED_PERSONAS (derived; `personas.mjs` untouched so
  the scoring results stay comparable) + fixed, RNG-free case pairing.
- `icebreaker-grade.mjs` — THEFT / FALSE_CLAIM (hard, possessive-anchored) and
  BRIEFING (heuristic). Reported separately so the soft signal cannot contaminate
  the hard number.
- `icebreaker-grade.test.mjs` — the grader pinned against the real prod failures.
  Run it before trusting any number: `node --test icebreaker-grade.test.mjs`.
- `icebreaker-run.mjs [model] [K]` — imports the LIVE prompt from
  `packages/coordinator/dist` (rebuild first) and splices in the pre-fix block as
  the control, with a self-check that the splice reproduces the shipped prompt
  byte-for-byte. A benchmark that drifts from what ships measures nothing.
- `icebreaker-regrade.mjs <result.json>` — re-score a saved run offline; every
  icebreaker is stored verbatim, so fixing the grader costs no API spend.

### Result — deepseek-v4-flash (production model), K=4, 20 targets

| variant | n | attribution errors | briefing | clean |
|---|---|---|---|---|
| pre-fix prompt | 127 | 4 (3.1%) | 29 (22.8%) | 75.6% |
| shipped prompt | 162 | 0 (0%) | 0 (0%) | 100% |

Caveats, so the 0% is not over-read: one model, one temperature, n=162 openers
on 20 personas whose artifacts are deliberately easy to attribute. It shows the
two known failure modes are gone on this fixture — not that they can never occur.
The pre-fix run also produced FEWER icebreakers overall (127 vs 162), i.e. the
old prompt padded less but misattributed more.

The first run scored 7 false claims that were all grader error ("I read about
X" is admiration, not a possessive). Fixed and pinned by a regression test; the
numbers above are post-fix. Any new check here needs a test against real output
before its number is quoted.
