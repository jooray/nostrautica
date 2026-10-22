/**
 * People mentioned inside a group-chat message, encoded the way White Noise
 * encodes them so the two clients agree on who was tagged.
 *
 * What White Noise sends (read from source, MDK 2026-10):
 *
 *  - Content: the composer inserts the literal `@npub1…` followed by a space
 *    (whitenoise-android core/MentionComposer.kt `insertMention`). There is no
 *    hidden span; the "chip" is a visual treatment of that literal run.
 *  - Tags: MDK's inner-event builder (marmot-app messages/intents.rs
 *    `mention_p_tags`) appends one `["p", <hex>]` per DISTINCT mentioned pubkey,
 *    first-seen order, after any reply `e`/`q` tags. It is derived from the
 *    content, so every Marmot client that tokenizes the same text tags the same
 *    people.
 *  - Recognized on receipt (marmot-markdown inline.rs): `@npub1…`, a bare
 *    `npub1…`, and `nostr:<hrp>1…` URIs, of which only npub and nprofile name a
 *    person. Each needs a word boundary on both sides: the neighbour may not be
 *    an ASCII letter, digit, `_` or `/`, which is what keeps `foo@npub1…` and a
 *    URL path from turning into mentions.
 *
 * Pure and network-free: names and avatars are the component's business, keyed
 * by the pubkey returned here.
 */
import { decode, npubEncode } from "nostr-tools/nip19";

export type MentionSegment =
  | { type: "text"; value: string }
  /** `pubkey` is hex; `raw` is the exact source text, for copy and fallback. */
  | { type: "mention"; pubkey: string; raw: string };

// One alternation, longest form first. `@?` in front of `nostr:` swallows the
// "@" a user (or a client) sometimes types before a URI, so it is not rendered
// as a stray character beside the chip.
const BECH32 = "[02-9ac-hj-np-z]";
const MENTION_RE = new RegExp(
  `@?nostr:((?:npub|nprofile)1${BECH32}{6,})|@(npub1${BECH32}{6,})|(npub1${BECH32}{6,})`,
  "g",
);

/** MDK's `left_boundary_ok` / `right_boundary_ok`: not [A-Za-z0-9_/]. */
function isBoundary(ch: string | undefined): boolean {
  return ch === undefined || !/[A-Za-z0-9_/]/.test(ch);
}

/** The hex pubkey a bech32 npub/nprofile names, or undefined for anything else. */
export function pubkeyOfBech32(bech32: string): string | undefined {
  try {
    const d = decode(bech32);
    if (d.type === "npub") return d.data;
    if (d.type === "nprofile") return d.data.pubkey;
  } catch {
    /* not valid bech32 (bad checksum, truncated): plain text */
  }
  return undefined;
}

/** Split message text into plain runs and person mentions. */
export function parseMentions(content: string): MentionSegment[] {
  const out: MentionSegment[] = [];
  let last = 0;
  MENTION_RE.lastIndex = 0;
  for (let m = MENTION_RE.exec(content); m; m = MENTION_RE.exec(content)) {
    const raw = m[0];
    const start = m.index;
    const end = start + raw.length;
    const bech32 = (m[1] ?? m[2] ?? m[3])!;
    // A bare `npub1…` directly after "@" or "nostr:" is the tail of a longer
    // form that already failed (bad checksum); MDK leaves it literal, so do we.
    const bare = m[3] !== undefined;
    const prev = content[start - 1];
    const leftOk = isBoundary(prev) && !(bare && (prev === "@" || content.slice(start - 6, start) === "nostr:"));
    const pubkey = leftOk && isBoundary(content[end]) ? pubkeyOfBech32(bech32) : undefined;
    if (!pubkey) {
      // Retry one character on, so "x@npub1…" can still find nothing rather than
      // skipping a mention that starts inside this match.
      MENTION_RE.lastIndex = start + 1;
      continue;
    }
    if (start > last) out.push({ type: "text", value: content.slice(last, start) });
    out.push({ type: "mention", pubkey, raw });
    last = end;
  }
  if (last < content.length) out.push({ type: "text", value: content.slice(last) });
  return out;
}

/** Distinct mentioned pubkeys, in first-seen order. */
export function mentionedPubkeys(content: string): string[] {
  const seen = new Set<string>();
  for (const s of parseMentions(content)) if (s.type === "mention") seen.add(s.pubkey);
  return [...seen];
}

/**
 * The `p` tags MDK derives for this content: one per distinct mentioned pubkey,
 * first-seen order. Without them a White Noise reader still renders the chip
 * (it parses the text), but its "you were mentioned" attention never fires.
 */
export function mentionPTags(content: string): string[][] {
  return mentionedPubkeys(content).map((pk) => ["p", pk]);
}

/** `npub1abcd…wxyz`: enough to tell two people with one display name apart. */
export function shortNpub(pubkey: string): string {
  try {
    const npub = npubEncode(pubkey);
    return `${npub.slice(0, 9)}…${npub.slice(-4)}`;
  } catch {
    return pubkey.slice(0, 8);
  }
}
