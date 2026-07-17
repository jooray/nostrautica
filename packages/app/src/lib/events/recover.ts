/**
 * Fresh-device recovery of ORGANIZER event custody from relays (audit G2/C1).
 *
 * `create.ts` self-encrypts the event's keys (E_id, E_inbox, ECK) into a
 * kind-30078 "eventkeys" backup addressed by a blinded d. That backup was
 * WRITTEN but never READ — so a wiped/fresh device could never recover an event
 * it created. This module reads those backups back and restores them into the
 * (owner-scoped) local keystore, so an organizer regains full custody from
 * relays alone. Attendee/co-organizer custody recovers via the 21602/21605
 * grants in `attendee.ts#receiveGrants`; this covers the organizer's own events.
 *
 * The backup's `d` is blinded (unguessable to others) but we don't need to
 * recompute it: we fetch the identity's own kind-30078s and pick out ours by the
 * `nostrautica:eventkeys:` prefix, then self-decrypt.
 */
import {
  KIND_APP_DATA,
  KIND_EVENT_CONFIG,
  eventKeysBackupSchema,
  makeCoordinate,
  parseCoordinate,
  hexToBytes,
  type EventKeysBackup,
} from "@nostrautica/protocol";
import { getPublicKey } from "nostr-tools/pure";
import type { AppSigner } from "$lib/signer/types.js";
import { fetchEvents } from "$lib/nostr/ndk.js";
import { DEFAULT_RELAYS } from "$lib/nostr/relays.js";
import { loadEventKeys, saveEventKeys } from "./keystore.js";

const EVENTKEYS_PREFIX = "nostrautica:eventkeys:";

// One recovery pass per identity per session is enough (the keystore is a
// durable local cache once restored). A failed pass isn't marked, so it retries.
const recovered = new Set<string>();

/**
 * Resolve the event coordinate a backup belongs to. New backups carry `a`
 * directly; older ones are reconstructed from the E_id key + the event's
 * published 31600 config (its `d` tag), fetched from relays.
 */
async function resolveCoordinate(backup: EventKeysBackup): Promise<string | undefined> {
  if (backup.a) {
    try {
      parseCoordinate(backup.a);
      return backup.a;
    } catch {
      /* malformed — fall through to derivation */
    }
  }
  let eidPubkey: string;
  try {
    eidPubkey = getPublicKey(hexToBytes(backup.eid_nsec));
  } catch {
    return undefined;
  }
  const configs = await fetchEvents(
    { kinds: [KIND_EVENT_CONFIG], authors: [eidPubkey] },
    DEFAULT_RELAYS,
  ).catch(() => []);
  const latest = configs.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
  const d = latest?.tags.find((t) => t[0] === "d")?.[1];
  return d ? makeCoordinate(eidPubkey, d) : undefined;
}

/**
 * Restore a backup into the keystore, merging with any existing local record so
 * a fresher local ECK set (e.g. after a revocation rotation) is never clobbered
 * by an older backup — union the ECK versions, keep local secrets when present.
 */
async function restore(coordinate: string, backup: EventKeysBackup): Promise<void> {
  const existing = await loadEventKeys(coordinate).catch(() => undefined);
  const byId = new Map<number, { id: number; key: string }>();
  for (const v of existing?.eck ?? []) byId.set(v.id, v);
  for (const v of backup.eck) if (!byId.has(v.id)) byId.set(v.id, v);
  await saveEventKeys({
    coordinate,
    role: "organizer",
    eck: [...byId.values()].sort((a, b) => a.id - b.id),
    eidNsecHex: existing?.eidNsecHex ?? backup.eid_nsec,
    einboxNsecHex: existing?.einboxNsecHex ?? backup.einbox_nsec,
  });
}

/**
 * Read the identity's kind-30078 eventkeys backups and restore organizer custody
 * into the local keystore. Returns the coordinates recovered. Idempotent and
 * cheap to call on every device/identity load (guarded to run once per session).
 */
export async function recoverEventKeys(
  signer: AppSigner,
  opts: { force?: boolean } = {},
): Promise<string[]> {
  const pubkey = await signer.getPublicKey();
  if (!opts.force && recovered.has(pubkey)) return [];

  const events = await fetchEvents(
    { kinds: [KIND_APP_DATA], authors: [pubkey] },
    DEFAULT_RELAYS,
  );

  const restoredCoords: string[] = [];
  let candidates = 0; // eventkeys backups we saw
  let decrypted = 0; // …of which we could actually read
  for (const e of events) {
    const d = e.tags.find((t) => t[0] === "d")?.[1];
    if (!d || !d.startsWith(EVENTKEYS_PREFIX)) continue;
    candidates++;
    let backup: EventKeysBackup;
    try {
      const json = await signer.nip44Decrypt(pubkey, e.content);
      backup = eventKeysBackupSchema.parse(JSON.parse(json));
    } catch {
      continue; // not our backup / undecryptable / SIGNER NOT READY / malformed
    }
    decrypted++;
    const coordinate = await resolveCoordinate(backup);
    if (!coordinate) continue;
    await restore(coordinate, backup);
    if (!restoredCoords.includes(coordinate)) restoredCoords.push(coordinate);
  }

  // Latch the once-per-session guard ONLY after a genuine sweep — otherwise a
  // remote signer (NIP-46/Amber) that wasn't reachable yet, or a relay race that
  // returned nothing, would permanently disable recovery and strand a real
  // organizer on "Visitor". A meaningful sweep is: we fetched app-data AND either
  // there were no eventkeys backups to read, or we successfully decrypted ≥1
  // (proving the signer can read them). Anything else stays retryable so the next
  // event-shell sync (a tab nav, or the signer finally answering) tries again.
  const meaningful = events.length > 0 && (candidates === 0 || decrypted > 0);
  if (meaningful) recovered.add(pubkey);
  return restoredCoords;
}

/** Reset the once-per-session guard (tests, or on logout). */
export function resetRecoveryGuard(): void {
  recovered.clear();
}
