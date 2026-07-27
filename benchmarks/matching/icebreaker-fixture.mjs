/**
 * Fixture for the icebreaker-attribution benchmark.
 *
 * The scoring benchmark's PERSONAS deliberately carry no uniquely-owned proper
 * nouns, which is fine for judging match quality but useless for catching the
 * bug we actually shipped: the model handing ONE person's work to the OTHER
 * ("Can your book Tamers of Entropy get a new brand?" sent to someone who did
 * not write it). To detect that automatically you need an artifact that provably
 * belongs to exactly one side, so a possessive attached to it is either right or
 * wrong with no judgement call.
 *
 * So each persona gets a SIGNATURE: an invented, unmistakable artifact name
 * injected into the ai_profile text the model sees. Names are deliberately odd
 * so a substring match cannot collide with ordinary prose or another persona.
 *
 * Derived, not edited in place: PERSONAS stays byte-identical so the existing
 * scoring results (recall@k, separation, the blind reasoning judgments) remain
 * comparable. Nothing here feeds the scoring benchmark.
 */
import { PERSONAS } from "./personas.mjs";

/** One unique artifact per persona: [entity, kind, verb phrase for the summary]. */
const SIGNATURES = [
  ["Handbasket Rails", "payments app", "builds"],
  ["Ferrous Tideline", "open-source crate", "maintains"],
  ["The Vellum Cipher", "novel", "wrote"],
  ["Pelagic Standard", "design system", "designed"],
  ["Nightjar Ledger", "audit toolkit", "built"],
  ["Copperwake", "hardware wallet", "designed"],
  ["Salt & Signal", "podcast", "hosts"],
  ["Kestrel Mesh", "mesh-network stack", "maintains"],
  ["The Ostrich Protocol", "research paper", "authored"],
  ["Marrowlight", "album", "recorded"],
  ["Quillfeather Press", "zine imprint", "runs"],
  ["Tessellate Bay", "co-op space", "founded"],
  ["Ashgrove Method", "training curriculum", "wrote"],
  ["Sundial Custody", "key-management library", "built"],
  ["Brambleway", "documentary", "directed"],
  ["The Halcyon Index", "dataset", "compiled"],
  ["Ironwood Assembly", "conference series", "founded"],
  ["Petrichor Fund", "grant programme", "runs"],
  ["Longshore Atlas", "mapping project", "leads"],
  ["Vantablack Kitchen", "supper club", "runs"],
];

/**
 * PERSONAS with a signature artifact woven into the ai_profile the prompt
 * renders. Injected into BOTH `summary` and `offers` so the model has an
 * ordinary, non-gimmicky reason to reach for it in an opener.
 */
export const SIGNED_PERSONAS = PERSONAS.map((p, i) => {
  const [entity, kind, verb] = SIGNATURES[i % SIGNATURES.length];
  const first = p.name.split(" ")[0];
  return {
    ...p,
    signature: { entity, kind, verb },
    firstName: first,
    ai_profile: {
      ...p.ai_profile,
      summary: `${p.ai_profile.summary} ${first} ${verb} ${entity}, a ${kind}.`,
      offers: [...p.ai_profile.offers, `${entity} (their own ${kind})`],
    },
  };
});

/**
 * Fixed (target, candidates) pairings — seeded and stable so two prompt variants
 * are graded on exactly the same inputs. Every persona is a target once, with K
 * candidates drawn from the rest by a fixed stride (no RNG, so no seed to drift).
 */
export function buildCases(k = 4) {
  const n = SIGNED_PERSONAS.length;
  return SIGNED_PERSONAS.map((target, i) => ({
    bucket: "base",
    target,
    candidates: Array.from({ length: k }, (_, j) => SIGNED_PERSONAS[(i + 1 + j * 3) % n]).filter(
      (c) => c.id !== target.id,
    ),
  }));
}

// ── shared artifact (prod 2026-07-25) ─────────────────────────────────────────
// The case above gives each artifact exactly one owner, which is why the fix
// benchmarked at 0% and then failed in production anyway. What actually broke was
// an artifact that appears in BOTH profiles: the candidate's own bio led with
// "hot project 🔥: <the reader's book>" because he had done its artwork. From the
// profile text alone "whose is it?" is genuinely ambiguous, so a possessive rule
// cannot settle it — and the model resolved it the wrong way three times out of
// three, handing the reader their own app, novel and courses as the candidate's
// and describing the reader as the candidate's profession.
//
// The clone below reproduces that shape exactly: it keeps its OWN signature
// artifact (so FALSE_CLAIM is still measurable) and additionally advertises the
// target's artifact as a project it worked on, with the same creative-producer
// skills that were stolen in production. It deliberately does NOT say the
// artifact belongs to someone else — the real bio didn't either.

/** A candidate whose profile advertises the TARGET's artifact as their project. */
function shareTargetArtifact(candidate, target) {
  const { entity } = target.signature;
  const first = candidate.firstName;
  return {
    ...candidate,
    id: `${candidate.id}-shares-${target.id}`,
    /** Marks rows for separate reporting; the grader ignores it. */
    sharesTargetArtifact: true,
    ai_profile: {
      ...candidate.ai_profile,
      summary: `${candidate.ai_profile.summary} ${first} is a creative producer too — hot project 🔥: ${entity}, ${first} did its artwork and launch branding.`,
      skills: [...candidate.ai_profile.skills, "branding", "storytelling", "visual identity"],
      interests: [...candidate.ai_profile.interests, entity],
      offers: [...candidate.ai_profile.offers, `branding and storytelling (worked on ${entity})`],
    },
  };
}

/**
 * The THIN sharer — closer to the profile that actually broke. The real candidate
 * had no project of his own in his bio at all: it was two words of profession and
 * a link to the READER's book, so the only concrete noun the model could reach for
 * belonged to the other person. The clone above keeps its own artifact and a full
 * skill list, which gives the model plenty of its own material and may be why it
 * never inverted anything here.
 *
 * FALSE_CLAIM is not measurable against this persona by design: its signature
 * artifact is deliberately absent from the profile text, exactly as in production.
 */
function shareTargetArtifactThin(candidate, target) {
  const { entity } = target.signature;
  const first = candidate.firstName;
  return {
    ...candidate,
    id: `${candidate.id}-thin-${target.id}`,
    sharesTargetArtifact: true,
    ai_profile: {
      summary: `${first} is a creative producer — branding and storytelling. Hot project 🔥: ${entity}.`,
      skills: ["branding", "storytelling", "visual identity", "campaign production"],
      interests: [entity, "visual culture", "independent publishing"],
      offers: [`branding and storytelling for projects like ${entity}`, "a visual identity"],
      seeks: ["projects that need a visual identity"],
    },
  };
}

/**
 * Shared-artifact cases, both shapes. Targets are chosen so the "artwork and
 * branding" framing is plausible for what they made (a novel, an album, a
 * documentary, a payments app), and each case still carries k−1 ordinary
 * candidates so the batch shape matches the base cases and the model is not handed
 * a one-candidate hint.
 */
// Eight targets, not four: the attribution error rate on the trap is ~1-2% of
// icebreakers, so four cases (~90 graded openers per variant) cannot separate a
// fix from noise. Eight is still cheap and doubles the graded surface.
const SHARED_TARGET_IDS = ["p01", "p03", "p05", "p07", "p10", "p12", "p15", "p17"];

export function buildSharedArtifactCases(k = 4) {
  const n = SIGNED_PERSONAS.length;
  return SHARED_TARGET_IDS.flatMap((id) => {
    const i = SIGNED_PERSONAS.findIndex((p) => p.id === id);
    const target = SIGNED_PERSONAS[i];
    const others = Array.from({ length: k }, (_, j) => SIGNED_PERSONAS[(i + 1 + j * 3) % n]).filter(
      (c) => c.id !== target.id,
    );
    // The sharer takes the first slot in the list; batches are not shuffled here
    // (the runner sends them in order), so position stays comparable across runs.
    return [
      {
        bucket: "shared-artifact",
        target,
        candidates: [shareTargetArtifact(others[0], target), ...others.slice(1)],
      },
      {
        bucket: "shared-thin",
        target,
        candidates: [shareTargetArtifactThin(others[0], target), ...others.slice(1)],
      },
    ];
  });
}

// ── prod replica (2026-07-25) ─────────────────────────────────────────────────
// Everything above is an English profile with the output language switched. The
// failure happened at a Slovak event, where the PROFILES were Slovak too — so the
// model had to track ownership through a language that inflects both the
// possessive and the artifact name, with no English anywhere to anchor on. This
// pair reproduces that: a reader who made an app, a novel and a course site, and a
// creative producer whose entire bio is his profession plus the reader's app.
// Names are invented (the real reader's are not this harness's business), the
// shape is not.
const REPLICA_TARGET = {
  id: "r01",
  name: "Marek Hraško",
  firstName: "Marek",
  signature: { entity: "Vetroplach", kind: "aplikácia", verb: "vytvoril" },
  ai_profile: {
    summary:
      "Marek je vývojár a autor. Vytvoril aplikáciu Vetroplach na spoznávanie ľudí na podujatiach, napísal román Tichý rez a vedie kurzy kryptografie na prelomsa.io.",
    skills: ["programovanie", "kryptografia", "písanie", "vzdelávanie"],
    interests: ["nostr", "súkromie", "sci-fi", "komunity"],
    offers: ["Vetroplach (vlastná aplikácia)", "román Tichý rez", "kurzy na prelomsa.io"],
    seeks: [
      "organizátorov, ktorí chcú Vetroplach vyskúšať na svojom podujatí",
      "pomoc s vizuálnou stránkou projektov",
    ],
  },
};
const REPLICA_SHARER = {
  id: "r02",
  name: "Pavol Nemec",
  firstName: "Pavol",
  sharesTargetArtifact: true,
  // Absent from the profile on purpose — see shareTargetArtifactThin.
  signature: { entity: "Modrá hodina", kind: "fotoséria", verb: "nafotil" },
  ai_profile: {
    summary: "Pavol je kreatívny producent — branding a storytelling. Horúci projekt 🔥: Vetroplach.",
    skills: ["branding", "storytelling", "vizuálna identita", "produkcia kampaní"],
    interests: ["Vetroplach", "vizuálna kultúra", "nezávislé vydavateľstvá"],
    offers: ["branding a storytelling pre projekty ako Vetroplach", "vizuálnu identitu"],
    seeks: ["projekty, ktorým dá vizuálnu identitu"],
  },
};

/**
 * Two cases: the sharer first and the sharer last, so a clean result cannot be an
 * artefact of where in the batch the trap sits. The filler candidates stay English
 * — mixed-language batches are normal at a Slovak event and production says so in
 * the prompt.
 */
export function buildProdReplicaCases(k = 4) {
  const filler = [1, 4, 7].map((i) => SIGNED_PERSONAS[i]).slice(0, Math.max(0, k - 1));
  return [
    { bucket: "prod-replica", target: REPLICA_TARGET, candidates: [REPLICA_SHARER, ...filler] },
    { bucket: "prod-replica", target: REPLICA_TARGET, candidates: [...filler, REPLICA_SHARER] },
  ];
}

// ── reverse shape (spec §16.2) ────────────────────────────────────────────────
// Everything above tests scoreBatch. Production ALSO scores through
// scoreReverseBatch — one shared person against K targets — whenever a single
// attendee changes, which is exactly what happens to the LAST person to submit a
// profile. That is the shape the 2026-07-25 failure most likely came through, and
// it had never been benchmarked: it prints the RECIPIENT of every icebreaker
// first, under its own heading, and buries each SENDER in a numbered list. If a
// model anchors on "the person at the top is the one speaking", this shape
// inverts every icebreaker in the batch, which is precisely what production
// showed — three icebreakers for ONE candidate, all inverted, while other
// candidates (scored in forward batches) were correct.
//
// Transposed from the same trap cases so the two shapes are compared on identical
// people: the artifact-sharing candidate becomes the shared person, the artifact's
// real owner becomes a target.
export function buildReverseCases(k = 4) {
  const forward = [...buildSharedArtifactCases(k), ...buildProdReplicaCases(k)];
  const seen = new Set();
  const out = [];
  for (const c of forward) {
    const sharer = c.candidates.find((x) => x.sharesTargetArtifact);
    if (!sharer) continue;
    const key = `${sharer.id}|${c.target.id}`;
    if (seen.has(key)) continue; // prod-replica appears twice (sharer first/last)
    seen.add(key);
    const others = c.candidates.filter((x) => x !== sharer);
    // Alternate whether the artifact's real owner is listed first or last, so a
    // clean result cannot be an artefact of position (the shared person is always
    // printed above the list, which is the bias this shape is suspected of).
    const owner = c.target;
    const targets = out.length % 2 === 0 ? [owner, ...others] : [...others, owner];
    out.push({ bucket: `reverse-${c.bucket}`, shared: sharer, targets: targets.slice(0, k) });
  }
  return out;
}

// ── dense reverse trap (2026-07-27) ───────────────────────────────────────────
// Why this bucket exists: buildReverseCases puts ONE trap in a batch of k. The
// shared person advertises a single target's artifact, so with production's k=10
// only a tenth of the graded openers can trip the hard checks at all — the other
// nine entries are ordinary pairs whose openers are counted in the denominator and
// can never be counted in the numerator. Every rate this benchmark has ever
// reported for the reverse shape is therefore diluted ~10x, which is exactly why
// 8 errors vs 2 across ~2,300 openers is statistically unreadable: the comparison
// is really 8 vs 2 out of ~230, hidden inside a denominator ten times too big.
//
// Here the shared person advertises EVERY target's artifact, so every entry in the
// batch is the ambiguous case and the denominator stops lying. This is a STRESS
// bucket, not a prevalence estimate: the rate it reports is the rate *given* the
// trap, and must never be quoted as "the production error rate". It is realistic
// in kind — the profile that actually broke was a creative producer whose entire
// bio was the projects he had done branding for — and exaggerated in degree.
function shareAllArtifacts(person, targets) {
  const entities = targets.map((t) => t.signature.entity);
  const first = person.firstName;
  const list = entities.join(", ");
  return {
    ...person,
    id: `${person.id}-shares-all`,
    sharesTargetArtifact: true,
    ai_profile: {
      ...person.ai_profile,
      // The person KEEPS their own signature artifact (it is still in summary and
      // offers from SIGNED_PERSONAS), so FALSE_CLAIM — a sender claiming the
      // recipient's work as "my" — stays measurable alongside THEFT.
      summary:
        `${person.ai_profile.summary} ${first} is a creative producer too — hot projects 🔥: ${list}. ` +
        `${first} did the artwork and launch branding for each of them.`,
      skills: [...person.ai_profile.skills, "branding", "storytelling", "visual identity"],
      interests: [...person.ai_profile.interests, ...entities],
      offers: [...person.ai_profile.offers, `branding and storytelling (worked on ${list})`],
    },
  };
}

// Eight different shared people rather than one repeated: a clean result on a
// single profile is a fact about that profile.
const DENSE_SHARED_IDS = ["p02", "p04", "p06", "p08", "p11", "p13", "p16", "p18"];

/**
 * Reverse-shape cases where every target's artifact is advertised by the shared
 * person. Same shape as buildReverseCases (one `shared`, k `targets`), so the
 * runner and the grader need no special case — only the bucket name differs.
 */
export function buildReverseDenseCases(k = 10) {
  const n = SIGNED_PERSONAS.length;
  return DENSE_SHARED_IDS.map((id) => {
    const i = SIGNED_PERSONAS.findIndex((p) => p.id === id);
    if (i === -1) throw new Error(`dense fixture: unknown persona ${id}`);
    const person = SIGNED_PERSONAS[i];
    // Consecutive stride, so the k targets differ per case and no case can be
    // explained by one unlucky pairing. The shared person is never among them.
    const targets = Array.from({ length: k }, (_, j) => SIGNED_PERSONAS[(i + 1 + j) % n]).filter(
      (t) => t.id !== person.id,
    );
    return { bucket: "reverse-dense", shared: shareAllArtifacts(person, targets), targets };
  });
}

/**
 * Every persona the grader may be asked about, including the shared-artifact
 * clones — icebreaker-regrade.mjs resolves saved rows by id through this.
 */
export const PERSONA_BY_ID = new Map([
  ...SIGNED_PERSONAS.map((p) => [p.id, p]),
  ...buildSharedArtifactCases(4).flatMap((c) => c.candidates.map((p) => [p.id, p])),
  // Only `signature` and `firstName` are read when grading, and neither depends on
  // k, so registering the k=10 clones resolves a saved row from any k.
  ...buildReverseDenseCases(10).map((c) => [c.shared.id, c.shared]),
  [REPLICA_TARGET.id, REPLICA_TARGET],
  [REPLICA_SHARER.id, REPLICA_SHARER],
]);
