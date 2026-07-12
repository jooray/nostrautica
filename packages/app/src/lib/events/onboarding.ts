/**
 * Nostr onboarding merge logic (spec §5.4). Registration IS Nostr onboarding, so
 * every profile-ish action must publish real, standard events WITHOUT clobbering
 * a user's pre-existing data. The two classic footguns:
 *
 *  - kind-0: blind overwrite drops unknown JSON fields → fetch-merge, edit only
 *    the fields the user changed, preserve everything else.
 *  - kind-3: publishing a fresh follow list silently wipes existing follows →
 *    always fetch the current kind 3 and APPEND, deduped by pubkey, keeping the
 *    relay/petname of untouched entries.
 *
 * These merge functions are pure (no relay I/O) so the data-loss regression is
 * unit-tested directly.
 */

export type Tag = string[];

/** Merge edited profile fields into an existing kind-0 content JSON string. */
export function mergeProfileContent(
  existingContent: string | undefined,
  edits: Record<string, string | undefined>,
): string {
  let base: Record<string, unknown> = {};
  if (existingContent) {
    try {
      const parsed = JSON.parse(existingContent);
      if (parsed && typeof parsed === "object") base = parsed as Record<string, unknown>;
    } catch {
      /* malformed existing profile — start clean rather than throw */
    }
  }
  for (const [key, value] of Object.entries(edits)) {
    // Only touch fields the user actually edited; undefined means "leave as-is".
    if (value !== undefined) base[key] = value;
  }
  return JSON.stringify(base);
}

/**
 * Append `newFollows` (pubkey hex) to an existing kind-3 tag set, deduped by
 * pubkey, preserving existing entries' relay/petname fields. Non-`p` tags are
 * kept untouched. Returns the merged tag array.
 */
export function mergeFollowTags(existingTags: Tag[], newFollows: string[]): Tag[] {
  const result: Tag[] = existingTags.map((t) => [...t]);
  const have = new Set(
    result.filter((t) => t[0] === "p" && t[1]).map((t) => t[1] as string),
  );
  for (const pk of newFollows) {
    if (!have.has(pk)) {
      result.push(["p", pk]);
      have.add(pk);
    }
  }
  return result;
}

/** Remove a pubkey from a kind-3 tag set (unfollow), preserving other tags. */
export function removeFollowTag(existingTags: Tag[], pubkey: string): Tag[] {
  return existingTags.filter((t) => !(t[0] === "p" && t[1] === pubkey));
}

/** True if `pubkey` is followed in this kind-3 tag set. */
export function isFollowing(tags: Tag[], pubkey: string): boolean {
  return tags.some((t) => t[0] === "p" && t[1] === pubkey);
}
