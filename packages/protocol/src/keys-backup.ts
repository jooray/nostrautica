/**
 * Union of two copies of an organizer's 30078 event-keys backup (audit SB-89).
 *
 * Every device of the account writes the SAME address
 * (`nostrautica:eventkeys:<blinded>`), and each used to publish its own local
 * snapshot, so the last device to rotate or attach defined the account's
 * recoverable custody for every device: the other device's ECK version and its
 * install generation were simply gone from the backup. Writers now read the
 * current backup, merge it with this, and publish the union; recovery merges the
 * same way.
 *
 * - ECK versions: union by `(id, key)` (NIP §4.1), staged ones kept staged
 *   unless the other side already has them as current.
 * - `coordinator_gen`: the maximum (generations only grow, NIP §3.5).
 * - E_inbox: every secret either side holds survives. The CURRENT one is the
 *   inbox the newest 31600 names when the caller knows it (`configInbox`, a
 *   pubkey); otherwise `a`'s (the caller passes its own copy first). Every other
 *   secret goes to `prior_einbox_nsecs`, where it still reads old submissions.
 */
import { getPublicKey } from "nostr-tools/pure";
import { hexToBytes } from "@noble/hashes/utils";
import { unionEck } from "./eck-identity.js";
import { MAX_PRIOR_INBOXES, PROTOCOL_VERSION, type EventKeysBackup } from "./schemas.js";

function inboxPubkey(secretHex: string): string | undefined {
  try {
    return getPublicKey(hexToBytes(secretHex));
  } catch {
    return undefined;
  }
}

export function mergeEventKeysBackups(
  a: EventKeysBackup,
  b: EventKeysBackup,
  opts: { configInbox?: string } = {},
): EventKeysBackup {
  const eck = unionEck(a.eck, b.eck);
  const pending = unionEck(a.pending_eck ?? [], b.pending_eck ?? []).filter(
    (p) => !eck.some((v) => v.id === p.id && v.key === p.key),
  );
  const inboxes = [
    ...new Set([a.einbox_nsec, b.einbox_nsec, ...(a.prior_einbox_nsecs ?? []), ...(b.prior_einbox_nsecs ?? [])]),
  ];
  const named = opts.configInbox ? inboxes.find((s) => inboxPubkey(s) === opts.configInbox) : undefined;
  const current = named ?? a.einbox_nsec;
  // Newest retirements are the likeliest to still hold unread submissions, so
  // when the cap bites the oldest go first.
  const prior = inboxes.filter((s) => s !== current).slice(-MAX_PRIOR_INBOXES);
  const gen = Math.max(a.coordinator_gen ?? 0, b.coordinator_gen ?? 0);
  return {
    v: PROTOCOL_VERSION,
    ...((a.a ?? b.a) ? { a: a.a ?? b.a } : {}),
    eid_nsec: a.eid_nsec,
    einbox_nsec: current,
    eck,
    coordinator_gen: gen,
    ...(pending.length > 0 ? { pending_eck: pending } : {}),
    ...(prior.length > 0 ? { prior_einbox_nsecs: prior } : {}),
  };
}
