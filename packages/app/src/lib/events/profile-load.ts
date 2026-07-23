/**
 * Existing-user profile load state machine (audit UX-O1).
 *
 * Join used to swallow a kind-0 fetch error, set `profileLoaded = true`, and
 * leave the name blank — so a transient relay failure could submit an
 * anonymous-looking join request that the organizer then has to guess at. This
 * distinguishes the three outcomes that were collapsed into one:
 *
 *  - "loaded":  a public profile with at least a name was fetched.
 *  - "empty":   the fetch succeeded but the user has no public kind-0 profile.
 *  - "failed":  the fetch itself failed (offline / relay gap) — retryable, and
 *               NOT a licence to submit an empty request.
 *
 * The classifier is pure so the Join view can drive Retry + a required
 * event-local display name (which never modifies kind 0) off it.
 */
export type ProfileLoadState = "idle" | "loading" | "loaded" | "empty" | "failed";

export interface FetchedProfile {
  name?: string;
  about?: string;
  picture?: string;
}

export interface ProfileLoadResult {
  state: ProfileLoadState;
  name: string;
  about: string;
  picture: string;
}

/**
 * Classify a completed profile fetch. `failed` is true when the network fetch
 * itself threw; otherwise `profile` is whatever kind-0 held (possibly nothing).
 * A profile with neither a name nor an about is treated as "empty" (no public
 * profile) rather than "loaded".
 */
export function classifyProfileLoad(
  profile: FetchedProfile | undefined,
  failed: boolean,
): ProfileLoadResult {
  if (failed) {
    return { state: "failed", name: "", about: "", picture: "" };
  }
  const name = (profile?.name ?? "").trim();
  const about = (profile?.about ?? "").trim();
  const picture = profile?.picture ?? "";
  const hasContent = name.length > 0 || about.length > 0;
  return { state: hasContent ? "loaded" : "empty", name, about, picture };
}

/**
 * Can a logged-in user submit the join request given the load state and the
 * event-local display name they typed? A failed load must be resolved (retry or
 * an explicit local name); an empty profile requires a local name so the request
 * isn't anonymous. A "loaded" profile can submit as-is even if the local field is
 * left untouched (it's prefilled from the loaded name).
 */
export function canSubmitLoggedIn(
  state: ProfileLoadState,
  eventDisplayName: string,
): boolean {
  const name = eventDisplayName.trim();
  switch (state) {
    case "loaded":
      return true;
    case "empty":
    case "failed":
      return name.length > 0;
    case "loading":
    case "idle":
    default:
      return false;
  }
}
