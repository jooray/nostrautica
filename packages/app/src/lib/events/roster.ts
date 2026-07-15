/**
 * Roster search/filter helpers (audit finding U8). Pure so the diacritic-
 * insensitive matching — which must work for Slovak names — is unit-tested.
 */

/** Lowercase and strip diacritics so "Ján" matches "jan" and vice-versa. */
export function normalizeForSearch(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/**
 * True if every whitespace-separated token of `query` appears in `haystack`
 * (both diacritic-folded). An empty/blank query matches everything.
 */
export function matchesQuery(haystack: string, query: string): boolean {
  const q = normalizeForSearch(query).trim();
  if (!q) return true;
  const hay = normalizeForSearch(haystack);
  return q.split(/\s+/).every((tok) => hay.includes(tok));
}

/** Join the searchable fields of a roster card into one haystack string. */
export function buildSearchText(
  parts: (string | string[] | undefined | null)[],
): string {
  const flat: string[] = [];
  for (const p of parts) {
    if (!p) continue;
    if (Array.isArray(p)) flat.push(...p);
    else flat.push(p);
  }
  return flat.join(" ");
}
