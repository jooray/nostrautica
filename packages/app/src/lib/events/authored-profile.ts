/**
 * Authored event-profile editing (audit UX-O3). "Edit what you wrote" used to
 * route to Record, which re-recorded media and republished the authored fields
 * unchanged — there was no way to actually edit the about/skills/looking_for/
 * links/text-intro an attendee typed. This models the authored fields as an
 * editable form and builds a fresh 21601 submission from them (a new revision),
 * preserving existing media so editing text never drops a recording. AI-profile
 * correction (21608) stays a separate action.
 */
import type { AttendeeProfile, MediaDescriptor } from "@nostrautica/protocol";

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
