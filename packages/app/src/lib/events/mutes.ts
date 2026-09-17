/**
 * NIP-51 mute list (kind 10000), audit finding U10. Blocking is done through the
 * standard Nostr mute list authored by the active identity — never a custom
 * event-scoped block kind — so mutes round-trip with other Nostr clients.
 *
 * Muted pubkeys are stored as PRIVATE `p` items (muting is sensitive): the tag
 * array is NIP-44 self-encrypted into the event `content`. Public items and any
 * unknown tags (`t` words, `e` threads, future kinds) are preserved verbatim on
 * a fetch-merge-write — we never blind-overwrite, exactly like the kind-3 follow
 * pattern (spec §5.4).
 *
 * The merge helpers are pure (no relay I/O) so the read/merge/write invariants
 * are unit-tested directly.
 */
import {
  KIND_MUTE_LIST,
  pickLatest,
  isNip44Ciphertext,
  isNip04Ciphertext,
} from "@nostrautica/protocol";
import type { AppSigner } from "$lib/signer/types.js";
import type { VerifiedEvent } from "nostr-tools/pure";
import { fetchEvents } from "$lib/nostr/ndk.js";
import { onlyVerified, onlyByAuthors } from "$lib/nostr/verify.js";
import { publishMonotonic } from "$lib/nostr/monotonic.js";

export type Tag = string[];

export interface MuteListState {
  /** Public tags on the event (p/t/word/e + any unknown), preserved verbatim. */
  publicTags: Tag[];
  /** Private tags decrypted from the event content, preserved verbatim. */
  privateTags: Tag[];
}

export const EMPTY_MUTE_LIST: MuteListState = { publicTags: [], privateTags: [] };

/**
 * The stored list exists but its private section is not something this client
 * can read — in practice a NIP-04 list written by an older client (NIP-51's
 * private items predate NIP-44, and Amethyst/Damus wrote them that way for
 * years), or a payload from some future scheme.
 *
 * A distinct type because the three things that see it need three different
 * answers, and a generic decrypt failure gave them all the same wrong one:
 *  - the store may LATCH on it (the condition is deterministic — that payload
 *    will not become NIP-44 on the next try, so re-reading it every time a
 *    mute-aware screen mounts is pure noise, and on a remote signer it was a
 *    failed round trip and a "Signing Failed" notification each time);
 *  - a WRITE must still refuse (see `fetchMuteList` — an unreadable list must
 *    never be flattened to "empty" and republished over);
 *  - the UI can say what is actually wrong instead of surfacing the signer's
 *    own error, which blames the signer for a payload it read correctly.
 */
export class UnreadableMuteListError extends Error {
  /** True when the stored payload is legacy NIP-04 rather than merely malformed. */
  readonly legacy: boolean;
  constructor(legacy: boolean) {
    super(
      legacy
        ? "mute list is NIP-04 encrypted (written by an older client); this client only reads NIP-44"
        : "mute list content is not a NIP-44 payload",
    );
    this.name = "UnreadableMuteListError";
    this.legacy = legacy;
  }
}

/** Every muted pubkey, from both public and private `p` items. */
export function mutedPubkeys(state: MuteListState): Set<string> {
  const out = new Set<string>();
  for (const t of [...state.publicTags, ...state.privateTags]) {
    if (t[0] === "p" && t[1]) out.add(t[1]);
  }
  return out;
}

/** True if `pubkey` appears in either the public or private `p` items. */
export function isMuted(state: MuteListState, pubkey: string): boolean {
  return mutedPubkeys(state).has(pubkey);
}

/**
 * Add `pubkey` as a PRIVATE mute. No-op (returns the same state) if it is
 * already muted publicly or privately, so we never create a duplicate.
 */
export function addPrivateMute(state: MuteListState, pubkey: string): MuteListState {
  if (isMuted(state, pubkey)) return state;
  return { publicTags: state.publicTags, privateTags: [...state.privateTags, ["p", pubkey]] };
}

/**
 * Remove `pubkey` from BOTH public and private `p` items (unmute), leaving every
 * other tag — including non-`p` public/private items — untouched.
 */
export function removeMute(state: MuteListState, pubkey: string): MuteListState {
  const drop = (tags: Tag[]) => tags.filter((t) => !(t[0] === "p" && t[1] === pubkey));
  return { publicTags: drop(state.publicTags), privateTags: drop(state.privateTags) };
}

/**
 * Fetch the latest kind-10000, decrypting the self-encrypted private items.
 *
 * THROWS when a list exists whose content cannot be decrypted. It used to
 * swallow that and return the public tags with `privateTags: []`, which reads as
 * a correct fail-soft until you follow it into `setMuted`: the very next step is
 * a merge-and-republish, and an empty private list re-encrypts to `content: ""`.
 * One NIP-46 round-trip that timed out while the user tapped "mute" therefore
 * wiped every private mute they had — silently, and irrecoverably, since
 * kind-10000 is replaceable and muting is exactly the thing people do not
 * re-notice until the person they blocked is back in their feed. "Couldn't read
 * it" and "there is nothing in it" have to be different answers here.
 *
 * A list whose content is not a NIP-44 payload at all throws
 * {@link UnreadableMuteListError} WITHOUT consulting the signer — same refusal,
 * no round trip, and with enough detail for the caller to stop asking and to
 * explain itself.
 */
export async function fetchMuteList(signer: AppSigner): Promise<MuteListState> {
  const pubkey = await signer.getPublicKey();
  const events = await fetchEvents({ kinds: [KIND_MUTE_LIST], authors: [pubkey] });
  // Pin to the user's own key before the latest-wins pick: `authors` is a request
  // a relay may ignore, and now that an undecryptable list is fatal rather than
  // ignored, a foreign kind-10000 with a high created_at would otherwise wedge
  // mute/unmute permanently. Only the user's own list is self-decryptable anyway.
  const latest = pickLatest(onlyByAuthors(onlyVerified(events), [pubkey]));
  if (!latest) return { ...EMPTY_MUTE_LIST };
  let privateTags: Tag[] = [];
  if (latest.content) {
    // Ask the SHAPE before asking the signer. A remote signer is a relay round
    // trip to someone's phone, and this content is not ours to assume about:
    // kind-10000 is the shared NIP-51 mute list, so whatever the user's other
    // clients wrote is what we find here. See `isNip44Ciphertext` for the
    // 2026-09-17 report this closes — a 2024-vintage NIP-04 list that made every
    // visit to a mute-aware screen fire a failed decrypt at the user's signer.
    if (!isNip44Ciphertext(latest.content)) {
      throw new UnreadableMuteListError(isNip04Ciphertext(latest.content));
    }
    const parsed = JSON.parse(await signer.nip44Decrypt(pubkey, latest.content));
    if (Array.isArray(parsed)) privateTags = parsed.filter((t) => Array.isArray(t)) as Tag[];
  }
  return { publicTags: (latest.tags as Tag[]) ?? [], privateTags };
}

/** Sign & publish a replacement kind-10000, re-encrypting the private items. */
export async function saveMuteList(signer: AppSigner, state: MuteListState): Promise<void> {
  const pubkey = await signer.getPublicKey();
  const content = state.privateTags.length
    ? await signer.nip44Encrypt(pubkey, JSON.stringify(state.privateTags))
    : "";
  // Monotonic (R6): kind-10000 is replaceable; a rapid mute-then-unmute must win
  // the §3.1 tie-break rather than tie on created_at and lose the id comparison.
  await publishMonotonic({
    kind: KIND_MUTE_LIST,
    author: pubkey,
    owner: pubkey,
    sign: (created_at) =>
      signer.signEvent({
        kind: KIND_MUTE_LIST,
        created_at,
        tags: state.publicTags,
        content,
      }) as Promise<VerifiedEvent>,
  });
}

/**
 * Mute or unmute `pubkey`: fetch the current list, merge the change, publish, and
 * return the resulting muted set. Fetch-first so concurrent-device edits and
 * unknown tags survive.
 */
export async function setMuted(
  signer: AppSigner,
  pubkey: string,
  muted: boolean,
): Promise<Set<string>> {
  const state = await fetchMuteList(signer);
  const next = muted ? addPrivateMute(state, pubkey) : removeMute(state, pubkey);
  await saveMuteList(signer, next);
  return mutedPubkeys(next);
}
