/**
 * Attendee-side consumption of coordinator status (kind 21606, NIP §6.3).
 *
 * The coordinator additionally seals a status rumor to the AFFECTED ATTENDEE for
 * failures in that attendee's own submission/talk pipeline (billing/budget blocks
 * go only to organizers). The attendee unwraps these on the normal grant-receiving
 * scan (`receiveGrants`), where the wrap is addressed to their account pubkey. This
 * module authenticates + stores them and exposes a modest reactive banner so a
 * stuck submission ("your talk failed processing — try re-recording") is visible
 * without the attendee having to ask the organizer.
 */
import {
  KIND_COORDINATOR_STATUS,
  coordinatorStatusContentSchema,
  type CoordinatorStatusContent,
  type Rumor,
} from "@nostrautica/protocol";
import { cacheGet, cacheSet } from "$lib/cache/persist.js";
import { ownStatusStore } from "$lib/stores/own-status.svelte.js";

function ownStatusKey(coordinate: string): string {
  return `ownstatus:${coordinate}`;
}

/** Cached own-status notices for a coordinate (no network), or undefined. */
export function cachedOwnStatuses(coordinate: string): CoordinatorStatusContent[] | undefined {
  return cacheGet<CoordinatorStatusContent[]>(ownStatusKey(coordinate))?.data;
}

/** One row per stage; a later status (higher `at`) supersedes an earlier one. */
function dedupeLatest(statuses: CoordinatorStatusContent[]): CoordinatorStatusContent[] {
  const latest = new Map<string, CoordinatorStatusContent>();
  for (const s of statuses) {
    const prev = latest.get(s.stage ?? "");
    if (!prev || s.at > prev.at) latest.set(s.stage ?? "", s);
  }
  return [...latest.values()];
}

/**
 * Try to interpret an unwrapped wrap as this attendee's OWN coordinator status and
 * record it. `rumor.pubkey` is the verified seal author (bound by the NIP-59
 * unwrap); the status is accepted only when that author is the coordinator named in
 * the event's signed 31600 (passed as `coordinatorPubkey`) — a status not sealed by
 * the configured coordinator is ignored. Returns true when it was a status rumor
 * (grant-scan should then memoize it), false when it was some other rumor kind.
 */
export function recordOwnStatus(
  rumor: Rumor,
  ownPubkey: string,
  coordinatorPubkey: string | undefined,
): boolean {
  if (rumor.kind !== KIND_COORDINATOR_STATUS) return false;
  // Authenticate: must be sealed by the configured coordinator.
  if (!coordinatorPubkey || rumor.pubkey !== coordinatorPubkey) return true;
  let content: CoordinatorStatusContent;
  try {
    content = coordinatorStatusContentSchema.parse(JSON.parse(rumor.content));
  } catch {
    return true; // a malformed status is still definitively a status wrap
  }
  // Only OUR OWN attendee-scoped statuses (billing goes to organizers only, and the
  // coordinator only ever seals attendee-scoped items here — but re-check anyway).
  if (content.pubkey && content.pubkey !== ownPubkey) return true;
  if (content.billing) return true; // never surface billing to an attendee
  const prior = cachedOwnStatuses(content.a) ?? [];
  const merged = dedupeLatest([...prior, content]);
  const newestAt = merged.reduce((m, s) => Math.max(m, s.at), 0);
  cacheSet(ownStatusKey(content.a), merged, newestAt);
  ownStatusStore.set(content.a, merged);
  return true;
}
