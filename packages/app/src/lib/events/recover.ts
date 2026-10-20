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
  blindedD,
  compareLatest,
  unionEck,
  type EventKeysBackup,
} from "@nostrautica/protocol";
import { deriveBlindingKey } from "./blinding.js";
import { getPublicKey } from "nostr-tools/pure";
import type { AppSigner } from "$lib/signer/types.js";
import { fetchEvents } from "$lib/nostr/ndk.js";
import { DEFAULT_RELAYS } from "$lib/nostr/relays.js";
import { cacheGet, cacheSet } from "$lib/cache/persist.js";
import { loadEventKeys, listEventKeys, saveEventKeys, activeKeystoreOwner } from "./keystore.js";
import {
  startScanBudget,
  emptyOutcome,
  type ScanBudget,
  type ScanOutcome,
} from "./scan-budget.js";

const EVENTKEYS_PREFIX = "nostrautica:eventkeys:";

// One recovery pass per identity per session is enough (the keystore is a
// durable local cache once restored). A failed pass isn't marked, so it retries.
const recovered = new Set<string>();

/** Cap on the persisted backup memo, mirroring attendee.ts's MAX_GRANT_WRAPS. */
export const MAX_RECOVERED_BACKUPS = 2000;

/**
 * Per-30078 memo (owner-scoped, persisted), mirroring the grant-wrap memo in
 * attendee.ts.
 *
 * The `d`-prefix test above already costs nothing for a FOREIGN 30078, so this
 * is not about other apps' app-data. It is about our own: an organizer with a
 * dozen events has one backup per event plus one per ECK rotation and attach,
 * and paid a `nip44Decrypt` for every one of them on every session — each of
 * which then restored a record the keystore already held. On a remote signer
 * that is a round trip (possibly an Amber dialog) each, drawn from the SAME
 * 50-call allowance `receiveGrants` needs to walk gift wraps, and the two scans
 * run concurrently from one budget: the re-decrypts could exhaust it before the
 * grant scan reached the wrap carrying a newly-joined event. Which is to say
 * this memo is here to stop recovery from starving discovery.
 *
 * A 30078 is addressable, so a rewritten backup is a NEW event id: memoizing by
 * id can never pin a stale backup. And the memo is bypassed entirely whenever it
 * could cost us custody rather than save a prompt — see `trustMemo`.
 */
function backupMemoKey(): string {
  return "eventkeysbackups";
}

function loadBackupMemo(): Record<string, true> {
  return { ...(cacheGet<Record<string, true>>(backupMemoKey())?.data ?? {}) };
}

function saveBackupMemo(memo: Record<string, true>): void {
  const keys = Object.keys(memo);
  if (keys.length > MAX_RECOVERED_BACKUPS) {
    const keep = new Set(keys.slice(-MAX_RECOVERED_BACKUPS));
    for (const k of keys) if (!keep.has(k)) delete memo[k];
  }
  cacheSet(backupMemoKey(), memo, Math.floor(Date.now() / 1000));
}

/**
 * Resolve the event coordinate a backup belongs to. New backups carry `a`
 * directly; older ones are reconstructed from the E_id key + the event's
 * published 31600 config (its `d` tag), fetched from relays.
 */
async function resolveCoordinate(
  backup: EventKeysBackup,
  backupD: string,
  signer: AppSigner,
): Promise<string | undefined> {
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
  // Every distinct `d` this E_id has published a 31600 at is a candidate. "The
  // newest config" was not an answer to "which event is this backup for": with
  // two events under one E_id it picked whichever was edited last (and on a
  // created_at tie, whichever the relay sent first), and restored the backup's
  // E_id/inbox secrets into that coordinate (audit SB-93).
  const ds = [
    ...new Set(
      configs
        .filter((e) => e.pubkey === eidPubkey)
        .map((e) => e.tags.find((t) => t[0] === "d")?.[1])
        .filter((d): d is string => !!d),
    ),
  ];
  if (ds.length <= 1) return ds[0] ? makeCoordinate(eidPubkey, ds[0]) : undefined;
  // Several: the backup's own `d` is blinded over its coordinate, so recompute it
  // for each candidate and take the one that matches. Costs a blinding-key
  // derivation, only on this legacy (no `a`) path. No match → unresolved, which
  // stays retryable (nothing is memoized for it).
  let blindingKey: Uint8Array;
  try {
    blindingKey = await deriveBlindingKey(signer);
  } catch {
    return undefined;
  }
  const ownPubkey = await signer.getPublicKey();
  for (const d of ds) {
    const coordinate = makeCoordinate(eidPubkey, d);
    if (`${EVENTKEYS_PREFIX}${blindedD(blindingKey, coordinate, ownPubkey)}` === backupD) return coordinate;
  }
  return undefined;
}

/**
 * Restore a backup into the keystore, merging with any existing local record so
 * a fresher local ECK set (e.g. after a revocation rotation) is never clobbered
 * by an older backup — union the ECK versions, keep local secrets when present.
 */
async function restore(coordinate: string, backup: EventKeysBackup, owner: string): Promise<void> {
  const existing = await loadEventKeys(coordinate, owner).catch(() => undefined);
  await saveEventKeys({
    coordinate,
    role: "organizer",
    // By (id, key): a backup holding the other key of a same-id collision adds
    // it rather than being skipped as "already held" (NIP §4.1, audit SB-86).
    eck: unionEck(existing?.eck ?? [], backup.eck),
    eidNsecHex: existing?.eidNsecHex ?? backup.eid_nsec,
    einboxNsecHex: existing?.einboxNsecHex ?? backup.einbox_nsec,
    // The install generation (NIP §3.5) only grows — keep the higher of the local
    // record and the backup so a re-attach on a fresh device still increments past
    // the last-used gen instead of colliding at gen 1.
    coordinatorGen: Math.max(existing?.coordinatorGen ?? 0, backup.coordinator_gen ?? 0) || undefined,
  }, owner);
}

/**
 * Read the identity's kind-30078 eventkeys backups and restore organizer custody
 * into the local keystore. Returns the coordinates recovered. Idempotent and
 * cheap to call on every device/identity load (guarded to run once per session).
 *
 * Bounded (see `scan-budget.ts`): every backup costs one `nip44Decrypt`, which
 * on a remote signer is a round trip with a 60s ceiling and possibly a human
 * approval dialog. Walking an unbounded list of them is the prompt storm the
 * 2026-07-28 "my events vanished" report ran into. `opts.budget` lets a caller
 * share one allowance across several scans; `opts.onOutcome` reports whether
 * this pass can be trusted as complete, so the caller can say "your signer
 * didn't answer" instead of "you have no events".
 */
export async function recoverEventKeys(
  signer: AppSigner,
  opts: {
    force?: boolean;
    budget?: ScanBudget;
    onOutcome?: (outcome: ScanOutcome) => void;
  } = {},
): Promise<string[]> {
  const pubkey = await signer.getPublicKey();
  if (!opts.force && recovered.has(pubkey)) return [];

  const budget = (opts.budget ?? startScanBudget()).fork();
  const outcome = emptyOutcome();
  // The memo is a PROMPT saver, never a correctness input, so it is trusted only
  // when skipping a backup cannot cost anything. An empty keystore means this
  // device holds no custody at all — a wipe, a fresh install, a restored
  // identity — and that is exactly the moment recovery must re-read every backup
  // it can find, memo or no memo. `force` is the user saying the same thing out
  // loud.
  const held = await listEventKeys(pubkey).catch(() => []);
  const trustMemo = !opts.force && held.length > 0;
  const memo = loadBackupMemo();
  let memoDirty = false;
  try {
    const events = await fetchEvents(
      { kinds: [KIND_APP_DATA], authors: [pubkey] },
      DEFAULT_RELAYS,
    );

    const restoredCoords: string[] = [];
    let candidates = 0; // eventkeys backups we saw
    let decrypted = 0; // …of which we could actually read
    // NEWEST FIRST (audit EV-10). Two 30078 backups per coordinate are ordinary —
    // one is written on every ECK rotation and again on attach — and relays return
    // them in whatever order they like. `restore()` unions the ECK versions but
    // takes the SECRETS first-writer-wins, so decrypting a stale backup first pins
    // a superseded E_inbox as current, and joins sealed to the inbox the published
    // 31600 actually names become unreadable. Ordering here rather than grouping by
    // coordinate because the coordinate only exists after the decrypt, and the
    // decrypt is the thing the budget below is rationing: this way a truncated pass
    // has spent its allowance on the newest backups rather than an arbitrary set.
    const ordered = [...events].sort(compareLatest); // §3.1 order, ties by lowest id

    for (const e of ordered) {
      const d = e.tags.find((t) => t[0] === "d")?.[1];
      if (!d || !d.startsWith(EVENTKEYS_PREFIX)) continue;
      candidates++;
      // Already decrypted and restored in an earlier pass, and the keystore still
      // holds custody — re-reading it would re-derive a record we have.
      if (trustMemo && memo[e.id]) {
        // Counts as read for the `meaningful` test below: skipping it is only
        // legitimate BECAUSE we once read it successfully, so a sweep made
        // entirely of memo hits is a complete sweep, not a signer outage.
        decrypted++;
        continue;
      }
      // Out of time or out of prompts: stop rather than start another decrypt.
      // The sweep is resumable — nothing here is memoized as a negative — so a
      // truncated pass costs a retry, while continuing costs the user an
      // open-ended chain of signer dialogs with no way to tell it is happening.
      if (!budget.take()) {
        outcome.truncated = true;
        break;
      }
      outcome.attempted++;
      let backup: EventKeysBackup;
      try {
        const json = await signer.nip44Decrypt(pubkey, e.content);
        backup = eventKeysBackupSchema.parse(JSON.parse(json));
      } catch {
        continue; // not our backup / undecryptable / SIGNER NOT READY / malformed
      }
      outcome.succeeded++;
      decrypted++;
      const coordinate = await resolveCoordinate(backup, d, signer);
      if (!coordinate) continue;
      // The session moved on while we awaited the signer/relays (audit DS41-001):
      // a logout, or a switch to another account. This backup is `pubkey`'s
      // custody, and the write used to resolve its owner NOW — filing A's E_id
      // and E_inbox nsecs under B. Stop instead; nothing below is memoized, so
      // the next session of this identity re-reads it.
      if (activeKeystoreOwner() !== pubkey) {
        outcome.truncated = true;
        break;
      }
      await restore(coordinate, backup, pubkey);
      // Definitive: decrypted, resolved, and written to the keystore. Only now —
      // a backup whose coordinate could not be resolved stays un-memoized, since
      // that depends on a 31600 read that may simply have failed this time.
      memo[e.id] = true;
      memoDirty = true;
      if (!restoredCoords.includes(coordinate)) restoredCoords.push(coordinate);
    }
    if (memoDirty) saveBackupMemo(memo);

    // Latch the once-per-session guard ONLY after a genuine sweep — otherwise a
    // remote signer (NIP-46/Amber) that wasn't reachable yet, or a relay race that
    // returned nothing, would permanently disable recovery and strand a real
    // organizer on "Visitor". A meaningful sweep is: we fetched app-data, we did
    // not run out of budget partway, AND either there were no eventkeys backups
    // to read, or we successfully decrypted ≥1 (proving the signer can read
    // them). Anything else stays retryable so the next event-shell sync (a tab
    // nav, or the signer finally answering) tries again.
    const meaningful =
      !outcome.truncated && events.length > 0 && (candidates === 0 || decrypted > 0);
    if (meaningful) recovered.add(pubkey);
    return restoredCoords;
  } finally {
    opts.onOutcome?.(outcome);
  }
}

/** Reset the once-per-session guard (tests, or on logout). */
export function resetRecoveryGuard(): void {
  recovered.clear();
}
