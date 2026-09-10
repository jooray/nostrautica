# Model bake-off: GLM 5.3 Flash vs DeepSeek V4 Flash 0731

**Question.** Venice shipped `z-ai-glm-5-3-flash` (GLM 5.3 Flash) on 2026-08-26.
Production scores matches with `deepseek-v4-flash-0731`. Is the new model better,
and is it deployable?

**Short answer.** It is meaningfully better at the actual task and ~11% cheaper,
and it is **not deployable today**, `providers/venice.ts` cannot drive it as
coded. Both blockers are in the provider, not the model. See
[Deployability](#deployability-two-hard-blockers).

This is also the first run of a **repeatable** suite. Adding the next model (Qwen 3.8 Flash when it lands, or anything after) is one command, and the
subjective grades recorded here carry forward instead of being thrown away. The
harness lives in `benchmarks/matching/`; `benchmarks/matching/README.md` has the
operating instructions.

---

## Method

Everything is the existing matching benchmark, frozen into one driver
(`bakeoff.mjs`, `SUITE_VERSION = 1`) so that a model measured in December is
measured against exactly what these two were measured against in August. No arm
is a reimplementation: the scoring arms are `run.mjs`, the icebreaker arm is
`icebreaker-run.mjs`, the statistics are `stats.mjs`.

| arm | shape | what it answers |
|---|---|---|
| A, B | BP3 / K=10 / eval subset / seeds 1+2 | scoring quality, matched to every historical row in `MATCHING-BENCHMARK.md` |
| C | BP3 / K=10 / full 190 pairs / seed 1 | the harder ranking (20 candidates, not 6), and the cost basis |
| D | R3 / K=10 / `reverse-dense` / sk+en ×6 | icebreaker attribution errors, graded by string match, not by a judge |
| E | 6 serial K=10 calls | latency and output tok/s, uncontaminated by concurrency |

Fixture: the same 20 synthetic cypherpunk-conference personas and the same
hidden `gold-pairs.json` (10 strong, 13 medium) the 2026-07 benchmark used, never
shown to a scoring model. The prompts are byte-recorded with hashes in
`benchmarks/matching/results/bakeoff/PROMPTS.md`; every card carries the hashes,
and `bakeoff-report.mjs` refuses to print a table whose rows were measured under
different prompt bytes.

Both models were run on the same day, from the same machine, against the same
fixture, with the two runs overlapping in time, so neither got a quiet hour
that the other did not.

---

## Deployability: two hard blockers

Neither is visible in any quality metric, and both were found by the harness
before a single quality number was read. Both apply to
`packages/coordinator/src/providers/venice.ts` as it is written today.

### 1. `disable_thinking` is rejected outright

`venice.ts` sends, unconditionally, on every call:

```js
venice_parameters: {
  include_venice_system_prompt: false,
  disable_thinking: true,
  strip_thinking_response: true,
}
```

GLM 5.3 Flash answers any request carrying `disable_thinking` with:

```
HTTP 400 {"error":"Reasoning is mandatory for this endpoint and cannot be disabled."}
```

Not intermittent, every request. `reasoning_effort: "none"` is rejected the same
way, even though `GET /models` advertises `"none"` as a supported effort for this
model. What works is omitting `disable_thinking` and keeping
`strip_thinking_response: true`: reasoning still runs and is still billed
(~210 reasoning tokens per K=10 scoring call, ~375 per full-190 call), but it is
stripped from the response.

Pointing production at this model id today produces a 400 on every match, which
surfaces as a startup model-verification failure or a matching run that scores
nothing, not as a degraded match.

### 2. Output is fenced, and production does not parse leniently

`venice.ts` does `JSON.parse(content)` and throws `ProviderContractError` on
anything else. The benchmark harness has always used `parseJsonLoose()`, which
strips code fences first. That difference was invisible until now because no
benchmarked model needed it.

GLM 5.3 Flash wraps its response in a ` ```json ` fence **despite** a strict
`response_format: {type: "json_schema", strict: true}`:

| model | responses surviving bare `JSON.parse` |
|---|---|
| `deepseek-v4-flash-0731` | 40/40 scoring calls (100%) |
| `z-ai-glm-5-3-flash` | 3/82 scoring calls (~4%) |

So GLM 5.3 Flash benchmarks at **zero format failures** and would fail
essentially **100% of production calls**. This is exactly the class of defect the
harness previously could not see, so it is now a measured column: every call
records whether the raw body survived `JSON.parse`, and `bakeoff-report.mjs`
prints any model below 100% as BLOCKED regardless of its recall.

### 2b. The strict schema is not honoured at all on the harder shape

On the reverse (icebreaker) batch (the same call production makes, K=10, strict
`json_schema` with `additionalProperties: false` and a required root object
`{matches: [...]}`) GLM 5.3 Flash answers with **at least three different
top-level shapes**, and adds an `entry_name` property the schema forbids:

| shape returned | declared? |
|---|---|
| `{"matches": [...]}` | yes |
| `[ ... ]` (bare array, no wrapper) | no |
| `{"entries": [...]}` (wrapper renamed) | no |

`deepseek-v4-flash-0731` returns the declared object on every one of its 96 calls.

This one nearly poisoned the benchmark rather than merely failing it. The
icebreaker harness read `value.matches`, which on the two undeclared shapes is
`undefined`, so those calls contributed **zero graded openers**, and GLM would
have posted a near-perfect attribution rate on a sample it had quietly been
excused from. A result that looks like a result is worse than an error. Sampling
the raw response cache mid-run showed roughly **half** of GLM's calls were being
dropped this way.

`icebreaker-run.mjs` now takes the entries wherever the model put them (so
quality is measured on everything it wrote), and counts the deviation separately.
`bakeoff-report.mjs` lists it as a blocker: in production `validateProviderValue`
rejects these outright.

The measured toll: **65 of GLM's 96 icebreaker calls** (63 bare arrays, 2 renamed
wrappers) ignored the declared shape. Before the fix its graded sample was 799
openers against DeepSeek's 2,821; after, 2,621. Every number in the Results
section is post-fix.

### 3. Not a blocker, but a policy difference

`GET /models` reports `privacy: "anonymized"` for `z-ai-glm-5-3-flash` and
`privacy: "private"` for `deepseek-v4-flash-0731`. The current deployment sets
`models.match.require_private = false` (see `coordinator.example.toml`), so this
does not block adoption mechanically, but moving from a private-tier model to an
anonymized one is a deliberate downgrade of that property, not a side effect, and
should be decided rather than inherited.

---

## Results

`node bakeoff-report.mjs --md`, 2026-08-26, suite v1, both models measured the
same day against the same fixture with the runs overlapping in time.

| model | $/Mtok | r@1 sub | r@3 sub | r@1 190 | r@3 190 | sep | ord>W | posB | strictJSON | attr-err | brief | judge R | judge IB | p50 s | tok/s | $/100 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **z-ai-glm-5-3-flash** | $0.09375/$0.3125 | **0.80** | **0.95** | **0.80** | **0.90** | **0.64** | 0.98 | **0.03** | **3.7%** | 0.3% (8/2621) | 0% | **4.60** | **3.93** | **16.1** | **71.4** | **$0.249** |
| deepseek-v4-flash-0731 | $0.175/$0.35 | 0.75 | 0.90 | 0.65 | 0.85 | 0.55 | 0.98 | 0.11 | **100%** | 0.6% (17/2821) | 0% | 4.13 | 3.67 | 22.1 | 41.6 | $0.281 |

`sub` = eval subset, two seeds pooled. `190` = the full 190-pair ranking.
`sep` = mean strong-pair score minus mean weak-pair score. `posB` = corr(slot, score).
`judge R` / `judge IB` = blind 1–5 means over 15 sampled reasonings and 15 sampled
icebreakers per model. `$/100` = projected cost to score 100 attendees.
Bold marks the better value, **including the one column GLM loses catastrophically**.

### Scoring quality: GLM 5.3 Flash wins, and by more the harder the task gets

On the eval subset it is ahead but not dramatically so (r@1 0.80 vs 0.75, both
seeds, identically). On the full 190-pair ranking (20 candidates per target
instead of ~6) the gap opens: **r@1 0.80 vs 0.65**.

The mechanism is score discrimination, not luck. Mean weak-pair score is 0.25 for
GLM against 0.37 for DeepSeek, so strong–weak separation is 0.64 vs 0.55 on the
same fixture. That matters in production because matches are selected by rank:
a model that scores mediocre pairs 0.37 puts more noise inside every attendee's
`top_k`. GLM also shows almost no position bias (0.03 vs 0.11), which is worth
having at K=10 with shuffled candidate order.

Neither model dropped or merged a candidate, and neither had a *lenient-parse*
format failure in 82 and 82 scoring calls respectively.

### Prose: GLM is better on average, and worse in Slovak

Blind-graded, 60 items, model identity withheld until after grading (rubric and
per-item notes in `benchmarks/matching/judging/`):

| | reasoning | icebreakers | 1–2 scores | 5s |
|---|---|---|---|---|
| GLM 5.3 Flash | **4.60** | **3.93** | 3 | 16 |
| DeepSeek V4 Flash 0731 | 4.13 | 3.67 | 2 | 9 |

The means hide a real difference in *failure mode*, and it is the more useful
finding:

- **DeepSeek's failures are emptiness and invention.** Five of its fifteen
  icebreakers were flagged `generic`: correct, sendable, and containing nothing
  about the person they were sent to ("Hey Yusuf, I'm looking for a low-stakes
  side project... Got any suggestions for where to start?"). Three invented
  facts, the worst handing a sender someone else's entire persona.
- **GLM's failures are Slovak.** Three of its fifteen were flagged
  `awkward-lang`: `v súkromí scéne` (broken word order), `vypotím históriu siete`
  (wrong verb, "sweat out" rather than "recount"), a doubled `si si`, an
  untranslated `hallway`, and switching between `ty` and `vy` mid-message. The
  content underneath was correct every time. Its one severe failure was a full
  role inversion, a message addressed to its own sender.

For a project that runs Slovak-language events, that is not a tie. GLM writes
better English prose and shakier Slovak, and the Slovak defects are the kind a
native reader notices in the first line.

Both models handled the fixture's hardest ownership traps correctly more often
than not: including the case the whole attribution benchmark exists for, where
the recipient's profile advertises branding work on the *sender's* own artifact
(`"si robila branding k môjmu Quillfeather Press"`, his imprint, her branding,
correctly assigned).

### Attribution errors: pooled they tie, per language they do not

Attribution errors are the failure this arm exists for, the reader's own book,
app or project handed back to them as the other person's work. They are graded by
string match against each persona's invented artifact, not by a judge.

Pooled over both languages:

| model | attribution errors | rate | 95% CI | vs baseline |
|---|---|---|---|---|
| z-ai-glm-5-3-flash | 8 / 2621 | 0.30% | [0.13%, 0.60%] | p = 0.374 |
| deepseek-v4-flash-0731 | 17 / 2821 | 0.60% | [0.35%, 0.96%] |, |

A tie. But the pooled row is hiding the single significant result in this run,
because **the two models fail in opposite languages**:

| language | GLM 5.3 Flash | DeepSeek 0731 | permutation test |
|---|---|---|---|
| **sk** | **1 / 1369 = 0.10%** [0.00%, 0.41%] | 14 / 1391 = 1.00% [0.55%, 1.68%] | **p = 0.016** ✱ |
| en | 7 / 1252 = 0.60% [0.23%, 1.15%] | 3 / 1430 = 0.20% [0.04%, 0.61%] | p = 0.329 |

In Slovak GLM makes **an order of magnitude fewer** attribution errors, and that
survives a permutation test over calls. In English it makes somewhat more, and
that does not. Averaged together they cancel, which is exactly how a real
difference disappears into a summary statistic.

This matters here specifically: DeepSeek's Slovak attribution rate is 1.0%, and
the live incident this whole arm was built after happened at a **Slovak** event.
`bakeoff-report.mjs` now prints the per-language rows unconditionally rather than
as a drill-down, so the next model cannot hide the same way.

(The permutation test shuffles CLUSTERS, because openers inside one LLM call are
correlated: a batch that inverts roles tends to invert several entries at once.
Getting the cluster right is not cosmetic: reconstructing it from
(target, candidate, rep) split each reverse-shape call into ten clusters, which
discarded the correlation the test exists to respect and reported p = 0.0008 for
the Slovak row instead of 0.016. Every row now carries a `callId` stamped by the
run that produced it, so the cluster is recorded rather than inferred.)

Neither model produced a single third-party briefing in ~5,400 openers, the
"You're a cypherpunk and she studies X, ask her about Y" failure that shipped to
a live event in July. The R3 prompt is holding on both.

### Speed and cost

GLM is both **cheaper and faster**, which is not the usual trade:

- **$0.249 vs $0.281 per 100 attendees**: despite burning reasoning tokens
  DeepSeek does not (285/call scoring, up to 3,244/call on the Slovak icebreaker
  batch). Its lower per-token price more than covers them.
- **16.1s vs 22.1s** p50 per K=10 call, measured serially, and **71.4 vs 41.6
  output tokens/sec**.

Two caveats on the speed number. The icebreaker arm (a K=10 reverse batch
producing 30 openers) takes both models 60–95s per call, and there GLM's
reasoning tokens do cost real wall-clock. And GLM returned a run of HTTP 500
`Inference processing failed` under sustained load on that arm (9 retries; the
harness's backoff absorbed them), which DeepSeek never did. One afternoon is not
enough to call that a reliability difference, but it is worth watching on the
next model that ships.

---

## Verdict (final: the language leak is fixed in the prompt; no model change)

1. **The Slovak-English leak is fixed and shipped.** One sentence, repeating the
   output language inside the icebreaker block: **15/144 → 1/96 calls fully
   English, p = 0.0032**, attribution unchanged. See
   [the experiment](#fixing-it-placement-beats-wording-and-not-in-the-direction-you-would-guess).
   No model change, no privacy trade, English events untouched.
2. **Keep `deepseek-v4-flash-0731`.** The rollback to 0423 was the fallback if
   the prompt could not be fixed. It could. 0423 remains the better model on
   speed and cost and is still live if that ever matters, but there is no longer
   a defect forcing the choice.
3. **GLM 5.3 Flash wins on quality and is still not adoptable**: 68% of its
   icebreaker calls return a shape the schema forbids, and tolerating that in
   `venice.ts` costs more than the model is worth. Revisit if z.ai fixes it. It
   is one command.
4. **No Qwen, three of them now, and no Minimax.** `qwen-3-8-flash`
   (2026-09-10) is the closest any challenger has come mechanically and the
   furthest any has been on output language: 28 of 48 Slovak batches fully
   English against the deployed model's 0, on the identical live prompt.
5. **Arm D measures R3, which stopped being the deployed prompt on
   2026-08-26.** Repointing it costs a `SUITE_VERSION` bump and a re-run of
   every card; until then read `sk-in-lang` and `attr-err` as R3 numbers.
   See [Round 4](#round-4-qwen-38-flash-and-the-arm-that-was-measuring-last-months-prompt).

The original round-1 reasoning follows.

**Do not switch today.** Not because GLM 5.3 Flash is worse (on the thing this
benchmark actually measures it is clearly better, and cheaper, and faster), but
because `providers/venice.ts` cannot call it at all. Every request 400s on
`disable_thinking`, and if that were fixed, ~96% of the responses that came back
would fail `JSON.parse`.

**What adopting it would take**, in order of increasing appetite:

1. **Make `disable_thinking` per-model.** The coordinator sends it
   unconditionally. It needs to be a capability lookup. Venice's `GET /models`
   already advertises `reasoningEffortOptions`, though note that GLM 5.3 Flash
   advertises `"none"` and rejects it, so the catalogue cannot be trusted alone;
   detect on the 400 as `benchmarks/matching/model-profiles.mjs` does.
2. **Parse leniently in `venice.ts`.** Stripping a ` ```json ` fence before
   `JSON.parse` is a few lines and would have made this model usable. It is
   defensible on its own merits (the benchmark harness has parsed leniently
   since the beginning precisely because models do this), but it is a change to
   the provider contract and belongs in its own commit with its own tests.
3. **Tolerate an undeclared response shape, or don't.** Accepting
   `{entries: [...]}` and bare arrays where the schema said `{matches: [...]}` is
   where I would stop. A provider that quietly reshapes whatever comes back is a
   provider that cannot tell a model's mistake from a model's answer.

**If (1) and (2) land**, GLM 5.3 Flash is worth a real trial: better ranking,
better English prose, cheaper, faster, and (in Slovak) significantly fewer
attribution errors than what is deployed today (0.10% vs 1.00%, p = 0.016).

The honest tension for a Slovak-language event is that those two Slovak results
point opposite ways: GLM gets **who owns what** right far more often, and writes
**clumsier sentences** while doing it (`v súkromí scéne`, `vypotím`, ty/vy drift).
Handing someone else's project to the wrong person is the worse failure of the
two (it is the one that actually shipped and was noticed), but awkward phrasing
is the one every attendee sees. If GLM is trialled, the Slovak prose is what to
watch, and it may be promptable in a way an attribution bug is not.

One more non-quality fact to weigh: GLM is `privacy: anonymized` where the
deployed model is `private`.

**Meanwhile, `deepseek-v4-flash-0731` stays.** Nothing here is a reason to move
off it in a hurry; it is 100% schema-clean, and the 2026-07 verdict that picked
it still holds.

---

## Round 2 (same day): two Qwen models, Minimax, and a live production defect

`minimax-m3-preview` and `openai-gpt-oss-120b` are **out before the first arm**:
both answer `400 "response_format is not supported by this model"`, and
`GET /models` says so honestly (`supportsResponseSchema: false`). That is now a
pre-flight check. Two Qwen models passed the probe and got the full suite.

| model | $/Mtok | r@1 190 | sep | strictJSON | sk in-language | attr-err | judge R | judge IB | p50 s | $/100 |
|---|---|---|---|---|---|---|---|---|---|---|
| z-ai-glm-5-3-flash | $0.094/$0.313 | **0.80** | **0.64** | 3.7% | **96.7%** | 0.3% | **4.60** | **3.93** | 16.1 | **$0.249** |
| deepseek-v4-flash-0731 | $0.175/$0.35 | 0.65 | 0.55 | **100%** | 93.3% | 0.6% | 4.13 | 3.47 | 22.1 | $0.281 |
| qwen-3-8-27b | $0.45/$3.20 | 0.65 | 0.52 | **100%** | 62.5% | **0.1%** | 4.00 | 3.20 | 11.3 | $1.734 |
| qwen3-6-35b-a3b | $0.10/$1.00 | 0.60 | 0.57 | **100%** | 31.2% | 5.4% | 3.73 | 2.87 | **4.4** | $0.475 |

Neither Qwen is adoptable. `qwen3-6-35b-a3b` is the most instructive failure in
the whole exercise: it is the fastest thing tested by a factor of three (4.4 s,
205 output tok/s), perfectly behaved on format (100% strict JSON, declared shape
every time), and it **hands people each other's work 5.4% of the time** (nine
times the deployed model's rate), while producing the only non-zero briefing rate
anything has recorded here. Every cheap metric said yes; the one arm that costs
real calls to run said no.

### The output-language metric, and what it found

Blind judging kept turning up Slovak-event openers written in **English**, or in
**Czech**. A 15-item sample cannot tell 20% from 47%, so this became a measured
column: `language-adherence.mjs` classifies every saved opener by exclusive
markers: letters and function words that exist in one language and not the other
(`ř/ě/ů` and `jsem/který/tvůj` for Czech; `ľ/ĺ/ŕ/ô/ä` and `som/ktorý/tvoj` for
Slovak), and anything with no marker either way is reported as `undecided`
rather than folded into the pass rate. It is pinned against messages a human
already graded.

Like-for-like (R3 prompt, `reverse-dense` bucket, Slovak):

| model | in Slovak | wrote English | wrote Czech |
|---|---|---|---|
| `deepseek-v4-flash` (the **previous** id) | **99.4%** (n=3372) | 0.0% | 0.4% |
| `z-ai-glm-5-3-flash` | 96.7% | 0.0% | 1.7% |
| **`deepseek-v4-flash-0731` (DEPLOYED)** | **93.3%** | **6.5%** | 0.0% |
| `qwen-3-8-27b` | 62.5% | 29.6% | 7.4% |
| `qwen3-6-35b-a3b` | **31.2%** | 9.4% | **58.9%** |

Two things fall out.

**`qwen3-6-35b-a3b` answers a Slovak event in Czech 59% of the time.** For a
Slovak audience that is not a subtle quality gradation; it is the wrong language,
visible in the first word, on the majority of messages.

**And the currently deployed model has a regression nobody measured.**
`deepseek-v4-flash-0731` writes English in **90 of 1391** Slovak openers, where
the id it replaced wrote English in **0 of 3372** on the same prompt, bucket and
fixture.

Those opener counts are the wrong unit for a test, and the first version of this
section used them anyway, reporting p = 9.5 × 10⁻⁵⁰. That number was inflated by
about forty-eight orders of magnitude, and the reason is written on the tin of
`stats.mjs`: **openers inside one call are not independent.** They are especially
not independent here, because the failure turns out to be *entirely whole-call*:

| | calls | all 30 openers English | some but not all |
|---|---|---|---|
| `deepseek-v4-flash` (previous) | 176 | **0** | 0 |
| `deepseek-v4-flash-0731` (deployed) | 48 | **3 (6.3%)** | **0** |

Three responses out of forty-eight came back with every single opener in English,
and forty-five with none. Nothing in between. At the call level (the unit the
correlation permits) that is **3/48 vs 0/176, Fisher exact p = 0.0094**, with a
95% interval on the deployed rate of **[1.3%, 17.2%]**. Real, and much less
precisely located than the opener count pretended.

The whole-call shape matters for more than the arithmetic. This is not a model
drifting out of Slovak word by word; it is a model ignoring the OUTPUT LANGUAGE
block outright on a whole response, which is a far more promptable defect, and,
for the reader, a worse one: when it fires, every icebreaker that person receives
in that batch is unusable, not one in fifteen. Samples:

> Yusuf: I founded Ironwood Assembly and I'm thrilled you did its branding. I'm scouting early freedom-tech teams to back; what's the most promising one you've seen?

> Hi Yusuf: I run Petrichor Fund and I'm curious how you'd grow a grant programme's reach. What's the ethical way to get the word out?

The 2026-08-04 deprecation swap was re-benchmarked before it shipped, and the
comparison was fair on every axis that existed at the time, recall, separation,
position bias, format failures. Output language was not one of them, because
nothing had ever needed it. It is a column now, and `bakeoff-report.mjs` flags
any model below 95% as a blocker.

**This is a live defect, not a benchmark curiosity**, though state it carefully:
about **6% of reverse batches** come back entirely in English, so the people
affected get *all* of their openers in the wrong language rather than an
occasional one. The confidence interval is wide (1.3–17.2%): 48 calls is a small
denominator, and the honest next step is more repeats, not a bigger claim.

It is also plausibly promptable. `languageInstruction(lang)` already names
icebreakers explicitly ("write every reasoning string **and every icebreaker**"),
so this is a model disobeying an instruction rather than a gap in one, but a
whole-response failure usually responds to placement and salience, and the
previous model id hitting 0/176 on the identical prompt proves the target is
reachable on this fixture. Testable against this arm for about $0.20 without
touching production.

---

## Round 3: the id we rolled off is still there, and it is better

`deepseek-v4-flash` (0423) was replaced on 2026-08-04 because `GET /models`
carried `deprecation: {date: 2026-08-14, autoRemap: false}`. As of 2026-08-26 it
is **still in the catalogue, carries no deprecation field, and answers 200**.
So it went through the same suite:

| | `deepseek-v4-flash` (0423) | `deepseek-v4-flash-0731` (deployed) |
|---|---|---|
| r@1 subset (2 seeds) | **0.80** | 0.75 |
| r@1 / r@3 full-190 | **0.75 / 0.90** | 0.65 / 0.85 |
| strong–weak separation | 0.56 | 0.55 |
| position bias | **0.01** | 0.11 |
| strict `JSON.parse` | 100% | 100% |
| **Slovak in-language** | **99.6%** | 93.3% |
| attribution errors (sk) | 1.6% | **1.0%** (n.s., p=0.47) |
| p50 latency / output tok/s | **10.5 s / 88.6** | 22.1 s / 41.6 |
| $/100 attendees | **$0.224** | $0.281 |
| Venice privacy tier | anonymized | **private** |

Read carefully, because two of these rows are noise and the rest are not. The
recall difference is 15 vs 13 hits out of 20 on a single seed. Do not spend it.
Separation is a tie. Attribution genuinely favours 0731 and does not survive a
test either.

What is real: **output language**, 0/176 calls fully English versus 3/48, Fisher
exact p = 0.0094 at the call level (see the correction above; the opener-level
p-value this document first reported was not a valid test), plus **2× the
throughput** and **20% cheaper**. The August swap bought a statistically
invisible attribution improvement and a private-tier badge, and paid for it with
a language regression nobody was measuring and half the speed.

---

## Fixing it: placement beats wording, and not in the direction you would guess

The trailing OUTPUT LANGUAGE block was never missing the point. It already says
"write every reasoning string **and every icebreaker**" in the target language,
and the previous model id obeyed it 176 times out of 176 on the identical prompt.
So the target was known to be reachable and the question was placement.

Four arms, 48 Slovak calls each, run together against a control byte-identical to
the live prompt (verified by hash against `dist`):

| arm | change | calls fully English |
|---|---|---|
| **L0** | control, the live prompt | 9/48 (18.8%) |
| **L1** | requirement hoisted to the TOP, as a pass/fail condition | 16/48 (33.3%) |
| **L2** | requirement repeated **inside the icebreaker block** | **1/48 (2.1%)** |
| **L3** | both | 14/48 (29.2%) |

Hoisting it to the top made it **worse**, and did so twice independently.
Repeating it next to the field it governs fixed it. Whatever the mechanism, the
intuitive move was the wrong one, which is a good argument for measuring prompt
changes rather than reasoning about them.

**The control also disagreed with itself.** L0 scored 9/48 here and the same
bytes scored 3/48 in the earlier run, a 3× swing hours apart. That is why this
went to a confirmation round rather than straight to production: at 96 calls per
arm the control settles at 12/96 and L2 at 1/96, **Fisher exact p = 0.0025**.
Pooling every draw of the live prompt ever taken: **15/144 (10.4%) vs 1/96
(1.0%), p = 0.0032**.

Attribution errors are unchanged across all four arms (0.4–0.7%, 99.4% clean),
which is the thing that had to not regress: a language fix that traded away
attribution accuracy would not be a fix.

Shipped as `reverseSystemPrompt(lang)` in `packages/coordinator/src/matching/
scoring.ts`. English events get byte-identical output to before. The function
throws rather than silently returning the un-reminded prompt if its anchor ever
moves, because a reworded block quietly reverting a measured fix is precisely how
the regression it repairs got in.

---

## Round 4: Qwen 3.8 Flash, and the arm that was measuring last month's prompt

Venice shipped `qwen-3-8-flash` (Qwen 3.8 Flash, $0.14/$0.49 per Mtok, 1M
context, `privacy: anonymized`), the model the "Adding the next model" section
below was written in anticipation of. It went through the same five arms on
2026-09-10, plus two arms that did not exist before, for a reason this round
discovered rather than planned.

**Verdict: no.** It is the first challenger with no mechanical blocker at all,
and on a Slovak event it writes English in two thirds of its openers.

### What it does well, which is not nothing

| | `qwen-3-8-flash` | `deepseek-v4-flash-0731` (deployed) |
|---|---|---|
| r@1 / r@3, eval subset (2 seeds) | 0.75 / 0.90 | 0.75 / 0.90 |
| r@1 / r@3, full-190 | **0.75 / 0.90** | 0.65 / 0.85 |
| strong–weak separation | **0.58** | 0.55 |
| position bias (full-190) | **0.04** | 0.11 |
| strict `JSON.parse` | **100%** (82/82) | 100% |
| declared response shape | **96/96 calls** | 96/96 |
| `disable_thinking` | **accepted** (0 reasoning tokens) | accepted |
| p50 latency / output tok/s | **12.3 s / 65.8** | 22.1 s / 41.6 |
| $/100 attendees | $0.306 | **$0.281** |

On the harder full-190 ranking it beats the deployed model by two gold pairs,
with a third of the position bias, at twice the throughput. Everything
`venice.ts` needs, it does: no 400 on `disable_thinking`, no code fence, no
renamed wrapper, no undeclared shape. GLM 5.3 Flash's two hard blockers are
simply absent here. If the only arms that existed were the ones this benchmark
had in July, this would read as an upgrade.

### The language failure, measured against the prompt production actually sends

The first pass put it at **22.1% in-language** on Slovak: 811 of 1052 openers
in English, and whole-call rather than mid-message, **31 of 48 calls came back
entirely in English**, 7 mixed, 10 clean.

That number came from arm D, which runs the **R3** variant, and R3 has been the
*pre-fix* prompt since 2026-08-26 (see the section below). So it was re-run
against **R6**, what `reverseSystemPrompt()` returns today, alongside a matched
same-day control on the deployed model. All four cells, same fixture, same
afternoon, runs overlapping in time:

| model | prompt | Slovak in-language | calls fully English |
|---|---|---|---|
| `deepseek-v4-flash-0731` | **R6 (live)** | **97.7%** | **0 / 48** |
| `deepseek-v4-flash-0731` | R3 (pre-fix) | 70.7% | 11 / 48 |
| `qwen-3-8-flash` | **R6 (live)** | 34.5% | **28 / 48** |
| `qwen-3-8-flash` | R3 (pre-fix) | 22.1% | 31 / 48 |

**The shipped fix does nothing for this model**: 31/48 → 28/48, Fisher exact
p = 0.68. Against the deployed model on the identical prompt it is 28/48 versus
0/48, **p = 2.6 × 10⁻¹¹**. The same reminder that takes DeepSeek to zero leaves
Qwen writing English on more than half of its batches. Whatever the sentence
does, this model does not read it.

Attribution is the second disqualifier and R6 does not help there either: 3.0%
(32/1073) on the live prompt, 2.5% on R3, against the deployed model's 0.4%
today. It is also the first model since `qwen3-6-35b-a3b` to produce third-party
briefings at all.

Blind judging (same judge, same rubric, same content-addressed pack as every
earlier round) puts it **last of six on reasoning** at 3.40, with **14 of 20
items flagged `generic`**. The prose is accurate and gives an attendee nothing to
do with it: "Yusuf helps scale open-source privacy tools, which could amplify
your workshop curriculum" is a true sentence and not an introduction.

### The thing this round actually found: arm D has been benchmarking a superseded prompt

`bakeoff.mjs` freezes `SUITE.icebreakerVariant = "R3"`. On 2026-08-26 the
output-language reminder shipped, the deployed prompt became **R6**, and
`reverse-variants.mjs` was updated to say so in as many words: *"R3 … is now the
PRE-FIX control … The current deployed prompt is R6."* Nothing propagated that to
the suite. Every model benchmarked since has had its language and attribution
measured on a prompt production stopped sending three weeks ago.

The card's fingerprint should have caught it and instead disguised it: it hashed
`reverseSystemPrompt()` (R6, live) while the arm sent R3. So cards written after
the fix carried an R6 hash over an R3 measurement, and when the drift check was
repaired it promptly announced that six cards "were NOT measured under the same
prompt", about six arms that had all sent byte-identical R3
(`63e056b48b6c6e8c` on every one of them). A drift detector that invents drift is
worth no more than one that misses it; this one managed both within an hour.

Three fixes landed:

- the icebreaker cache key now includes the SHA of the system prompt, not just
  the variant label, because a label here names whatever `scoring.ts` said on
  the day;
- the fingerprint records **both** the measured variant (`icebreaker.system.R3.sk`)
  and the live prompt (`icebreaker.system.LIVE.sk`), so a card shows on its face
  whether it measured what ships;
- `bakeoff.mjs` says loudly, at the end of every run, when the two differ.

**Still open, and a deliberate decision rather than a bug fix:** pointing
`SUITE.icebreakerVariant` at R6 means bumping `SUITE_VERSION` and re-running arm
D for all six existing cards (~$0.55, about an hour), because the report refuses
to mix suite versions. Until that happens the `sk-in-lang` and `attr-err` columns
of the cross-model table describe R3.

### And the R3 control is far noisier than one draw suggests

Re-running the deployed model's R3 Slovak arm today, against bytes that have not
changed since August, produced **11/48** fully-English calls where the
2026-08-26 card recorded **3/48**. Pooling every R3-equivalent control draw ever
taken (3/48, 8/48, 9/48, 11/48), the control sits nearer 80–85% in-language than
the card's 93.3%, which was a lucky draw that has been quoted in three subsequent
rounds.

This does not weaken the round-3 verdict; it strengthens it. Every control draw
sits far above every R6 draw (0/48 today, 1/48 and 1/96 in August), and today's
matched pair re-establishes the fix independently: **11/48 → 0/48, p = 0.0005**.
What it does mean is that a single 48-call draw of this metric cannot separate
80% from 93%, and no future round should quote one as if it could.

*Round 4 cost: $0.48 of Venice API: $0.22 for the five frozen arms, $0.26 for
the three R3/R6 arms this round added.*

---

## Adding the next model

```sh
cd benchmarks/matching
export VENICE_API_KEY=...
pnpm --filter @nostrautica/coordinator build   # arm D imports the LIVE prompt from dist
node refresh-models.mjs qwen                   # find the id; prices + capabilities snapshot
node bakeoff.mjs <venice-model-id>             # all five arms, cached, ~25 min
node bakeoff-report.mjs                        # the cross-model table
node judge-pack.mjs                            # blind pack: only the NEW items are ungraded
#   ...grade judging/pack.md into judging/grades.json...
node judge-report.mjs && node bakeoff-report.mjs
```

Nothing in `bakeoff.mjs` names a model. Request quirks are discovered on the
model's own error responses and persisted to `model-profiles.json`; prices come
from the `GET /models` snapshot, so a model nobody has priced by hand no longer
costs `$0.0000` (which reads as free, not as unknown); prompt bytes are hashed
into every card so a stale `dist/` cannot silently benchmark last release's
icebreaker prompt.

### Why the subjective grades survive

Recall@k says the right person is ranked first. It says nothing about whether the
sentence shown to that attendee is one a human would send, and that is the half
that decides whether the product feels good. The 2026-07 round judged prose by
hand, once, on a pack built by a one-off script, and those grades died with the
run, so this round could not reuse them.

`judge-pack.mjs` fixes that by making an item's id the **SHA-256 of its text**:

- grading is append-only. Regenerating the pack with a third model in it leaves
  every existing grade attached to the exact text it was given for, and only
  genuinely new items show up as ungraded. Adding the fourth model is cheap.
- a full re-grade over the whole dataset (a better judge, a changed rubric) is
  `node judge-pack.mjs --regrade-all`. That is the only way to compare prose
  across models fairly, because it puts every model in front of the same judge on
  the same day. **The grades in this document were produced by a small model and
  should be re-run this way when a stronger judge is available**; the items are
  on disk and re-grading costs no API spend.
- the pack carries no model attribution and is shuffled with a fixed seed;
  `key.json` holds the mapping and is joined only afterwards, by
  `judge-report.mjs`.

Samples are stratified (reasoning by hidden gold label, icebreakers by language) because a judge shown twenty gold-strong pairs grades every model 5/5. The
text that separates models is what they write about two people with little to say
to each other.

