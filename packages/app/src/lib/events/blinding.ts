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
  pickLatest,
  KIND_APP_DATA,
} from "@nostrautica/protocol";
import type { AppSigner } from "$lib/signer/types.js";
import { fetchEventsAnswered } from "$lib/nostr/ndk.js";
import { publishOrQueue } from "$lib/nostr/publish-queue.js";
import { cacheGet, cacheSet, cacheGeneration, whenCacheReady } from "$lib/cache/persist.js";
import { withExclusiveLock } from "$lib/util/exclusive-lock.js";

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

/**
 * Thrown when the stored seed could not be read and minting a replacement would
 * therefore be a guess. Callers degrade — the features that need a blinding key
 * go unavailable for the session — rather than silently re-keying the user.
 */
export class BlindSeedUnavailableError extends Error {
  constructor() {
    super("blinding seed could not be read and must not be replaced by a guess");
    this.name = "BlindSeedUnavailableError";
  }
}

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

/**
 * The stored seed, or a new one — and the ONLY function allowed to decide that
 * there isn't a stored one.
 *
 * Minting is not a fallback, it is a REPLACEMENT: the seed lives in a
 * replaceable kind-30078, so publishing a fresh one overwrites the old one on
 * every relay, and it is unrecoverable. The seed derives the blinded `d`
 * literals for this user's reuse library and their per-event settings, so a new
 * one silently orphans every intro they have ever recorded and every
 * "want to meet" they have ever ticked — on this device and all the others.
 * Nothing shows an error; the library simply appears empty from then on.
 *
 * Both reads it used to trust could be empty for reasons that have nothing to do
 * with the seed's existence:
 *
 *  - the CACHE is cold for the first second or so of every boot, because boot
 *    deliberately does not wait for IndexedDB (§7.4.5);
 *  - `fetchEvents` resolves with whatever arrived by EOSE-or-timeout, so venue
 *    Wi-Fi, a slow relay or a cold connection all produce an empty array that is
 *    indistinguishable from "this user has no seed".
 *
 * Note this path runs ONLY for remote signers (a local key derives the same
 * secret arithmetically and never stores anything), which is the population most
 * exposed to slow reads in the first place.
 *
 * So: wait for the cache to actually be read, and require a relay to have said
 * EOSE before believing an absence. Anything else throws, and the caller loses a
 * feature for the session instead of their library forever.
 */
async function getOrCreateBlindSeed(signer: AppSigner, pubkey: string): Promise<Uint8Array> {
  // Cross-session cache hit: no relay fetch, no signer prompt (§2.9). Behind the
  // real bulk read, or a cold miss here sends us on to mint a new seed.
  await whenCacheReady();
  const fromCache = cachedSeed(pubkey);
  if (fromCache) return fromCache;
  // A logout while the relay read or signer decrypt is in flight must not write
  // this identity's seed back over the wipe.
  const gen = cacheGeneration();
  // Read → mint → publish is ONE critical section per account, across tabs
  // (audit DS41-012). Two tabs of a remote-signer account used to both read "no
  // seed, relay answered", both mint, and both publish a replaceable 30078 —
  // each then kept its own seed for the session, so every blinded address (reuse
  // library, per-event settings, self-copies) differed between them. The second
  // tab now waits, and its relay read inside the lock finds the first one's seed.
  return withExclusiveLock(`nostrautica-blindseed:${pubkey}`, async () => {
    const again = cachedSeed(pubkey);
    if (again) return again;
    return readOrMintBlindSeed(signer, pubkey, gen);
  });
}

function cachedSeed(pubkey: string): Uint8Array | undefined {
  const cached = cacheGet<string>(BLINDSEED_CACHE_KEY, pubkey);
  if (!cached) return undefined;
  const bytes = base64ToBytes(cached.data);
  return bytes.length === 32 ? bytes : undefined;
}

/**
 * Decrypt one stored seed event, or undefined when its content is not a seed.
 * The signer's own failures propagate (a prompt the user dismissed is not
 * evidence the seed is unreadable).
 */
async function decryptSeed(
  signer: AppSigner,
  pubkey: string,
  event: { content: string },
): Promise<{ bytes: Uint8Array; b64: string } | undefined> {
  const b64 = await signer.nip44Decrypt(pubkey, event.content);
  const bytes = base64ToBytes(b64);
  return bytes.length === 32 ? { bytes, b64 } : undefined;
}

async function readOrMintBlindSeed(
  signer: AppSigner,
  pubkey: string,
  gen: number,
): Promise<Uint8Array> {
  const filter = { kinds: [KIND_APP_DATA], authors: [pubkey], "#d": [BLINDSEED_D] };
  const { events: existing, answered } = await fetchEventsAnswered(filter);
  // The replaceable winner by the §3.1 rule (newest, then lowest id), not
  // whichever copy a relay happened to list first: two copies are exactly the
  // split this function exists to avoid, and every reader must pick the same one.
  const latest = pickLatest(existing);
  if (latest) {
    const seed = await decryptSeed(signer, pubkey, latest);
    if (seed) {
      cacheSet(BLINDSEED_CACHE_KEY, seed.b64, latest.created_at ?? 0, pubkey, gen);
      return seed.bytes;
    }
    // An event IS there and we could not make sense of it. That is the one case
    // where absence is definitely wrong, so it is the last case that should mint.
    throw new BlindSeedUnavailableError();
  }
  // Nobody said EOSE: the read was bounded by a timeout, not by an answer.
  if (!answered) throw new BlindSeedUnavailableError();

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
  // Re-read the relay winner (DS41-012). The lock covers this browser profile;
  // another DEVICE of the same account can have minted in the same window, and
  // relays keep one of the two. Adopt whichever they kept so this device does not
  // spend the session (and, through the cache, every later one) on a seed the
  // account's other devices will never see. Best effort: no answer keeps ours.
  const after = await fetchEventsAnswered(filter).catch(() => undefined);
  const winner = after ? pickLatest([...after.events, event]) : undefined;
  if (winner && winner.id !== event.id) {
    const adopted = await decryptSeed(signer, pubkey, winner).catch(() => undefined);
    if (adopted) {
      cacheSet(BLINDSEED_CACHE_KEY, adopted.b64, winner.created_at ?? 0, pubkey, gen);
      return adopted.bytes;
    }
  }
  cacheSet(BLINDSEED_CACHE_KEY, seedB64, event.created_at, pubkey, gen);
  return seed;
}
