/**
 * Post-event report assembly (spec §13 "Post-event report & payoff flow").
 *
 * Pure, so the "who did I meet / want to meet but didn't / take notes on" derivation
 * from the user-private 30078 per-event settings (§7.3) is unit-tested. All inputs are
 * already-decrypted local data; nothing here touches the network. The report is
 * rendered to a print-friendly view (browser print-to-PDF) — no server rendering.
 */
import { npubEncode } from "nostr-tools/nip19";
import type { PerEventSettings } from "@nostrautica/protocol";

/** One person on the report: identity plus the user's private note about them. */
export interface ReportPerson {
  pubkey: string;
  npub: string;
  name: string;
  note?: string;
}

/** One favorited talk on the report (resolved title for its blinded `d`). */
export interface ReportTalk {
  d: string;
  title: string;
}

export interface EventReport {
  /** People the user marked "met", in the order they were marked. */
  met: ReportPerson[];
  /** People the user wanted to meet but never marked "met". */
  wantedNotMet: ReportPerson[];
  /** Talks the user favorited (locally), resolved to titles. */
  favoriteTalks: ReportTalk[];
  /** Every person the user took a private note on (met or not). */
  notes: ReportPerson[];
}

type ReportSettings = Pick<PerEventSettings, "want_to_meet" | "met" | "notes">;

function person(pubkey: string, nameOf: (p: string) => string, note?: string): ReportPerson {
  const trimmed = note?.trim();
  return {
    pubkey,
    npub: safeNpub(pubkey),
    name: nameOf(pubkey),
    ...(trimmed ? { note: trimmed } : {}),
  };
}

/** npub for a hex pubkey; falls back to the raw hex if it isn't encodable. */
export function safeNpub(pubkey: string): string {
  try {
    return npubEncode(pubkey);
  } catch {
    return pubkey;
  }
}

/**
 * Assemble the report from decrypted per-event settings + resolved favorite talks.
 * `nameOf` resolves a display name (kind-0 / directory-entry name) for a pubkey.
 */
export function assembleReport(input: {
  settings: ReportSettings;
  favoriteTalks?: ReportTalk[];
  nameOf: (pubkey: string) => string;
}): EventReport {
  const { settings, nameOf } = input;
  const met = settings.met ?? [];
  const wantToMeet = settings.want_to_meet ?? [];
  const notes = settings.notes ?? {};
  const metSet = new Set(met);

  return {
    met: met.map((p) => person(p, nameOf, notes[p])),
    // Planned-but-didn't-happen: want-to-meet minus met (spec: "reflects what
    // actually happened at the venue, not just what was planned beforehand").
    wantedNotMet: wantToMeet.filter((p) => !metSet.has(p)).map((p) => person(p, nameOf, notes[p])),
    favoriteTalks: input.favoriteTalks ?? [],
    notes: Object.keys(notes)
      .filter((p) => notes[p]?.trim())
      .map((p) => person(p, nameOf, notes[p])),
  };
}

/**
 * The pubkeys a "follow all" acts on: everyone marked met or want-to-meet, deduped,
 * minus any the user opted out of in the confirm step. Order: met first, then the
 * remaining want-to-meet — the same emphasis the report uses.
 */
export function followTargets(
  settings: Pick<PerEventSettings, "want_to_meet" | "met">,
  optOut: ReadonlySet<string> = new Set(),
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of [...(settings.met ?? []), ...(settings.want_to_meet ?? [])]) {
    if (seen.has(p) || optOut.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}
