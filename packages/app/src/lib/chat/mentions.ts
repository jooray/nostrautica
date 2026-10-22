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

// ── composing ────────────────────────────────────────────────────────────────

/** An open `@` query in the composer: the `@` at `start`, then `query` up to the caret. */
export interface ActiveMention {
  start: number;
  query: string;
}

const CHIP_AT = new RegExp(`^@npub1${BECH32}+`);

/**
 * The `@`-query the caret is in, or null. Same rules as White Noise's composer
 * (`activeMentionQuery`): the nearest `@` left of the caret with no whitespace
 * in between, that `@` starting a word (so an e-mail address never opens the
 * picker), and not an already inserted `@npub1…` the caret is sitting in.
 */
export function activeMention(text: string, caret: number): ActiveMention | null {
  if (caret < 0 || caret > text.length) return null;
  let i = caret - 1;
  while (i >= 0 && text[i] !== "@") {
    if (/\s/.test(text[i]!)) return null;
    i--;
  }
  if (i < 0) return null;
  if (i > 0 && !/\s/.test(text[i - 1]!)) return null;
  const chip = CHIP_AT.exec(text.slice(i));
  if (chip && caret <= i + chip[0].length) return null;
  return { start: i, query: text.slice(i + 1, caret) };
}

/**
 * Replace the open query with `@<npub> ` and put the caret after the space. The
 * space is skipped when the text already continues with whitespace, so a
 * mention dropped mid-sentence does not leave a double space.
 */
export function insertMention(
  text: string,
  active: ActiveMention,
  pubkey: string,
): { text: string; caret: number } {
  const end = Math.min(text.length, active.start + 1 + active.query.length);
  const before = text.slice(0, active.start);
  const after = text.slice(end);
  const chip = `@${npubEncode(pubkey)}${/^\s/.test(after) ? "" : " "}`;
  return { text: before + chip + after, caret: before.length + chip.length };
}

/**
 * Backspace at a chip's right edge, or just past the space `insertMention`
 * added, removes the whole chip: a 63-character npub one keystroke at a time
 * is not editing, it is a chore. Returns null when the caret is anywhere else,
 * so the textarea's own Backspace runs.
 */
export function deleteMentionBackward(text: string, caret: number): { text: string; caret: number } | null {
  const head = text.slice(0, caret);
  const m = new RegExp(`(?:^|(?<=\\s))@npub1${BECH32}{58}( ?)$`).exec(head);
  if (!m || !pubkeyOfBech32(m[0].trim().slice(1))) return null;
  const start = m.index;
  return { text: text.slice(0, start) + text.slice(caret), caret: start };
}

/** Someone the picker can offer. `account` is hex and is what gets encoded. */
export interface MentionCandidate {
  account: string;
  name: string;
}

/**
 * Who to offer for `query`: name prefix matches first, then names containing
 * it, then an npub typed out by hand. An empty query lists everyone, so a lone
 * `@` is a people picker.
 */
export function matchMentionCandidates<T extends MentionCandidate>(
  candidates: readonly T[],
  query: string,
  limit = 8,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return candidates.slice(0, limit);
  const pre: T[] = [];
  const contains: T[] = [];
  const byKey: T[] = [];
  for (const c of candidates) {
    const n = c.name.toLowerCase();
    if (n.startsWith(q)) pre.push(c);
    else if (n.includes(q)) contains.push(c);
    else if (q.startsWith("npub1") && npubEncode(c.account).startsWith(q)) byKey.push(c);
  }
  return [...pre, ...contains, ...byKey].slice(0, limit);
}
