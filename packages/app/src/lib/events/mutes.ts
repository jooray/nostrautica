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
import { KIND_MUTE_LIST } from "@nostrautica/protocol";
import type { AppSigner } from "$lib/signer/types.js";
import { fetchEvents } from "$lib/nostr/ndk.js";
import { publishOrQueue } from "$lib/nostr/publish-queue.js";

export type Tag = string[];

export interface MuteListState {
  /** Public tags on the event (p/t/word/e + any unknown), preserved verbatim. */
  publicTags: Tag[];
  /** Private tags decrypted from the event content, preserved verbatim. */
  privateTags: Tag[];
}

export const EMPTY_MUTE_LIST: MuteListState = { publicTags: [], privateTags: [] };

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

/** Fetch the latest kind-10000, decrypting the self-encrypted private items. */
export async function fetchMuteList(signer: AppSigner): Promise<MuteListState> {
  const pubkey = await signer.getPublicKey();
  const events = await fetchEvents({ kinds: [KIND_MUTE_LIST], authors: [pubkey] });
  const latest = events.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
  if (!latest) return { ...EMPTY_MUTE_LIST };
  let privateTags: Tag[] = [];
  if (latest.content) {
    try {
      const parsed = JSON.parse(await signer.nip44Decrypt(pubkey, latest.content));
      if (Array.isArray(parsed)) privateTags = parsed.filter((t) => Array.isArray(t)) as Tag[];
    } catch {
      // Undecryptable content is foreign/corrupt — keep public items, don't guess.
    }
  }
  return { publicTags: (latest.tags as Tag[]) ?? [], privateTags };
}

/** Sign & publish a replacement kind-10000, re-encrypting the private items. */
export async function saveMuteList(signer: AppSigner, state: MuteListState): Promise<void> {
  const pubkey = await signer.getPublicKey();
  const content = state.privateTags.length
    ? await signer.nip44Encrypt(pubkey, JSON.stringify(state.privateTags))
    : "";
  const event = await signer.signEvent({
    kind: KIND_MUTE_LIST,
    created_at: Math.floor(Date.now() / 1000),
    tags: state.publicTags,
    content,
  });
  await publishOrQueue(event);
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
