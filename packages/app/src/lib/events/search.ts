/**
 * Client-side directory search (spec §13). Searches across everything the app has
 * already decrypted for an attendee — display name, authored profile (about,
 * skills, looking-for), the coordinator's AI profile (summary, skills, interests,
 * offers, seeks) and its translation, and cached transcript text — with name hits
 * ranked ahead of body-only hits. Pure, so the field coverage and ranking are
 * unit-tested; it works offline because every field is local cache.
 */
import type { DirectoryEntryContent } from "@nostrautica/protocol";
import { matchesQuery } from "./roster.js";

/** The two searchable halves of one person: their name vs. everything else. */
export interface SearchFields {
  /** Display name (kind-0 / directory-entry name) — a hit here ranks first. */
  name: string;
  /** All other indexed text (about, skills, looking-for, AI profile, transcript). */
  rest: string[];
}

function pushAll(into: string[], v: string | string[] | undefined | null): void {
  if (!v) return;
  if (Array.isArray(v)) into.push(...v.filter(Boolean));
  else into.push(v);
}

/**
 * The searchable fields of one directory entry, given its resolved display name.
 * `locale` selects the coordinator translation to fold in when present, so a
 * search in the event language finds people who wrote in another one.
 */
export function directoryEntryFields(
  entry: DirectoryEntryContent,
  displayName: string,
  locale?: string,
): SearchFields {
  const rest: string[] = [];
  pushAll(rest, entry.name && entry.name !== displayName ? entry.name : undefined);
  pushAll(rest, entry.profile.about);
  pushAll(rest, entry.profile.skills);
  pushAll(rest, entry.profile.looking_for);
  pushAll(rest, entry.intro_text);
  const ai = entry.ai_profile;
  if (ai) {
    pushAll(rest, ai.summary);
    pushAll(rest, ai.skills);
    pushAll(rest, ai.interests);
    pushAll(rest, ai.offers);
    pushAll(rest, ai.seeks);
    const tr = ai.translations;
    if (tr && (!locale || tr.lang === locale)) {
      pushAll(rest, tr.about);
      pushAll(rest, tr.skills);
      pushAll(rest, tr.looking_for);
    }
  }
  // Cached transcript text — the "find the person who mentioned X" path (spec §13).
  for (const tr of entry.transcripts ?? []) pushAll(rest, tr.text);
  return { name: displayName, rest };
}

/**
 * Filter + rank `items` by `query`: keep every item whose name OR body matches all
 * query tokens (diacritic-folded), with name matches ordered ahead of body-only
 * matches. Order is otherwise stable (respects the caller's incoming order — e.g.
 * an existing sort). An empty/blank query returns `items` unchanged.
 */
export function searchRank<T>(
  items: T[],
  query: string,
  fieldsOf: (item: T) => SearchFields,
): T[] {
  if (!query.trim()) return items;
  const nameHits: T[] = [];
  const bodyHits: T[] = [];
  for (const item of items) {
    const f = fieldsOf(item);
    if (matchesQuery(f.name, query)) nameHits.push(item);
    else if (matchesQuery([f.name, ...f.rest].join(" "), query)) bodyHits.push(item);
  }
  return [...nameHits, ...bodyHits];
}
