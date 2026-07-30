/**
 * Publish-boundary output hygiene (audit COORD-12). LLM-authored text (match
 * `reasoning`, `ai_profile` fields) is attacker-influenceable via prompt
 * injection through attendee-controlled inputs, and is published verbatim to
 * relays where clients render it. Defensively, at the publish boundary only:
 *
 *  - cap string length, truncating on a word boundary (no mid-word cut);
 *  - neutralize URLs by stripping the `https?://` scheme prefix, so injected
 *    text stays readable but nothing is auto-linkified/clickable.
 *
 * Also the directory-entry size guard (audit COORD-18): NIP-44 caps plaintext
 * at 65,535 bytes, so user-authored fields are bounded here as defense in
 * depth (the protocol package's schema caps are the primary control).
 */
import { MAX_SKILLS, MAX_SKILL, type AiProfile } from "@nostrautica/protocol";

/** Max chars for a single LLM-authored string (reasoning, ai_profile fields). */
export const MAX_LLM_TEXT_CHARS = 2000;

/** Caps for user-authored directory fields (COORD-18 65,535-byte guard). */
export const MAX_NAME_CHARS = 200;
export const MAX_PROFILE_FIELD_CHARS = 4000;
export const MAX_LIST_ITEMS = 64;

/** Truncate on a word boundary so the result (with ellipsis marker) fits `max`. */
export function truncateWords(text: string, max = MAX_LLM_TEXT_CHARS): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1); // room for the ellipsis — never exceed max
  const lastSpace = cut.search(/\s+\S*$/);
  return (lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
}

/** Strip the `https?://` scheme so a URL remains as readable text, unclickable. */
export function neutralizeUrls(text: string): string {
  return text.replace(/https?:\/\//gi, "");
}

/** Hygiene for a single LLM-authored string: URL-neutralize + word-boundary cap. */
export function sanitizeLlmText(text: string, max = MAX_LLM_TEXT_CHARS): string {
  return truncateWords(neutralizeUrls(text), max);
}

/**
 * Sanitize every LLM-authored string field of an ai_profile in place-safe copy
 * (summary + the skills/interests/offers/seeks lists + translations). Authored
 * identity fields are not part of AiProfile, so everything here is LLM output.
 */
export function sanitizeAiProfile(profile: AiProfile): AiProfile {
  const clean: AiProfile = {
    ...profile,
    summary: sanitizeLlmText(profile.summary),
    skills: profile.skills.map((s) => sanitizeLlmText(s, 200)),
    interests: profile.interests.map((s) => sanitizeLlmText(s, 200)),
    offers: profile.offers.map((s) => sanitizeLlmText(s, 200)),
    seeks: profile.seeks.map((s) => sanitizeLlmText(s, 200)),
  };
  if (profile.translations) {
    clean.translations = {
      ...profile.translations,
      ...(profile.translations.about ? { about: truncateWords(profile.translations.about, MAX_PROFILE_FIELD_CHARS) } : {}),
      ...(profile.translations.looking_for
        ? { looking_for: truncateWords(profile.translations.looking_for, MAX_PROFILE_FIELD_CHARS) }
        : {}),
      // Sliced as well as truncated: unlike the four ai_profile lists above (bounded
      // by aiProfileSchema when the model's output was validated), `translations` is
      // attached AFTER that check, so this is the only place enforcing its item
      // count. An over-cap list publishes fine and then fails every reader's
      // directoryEntryContentSchema.parse — silently removing the attendee from the
      // directory for everyone (2026-07-30).
      // MAX_SKILLS (50), not this file's MAX_LIST_ITEMS (64) — a publish-time re-cap
      // that is LOOSER than the schema enforces nothing, the same mistake already
      // corrected for authored `profile.skills` (NIP §8).
      ...(profile.translations.skills
        ? { skills: profile.translations.skills.slice(0, MAX_SKILLS).map((s) => truncateWords(s, MAX_SKILL)) }
        : {}),
    };
  }
  return clean;
}

/** Cap a user-authored free-text field (COORD-18 defensive size guard). */
export function capAuthoredText(text: string, max = MAX_PROFILE_FIELD_CHARS): string {
  return text.length > max ? text.slice(0, max) : text;
}
