/**
 * Blinding-key derivation for the attendee's own self-stores (spec §6.6).
 *
 * For per-attendee self-stores (kind 31602) the blinding key is "the attendee's
 * NIP-44 self-conversation-key". A local-key signer exposes its secret, so we
 * compute that key exactly. A remote signer (NIP-07/46) never reveals a secret
 * and won't hand out a raw conversation key, so we derive an equivalent stable
 * per-user secret out of band: a random 32-byte seed self-encrypted into a
 * kind-30078 entry (`d = nostrautica:blindseed`). It is secret (only the user
 * can decrypt it) and deterministic for the owner — the two properties §6.6 needs.
 *
 * (Blinded d's for directory/roster/match entries use the ECK, which every
 * entitled party already holds — no self-key needed there.)
 */
import {
  selfConversationKey,
  bytesToBase64,
  base64ToBytes,
  KIND_APP_DATA,
} from "@nostrautica/protocol";
import type { AppSigner } from "$lib/signer/types.js";
import { fetchEvents } from "$lib/nostr/ndk.js";
import { publishOrQueue } from "$lib/nostr/publish-queue.js";
import { cacheGet, cacheSet } from "$lib/cache/persist.js";

const BLINDSEED_D = "nostrautica:blindseed";
// Persist the remote-signer blind seed owner-scoped (CACHING-PLAN §2.9). This is
// the same secret-at-rest class as the ECK / local-sk already in IndexedDB
// (SPECIFICATION.md §14) and is wiped on logout by clearOwnerCache. Persisting it
// saves one Amber/NIP-07 prompt + relay fetch per session for remote-signer users
// (local-key derivation stays purely computed — never cached).
const BLINDSEED_CACHE_KEY = "blindseed";

// The blinding key is stable per identity, but the remote-signer path costs a
// relay fetch plus a live NIP-44 decrypt (an Amber/NIP-07 prompt) — memoize per
// pubkey so one session pays that at most once. Cleared on logout.
const blindCache = new Map<string, Promise<Uint8Array>>();

export function clearBlindingCache(): void {
  blindCache.clear();
}

export async function deriveBlindingKey(signer: AppSigner): Promise<Uint8Array> {
  const sk = signer.getSecretKey?.();
  if (sk) return selfConversationKey(sk);
  const pubkey = await signer.getPublicKey();
  // Cache the promise (not the value) so concurrent callers share one fetch;
  // drop it on failure so the next call can retry.
  let pending = blindCache.get(pubkey);
  if (!pending) {
    pending = getOrCreateBlindSeed(signer, pubkey);
    blindCache.set(pubkey, pending);
    pending.catch(() => blindCache.delete(pubkey));
  }
  return pending;
}

async function getOrCreateBlindSeed(signer: AppSigner, pubkey: string): Promise<Uint8Array> {
  // Cross-session cache hit: no relay fetch, no signer prompt (§2.9).
  const cached = cacheGet<string>(BLINDSEED_CACHE_KEY, pubkey);
  if (cached) {
    const bytes = base64ToBytes(cached.data);
    if (bytes.length === 32) return bytes;
  }
  const existing = await fetchEvents({
    kinds: [KIND_APP_DATA],
    authors: [pubkey],
    "#d": [BLINDSEED_D],
  });
  if (existing[0]) {
    const b64 = await signer.nip44Decrypt(pubkey, existing[0].content);
    const bytes = base64ToBytes(b64);
    if (bytes.length === 32) {
      cacheSet(BLINDSEED_CACHE_KEY, b64, existing[0].created_at ?? 0, pubkey);
      return bytes;
    }
  }

  const seed = crypto.getRandomValues(new Uint8Array(32));
  const seedB64 = bytesToBase64(seed);
  const content = await signer.nip44Encrypt(pubkey, seedB64);
  const event = await signer.signEvent({
    kind: KIND_APP_DATA,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["d", BLINDSEED_D]],
    content,
  });
  await publishOrQueue(event);
  cacheSet(BLINDSEED_CACHE_KEY, seedB64, event.created_at, pubkey);
  return seed;
}
