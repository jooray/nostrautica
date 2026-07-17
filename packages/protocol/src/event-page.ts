/**
 * Event page customization helpers (spec §7.4, kinds 31607–31609).
 *
 * - Size caps: members-only post markdown ≤ 60,000 bytes (safely under the
 *   NIP-44 65,535-byte plaintext ceiling and relay event-size caps); theme CSS
 *   ≤ 32 KB.
 * - ECK encrypt/decrypt of the 31607 payload and the 31608 `private` string,
 *   validated at the boundary via the zod schemas.
 * - Merge/split of public + members-only menu items and layout sections: the
 *   encrypted items carry a `pos` index into the MERGED list; members
 *   interleave them client-side, visitors render the public list alone.
 */
import { eckEncrypt, eckDecrypt } from "./crypto.js";
import {
  membersPostContentSchema,
  eventPagePrivateSchema,
  type MembersPostContent,
  type EventPagePrivate,
  type EventPageSection,
  type MenuItem,
} from "./schemas.js";

// ── Size caps (spec §7.4) ────────────────────────────────────────────────────

/** Editor cap for members-only post markdown (spec §7.4, plan gotcha #9). */
export const MAX_MEMBERS_POST_MARKDOWN_BYTES = 60_000;
/** Hard NIP-44 v2 single-payload plaintext ceiling. */
export const NIP44_MAX_PLAINTEXT_BYTES = 65_535;
/** Theme CSS cap (kind 31609 content). */
export const MAX_THEME_CSS_BYTES = 32 * 1024;

/** UTF-8 byte length of a string (what NIP-44 and relays actually count). */
export function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

// ── 31607 payload encrypt/decrypt ────────────────────────────────────────────

/**
 * Validate + ECK-encrypt a members-only post payload. Rejects markdown over
 * the 60,000-byte editor cap (chunking is out of scope for v1).
 */
export function encryptMembersPost(
  eck: Uint8Array,
  post: MembersPostContent,
): string {
  const valid = membersPostContentSchema.parse(post);
  const mdBytes = utf8ByteLength(valid.content);
  if (mdBytes > MAX_MEMBERS_POST_MARKDOWN_BYTES) {
    throw new Error(
      `members-only post markdown is ${mdBytes} bytes — the limit is ${MAX_MEMBERS_POST_MARKDOWN_BYTES}`,
    );
  }
  return eckEncrypt(eck, JSON.stringify(valid));
}

/** Decrypt + validate a 31607 ciphertext. Throws on wrong key / bad payload. */
export function decryptMembersPost(
  eck: Uint8Array,
  ciphertext: string,
): MembersPostContent {
  return membersPostContentSchema.parse(JSON.parse(eckDecrypt(eck, ciphertext)));
}

// ── 31608 `private` encrypt/decrypt ──────────────────────────────────────────

export function encryptEventPagePrivate(
  eck: Uint8Array,
  priv: EventPagePrivate,
): string {
  return eckEncrypt(eck, JSON.stringify(eventPagePrivateSchema.parse(priv)));
}

export function decryptEventPagePrivate(
  eck: Uint8Array,
  ciphertext: string,
): EventPagePrivate {
  return eventPagePrivateSchema.parse(JSON.parse(eckDecrypt(eck, ciphertext)));
}

// ── Merge/split of public + members-only lists ───────────────────────────────
// Merged items carry `membersOnly` so the UI can badge them and the admin
// editor can split them back. `pos` = the item's index in the merged list;
// merge/split round-trip exactly (tested), so the editor can load → edit →
// republish without drift.

export type Positioned<T> = T & { pos: number };
export type Merged<T> = T & { membersOnly: boolean };

function mergeByPos<T extends object>(
  publicItems: T[],
  privateItems: Positioned<T>[],
): Merged<T>[] {
  const merged: Merged<T>[] = publicItems.map((item) => ({
    ...item,
    membersOnly: false,
  }));
  // Insert in ascending pos order so earlier insertions don't shift later ones.
  for (const item of [...privateItems].sort((a, b) => a.pos - b.pos)) {
    const { pos, ...rest } = item;
    const idx = Math.min(Math.max(0, pos), merged.length);
    merged.splice(idx, 0, { ...(rest as T), membersOnly: true });
  }
  return merged;
}

function splitByPos<T extends object>(merged: Merged<T>[]): {
  publicItems: T[];
  privateItems: Positioned<T>[];
} {
  const publicItems: T[] = [];
  const privateItems: Positioned<T>[] = [];
  merged.forEach((item, index) => {
    const { membersOnly, ...rest } = item;
    if (membersOnly) privateItems.push({ ...(rest as T), pos: index });
    else publicItems.push(rest as T);
  });
  return { publicItems, privateItems };
}

export type MergedMenuItem = Merged<MenuItem>;
export type MergedSection = Merged<EventPageSection>;

/** Interleave members-only menu items into the public list by `pos`. */
export function mergeMenu(
  publicItems: MenuItem[],
  privateItems: Positioned<MenuItem>[],
): MergedMenuItem[] {
  return mergeByPos(publicItems, privateItems);
}

/** Inverse of {@link mergeMenu} — what the admin editor publishes from. */
export function splitMenu(merged: MergedMenuItem[]): {
  publicItems: MenuItem[];
  privateItems: Positioned<MenuItem>[];
} {
  return splitByPos(merged);
}

/** Interleave members-only sections into the public layout by `pos`. */
export function mergeSections(
  publicSections: EventPageSection[],
  privateSections: Positioned<EventPageSection>[],
): MergedSection[] {
  return mergeByPos(publicSections, privateSections);
}

/** Inverse of {@link mergeSections}. */
export function splitSections(merged: MergedSection[]): {
  publicItems: EventPageSection[];
  privateItems: Positioned<EventPageSection>[];
} {
  return splitByPos(merged);
}

// ── 31608 menu ⇄ `r` tags ────────────────────────────────────────────────────

/** Public menu items as ["r", target, label] tags, in display order. */
export function menuToRTags(items: MenuItem[]): string[][] {
  return items.map((m) => ["r", m.target, m.label]);
}

/** Parse the public menu back out of a 31608 tag array (display order kept). */
export function rTagsToMenu(tags: string[][]): MenuItem[] {
  return tags
    .filter((t) => t[0] === "r" && typeof t[1] === "string")
    .map((t) => ({ target: t[1]!, label: t[2] ?? t[1]! }));
}
