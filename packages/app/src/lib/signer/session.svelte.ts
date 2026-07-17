/**
 * Global session state (Svelte 5 runes). Holds the active signer + user pubkey
 * and drives the login ladder (spec §5.1). A returning local-key user is logged
 * back in from IndexedDB on boot.
 */
import { npubEncode } from "nostr-tools/nip19";
import type { AppSigner } from "./types.js";
import { LocalSigner } from "./local.js";
import { Nip07Signer, hasNip07 } from "./nip07.js";
import {
  Nip46Signer,
  Nip46IdentityMismatchError,
  type Nip46Session,
} from "./nip46.js";
import { importCredential } from "./backup.js";
import {
  saveLocalKey,
  loadLocalKey,
  loadLoginMethod,
  saveLoginMethod,
  saveNip46Session,
  loadNip46Session,
  clearKeystore,
} from "./keystore.js";
import { setActiveOwner } from "$lib/events/keystore.js";
import { clearBlindingCache } from "$lib/events/blinding.js";
import { setActiveCacheOwner, clearOwnerCache } from "$lib/cache/persist.js";

class Session {
  signer = $state<AppSigner | null>(null);
  pubkey = $state<string | null>(null);
  /** True right after a brand-new local key is generated (drives the backup nag). */
  freshLocalKey = $state(false);

  get npub(): string | null {
    return this.pubkey ? npubEncode(this.pubkey) : null;
  }

  get loggedIn(): boolean {
    return this.signer !== null && this.pubkey !== null;
  }

  private async adopt(signer: AppSigner): Promise<void> {
    this.pubkey = await signer.getPublicKey();
    this.signer = signer;
    // Scope the per-event keystore to this identity (audit G2 owner-scoping).
    setActiveOwner(this.pubkey);
    // Scope the persistent app-cache to this identity too (CACHING-PLAN §3.1),
    // so owner-scoped cachedX() reads resolve against the current owner.
    setActiveCacheOwner(this.pubkey);
  }

  /** Try to restore a previous session (local key) from IndexedDB. */
  async restore(): Promise<boolean> {
    const method = await loadLoginMethod();
    if (method === "local") {
      const sk = await loadLocalKey();
      if (sk) {
        await this.adopt(new LocalSigner(sk));
        return true;
      }
    }
    // NIP-07 can be re-established silently if the extension is present.
    if (method === "nip07" && hasNip07()) {
      await this.adopt(new Nip07Signer());
      return true;
    }
    // NIP-46 (Amber): reconnect the persisted bunker session (spec §5.3).
    if (method === "nip46") {
      const persisted = await loadNip46Session<Nip46Session>();
      if (persisted) {
        try {
          const signer = await Nip46Signer.fromPersisted(persisted);
          await this.adopt(signer);
          // Re-persist: backfills `userPubkey` for pre-upgrade sessions so the
          // identity check applies from the next restore onwards.
          await saveNip46Session(signer.serialize());
          return true;
        } catch (e) {
          // A bunker answering for a DIFFERENT user is invalid for good —
          // clear it so it is never retried. Transient failures (signer
          // offline) keep the session for the next boot.
          if (e instanceof Nip46IdentityMismatchError) {
            await clearKeystore().catch(() => {});
          }
          // Fall back to logged-out.
          return false;
        }
      }
    }
    return false;
  }

  async loginNip07(): Promise<void> {
    if (!hasNip07()) throw new Error("No NIP-07 extension found");
    await this.adopt(new Nip07Signer());
    await saveLoginMethod("nip07");
  }

  async loginNip46(signer: Nip46Signer): Promise<void> {
    await this.adopt(signer);
    // Persist the bunker session (incl. the expected user pubkey — adopt()
    // just cached it) so the user stays logged in across refreshes.
    await saveNip46Session(signer.serialize());
  }

  /** Generate a brand-new local key (normie default), persist it, log in. */
  async createLocalKey(): Promise<void> {
    const signer = LocalSigner.generate();
    await saveLocalKey(signer.getSecretKey());
    await this.adopt(signer);
    this.freshLocalKey = true;
  }

  /** Import a pasted/URL credential (nsec / ncryptsec+pw / hex) as a local key. */
  async importLocalKey(input: string, passphrase?: string): Promise<void> {
    const sk = importCredential(input, passphrase);
    const signer = new LocalSigner(sk);
    await saveLocalKey(sk);
    await this.adopt(signer);
    this.freshLocalKey = false;
  }

  async logout(): Promise<void> {
    // Close the signer's transport first: the NIP-46 pool auto-reconnects, so
    // just dropping the reference keeps re-opening sockets to the signer
    // relays until reload. Defensive: local logout completes even if the
    // teardown throws (Nip46Signer.close is itself bounded and non-throwing).
    try {
      await this.signer?.close?.();
    } catch {
      /* transport teardown failed — proceed with local logout */
    }
    await clearKeystore();
    // Wipe every decrypted app-cache copy for this identity BEFORE dropping the
    // owner (CACHING-PLAN §3.1), then unscope. Anon (public) entries survive.
    const owner = this.pubkey;
    if (owner) clearOwnerCache(owner);
    setActiveOwner(null);
    setActiveCacheOwner(null);
    clearBlindingCache();
    this.signer = null;
    this.pubkey = null;
    this.freshLocalKey = false;
  }
}

export const session = new Session();

/**
 * Consume an `nsec` carried in `#/login?nsec=…` and immediately strip it from the
 * URL and history (spec §5.2, §14). Returns true if a key was imported.
 *
 * The fragment never reaches a server, but it must not linger in history either.
 */
export async function consumeNsecFromHash(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  const hash = window.location.hash;
  const qIndex = hash.indexOf("?");
  if (qIndex < 0) return false;
  const params = new URLSearchParams(hash.slice(qIndex + 1));
  const nsec = params.get("nsec");
  if (!nsec) return false;

  try {
    await session.importLocalKey(nsec);
  } finally {
    // Strip the secret from the URL + history regardless of import success.
    params.delete("nsec");
    const path = hash.slice(0, qIndex);
    const rest = params.toString();
    const cleaned = rest ? `${path}?${rest}` : path || "#/";
    window.history.replaceState(null, "", cleaned);
  }
  return true;
}
