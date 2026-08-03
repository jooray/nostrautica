/**
 * Authored event-profile editing (audit UX-O3). "Edit what you wrote" used to
 * route to Record, which re-recorded media and republished the authored fields
 * unchanged — there was no way to actually edit the about/skills/looking_for/
 * links/text-intro an attendee typed. This models the authored fields as an
 * editable form and builds a fresh 21601 submission from them (a new revision),
 * preserving existing media so editing text never drops a recording. AI-profile
 * correction (21608) stays a separate action.
 */
import {
  MAX_ABOUT,
  MAX_LINKS,
  MAX_LOOKING_FOR,
  MAX_SKILL,
  MAX_SKILLS,
  MAX_URL,
  type AttendeeProfile,
  type MediaDescriptor,
} from "@nostrautica/protocol";

export interface AuthoredFields {
  about: string;
  /** Comma-separated in the form. */
  skills: string;
  lookingFor: string;
  /** One per line in the form. */
  links: string;
  introText: string;
}

/** Seed the editable form from a loaded profile + text intro. */
export function fieldsFromProfile(
  profile: AttendeeProfile | undefined,
  introText: string | undefined,
): AuthoredFields {
  return {
    about: profile?.about ?? "",
    skills: (profile?.skills ?? []).join(", "),
    lookingFor: profile?.looking_for ?? "",
    links: (profile?.links ?? []).join("\n"),
    introText: introText ?? "",
  };
}

function parseList(s: string, sep: RegExp): string[] {
  // Deduped: skills/links are rendered in {#each} blocks keyed on the string
  // itself (Attendee, MyProfile, AdminQueue), and in Svelte 5 a duplicate key is
  // a hard throw that takes the whole route down. Someone typing "rust, rust" in
  // the join form must not be able to break the organizer's queue.
  return [
    ...new Set(
      s
        .split(sep)
        .map((x) => x.trim())
        .filter((x) => x.length > 0),
    ),
  ];
}

/**
 * Build the authored `profile` + optional text intro from the edited form. Media
 * is passed through untouched (editing text must not drop a recorded intro).
 */
export function buildAuthoredSubmission(
  fields: AuthoredFields,
  existingMedia: MediaDescriptor[],
): { profile: AttendeeProfile; introText?: string; media: MediaDescriptor[] } {
  const profile: AttendeeProfile = {
    about: fields.about.trim(),
    skills: parseList(fields.skills, /,/),
    looking_for: fields.lookingFor.trim(),
    links: parseList(fields.links, /[\n,]/),
  };
  const introText = fields.introText.trim() || undefined;
  return { profile, introText, media: existingMedia };
}

/**
 * Coerce an authored profile into something `attendeeProfileSchema` accepts.
 *
 * This exists because the boundary caps are enforced ONLY at the coordinator,
 * and the penalty there is total: `profileSubmissionContentSchema.parse` throws
 * a ZodError, the coordinator classifies it as permanently unprocessable, marks
 * the rumor seen and drops it forever, while the app reports "Saved". Nothing on
 * either side ever says otherwise. Two of those are in the production log.
 *
 * `links` is the sharp edge — the schema demands `z.string().url()`, and typing
 * a bare `example.com` is the normal way people write a link. Giving that back
 * as a validation error would be pedantry about a value we can obviously repair,
 * so a scheme-less link gets `https://`, and only something that still will not
 * parse (or is not http/https) is reported as dropped. Callers surface that;
 * everything else is repaired quietly, because truncating a 6000-character bio
 * is plainly better than discarding the whole submission it came in.
 */
export interface NormalizedProfile {
  profile: AttendeeProfile;
  /** Links that could not be repaired into a URL, for the caller to surface. */
  dropped: string[];
}

/**
 * A value that may plausibly be a URL missing its scheme: it must START with
 * something hostname-shaped, ending in a dotted TLD. Without this the repair is
 * far too eager — `new URL("https://@my_handle")` parses happily, yielding
 * `https://my_handle/`, so a Nostr/Twitter handle would be "fixed" into a link
 * to a host that does not exist rather than reported back to the person who
 * typed it.
 */
const HOSTNAME_LIKE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)*\.[a-z]{2,}([:/?#]|$)/i;

function normalizeLink(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  // A scheme-less value is only repaired when it looks like a hostname; anything
  // already carrying a scheme is judged on that scheme alone, so `mailto:` and
  // `javascript:` are rejected rather than silently re-prefixed.
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(value)
    ? value
    : HOSTNAME_LIKE.test(value)
      ? `https://${value}`
      : undefined;
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (!url.hostname.includes(".")) return undefined;
    if (url.href.length > MAX_URL) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

export function normalizeAuthoredProfile(profile: AttendeeProfile): NormalizedProfile {
  const dropped: string[] = [];
  const links: string[] = [];
  for (const raw of profile.links ?? []) {
    const url = normalizeLink(raw);
    if (url === undefined) {
      if (raw.trim()) dropped.push(raw.trim());
      continue;
    }
    if (!links.includes(url)) links.push(url);
  }
  const skills: string[] = [];
  for (const raw of profile.skills ?? []) {
    const skill = raw.trim().slice(0, MAX_SKILL);
    if (skill && !skills.includes(skill)) skills.push(skill);
  }
  return {
    profile: {
      about: (profile.about ?? "").trim().slice(0, MAX_ABOUT),
      skills: skills.slice(0, MAX_SKILLS),
      looking_for: (profile.looking_for ?? "").trim().slice(0, MAX_LOOKING_FOR),
      links: links.slice(0, MAX_LINKS),
    },
    dropped,
  };
}

/** True when the edited form differs from the baseline it was seeded with. */
export function authoredChanged(current: AuthoredFields, baseline: AuthoredFields): boolean {
  return (
    current.about.trim() !== baseline.about.trim() ||
    current.skills.trim() !== baseline.skills.trim() ||
    current.lookingFor.trim() !== baseline.lookingFor.trim() ||
    current.links.trim() !== baseline.links.trim() ||
    current.introText.trim() !== baseline.introText.trim()
  );
}
