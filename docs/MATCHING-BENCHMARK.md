# Matching benchmark — model × prompt × batch size

**Setup.** 20 synthetic personas (cypherpunk conference, real `ai_profile` shape from `profile.ts`) with hidden ground truth: 10 planted STRONG pairs, 13 MEDIUM, rest weak (`benchmarks/matching/gold-pairs.json`, never shown to models). Scoring runs on Venice (same request shape/quirks as `providers/venice.ts`). Primary axis is **batched scoring** — one call = 1 target + K candidates returning per-candidate `{similarity, complementarity, score, reasoning_for_target}` — with pairwise (K=1, exact production prompt P0) as the reference. Metrics: recall of gold-strong pairs in each persona's top-3/top-1, strong-vs-weak score separation, blind-judged reasoning quality (1–5, user-facing-host rubric), position bias, format failures, latency, cost. Harness + raw data: `benchmarks/matching/`.

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

### Deprecation follow-up — `deepseek-v4-flash` → `deepseek-v4-flash-0731` (2026-08-04)

Venice deprecated the winning id: `GET /models` carries
`deprecation: {date: 2026-08-14, autoRemap: false, replacementModelId: "deepseek-v4-flash-0731"}`.
`autoRemap: false` means nothing silently redirects — on 2026-08-14 the old id
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
- **Price is ~27% higher** — $0.175/$0.35 per Mtok vs $0.138/$0.275 ⇒ roughly
  **$0.28 per 100 attendees**, still ~35× cheaper than glm-5-2 pairwise.
- **Venice now reports `privacy: "private"`** for 0731 where 0423 was
  `"anonymized"` (`supportsTeeAttestation` is still `false` on both). The
  `models.match.require_private = false` override was kept anyway — see
  `coordinator.example.toml` for why — but the ⚠ in the Recommendation below no
  longer describes the deployed model.
- 0731 also advertises `reasoning_effort` (`none|low|high|max`, default **high**),
  which 0423 did not. Irrelevant in practice here: the coordinator sends
  `venice_parameters.disable_thinking`, verified to still zero reasoning on 0731
  (probe returned `reasoning_content: null`, 82 completion tokens for an 82-token
  answer).

## What actually moved quality

- **Rubric anchors beat everything else.** Adding explicit score bands ("0.9–1.0 = near-perfect mutual fit … 0.0–0.1 = no reason to meet") + "most candidates should NOT score high" (BP1) roughly **doubled strong-vs-weak separation** on every model (e.g. glm-5-2: 0.34→0.62; glm-4.7-flash: 0.06→0.50). The production P0 prompt compresses scores badly — weak pairs average 0.6–0.86, so top-K lists are ranked noise even when recall looks fine.
- **Small models fail P0 hardest.** glm-4.7-flash under P0 scored *everyone* 0.7–0.95 (separation 0.06 — unusable); with the BP3 rubric it's a viable budget scorer. Prompt >> model at this task.
- **Batched scoring (K=10) matches pairwise quality at ~10–45× lower cost.** recall@3 0.90 vs 1.00 (that gap is one rank-4 miss over a 20-item denominator on a much harder full-190 ranking; on the like-for-like subset, batched ties or beats pairwise), far better separation, and 10× fewer calls. Position bias exists but is small at K=10 with shuffled candidate order (corr 0.0–0.16; qwen3-235b worst at 0.28); no skipped/merged candidates in any healthy run.
- **The host-voice instruction (BP3) is what makes reasoning shippable.** Naive batched reasoning (BP0) judged 2.97/5 — full of "high complementarity … strong match score" scoresplaining. BP3's "you're a host introducing them; concrete hook; never say match/score/complementarity" + one good/bad example lifted every model to 4.3–4.6 with near-zero meta-commentary. Few-shot calibration examples (BP2) helped scores a little; the good/bad *reasoning* example helped language a lot.
- **Failure modes to watch:** the only invented-facts case in judging was glm-5-2 asserting a candidate "needs exactly" something she never asked for (judged 2.5); occasional prompt-rubric echo ("puzzle-piece fit") appears when a rubric phrase is colorful — keep rubric wording drab. Long reasonings (4–7 sentences) came mostly from pairwise P0; BP3 batched stays near the 1–2 sentence target.
- **Ops:** strict `json_schema` worked on every kept model with zero format failures across ~2.3k calls (after excluding glm-5-turbo pairwise). deepseek-v4-flash showed no position bias at all (−0.01) and is the cheapest model tested ($0.138/$0.275 per Mtok).

## Recommendation

- **Winner: `deepseek-v4-flash` + BP3 prompt, batched K=10** — best recall@1 (0.75), best separation (0.59), judge 4.53, zero format failures/position bias, **$0.22 per 100 attendees** (≈45× cheaper than today's glm-5-2+P0 pairwise). ⚠ Not Venice private-tier: adopting it means relaxing `require_private` (an `e2ee-deepseek-v4-flash` private variant exists but lacks `response_schema` support — would need instructed-JSON parsing).
- **Private-tier winner (drop-in, no policy change): keep `zai-org-glm-5-2`, switch to BP3 batched K=10** — statistically tied on quality (judge 4.63, best prose), $2.64/100 attendees = 3.7× cheaper than current production. **Value pick (private): `zai-org-glm-4.7-flash` + BP3** — $0.32/100 attendees, recall@3 0.90, slightly mushier separation (0.48).
- Even without the batching refactor, **adopt the BP3 scoring rubric + host-voice reasoning into the pairwise prompt today** — it fixes the two real production defects (score compression, analytical reasoning) with a one-string change.

**Adoption:** set `models.match` in coordinator config to the chosen model id; replace `PAIR_SYSTEM_PROMPT` in `packages/coordinator/src/matching/scoring.ts` with the appendix prompt (for pairwise adoption, keep the two-reasonings paragraph but replace its style instructions with the host-voice block). Event context is already wired: `scorePair` receives `EventContextForScoring` (31923 title/summary/hashtags) via matcher orchestration — keep passing it; batched scoring would group `selectPairsToScore` output by target and send K=10 candidate blocks per call.

## Appendix — recommended prompt (BP3, batched)

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
