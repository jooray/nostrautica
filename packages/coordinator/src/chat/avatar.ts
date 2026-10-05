/**
 * The event chat's group avatar (`marmot.group.avatar-url.v1`, component 0x8007)
 * mirrors the event's icon: the `picture` of the event identity's (E_id) kind-0
 * profile, which the organizer sets as the event/community "icon"
 * (app `events/event-metadata.ts`). Not the wide `image` banner tag.
 *
 * The component holds a plain https URL. Per the spec the PRODUCER stores the
 * WHATWG-normalized form (`new URL(x).href`) and decoders reject anything else,
 * so the URL is normalized here, once, and a URL that cannot be stored validly
 * is skipped rather than allowed to break group creation or reconciliation.
 * `dim`/`thumbhash` are left empty.
 */

/** The spec's byte limit on the encoded `url`. */
export const AVATAR_URL_MAX_BYTES = 2048;

export type AvatarUrlResult =
  /** `url` is the normalized URL, or "" for "no avatar". */
  | { ok: true; url: string }
  | { ok: false; reason: string };

/**
 * Normalize an icon URL for the avatar component. A missing/blank icon is a valid
 * "no avatar" (`url: ""`, the component's empty state). Anything else must parse,
 * be `https`, have a host, carry no userinfo and no fragment, and fit in 2048
 * bytes once serialized.
 */
export function normalizeAvatarUrl(raw: string | undefined | null): AvatarUrlResult {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return { ok: true, url: "" };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: "not a URL" };
  }
  if (parsed.protocol !== "https:") return { ok: false, reason: `scheme ${parsed.protocol} is not https` };
  if (!parsed.host) return { ok: false, reason: "no host" };
  if (parsed.username || parsed.password) return { ok: false, reason: "has userinfo" };
  const href = parsed.href;
  // `hash` is "" for both "no fragment" and an empty one ("…/#"); only the
  // serialized form tells them apart, and the spec forbids either.
  if (parsed.hash || href.includes("#")) return { ok: false, reason: "has a fragment" };
  if (new TextEncoder().encode(href).length > AVATAR_URL_MAX_BYTES) {
    return { ok: false, reason: `longer than ${AVATAR_URL_MAX_BYTES} bytes` };
  }
  return { ok: true, url: href };
}

/** The `picture` of a kind-0 profile's JSON content, if it is a string. */
export function profilePicture(content: string | undefined): string | undefined {
  if (!content) return undefined;
  try {
    const parsed = JSON.parse(content) as { picture?: unknown };
    return typeof parsed.picture === "string" ? parsed.picture : undefined;
  } catch {
    return undefined;
  }
}
