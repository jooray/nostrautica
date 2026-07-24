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
    target,
    candidates: Array.from({ length: k }, (_, j) => SIGNED_PERSONAS[(i + 1 + j * 3) % n]).filter(
      (c) => c.id !== target.id,
    ),
  }));
}
