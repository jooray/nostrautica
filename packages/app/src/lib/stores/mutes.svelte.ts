/**
 * Reactive NIP-51 mute cache (audit finding U10). One shared muted-pubkey set so
 * every surface — roster, matches, DM lists, attendee detail, DM header — can
 * filter/annotate the same source without each page re-reading the list.
 *
 * Scoped to the active identity: `load()` re-fetches when the signer's pubkey
 * changes, so a logout/login (which this store can't observe directly — the
 * session lives in the off-limits signer module) never leaks one identity's
 * mutes into another.
 */
import type { AppSigner } from "$lib/signer/types.js";
import { fetchMuteList, mutedPubkeys, setMuted } from "$lib/events/mutes.js";
import { cacheGet, cacheSet } from "$lib/cache/persist.js";

// The muted set is decrypted private data, cached owner-scoped and wiped on
// logout (CACHING-PLAN §2.8). `mutes.load()` paints from cache then refreshes.
const MUTES_KEY = "mutes";

class Mutes {
  muted = $state<Set<string>>(new Set());
  private loadedFor: string | null = null;
  private loading = false;

  /** Lazily load the muted set for `signer`'s identity (idempotent per pubkey). */
  async load(signer: AppSigner): Promise<void> {
    if (this.loading) return;
    const pubkey = await signer.getPublicKey();
    if (this.loadedFor === pubkey) return;
    this.loading = true;
    try {
      // Paint the cached muted set instantly (owner-scoped), then refresh.
      const cached = cacheGet<string[]>(MUTES_KEY, pubkey);
      if (cached) this.muted = new Set(cached.data);
      const set = mutedPubkeys(await fetchMuteList(signer));
      this.muted = set;
      cacheSet(MUTES_KEY, [...set], Math.floor(Date.now() / 1000), pubkey);
      this.loadedFor = pubkey;
    } catch {
      // Leave the set as-is; muting is best-effort and non-blocking.
    } finally {
      this.loading = false;
    }
  }

  isMuted(pubkey: string): boolean {
    return this.muted.has(pubkey);
  }

  /** Toggle mute for `pubkey`, persisting to the NIP-51 list. Returns the new state. */
  async toggle(signer: AppSigner, pubkey: string): Promise<boolean> {
    const willMute = !this.muted.has(pubkey);
    // setMuted keeps its fetch-merge-write against fresh relay state (constraint 4).
    this.muted = await setMuted(signer, pubkey, willMute);
    const owner = await signer.getPublicKey();
    this.loadedFor = owner;
    cacheSet(MUTES_KEY, [...this.muted], Math.floor(Date.now() / 1000), owner);
    return willMute;
  }
}

export const mutes = new Mutes();
