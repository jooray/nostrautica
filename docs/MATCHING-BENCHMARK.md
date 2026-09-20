# Matching benchmark: model × prompt × batch size

**Setup.** 20 synthetic personas (cypherpunk conference, real `ai_profile` shape from `profile.ts`) with hidden ground truth: 10 planted STRONG pairs, 13 MEDIUM, rest weak (`benchmarks/matching/gold-pairs.json`, never shown to models). Scoring runs on Venice (same request shape/quirks as `providers/venice.ts`). Primary axis is **batched scoring** (one call = 1 target + K candidates returning per-candidate `{similarity, complementarity, score, reasoning_for_target}`) with pairwise (K=1, exact production prompt P0) as the reference. Metrics: recall of gold-strong pairs in each persona's top-3/top-1, strong-vs-weak score separation, blind-judged reasoning quality (1–5, user-facing-host rubric), position bias, format failures, latency, cost. Harness + raw data: `benchmarks/matching/`.

## Results (headline rows; full table via `node evaluate.mjs`)

| Model | Prompt | K | recall@1 | recall@3 | sep S–W | judge | fail | p50 lat | $/100 attendees* |
|---|---|---|---|---|---|---|---|---|---|
| **deepseek-v4-flash** | **BP3** | **10 (full 190)** | **0.75** | **0.90** | **0.59** | **4.53** | 0 | 9.5 s | **$0.22** |
| gemini-3-flash-preview | BP3 | 10 (full) | 0.70 | 0.90 | 0.56 | 4.33 | 0 | 5.6 s | $1.67 |
| zai-org-glm-5-2 | BP3 | 10 (full) | 0.70 | 0.90 | 0.59 | 4.63 | 0 | 10.6 s | $2.64 |
| zai-org-glm-5-2 (production) | P0 | 1 (pairwise) | 0.75 | 1.00 | 0.34 | 4.00 | 0 | 9.0 s | $9.90 |
| zai-org-glm-4.7-flash | BP3 | 10 (subset) | 0.80 | 0.90 | 0.48 | – | 0 | 8.6 s | $0.32 |
| deepseek-v4-flash | BP0 (naive batch) | 10 (subset) | 0.80 | 1.00 | 0.48 | 2.97 | 0 | 10.0 s | $0.22 |
| deepseek-v4-pro | P0/BP0 (partial) | – | 0.80 | 1.00 | 0.40 | – | 0 | 16.2 s | – |
| z-ai-glm-5-turbo | P0 | 1 (pairwise) | – | – | – | – | **116** | 11.1 s | – |

\* prefiltered ≈2k pairs/100 attendees ⇒ 4k directional scorings = 400 K=10 calls (pairwise: 2k calls). Judge = blind 15-sample mean.
Ruled out: **deepseek-v4-pro** on latency (maintainer call: ~16 s p50 / 23 s p95; partial subset numbers above for context). **z-ai-glm-5-turbo** disqualified for pairwise P0 (116/120 format failures under strict `json_schema`); worked batched but slow (13–25 s p50).

> **Later rounds live in [`MODEL-BAKEOFF.md`](MODEL-BAKEOFF.md)** (from 2026-08-26).
> The procedure below was run by hand; it is now frozen in `benchmarks/matching/bakeoff.mjs`
> so that a model benchmarked next month is measured against exactly what these rows were.
> This document stays as the record of how the deployed prompt and model were chosen.

### Deprecation follow-up: `deepseek-v4-flash` → `deepseek-v4-flash-0731` (2026-08-04)

Venice deprecated the winning id: `GET /models` carries
`deprecation: {date: 2026-08-14, autoRemap: false, replacementModelId: "deepseek-v4-flash-0731"}`.
`autoRemap: false` means nothing silently redirects, on 2026-08-14 the old id
simply stops resolving, which for this coordinator is a startup model-verification
failure, not a degraded match. Production moved to 0731 before that date.

Re-ran BP3 / K=10 / eval subset on both ids, two seeds each (paired, so the
comparison isn't reading seed noise as a regression):

| id | recall@1 | recall@3 | sep S–W | strong | weak | posBias | fail | p50 lat |
|---|---|---|---|---|---|---|---|---|
| `deepseek-v4-flash` (0423) | 0.80 / 0.75 | 0.95 / 0.95 | 0.65 / 0.64 | 0.89 / 0.88 | 0.25 / 0.24 | 0.04 / 0.10 | 0 | 16.1 s / 6.6 s |
| `deepseek-v4-flash-0731` | 0.75 / 0.75 | 0.95 / 0.90 | 0.62 / 0.59 | 0.91 / 0.89 | 0.29 / 0.31 | 0.09 / 0.19 | 0 | 11.2 s / 6.2 s |

Like-for-like within noise on the metrics that decide what attendees see. The one
consistent (both seeds) difference is weak pairs scoring ~5 points higher, which
narrows the strong–weak margin without reordering: ordering-above-weak stays
0.98–0.99 and matches are selected by rank (`top_k`), not by an absolute score
floor. Zero format failures under strict `json_schema` across 84 calls.

Two things changed besides the id:
- **Price is ~27% higher**: $0.175/$0.35 per Mtok vs $0.138/$0.275 ⇒ roughly
  **$0.28 per 100 attendees**, still ~35× cheaper than glm-5-2 pairwise.
- **Venice now reports `privacy: "private"`** for 0731 where 0423 was
  `"anonymized"` (`supportsTeeAttestation` is still `false` on both). The
  `models.match.require_private = false` override was kept anyway (see
  `coordinator.example.toml` for why), but the ⚠ in the Recommendation below no
  longer describes the deployed model.
- 0731 also advertises `reasoning_effort` (`none|low|high|max`, default **high**),
  which 0423 did not. Irrelevant in practice here: the coordinator sends
  `venice_parameters.disable_thinking`, verified to still zero reasoning on 0731
  (probe returned `reasoning_content: null`, 82 completion tokens for an 82-token
  answer).

## What actually moved quality

- **Rubric anchors beat everything else.** Adding explicit score bands ("0.9–1.0 = near-perfect mutual fit … 0.0–0.1 = no reason to meet") + "most candidates should NOT score high" (BP1) roughly **doubled strong-vs-weak separation** on every model (e.g. glm-5-2: 0.34→0.62; glm-4.7-flash: 0.06→0.50). The production P0 prompt compresses scores badly, weak pairs average 0.6–0.86, so top-K lists are ranked noise even when recall looks fine.
- **Small models fail P0 hardest.** glm-4.7-flash under P0 scored *everyone* 0.7–0.95 (separation 0.06, unusable); with the BP3 rubric it's a viable budget scorer. Prompt >> model at this task.
- **Batched scoring (K=10) matches pairwise quality at ~10–45× lower cost.** recall@3 0.90 vs 1.00 (that gap is one rank-4 miss over a 20-item denominator on a much harder full-190 ranking; on the like-for-like subset, batched ties or beats pairwise), far better separation, and 10× fewer calls. Position bias exists but is small at K=10 with shuffled candidate order (corr 0.0–0.16; qwen3-235b worst at 0.28); no skipped/merged candidates in any healthy run.
- **The host-voice instruction (BP3) is what makes reasoning shippable.** Naive batched reasoning (BP0) judged 2.97/5: full of "high complementarity … strong match score" scoresplaining. BP3's "you're a host introducing them; concrete hook; never say match/score/complementarity" + one good/bad example lifted every model to 4.3–4.6 with near-zero meta-commentary. Few-shot calibration examples (BP2) helped scores a little; the good/bad *reasoning* example helped language a lot.
- **Failure modes to watch:** the only invented-facts case in judging was glm-5-2 asserting a candidate "needs exactly" something she never asked for (judged 2.5); occasional prompt-rubric echo ("puzzle-piece fit") appears when a rubric phrase is colorful, keep rubric wording drab. Long reasonings (4–7 sentences) came mostly from pairwise P0; BP3 batched stays near the 1–2 sentence target.
- **Ops:** strict `json_schema` worked on every kept model with zero format failures across ~2.3k calls (after excluding glm-5-turbo pairwise). deepseek-v4-flash showed no position bias at all (−0.01) and is the cheapest model tested ($0.138/$0.275 per Mtok).

## Negative result: the flat top is not a prompt problem (2026-09-12)

Production's Plan B event (39 attendees with profile content, 1,482 directed
scores) rendered "Strong match" on essentially every match an attendee opened.
The first suspicion was score compression — the defect this document's rubric
anchors were written to fix — so the scores were pulled and looked at directly.

**They were not compressed.** Across all 1,482 pairs only 28% clear 0.80, spread
smoothly over 0.05–0.95, mean 0.60. The scorer uses its range. What produced the
symptom was the badge: an ABSOLUTE threshold applied to a list already truncated
to the top `top_k` **by rank**. Of the top 20 each attendee is shown, 51% clear
0.80, and 30 of 39 saw an all-strong top five. That is a UI bug, fixed in
`packages/app/src/lib/events/confidence.ts`, not a scoring one.

What survived the fix is a real property of the data: **the top of a list is
genuinely flat.** Scores land on multiples of 0.05, so 1,482 of them take 19
distinct values; 19 of 39 attendees had a tied #1, and an average top five holds
only 2.46 distinct scores. Five attendees have six or more pairs tied at 0.95.

So four prompt variants were run against that real roster, two seeds each, to see
whether the flatness was something the prompt was causing. Each is the deployed
BP3 plus exactly one inserted block:

| variant | strong% | all-strong top-5 | sd | distinct | tau | dirGap | meta% |
|---|---|---|---|---|---|---|---|
| V0 deployed prompt | 23 | 17/39 | 0.230 | 18 | 0.71 | 0.159 | 1.9 |
| V1 discount the event baseline | 23 | 16/39 | 0.230 | 18 | 0.68 | 0.163 | **4.1** |
| V2 explicit per-batch quota | 25 | 16/39 | 0.235 | 30 | 0.72 | 0.167 | 3.1 |
| V3 ask for two decimals | 24 | 18/39 | 0.228 | **32** | 0.69 | 0.152 | 2.0 |
| V4 V1 + V2 | 22 | 15/39 | 0.231 | 19 | 0.69 | 0.165 | 3.4 |

`tau` = Kendall between the two seeds; `dirGap` = mean |A→B − B→A|; `meta%` =
reasonings containing analytical framing. Metrics were chosen so a prompt that
merely adds NOISE cannot win: spread must rise while `tau` and `dirGap` hold.

**Nothing moved.** strong% 22–25, all-strong top fives 15–18 of 39, sd 0.228–0.235.
At n=39 with two seeds those are indistinguishable.

Three findings worth keeping:

- **Telling the model to discount what the event shares backfires, visibly.** V1's
  block leaked into the user-facing text and made it dismissive: *"…ale nemá pre
  vás obchodný potenciál. Zhodíte sa len v téme krypta, čo je na tejto akcii
  bežné."* — "has no business potential for you", shown to an attendee. Dismissive
  phrasing doubled (17→34 per 1,482; V4: 40), meta-commentary doubled, and
  language drift at a Czech event nearly doubled (4.3%→7.3% Slovak function words).
  This is the leak this document already warns about under "keep rubric wording
  drab", and drab wording was not enough: the INSTRUCTION leaked, not its adjectives.
- **Finer granularity does not reach the top.** V3 raised distinct score values
  from 18 to 32, but tied #1s got WORSE (18→22 of 39) and distinct values inside a
  top five barely moved (2.69→2.82). The extra precision lands mid-distribution;
  the model still snaps to 0.90/0.95 at the top. So the ties are not an expressive
  limit it was working around.
- **A quota is not obeyed as one.** V2 asked for "one or two above 0.8 in a batch
  of ten" and produced 25% strong — slightly MORE than the baseline.

The conclusion is mechanical, not linguistic. `scoreBatch` judges each candidate
independently — deliberately, so scores stay comparable across the four batches a
38-candidate target needs — and nothing in that design ever asks "of these ten,
which is best?". Three different ways of asking the scorer to spread itself failed,
and the granularity result rules out the reading that it wanted to and could not.
When it says ten people are 0.95, that is its answer.

Caveats: one event, one language (cs), one model, n=39. The harness reproduces
production's DISTRIBUTION (strong% 20 vs 23, sd 0.227 vs 0.230, distinct 19 vs 18)
but not its second-order structure (rater share of variance 38% vs 20%, hub Gini
0.52 vs 0.65) — production scored this roster incrementally over eight days as
people joined, so every pair was judged beside whatever batch peers were pending
at the time, and 6% of its rows predate an edit to one of the two profiles. Read
the table as variant-vs-V0; variant-vs-production is not a claim it can support.

*Cost: $2.24 across 1,560 calls, 0 unparsed and 0 failed. The roster is real
attendees, so the fixture and harness stay local — see
`benchmarks/matching/private/README.md`, which is gitignored.*

## Follow-up: a rerank pass, and what it exposed about the scorer (2026-09-13)

The negative result above pointed at the mechanism rather than the wording, so the
obvious next thing was tested: take each target's top-N by score and ask, in one
call, for a strict order over them — the question independent scoring never asks.
39 targets, two runs per configuration, the shortlist presented in a DIFFERENT
shuffled order each run. The reranker emits an order and nothing else; after V1's
leak there is no reason to give a second prompt a prose channel.

The only honest question about the output is whether it is reproducible, and the
baseline for that is not zero — it is how well the **scorer** agrees with itself
on exactly the same shortlists. That comparison is the finding:

| ordering the top 5 | cross-seed Kendall tau | same #1 in both runs |
|---|---|---|
| current scorer | 0.215 | 11/39 (28%) |
| listwise rerank | **0.463** | **19/38 (50%)** |

| ordering the top 10 | | |
|---|---|---|
| current scorer | 0.242 | 9/39 (23%) |
| listwise rerank | 0.289 | 16/39 (41%) |

**The scorer's top-of-list order is barely reproducible.** Re-run matching with the
candidates shuffled into different batches and the attendee's #1 match changes
about three times in four. That is not a reranking problem, it is a property of
what ships today, and it was invisible until something was measured against it:
the sweep's headline tau of 0.71 runs over all 38 candidates, where Kendall skips
tied pairs and most comparisons are between an obvious 0.9 and an obvious 0.2.
Restricted to the five people an attendee actually looks at — near-identical
scores, which is the hard case — it falls to 0.215.

Reranking roughly doubles that, and only at a short list. At N=10 the returned
order correlates with the order the model was SHOWN (0.313) about as much as with
itself across runs (0.289): ten near-identical profiles is past what it can hold,
and it starts echoing the list back. At N=5 content wins over position (0.463 vs
0.353).

So a rerank over the top ~5 is worth building; over the top 10 it is not. Neither
is a fix for the flat top — the reranker disagrees with the scorer's order about
as much as it disagrees with itself (tauScore 0.27–0.29), so it is not resolving
the ties so much as replacing one unstable order with a less unstable one. Before
implementing, the thing to settle is what "better" means here, because no metric
on this page can distinguish a more reproducible order from a more USEFUL one.
That needs the human labels `evaluate.mjs --labels` was written to collect.

*Cost: $0.06 across 156 calls.*

## A decision model instead of a chat model: Jev (2026-09-19)

Venice now lists `jev-latest` (TypeSafe AI's "System One" model, `type:
decision`) behind its own endpoint, `POST /decisions`. It takes a `state` and a
map of typed questions and returns probabilities: a `score` question over an
ordered rubric comes back as a probability-weighted level with the full
distribution. No prose. Input tokens only are billed ($0.042/Mtok, output $0),
the state is billed once per request however many questions ride on it, and a
call returns in under a second. The API notes are in the operator's
`server-documentation/experiments/jev.md`; this section is what it did on the
fixture. Harness: `benchmarks/matching/jev-run.mjs`, results score through the
unchanged `evaluate.mjs`.

BP3 cannot be used as a prompt, so its five score anchors became a five-level
rubric (`score / 4` → 0..1), with `similarity` and `complementarity` rubrics
and a `noul` (yes/no probability) "should the target make a point of meeting
this candidate" on the same request. Two shapes: **pair**, one request per
directed pair with the EVENT/TARGET/CANDIDATE text block BP3 sees (380
requests); **batch K=10**, a JSON state `{event, target, candidates[]}` with a
`score` and `noul` question per candidate (40 requests). The deployed model was
re-run with a second seed today so stability could be compared like for like.

| scorer | shape | recall@1 | recall@3 | sep S−W | posBias | p50 | $ (380 edges) |
|---|---|---|---|---|---|---|---|
| deepseek-v4-flash-0731 BP3 | K=10 seed 1 / 2 | 0.65 / 0.70 | 0.85 / 0.85 | 0.55 / 0.51 | 0.11 / 0.08 | 28.9 s / 18.1 s | $0.0267 |
| jev, score rubric | pair seed 1 / 2 | 0.70 / 0.70 | 0.90 / 0.90 | 0.52 / 0.52 | 0.00 | 0.56 s | $0.0162 |
| jev, score rubric | K=10 seed 1 / 2 | 0.70 / 0.75 | 0.85 / 0.85 | 0.51 / 0.52 | 0.08 / 0.03 | 0.73 s | $0.0074 |
| jev, score rubric | K=5 seed 1 | 0.75 | 0.85 | 0.51 | 0.00 | 0.59 s | $0.0084 |
| jev, noul | pair / K=10 | 0.75 / 0.70–0.75 | 0.85 / 0.85–0.90 | 0.46 / 0.54 | 0.00 | same calls | same calls |

Eval subset: jev K=10 recall@1 0.75, recall@3 0.95 on both seeds, the same as
0731's best subset row, at $0.0025 against $0.0098.

**On ranking quality it is a tie.** Every difference above is one or two targets
out of twenty and flips between seeds. Both scorers miss the same three gold
pairs (Yusuf↔Elena, Aleksy↔Priya, Mara↔Nadia) and put about the same number of
unplanned pairs into a top three (jev 30–33 of 60, DeepSeek 35–36).

**On stability it is not.** The rerank study above found the deployed scorer's
top-of-list order barely reproduces; the same measurement on this fixture:

| two runs, same configuration | top-5 τ | top-10 τ | same #1 | mean \|Δscore\| per edge | tied #1s | distinct values | dirGap |
|---|---|---|---|---|---|---|---|
| deepseek-v4-flash-0731 K=10 | 0.571 | 0.506 | 16/20 | 0.109 (max 0.50) | 5 and 8 of 20 | 21 | 0.128–0.149 |
| jev K=10 | 0.626 | 0.719 | 16/20 | – | 0 | 81–82 | 0.085–0.094 |
| jev pair | **0.876** | **0.905** | **19/20** | **0.012** (max 0.08) | 0 | 86–88 | 0.083 |

DeepSeek snaps to multiples of 0.05; a DeepSeek top five holds 3.4–3.8 distinct
scores, jev's 4.95–5.00. This is the flat-top finding of 2026-09-12 addressed
at the source rather than in the UI: the ties are not there to begin with.

Two caveats the numbers carry. Jev pair and jev K=10 agree with each other at
τ 0.65, about as well as K=10 agrees with itself across seeds: **the other
candidates in a batched state leak into a score** even though every question is
evaluated in isolation, so this batch shape is cheaper and roughly a third less
reproducible. The leak is specific to several items sharing a state: a sibling
project measured fifteen questions over one item against one question per
request at Spearman 0.999 the same day. The shape to try next is therefore the
anchor alone in the state and each candidate's text inside its own question. And `score` vs `noul` is a wash on rank (noul slightly better at
#1, worse on separation); keep `score` for its re-thresholdable distribution and
add `noul` free on the same request.

Operationally: 1,340 paid requests, zero non-200 after retry, zero missing
answers. Venice allows 100 decisions/min per key and locks the key for 30 s after
more than 50 non-success responses, so the runner paces itself rather than
retrying; the long p95s in the logs are backoff from two other sessions sharing
the key during the sweep. Position bias is 0.00–0.08 (0.15 on one 21-call
subset seed).

**What it does not give you.** No `reasoning_for_target`: a chat model still
writes the sentence the attendee reads. Same `anonymized` tier as today, beta,
and this is the synthetic fixture only: whether the continuous scores stay
spread on a single-topic Czech roster, where the chat model rated the whole
room 0.95, is exactly what `private/` exists to ask and has not been asked.

**Cost per 100 attendees** (~4,000 directed scorings): jev K=10 ≈ **$0.07**,
jev pair ≈ $0.17, deployed path ≈ $0.28 including prose. A hybrid, jev scoring
everything and the chat model writing reasoning only for the ~2,000 edges shown
(and, seeing the shortlist together, doing the top-5 rerank), lands near $0.21.
The larger win is wall-clock: 400 batched requests clear in ~4 minutes against
~30 for the same DeepSeek calls.


### The same day on the real roster

The synthetic fixture cannot show the flat top, so jev was then run on the Plan
B roster through the private harness (`benchmarks/matching/private/jev-run.mjs`;
the rows stay on the machine, only these aggregates leave it). Shape: target
alone in the state, each candidate's profile inside its own `score` and `noul`
question, all 38 in one request or ten per request. 39 requests, 27 seconds and
$0.05 for a full run. The deployed prompt on `deepseek-v4-flash-0731` was
re-run at two seeds the same day as the reference, beside the live scores.

| Plan B, 1,482 directed scores | tied #1 | distinct in a top 5 | distinct values | cross-seed top-5 τ | same #1 across seeds | whole-list τ | dirGap |
|---|---|---|---|---|---|---|---|
| production (live) | 19/39 | 2.46 | 19 | – | – | – | 0.114 |
| deepseek 0731, same day | 18 and 23 /39 | 2.6–2.8 | 18–23 | 0.34 | 14/39 | 0.73 | 0.159 |
| jev, all candidates per request | **0/39** | **4.9** | **348** | **0.89** | **36/39** | **0.96** | **0.098** |
| jev, ten per request | 0/39 | 4.9 | 347 | 0.86 | 37/39 | 0.96 | 0.098 |

Re-run the deployed scorer and 25 of 39 attendees get a different #1; re-run
jev and 3 do. Jev agrees with production on the #1 for 12/39 (top-5 Jaccard
0.27), which is the same as the deployed model re-run today agrees with its own
live output (11/39, 0.28), so the disagreement is the chat scorer's noise, not a
jev divergence; whole-list Spearman against production is 0.60 for both. Two
things to carry into any wiring change: jev's scale is lower (3% of pairs ≥ 0.8
against 23–28%, no all-Strong top fives against 15/39), so the `confidence.ts`
banding needs recalibrating; and jev hands its most popular attendee 13 first
places against production's 8, which only a human can judge. The private
directory holds a blind sheet (`labels-blind-top3.json`) with each attendee's
top three from jev, DeepSeek and production in shuffled columns for exactly
that. *Cost: $0.21 of jev across 390 requests, $0.35 of DeepSeek.*

**Recommendation.** Build the hybrid: jev scores every pair (target in state,
candidates in questions), the chat model writes reasoning for the shown edges
and reranks the top five while it has them together. Ship the badge threshold
change with it. Read the blind sheet before deciding whose picks are better;
reproducible is not the same as right. Nothing in the coordinator was changed
for this. *Cost: ≈ $0.075 of jev across 1,340 requests,
plus $0.027 for the second DeepSeek seed.*

## Recommendation

- **Winner: `deepseek-v4-flash` + BP3 prompt, batched K=10**: best recall@1 (0.75), best separation (0.59), judge 4.53, zero format failures/position bias, **$0.22 per 100 attendees** (≈45× cheaper than today's glm-5-2+P0 pairwise). ⚠ Not Venice private-tier: adopting it means relaxing `require_private` (an `e2ee-deepseek-v4-flash` private variant exists but lacks `response_schema` support, would need instructed-JSON parsing).
- **Private-tier winner (drop-in, no policy change): keep `zai-org-glm-5-2`, switch to BP3 batched K=10**: statistically tied on quality (judge 4.63, best prose), $2.64/100 attendees = 3.7× cheaper than current production. **Value pick (private): `zai-org-glm-4.7-flash` + BP3**, $0.32/100 attendees, recall@3 0.90, slightly mushier separation (0.48).
- Even without the batching refactor, **adopt the BP3 scoring rubric + host-voice reasoning into the pairwise prompt today**: it fixes the two real production defects (score compression, analytical reasoning) with a one-string change.

**Adoption:** set `models.match` in coordinator config to the chosen model id; replace `PAIR_SYSTEM_PROMPT` in `packages/coordinator/src/matching/scoring.ts` with the appendix prompt (for pairwise adoption, keep the two-reasonings paragraph but replace its style instructions with the host-voice block). Event context is already wired: `scorePair` receives `EventContextForScoring` (31923 title/summary/hashtags) via matcher orchestration, keep passing it; batched scoring would group `selectPairsToScore` output by target and send K=10 candidate blocks per call.

## Appendix: recommended prompt (BP3, batched)

```text
You are a conference matchmaker for the event described below. You are given ONE target attendee
and a numbered list of candidate attendees. For EACH candidate, judge how valuable it would be
for the TARGET to meet them, considering what THIS event is for.

Score three fields, each a DECIMAL between 0.0 and 1.0 (never 0-10 or 0-100):
 • similarity: shared interests, background, or goals.
 • complementarity: how much their skills/roles COMPLETE each other for this event — one has what
   the other needs (a founder needing a Rust dev + a Rust dev wanting a mission; a drummer + a
   bassist; powerful-but-unusable tech + a designer). This is the most important signal.
 • score: overall value of the meeting. A meeting is high-value when one person's SEEKS is met by
   the other's OFFERS/skills (in either direction). Reward that fit heavily.

Score anchors for `score`: 0.9-1.0 = a near-perfect mutual fit (each solves the other's stated need);
 0.7-0.85 = strong one-directional or clearly useful fit; 0.4-0.6 = plausible, some overlap but no
 sharp need met; 0.15-0.35 = weak, only vague topical overlap; 0.0-0.1 = no real reason to meet.

Scoring rules:
 • Score each candidate INDEPENDENTLY on its own merits. Do not let an early strong candidate inflate
   later ones, or let a strong batch drag up a weak candidate. Use the FULL range — most candidates in
   a batch should NOT score high.
 • Ground every judgement in the ACTUAL profile text. Never invent skills, goals, or facts.

reasoning_for_target — THIS TEXT IS SHOWN DIRECTLY TO THE TARGET ATTENDEE. Write 1-2 sentences in
the voice of a good host introducing them to the candidate:
 • Second person, direct: "You should grab Elena — ...", "Ask him about ...".
 • Name a CONCRETE thing to talk about or do together, drawn from both people's actual details.
 • ABSOLUTELY NO analytical framing: never say "this pair", "based on their profiles", "high
   complementarity", "scores", "match", or explain why a rating was given. No hedging boilerplate.
Example of GOOD: "You've been hunting for a bassist — Sunny plays bass, she's new in town and dead
serious about joining a band; ask her what she'd want your first setlist to sound like."
Example of BAD (never do this): "This pair has high complementarity because both are musicians
seeking bandmates, resulting in a strong match score."

Return one entry per candidate, using the candidate's number as `index`. Score EVERY candidate exactly once.
```

*Benchmark cost: ≈$3.4 of Venice API across ~2,377 calls (2.9M prompt / 1.0M completion tokens). Reproduce: `benchmarks/matching/README.md`.*
