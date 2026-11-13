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

/**
 * Ties Join's identity-specific state (the fetched kind-0, the event-local name
 * and bio prefilled from it, the intro library) to ONE account (audit KIMIK31
 * W-13). Join loaded the profile only while its state was "idle" and never reset
 * it, so when A logged out and B signed in with the page still mounted, B's form
 * kept A's name and bio, and a fetch for A that finished after the switch could
 * overwrite B's fields. B then submitted a join request carrying A's identity.
 *
 * `switchTo` reports a change of account so the caller can clear its fields;
 * `capture` / `isCurrent` fence an async load against a switch that happened
 * while it was in flight.
 */
export class IdentityFence {
  private owner: string | null | undefined = undefined;
  private generation = 0;

  /** Record the active account. True when it differs from the last one seen. */
  switchTo(pubkey: string | null): boolean {
    if (pubkey === this.owner) return false;
    this.owner = pubkey;
    this.generation++;
    return true;
  }

  /** Snapshot taken before an async load. */
  capture(): number {
    return this.generation;
  }

  /** Whether a load that captured `snapshot` still belongs to the active account. */
  isCurrent(snapshot: number): boolean {
    return snapshot === this.generation;
  }
}
