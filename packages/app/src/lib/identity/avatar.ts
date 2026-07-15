/**
 * Deterministic identity visuals (redesign §3.4). A person (or an event) is
 * given a stable gradient + initials derived from their pubkey, so they look the
 * same everywhere in the app and no list ever shows an empty grey circle.
 *
 * Lightness is pinned low so white initials clear WCAG 4.5:1 at EVERY hue — the
 * unit test asserts this across the full 0–359° wheel. Pure, no DOM.
 */
import { sha256Hex, utf8ToBytes } from "@nostrautica/protocol";

/**
 * Two deterministic hues (degrees) from a seed. Shared by the person avatar
 * gradient and the event colour wash (which seeds it with the event pubkey).
 * Mirrors the `hues()` helper in media/image.ts.
 */
export function avatarHues(seed: string): [number, number] {
  const hash = sha256Hex(utf8ToBytes(seed || "anon"));
  const h1 = (parseInt(hash.slice(0, 2), 16) * 360) / 255;
  const h2 = (h1 + 40 + (parseInt(hash.slice(2, 4), 16) % 80)) % 360;
  return [h1, h2];
}

/**
 * A CSS gradient for a person's avatar, deterministic from their pubkey. The
 * lightness values (29% / 24%) are chosen so #fff initials pass 4.5:1 at every
 * hue — do not raise them without re-running avatar.test.ts.
 */
export function avatarGradient(pubkeyHex: string): string {
  const [h1, h2] = avatarHues(pubkeyHex);
  return `linear-gradient(135deg, hsl(${h1.toFixed(0)} 55% 29%), hsl(${h2.toFixed(0)} 50% 24%))`;
}

function graphemes(s: string): string[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    return Array.from(new Intl.Segmenter().segment(s), (x) => x.segment);
  }
  return Array.from(s);
}

/**
 * 1–2 uppercase grapheme clusters for the avatar fallback:
 * "Šimon Koska" → "ŠK", "sats" → "SA", no name → first 2 chars of the npub body.
 */
export function initialsFor(name?: string, npub?: string): string {
  const trimmed = (name ?? "").trim();
  if (trimmed) {
    const words = trimmed.split(/\s+/).filter(Boolean);
    if (words.length >= 2) {
      const first = graphemes(words[0]!)[0] ?? "";
      const last = graphemes(words[words.length - 1]!)[0] ?? "";
      return (first + last).toUpperCase();
    }
    return graphemes(words[0]!).slice(0, 2).join("").toUpperCase();
  }
  if (npub) {
    const body = npub.startsWith("npub1") ? npub.slice(5) : npub;
    if (body) return body.slice(0, 2).toUpperCase();
  }
  return "?";
}
