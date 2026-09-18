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
import {
  fetchMuteList,
  mutedPubkeys,
  setMuted,
  UnreadableMuteListError,
} from "$lib/events/mutes.js";
import { cacheGet, cacheSet } from "$lib/cache/persist.js";

// The muted set is decrypted private data, cached owner-scoped and wiped on
// logout (CACHING-PLAN §2.8). `mutes.load()` paints from cache then refreshes.
const MUTES_KEY = "mutes";

class Mutes {
  muted = $state<Set<string>>(new Set());
  /**
   * Set when this identity's stored list cannot be read at all (a legacy NIP-04
   * list from another client). Surfaced so a failed mute says what is wrong
   * instead of leaving the user with their signer's own error — or, worse,
   * nothing.
   */
  unreadable = $state<UnreadableMuteListError | null>(null);
  private loadedFor: string | null = null;
  /** The identity this store is scoped to; distinct from `loadedFor`, which
   *  tracks whether a fetch has completed for it. */
  private scopedTo: string | null = null;
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
      this.unreadable = null;
      cacheSet(MUTES_KEY, [...set], Math.floor(Date.now() / 1000), pubkey);
      this.loadedFor = pubkey;
    } catch (err) {
      // Leave the set as-is; muting is best-effort and non-blocking.
      //
      // But an UNREADABLE list is a DEFINITIVE answer, and the only failure here
      // that is. Everything else — relay timeout, signer not approved yet — is
      // worth retrying on the next screen that needs mutes, which is why
      // `loadedFor` is deliberately left unset. That same "retry forever" is
      // wrong for a stored payload that is not NIP-44: it will not become NIP-44,
      // so every DM/Chat/Attendees mount re-fetched it and (before the shape
      // check in mutes.ts) fired another doomed decrypt at the user's signer.
      // Clave shows one push notification per failure; this is what the
      // 2026-09-17 reporter was seeing several times an hour.
      if (err instanceof UnreadableMuteListError) {
        this.unreadable = err;
        this.loadedFor = pubkey;
      }
    } finally {
      this.loading = false;
    }
  }

  /**
   * Point the store at `pubkey` (or nothing, on logout), dropping the previous
   * identity's set. Idempotent for the same owner, so a session restore keeps what
   * it loaded.
   *
   * `load()` does re-fetch for a new pubkey, but it is async and driven from the
   * pages that need it — so between an account switch and that fetch landing, B's
   * Matches page filtered by A's mute list and quietly hid people from them.
   */
  setOwner(pubkey: string | null): void {
    if (this.scopedTo === pubkey) return;
    this.scopedTo = pubkey;
    this.muted = new Set();
    this.unreadable = null;
    // Not `= pubkey`: that would tell `load()` this identity was already fetched
    // and it would never load, leaving the new owner permanently muting nobody.
    this.loadedFor = null;
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
