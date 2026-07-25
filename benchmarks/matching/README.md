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

```
pnpm --filter @nostrautica/coordinator build     # or you benchmark the OLD prompt
node --test icebreaker-grade.test.mjs            # never quote a number before this passes
export VENICE_API_KEY=...
node icebreaker-run.mjs deepseek-v4-flash 4 en,sk IB1,IB2                # forward shape
node icebreaker-run.mjs deepseek-v4-flash 4 sk R1,R2 reverse-shared-artifact,reverse-shared-thin,reverse-prod-replica
node icebreaker-regrade.mjs results/ICEBREAKER_deepseek-v4-flash_K4_sk_R1-R2.json
```

- `icebreaker-fixture.mjs` — SIGNED_PERSONAS (derived; `personas.mjs` untouched so
  the scoring results stay comparable) + fixed, RNG-free case pairing, in buckets:
  `base` (one artifact, one owner), `shared-artifact` / `shared-thin` (a candidate
  whose own profile advertises the TARGET's artifact), `prod-replica` (the same
  shape with Slovak profiles) and `reverse-*` (the same people transposed into the
  reverse-batch shape).
- `icebreaker-grade.mjs` — THEFT / FALSE_CLAIM (hard, possessive-anchored, en + sk
  + cs) and BRIEFING (heuristic). Reported separately so the soft signal cannot
  contaminate the hard number. Also reports `names-an-artifact`: the hard checks
  can only fire on an opener that names one, so a clean rate is unreadable without
  it.
- `icebreaker-grade.test.mjs` — the grader pinned against real prod failures AND
  against every false positive it has ever produced on real model output. Run it
  before trusting any number: `node --test icebreaker-grade.test.mjs`.
- `icebreaker-run.mjs [model] [K] [langs] [variants] [buckets]` — imports the LIVE
  prompts and user-block builders from `packages/coordinator/dist` (rebuild first)
  and splices the historical blocks back in as controls, with self-checks that the
  splice reproduces the shipped prompt byte-for-byte and that the user block sent
  is the one production builds. A benchmark that drifts from what ships measures
  nothing. Variants: `IB0` (pre-2026-07-24), `IB1` (deployed 2026-07-24), `IB2`
  (current) for the forward shape; `R1`/`R2` for the reverse shape.
- `icebreaker-regrade.mjs <result.json>` — re-score a saved run offline; every
  icebreaker is stored verbatim, so fixing the grader costs no API spend. This is
  how every number below survived four grader corrections without new API calls.

### Result — deepseek-v4-flash (production model), K=4, 20 targets, English only

`results/ICEBREAKER_deepseek-v4-flash_K4.json`

| variant | n | attribution errors | briefing | clean |
|---|---|---|---|---|
| pre-fix prompt (IB0) | 127 | 9 (7.1%) | 29 (22.8%) | 74.8% |
| 2026-07-24 prompt (IB1) | 162 | 0 (0%) | 0 (0%) | 100% |

**This table originally read "4 (3.1%)" for the pre-fix prompt and was used to
call the failure fixed. Both halves of that were wrong** — see below.

## The 0% was English-only, and production disproved it (2026-07-25)

A live Slovak event produced three icebreakers for one candidate, every one
inverted: the reader was written as the candidate's profession and offered their
own app, novel and courses as the candidate's work. `reasoning_for_target` for
that same candidate had the ownership right. So the 0% above measured something
narrower than it claimed, in three separate ways:

1. **Language.** The harness only ever ran in English, while WHO IS WHO can only
   be stated with English pronoun tokens ("I"/"my", "you"/"your"). Nothing checked
   that the binding survives into môj/tvoj. Output language is now a parameter and
   the event's `languageInstruction(lang)` is appended exactly as production does
   it.
2. **The grader.** English-only, and blind to how Slovak states ownership: the
   possessive inflects (tvoj/tvoja/tvojich), the artifact NAME inflects
   ("Nostrautica" → "Nostrauticu", "Krotitelia" → "Krotiteľov", so an exact
   substring match finds nothing and grades the opener clean), and ownership is
   routinely a verb with no possessive at all ("počul som, že si vytvoril X").
   All three real Slovak failures and all three real Slovak successes are pinned
   as tests.
3. **The fixture.** Every persona owned exactly one artifact that nobody else
   mentioned, which makes "whose is it?" trivial. The real candidate's bio led
   with the READER's book as his `hot project 🔥` because he had done its artwork,
   so the same artifact sat in both profiles and the text alone cannot settle it.
   A possessive rule cannot fix that; provenance has to be asserted from the block
   a thing appears in.

### Result — forward shape, en + sk, base + shared-artifact buckets

`results/ICEBREAKER_deepseek-v4-flash_K4_en-sk.json` (24 calls per variant per
language)

| variant | lang | n | attribution errors | briefing | names an artifact | clean |
|---|---|---|---|---|---|---|
| IB1-deployed | en | 180 | 0 (0%) | 1 (0.6%) | 35% | 99.4% |
| IB2-new | en | 185 | 0 (0%) | 0 (0%) | 44% | 100% |
| IB1-deployed | sk | 217 | 0 (0%) | 0 (0%) | 44% | 100% |
| IB2-new | sk | 162 | 0 (0%) | 0 (0%) | 40% | 100% |

**The control is also at 0%, so this table proves nothing about the fix.** The
trap-only buckets are the same story
(`results/ICEBREAKER_deepseek-v4-flash_K4_sk_IB1-IB2.json`, 18 calls per variant,
`shared-artifact` + `shared-thin` + `prod-replica`, Slovak output):

| variant | lang | n | attribution errors | briefing | names an artifact | clean |
|---|---|---|---|---|---|---|
| IB1-deployed | sk | 145 | 0 (0%) | 0 (0%) | 57% | 100% |
| IB2-new | sk | 117 | 0 (0%) | 0 (0%) | 45% | 100% |

Whatever went wrong in production, `scoreBatch` with this model does not reproduce
it — not even on a Slovak-profile replica of the exact pair that broke.

### Where it does reproduce: the reverse shape

Production also scores through `scoreReverseBatch` — one shared person against K
targets — whenever a single attendee changes, which is what happens to the LAST
person to submit a profile. That prompt had never been benchmarked, and it is the
shape most likely to invert: it prints the RECIPIENT of every icebreaker first,
under its own heading, and buries each SENDER in a numbered list. It also matches
what production showed: three icebreakers for ONE candidate all inverted, while
other candidates were fine.

`results/ICEBREAKER_deepseek-v4-flash_K4_sk-en_R1-R2.json` (9 trap cases) and
`results/ICEBREAKER_deepseek-v4-flash_K4_sk_R1-R2.json` (17 trap cases)

| variant | lang | n | attribution errors | briefing | clean |
|---|---|---|---|---|---|
| R1-deployed | sk | 86 | 1 (1.2%) | 0 | 98.8% |
| R2-new | sk | 96 | 2 (2.1%) | 0 | 97.9% |
| R1-deployed | en | 89 | 1 (1.1%) | 0 | 98.9% |
| R2-new | en | 100 | 0 (0%) | 0 | 100% |
| R1-deployed (17 cases) | sk | 171 | 1 (0.6%) | 5 (2.9%) | 96.5% |
| R2-new (17 cases) | sk | 182 | 1 (0.5%) | 0 (0%) | 99.5% |

Every flagged row was read by hand. They are genuine, and they are the production
failure verbatim: *"Tvoj Marrowlight projekt je vizuálne silný"* — the sender's own
album — and *"počula som o tvojom projekte The Vellum Cipher – ja som napísala
rovnomenný román"*, which contradicts itself inside one sentence. The model lifts
the word "project" straight out of the recipient's `hot project 🔥:` line.

Honest reading: the reverse shape produces attribution errors at roughly
0.5-1% of openers and **the new prompt does not clear them** — one error in 182 vs
one in 171. What it does clear is the reverse shape's third-party briefings (5 → 0)
with no regression anywhere else. At these rates a run of this size cannot separate
0.5% from 0%; showing that would need ~10× the calls.

### Grader corrections, and why they are pinned

Four rounds of false positives, each found by reading every flagged row and each
fixed offline for free with `icebreaker-regrade.mjs`:

1. `"I read about X"` graded as a false claim — a bare pronoun is not a possessive
   (2026-07-24, 7 rows).
2. `"Vantablack Kitchen is your place"` graded as theft — an invitation is not a
   transfer; only a *standalone* trailing possessive counts.
3. A possessive in the PREVIOUS sentence, and first-person claims in the simple
   present the grader could not read (`"I host Salt & Signal"`, `"ja mám Sundial
   Custody"`, `"pracujem na X"`) — 8 rows, all correct openers.
4. A possessive governing a DIFFERENT noun: `"your branding for X"`, `"tvoja práca
   na X"`, `"tvoja špecializácia … je presne to, čo X potrebuje"` — 17 of 17
   flagged rows in one run. A claim now has to *reach* the artifact (`governs()`),
   which still keeps the real `"o tvojich kurzoch na hackyourself.io"` flagged,
   because courses are content published under the site rather than a service
   rendered to it.

Round 4 is the important one for anyone reading a number here: **the first version
of every table above was pure grader error.** Nothing is quotable until
`node --test icebreaker-grade.test.mjs` passes and the flagged rows have been read.

Remaining caveats: one model, one temperature, artifacts deliberately easy to
attribute, and `names-an-artifact` is only 35-50%, so roughly half the openers
cannot trip the hard checks at all. `cs` is supported by the runner and the grader
but has not been run.
