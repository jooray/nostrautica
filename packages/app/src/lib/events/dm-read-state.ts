/**
 * Cross-device DM read state (kind-30078, `d = nostrautica:dmread`).
 *
 * DM *history* already syncs: every NIP-17 send produces a self-addressed wrap
 * alongside the recipient's, so any device can reconstruct the conversation. Read
 * state did not — `dm-unread.svelte.ts` kept its per-peer watermarks only in the
 * owner-scoped IndexedDB cache. Signing in on a second device therefore showed
 * every already-read message as unread again, and clearing the badge on a phone
 * left the laptop's badge untouched. The two devices never converged.
 *
 * This publishes the watermark map as a NIP-44 self-encrypted 30078, the same
 * user-private tier as per-event settings (§7.3) and the key-backup marker: peer
 * pubkeys sit inside the ciphertext, so a relay learns only that the account
 * wrote a read-state event, never who it talks to.
 *
 * ORDERING. 30078 is replaceable — last write wins on the wire — so a device
 * publishing its own map blind would erase whatever the other device recorded.
 * Every publish here is therefore read-merge-write: fetch the current event, fold
 * it into the local map with a per-peer maximum (`mergeWatermarks`), and publish
 * the union. The merge is commutative and monotone, so devices converge no matter
 * what order their writes land in, and a thread can never revert to unread.
 * `publishMonotonic` supplies the §3.1-monotonic `created_at` on top of that, so a
 * same-second write from two devices resolves rather than tie-and-loses.
 *
 * SIGNER PROMPTS. Reconciling costs one nip44Decrypt plus, only when something
 * actually changed, one nip44Encrypt and one signature. Callers must respect the
 * project rule that a remote signer is never prompted just to paint a badge:
 *
 *  - DM screens call this freely — they already drive `fetchDms()` through the
 *    same signer on every poll, so one more decrypt per minute costs nothing.
 *  - The app shell's background inbox poll calls it ONLY on its local-key branch,
 *    which already unwraps silently. Its remote-signer branch stays strictly
 *    ciphertext-only, so an Amber/NIP-46 user's nav badge reflects only what this
 *    device has read until they actually open Chat. That is the intended
 *    trade — a correct badge is not worth an unprompted signer dialog.
 */
import {
  KIND_APP_DATA,
  MAX_DM_READ_THREADS,
  dmReadStateSchema,
  pickLatest,
  PROTOCOL_VERSION,
  type DmReadState,
} from "@nostrautica/protocol";
import type { AppSigner } from "$lib/signer/types.js";
import type { VerifiedEvent } from "nostr-tools/pure";
import { fetchEvents } from "$lib/nostr/ndk.js";
import { publishMonotonic } from "$lib/nostr/monotonic.js";
import {
  dmUnread,
  sameWatermarks,
  type ReadWatermarks,
} from "$lib/stores/dm-unread.svelte.js";

export const DM_READ_STATE_D = "nostrautica:dmread";

/** Poll-driven reconciles are throttled to this; a local read advance bypasses it. */
const PULL_INTERVAL_MS = 60_000;
/** Coalesce a burst of local advances (opening several threads) into one publish. */
const PUBLISH_DEBOUNCE_MS = 4_000;

const HEX32 = /^[0-9a-f]{64}$/;

let lastPullAt = 0;
let inflight: Promise<void> | null = null;
/** A reconcile requested while one was already running — run once more after it. */
let queued = false;
let debounce: ReturnType<typeof setTimeout> | null = null;
let listeningFor: string | null = null;
let activeSigner: AppSigner | null = null;

/**
 * Drop entries the schema would reject on read-back. Watermarks only ever come
 * from incoming rumors (real 32-byte event ids keyed by a real pubkey), so this
 * should never fire — but one malformed entry would make the published payload
 * unparseable for EVERY device, which is a far worse failure than silently
 * omitting a thread. Cheap insurance on the write path.
 */
function sanitize(watermarks: ReadWatermarks): ReadWatermarks {
  const clean: ReadWatermarks = {};
  for (const [peer, position] of Object.entries(watermarks)) {
    if (!HEX32.test(peer) || !position || !HEX32.test(position.id)) continue;
    if (!Number.isInteger(position.at) || position.at < 0) continue;
    clean[peer] = { at: position.at, id: position.id };
  }
  return clean;
}

/**
 * The map as published: sanitized, then capped at the most recently read
 * MAX_DM_READ_THREADS so the whole thing stays inside one NIP-44 payload. Dropping
 * the oldest-read threads is the right sacrifice — those are the conversations
 * whose unread count the user is least likely to be watching, and a dropped entry
 * degrades to "this device's local watermark only", not to data loss.
 */
export function prunedForPublish(watermarks: ReadWatermarks): ReadWatermarks {
  const clean = sanitize(watermarks);
  const peers = Object.keys(clean);
  if (peers.length <= MAX_DM_READ_THREADS) return clean;
  const kept: ReadWatermarks = {};
  for (const peer of peers.sort((a, b) => clean[b].at - clean[a].at).slice(0, MAX_DM_READ_THREADS)) {
    kept[peer] = clean[peer];
  }
  return kept;
}

/** The published read state for `pubkey`, or null when absent/unreadable. */
async function fetchRemote(signer: AppSigner, pubkey: string): Promise<DmReadState | null> {
  const events = await fetchEvents({
    kinds: [KIND_APP_DATA],
    authors: [pubkey],
    "#d": [DM_READ_STATE_D],
  });
  // §3.1 ordering, not a plain created_at sort: two devices can publish in the
  // same second, and the tie-break decides which map is authoritative.
  const latest = pickLatest(events);
  if (!latest) return null;
  try {
    const json = await signer.nip44Decrypt(pubkey, latest.content);
    return dmReadStateSchema.parse(JSON.parse(json));
  } catch {
    // Unreadable (a payload from a future schema, a decrypt failure, corruption).
    // Treated as "no remote state": the local map is preserved, and the caller
    // republishes it, which self-heals the stored event.
    return null;
  }
}

async function publish(signer: AppSigner, pubkey: string, threads: ReadWatermarks): Promise<void> {
  const state: DmReadState = { v: PROTOCOL_VERSION, threads };
  const content = await signer.nip44Encrypt(pubkey, JSON.stringify(state));
  await publishMonotonic({
    kind: KIND_APP_DATA,
    author: pubkey,
    identifier: DM_READ_STATE_D,
    owner: pubkey,
    sign: (created_at) =>
      signer.signEvent({
        kind: KIND_APP_DATA,
        created_at,
        tags: [["d", DM_READ_STATE_D]],
        content,
      }) as Promise<VerifiedEvent>,
  });
}

async function reconcile(signer: AppSigner): Promise<void> {
  const pubkey = await signer.getPublicKey();
  const remote = await fetchRemote(signer, pubkey);
  if (remote) dmUnread.mergeRemoteWatermarks(pubkey, remote.threads);

  const local = prunedForPublish(dmUnread.readWatermarks);
  // Nothing read anywhere yet — an empty event is pure noise.
  if (Object.keys(local).length === 0) return;
  // Already identical on the relay: this is the steady state once devices agree,
  // so the common poll costs one fetch and stops there (no signature, no publish).
  if (remote && sameWatermarks(local, remote.threads)) return;
  await publish(signer, pubkey, local);
}

/**
 * Run a reconcile, collapsing concurrent callers. A request that arrives while
 * one is in flight sets `queued` rather than being dropped, so a read that lands
 * mid-flight is still published (it would otherwise sit unsynced until the next
 * poll — the exact "I marked it read and the other device never noticed" bug).
 */
function run(signer: AppSigner): Promise<void> {
  if (inflight) {
    queued = true;
    return inflight;
  }
  inflight = reconcile(signer)
    .catch(() => {
      /* offline, relay down, signer refused — retried by the next poll */
    })
    .finally(() => {
      inflight = null;
      if (queued) {
        queued = false;
        void run(signer);
      }
    });
  return inflight;
}

/**
 * Reconcile local read state with the account's published copy. Call from the DM
 * screens' existing poll loop; throttled to PULL_INTERVAL_MS so a 5s poll does not
 * become a 5s fetch+decrypt. Registers the local-advance listener on first call,
 * so marking a thread read schedules its own (debounced, unthrottled) publish.
 */
export async function syncDmReadState(signer: AppSigner, force = false): Promise<void> {
  const pubkey = await signer.getPublicKey();
  activeSigner = signer;

  if (listeningFor !== pubkey) {
    // Account switch without an intervening logout: the throttle and any pending
    // publish belong to the PREVIOUS identity. Firing that debounce now would
    // publish the old account's watermarks — which the store has already
    // re-pointed at the new owner — so drop it and let the new identity pull
    // immediately instead of waiting out a window it never opened.
    if (debounce) clearTimeout(debounce);
    debounce = null;
    lastPullAt = 0;
    listeningFor = pubkey;
    dmUnread.setLocalAdvanceListener((owner) => {
      if (owner !== listeningFor || !activeSigner) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        if (activeSigner) void run(activeSigner);
      }, PUBLISH_DEBOUNCE_MS);
    });
  }

  const now = Date.now();
  if (!force && now - lastPullAt < PULL_INTERVAL_MS) return;
  lastPullAt = now;
  await run(signer);
}

/**
 * Publish any debounced read advance now, without waiting out the debounce —
 * for leaving a DM screen or hiding the tab, where the timer may never fire.
 */
export function flushDmReadState(): void {
  if (!debounce || !activeSigner) return;
  clearTimeout(debounce);
  debounce = null;
  void run(activeSigner);
}

/** Drop all syncer state (logout, account switch, tests). */
export function resetDmReadStateSync(): void {
  if (debounce) clearTimeout(debounce);
  debounce = null;
  lastPullAt = 0;
  inflight = null;
  queued = false;
  listeningFor = null;
  activeSigner = null;
  dmUnread.setLocalAdvanceListener(null);
}
