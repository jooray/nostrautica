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
      this.muted = mutedPubkeys(await fetchMuteList(signer));
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
    this.muted = await setMuted(signer, pubkey, willMute);
    this.loadedFor = await signer.getPublicKey();
    return willMute;
  }
}

export const mutes = new Mutes();
