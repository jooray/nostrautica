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

const BLINDSEED_D = "nostrautica:blindseed";

export async function deriveBlindingKey(signer: AppSigner): Promise<Uint8Array> {
  const sk = signer.getSecretKey?.();
  if (sk) return selfConversationKey(sk);
  return getOrCreateBlindSeed(signer);
}

async function getOrCreateBlindSeed(signer: AppSigner): Promise<Uint8Array> {
  const pubkey = await signer.getPublicKey();
  const existing = await fetchEvents({
    kinds: [KIND_APP_DATA],
    authors: [pubkey],
    "#d": [BLINDSEED_D],
  });
  if (existing[0]) {
    const b64 = await signer.nip44Decrypt(pubkey, existing[0].content);
    const bytes = base64ToBytes(b64);
    if (bytes.length === 32) return bytes;
  }

  const seed = crypto.getRandomValues(new Uint8Array(32));
  const content = await signer.nip44Encrypt(pubkey, bytesToBase64(seed));
  const event = await signer.signEvent({
    kind: KIND_APP_DATA,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["d", BLINDSEED_D]],
    content,
  });
  await publishOrQueue(event);
  return seed;
}
