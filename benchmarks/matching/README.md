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
# reverse shape at production's batch size, control vs live, both languages:
REPEATS=3 CONC=6 node icebreaker-run.mjs deepseek-v4-flash 10 sk,en R2,R3 \
  reverse-shared-artifact,reverse-shared-thin,reverse-prod-replica
# did the same change move the SCORES?
node reverse-score-run.mjs deepseek-v4-flash 10 R2,R3 1,2 && node evaluate.mjs
```
`DRY=1` on icebreaker-run.mjs prints the exact bytes each reverse variant would
send and exits, which is how to check a control reconstruction before it is billed.

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
- `reverse-variants.mjs` — the reverse-shape prompt variants, imported by BOTH
  icebreaker-run.mjs and reverse-score-run.mjs.
  `R1` = the 2026-07-24 prompt (lives in icebreaker-run.mjs);
  `R2` = the 2026-07-25 roles wording, i.e. what was deployed *before* d0b7164;
  `R3` = **live and deployed** — R2 plus the writer directory, the per-entry
  binding line and the block-order bullet;
  `R4` = R3 plus per-entry `writer_name`/`recipient_name` fields emitted *before*
  the icebreakers, so the binding is restated in the model's own output where the
  decode actually needs it (changes the output schema; the coordinator's parser
  ignores unknown fields, so they would be diagnostic only);
  `R5` = R3 with the blocks physically reordered, writers first and the shared
  person last — the mirror of the forward shape, and the one structural hypothesis
  R3 only approximated. Shipping R5 means rewriting `coordinator.test.ts`'s fake
  LLM and the `scoring.test.ts` landmark pins, which is why it is measured first.
  Historical note: the old line here said "`R2` = deployed 2026-07-25, `R3` =
  live", which was true when written and became misleading the moment R3 shipped.
  It is a module rather than copy-paste because the two benchmarks answer two
  halves of one question — did attribution improve, did the scores move — and two
  copies of a control are two different controls the day one of them is edited.
- `icebreaker-compare.mjs <result.json...>` — pools graded runs by (variant, lang)
  and prints Clopper-Pearson intervals plus pairwise Fisher exact tests. Use it
  instead of reading two counts side by side; that is how "1/171 vs 1/182" and
  "8 vs 2" both got written up as results.
- `stats.mjs` / `stats.test.mjs` — the exact statistics behind it, with no normal
  approximations (a Wald interval on 0 errors returns [0, 0], which reads as proof
  of perfection) and no dependencies. 10 tests.
- `icebreaker-fixture.test.mjs` — the properties the dense bucket must have for its
  number to mean what it says: 100% trap density, the shared person keeps its own
  artifact so FALSE_CLAIM stays measurable, and every clone resolves through
  `PERSONA_BY_ID` so saved runs survive the next grader correction.
- `reverse-score-run.mjs [model] [K] [variants] [seeds]` — SCORE quality of the
  reverse shape, which run.mjs never measured (it only ever ran the forward shape,
  against prompts.mjs). Writes `results/REVERSE_*.json` in evaluate.mjs's edge
  format, so `node evaluate.mjs` prints reverse rows (`prompt` = `rev-…`) next to
  the historical forward ones. Uses the PLAIN personas, not the signature-artifact
  clones: gold-pairs.json is about those profiles.

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

## What is actually deployed (corrected 2026-07-27)

`d0b7164`'s commit message says it shipped **R2-roles** and that R3-order "was
only ever a benchmark variant and was never written into scoring.ts". **That is
wrong. The commit shipped R3-order.** Its own diff adds all three of R3's devices
to `scoring.ts`: the `WHO WRITES EACH ENTRY` directory, the per-entry
`(Entry n is written BY the TARGET n profile above, TO …)` line, and the
`BLOCK ORDER IS NOT ROLE ORDER` system bullet.

Three independent confirmations, because a commit message and the code disagreeing
is exactly the situation where one more grep is cheap:

1. `git show d0b7164 -- packages/coordinator/src/matching/scoring.ts` — the diff.
2. `reverse-variants.mjs` defines `R3 = live, untouched` and `R2 = live with those
   devices spliced back out`, and its import-time self-check throws if the live
   prompt is missing `BLOCK ORDER IS NOT ROLE ORDER`. Every R3 run in this
   directory therefore *is* a run of the deployed prompt.
3. Production: `nostrautica@jl.bednar.io`'s built
   `packages/coordinator/dist/matching/scoring.js`, timestamped with the deploy,
   contains all three markers; the daemon is active.

So the "shipped the weaker of the two variants" caveat in that commit message does
not apply — the better-measured variant is the one running. Of its other two
caveats:

- **"The scoring-quality re-validation was NOT done … the saved reverse artifacts
  carry operational stats only."** Also wrong. Each `results/REVERSE_*.json`
  carries all 380 directed edges with their scores, and `node evaluate.mjs`
  recomputes recall@1/@3, separation, ordering accuracy and position bias from
  them — the rev-R2/rev-R3 table below is that output, reproducible today with no
  API spend. Nothing needed re-running; the numbers were on disk.
- **"There is no matched baseline."** Half right. R2 — the prompt deployed *before*
  d0b7164 — and R3 both have K=10 × 6-rep runs, so the previous-deployed vs
  now-deployed comparison is matched (and, per the statistics below, null). What is
  genuinely missing is R1, the 2026-07-24 prompt, at that size.

## Read the tables with a test, not with your eyes

`icebreaker-compare.mjs` pools graded runs by (variant, language) and prints exact
statistics: a Clopper-Pearson interval per arm and a two-sided Fisher exact test
per pair. `stats.mjs` holds the maths, pinned by `stats.test.mjs` against values
computed by inverting the binomial CDF independently of the implementation.

```
node --test stats.test.mjs                       # before quoting any p-value
node icebreaker-compare.mjs results/ICEBREAKER_*_x6.json
```

Applied to the x6 tables further down, the headline result of the 2026-07-25 round
does not survive:

| arm | lang | n | err | rate | 95% CI |
|---|---|---|---|---|---|
| R2-roles | en | 2594 | 4 | 0.15% | [0.04%, 0.39%] |
| R3-order | en | 2435 | 2 | 0.08% | [0.01%, 0.30%] |
| R2-roles | sk | 2272 | 8 | 0.35% | [0.15%, 0.69%] |
| R3-order | sk | 2222 | 2 | 0.09% | [0.01%, 0.32%] |

Fisher exact: en p = 0.69, sk p = 0.11, languages pooled p = 0.078. **"8 versus 2"
is not a difference this data can establish.** It was written up as one because
the counts were read side by side. Every interval above also overlaps every other.

Why the numbers are this weak is structural, not bad luck — see the dense bucket
below.

## The sparse reverse buckets dilute every rate by ~10x

`buildReverseCases` puts **one** trap in a batch of k: the shared person advertises
a single target's artifact. At production's k=10 that means one entry per call can
trip the hard checks and nine cannot — but all ten contribute their openers to the
denominator. Every reverse rate ever reported here is therefore roughly a tenth of
the rate *given the trap*, and the numerator stays in single digits no matter how
many repeats are bought.

`buildReverseDenseCases` (bucket `reverse-dense`) fixes the denominator: the shared
person advertises **every** target's artifact, so every entry is the ambiguous case.
Eight different shared people, `icebreaker-fixture.test.mjs` pins the density at
100% (and pins the sparse bucket at ≤1, so the contrast is a fact in the repo).

This is a **stress** bucket. The rate it reports is conditional on the trap and
must never be quoted as a production error rate. It is realistic in kind — the
profile that actually broke was a creative producer whose bio was the projects he
had done branding for — and deliberately exaggerated in degree.

## Second attempt: restructure the reverse block (R3, 2026-07-25)

The wording was not the problem — R2 already said, in as many words, that the
target is the SENDER. So R3 changes the SHAPE, on the hypothesis that role salience
follows print order and heading prominence:

1. A **writer directory above the shared person's block** (`WHO WRITES EACH ENTRY`),
   one line per entry with the writer named FIRST, so the first people the prompt
   introduces are the senders, in the role they actually hold.
2. A **binding line inside every numbered entry** (`(Entry n is written BY the
   TARGET n profile above, TO <recipient> …)`) — the forward block puts its SENDER
   line directly under the SENDER's profile; here that has to repeat per entry
   because every entry has a different sender.
3. One system bullet, `BLOCK ORDER IS NOT ROLE ORDER`, which is the only line that
   names the suspected cause and overrules it.

The blocks are NOT simply reordered, for two reasons. There are K senders and one
recipient, so the forward layout cannot be mirrored; and `coordinator.test.ts`'s
fake LLM decides who it was asked about by slicing the user block on the
`SHARED PERSON (…)` heading, then `TARGET ATTENDEES:`, then `--- TARGET n ---`, in
that order — moving them would silently make it answer about the wrong people.
`scoring.test.ts` pins those three landmarks so a future restructure fails loudly.

### Did the SCORES move? (new: `reverse-score-run.mjs`)

Nothing had ever measured score quality in this shape, so a prompt change here was
unfalsifiable in the direction that matters most: a fix for attribution that
degrades matching is a bad trade. Same gold pairs and metrics as the forward
benchmark, K=10 (production's `batch_size` default), all 380 directed edges, two
seeds per variant because recall@1 has a denominator of 20 and moves in 5% steps.

| prompt | seed | r@1 | r@3 | strong | medium | weak | sep | o>W | o>M | disc | posBias | format-fails |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| rev-R2-roles | 1 | 0.63 | 0.84 | 0.930 | 0.740 | 0.503 | 0.427 | 0.965 | 0.873 | 0.311 | −0.03 | 1 |
| rev-R2-roles | 2 | 0.40 | 0.90 | 0.927 | 0.733 | 0.504 | 0.424 | 0.967 | 0.919 | 0.321 | −0.06 | 0 |
| rev-R3-order | 1 | 0.70 | 0.90 | 0.935 | 0.713 | 0.413 | 0.522 | 0.990 | 0.935 | 0.322 | −0.07 | 0 |
| rev-R3-order | 2 | 0.80 | 0.95 | 0.917 | 0.658 | 0.440 | 0.477 | 0.961 | 0.935 | 0.318 | −0.03 | 0 |

**Scoring did not regress; it improved slightly.** Pooling the two seeds, gold
recall@1 goes 20/39 → 30/40 (Fisher exact p = 0.037) and recall@3 34/39 → 37/40
(p = 0.48, i.e. nothing). Strong-vs-weak separation rises 0.43 → 0.50 in BOTH
seeds, and the mechanism is visible in the columns: strong pairs stay at 0.92-0.94
while WEAK pairs drop 0.50 → 0.41-0.44, so the gain is the model being less
generous to bad matches, not more generous to good ones. Ordering accuracy and
score discrimination are flat. Read the recall numbers with the denominator in
mind: 20 directed gold pairs per run, and the two R2 seeds alone span 0.40-0.63, so
the r@1 gap is suggestive, not established.

Also worth recording: R2 produced one unparseable response in 80 calls, R3 none.
Not a metric, just the observation that the extra structure did not cost format
reliability.

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

## Structured output comes back in ALPHABETICAL key order (2026-07-27)

Venice's `json_schema` mode emits object keys sorted alphabetically, **not** in the
order the schema lists them under `properties`. Every cached response in this
directory confirms it:

```
complementarity -> icebreakers -> index -> reasoning_for_target -> score -> similarity
```

Two consequences, one of them a trap:

1. **You cannot order the decode by ordering the schema.** R4's whole mechanism is
   to make the model name the two roles *before* it writes the openers, and the
   first draft called the fields `writer_name` / `recipient_name` — both of which
   sort *after* `icebreakers`. It passed the schema self-checks, returned HTTP 200,
   and would have measured a no-op at the cost of a full arm. The fields are now
   `addressed_to` / `authored_by`, which sort ahead of `complementarity`, and
   `icebreaker-run.mjs` asserts `field < "icebreakers"` rather than checking the
   schema's property order, because the property order is not what decides.
2. **Production already writes icebreakers before its reasoning.** `icebreakers`
   sorts before `reasoning_for_target`, so however the prompt is phrased, the
   openers are not generated "after" the model has reasoned about the pair. Whether
   forcing the reverse — a reasoning field renamed to sort earlier — improves
   opener quality is untested and worth a variant; it would be a rename of a field
   the coordinator parses, so it is not free.

## Third attempt: the dense bucket settles it (R4, R5, 2026-07-27)

With the denominator fixed (see the dense bucket above), the reverse shape can
finally be measured. Two new candidates were tried against R3, the deployed
prompt:

- **R4-selflabel** — R3 plus two per-entry output fields naming the roles,
  emitted BEFORE the icebreakers. Field names are load-bearing: Venice emits keys
  alphabetically, so they are `addressed_to` / `authored_by`, not `writer_name` /
  `recipient_name`, which would have sorted after `icebreakers` and steered nothing.
- **R5-writersfirst** — R3 with the blocks physically reordered: every WRITER is
  printed first and the shared person LAST, mirroring the forward shape.

### Attribution (Slovak, reverse-dense, 96 calls per arm)

| variant | openers | errors | rate | per call | entries/call | openers/entry |
|---|---|---|---|---|---|---|
| R3-order (deployed) | 2514 | 23 | 0.91% | 10/96 (10.4%) | 9.97 | 2.63 |
| R5-writersfirst | 2721 | 4 | **0.15%** | 2/96 (2.1%) | 9.99 | 2.84 |

Significant on all three tests, including the conservative one: cluster
permutation **p = 0.031**, per-call Fisher p = 0.033, per-opener p = 0.0001. R5
is not buying this by emitting less — it returns MORE openers per entry and
grounds them in a named artifact more often (67.7% vs 58.5%).

An earlier 32-call pass also measured R4 at 4/616 (0.65%) against R3's 17/858,
and R2 — the prompt deployed BEFORE R3 — at 12/884 (1.36%). At 32 calls nothing
separated (all pairwise permutation p > 0.16). Worth recording anyway: **R2 came
out nominally BETTER than the R3 that replaced it**, which is consistent with the
sparse-bucket evidence for that change having been noise.

### Scoring quality — and why R5 was NOT shipped

| | R3 (deployed) | R5 |
|---|---|---|
| recall@1 (2 seeds, 40 gold) | 30/40 (75%) | 23/40 (58%) |
| recall@3 | 37/40 (93%) | 32/40 (80%) |
| separation, per seed | 0.48, 0.52 | 0.40, 0.40 |
| mean score on WEAK pairs | 0.44, 0.41 | 0.54, 0.53 |
| format fails / 80 calls | 0 | 0 |
| latency p50 | ~110s | ~47s |

The recall gaps are not individually significant (p = 0.16 and 0.19 on a
denominator of 40). But every quality indicator moves the same way in BOTH seeds,
the separation ranges do not overlap, and there is a mechanism: R5 inflates weak
pairs by about 0.11, so it discriminates bad matches less well. Printing the
recipient last fixes who is speaking and costs the model its grip on who is worth
meeting.

**Verdict: R3 stays.** Not because it is good — 0.91% of openers and 10.4% of
batches under stress — but because the one prompt that beats it on attribution
loses on matching, and a fix for attribution that degrades matching is a bad
trade. The decision rule (cluster permutation p < 0.05 on attribution AND no
regression in recall/separation) was fixed before the data was seen.

What this DOES establish is that the failure is fixable: a 6x reduction exists.
The most promising untried route is R4 with its yield bug fixed — it improved
attribution without touching block order, so it should not carry R5's scoring
regression, and its only disqualifier was returning 9.66 of the 10 required
entries (a missing entry is a pair that never gets scored). That looks promptable.

## Venice refuses concurrency; it does not queue it (2026-07-27)

Worth knowing before setting `CONC`. When a model is busy, Venice answers requests
beyond its allowance with an immediate **429 `"The model is currently
overloaded"`** — within ~360ms, and with the request quota almost untouched
(`x-ratelimit-remaining-requests` 990/1000). It is a concurrency cap, not a rate
limit, and it moves: eight parallel probes went 7-of-8 refused one hour and
8-of-8 accepted the next.

This was invisible and cost hours. `complete()` retried 429s silently, so a run at
`CONC=16` where the model was accepting about one call at a time looked exactly
like a slow model — every other worker was asleep in the backoff. Two changes:
retries now log (`RETRY_QUIET=1` to silence), and the retry budget went from 6
uncapped attempts (giving up after ~1 minute) to 12 with the sleep capped at 20s.
A lost call is a lost *batch* of ~30 graded openers; waiting is free by comparison.

Diagnose it directly rather than inferring it from throughput — fire eight small
parallel completions and look at the status codes. If they come back 429 in
milliseconds, lower `CONC`; if they come back 200, raise it.
