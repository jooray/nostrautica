/**
 * Durable account-key backup marker (audit G2 part 3 / U6).
 *
 * The readiness journey's "Backup secured" step used to be a transient,
 * device-local nag (`backup-nag.svelte.ts`, localStorage) — it claimed "secured"
 * the moment the user dismissed it, and a fresh device forgot it entirely. This
 * records a DURABLE, relay-persisted marker (a self-encrypted kind-30078,
 * `d = nostrautica:keybackup`) when the user actually completes a backup ceremony
 * (copy nsec / email / ncryptsec). It survives a device wipe, so readiness can
 * report "secured" honestly and recover the signal on a fresh device.
 */
import { KIND_APP_DATA } from "@nostrautica/protocol";
import type { AppSigner } from "$lib/signer/types.js";
import { fetchEvents } from "$lib/nostr/ndk.js";
import { publishOrQueue } from "$lib/nostr/publish-queue.js";
import { cacheGet, cacheSet } from "$lib/cache/persist.js";

const KEY_BACKUP_D = "nostrautica:keybackup";
// Persist the confirmed marker per owner (CACHING-PLAN §2.10) so readiness reports
// "secured" instantly on reload — a monotone true (never re-nag a backed-up user).
const KEY_BACKUP_CACHE_KEY = "keybackup";

// A confirmed marker never becomes false again, so once we've seen it this
// session we can answer "yes" even offline (avoids re-nagging a backed-up user).
const confirmed = new Set<string>();

/** Record that the user completed a durable key backup (publishes a 30078 marker). */
export async function markKeyBackedUp(signer: AppSigner): Promise<void> {
  const pubkey = await signer.getPublicKey();
  const content = await signer.nip44Encrypt(
    pubkey,
    JSON.stringify({ v: 1, at: Math.floor(Date.now() / 1000) }),
  );
  const event = await signer.signEvent({
    kind: KIND_APP_DATA,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["d", KEY_BACKUP_D]],
    content,
  });
  await publishOrQueue(event);
  confirmed.add(pubkey);
  cacheSet(KEY_BACKUP_CACHE_KEY, true, Math.floor(Date.now() / 1000), pubkey);
}

/**
 * Whether the identity has a durable key-backup marker on relays. Existence of
 * the replaceable 30078 is the signal (no decrypt needed). Cached positively for
 * the session so a later offline check still reports secured.
 */
export async function hasDurableKeyBackup(signer: AppSigner): Promise<boolean> {
  const pubkey = await signer.getPublicKey();
  if (confirmed.has(pubkey)) return true;
  // Persisted marker: report secured instantly on a reload, before the network.
  if (cacheGet<boolean>(KEY_BACKUP_CACHE_KEY, pubkey)?.data) {
    confirmed.add(pubkey);
    return true;
  }
  const events = await fetchEvents({
    kinds: [KIND_APP_DATA],
    authors: [pubkey],
    "#d": [KEY_BACKUP_D],
  });
  const has = events.length > 0;
  if (has) {
    confirmed.add(pubkey);
    cacheSet(KEY_BACKUP_CACHE_KEY, true, Math.floor(Date.now() / 1000), pubkey);
  }
  return has;
}

/** Clear the in-session cache (tests). */
export function resetKeyBackupCache(): void {
  confirmed.clear();
}
