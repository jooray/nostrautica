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
import {
  setActiveOwner,
  lockEventKeysForLogout,
  unlockEventKeysForLogin,
} from "$lib/events/keystore.js";
import { lockChatIdentityForLogout, unlockChatIdentityForLogin } from "$lib/chat/identity.js";
import { clearBlindingCache } from "$lib/events/blinding.js";
import { setActiveCacheOwner, clearOwnerCache } from "$lib/cache/persist.js";
import { discardQueuedForOwner } from "$lib/nostr/publish-queue.js";
import { outbox } from "$lib/stores/outbox.svelte.js";
import { recentEvents } from "$lib/stores/recent-events.svelte.js";
import { clearAllJoinSent } from "$lib/stores/join-sent.svelte.js";
import { router } from "$lib/router/router.svelte.js";
import { broadcastLogout } from "./session-broadcast.js";

class Session {
  signer = $state<AppSigner | null>(null);
  pubkey = $state<string | null>(null);
  /** True right after a brand-new local key is generated (drives the backup nag). */
  freshLocalKey = $state(false);
  /**
   * True when the last logout could not self-encrypt event-key/chat custody
   * (H-5) — e.g. an unreachable NIP-46 signer. The keys were left in plaintext
   * rather than risked, and the shell surfaces a localized warning so the user
   * knows the on-device wipe was incomplete.
   */
  logoutError = $state(false);

  /**
   * Monotonic session-operation token (H-6). Every restore / login / logout
   * captures the next value at its start; a slow adoption (chiefly a NIP-46
   * `getPublicKey` round-trip) only applies if its token is still current. A
   * background restore that finishes after a newer login or a logout is dropped
   * and its transport closed, so it can neither replace a newer session nor
   * silently log a logged-out user back in.
   */
  private opToken = 0;

  /** Take the next operation token — call at the START of restore/login/logout. */
  private nextOp(): number {
    return ++this.opToken;
  }

  get npub(): string | null {
    return this.pubkey ? npubEncode(this.pubkey) : null;
  }

  get loggedIn(): boolean {
    return this.signer !== null && this.pubkey !== null;
  }

  private async adopt(signer: AppSigner, tok: number): Promise<boolean> {
    const pubkey = await signer.getPublicKey();
    // H-6: a newer login/logout superseded this (possibly slow) adoption while we
    // awaited getPublicKey. Drop it and close its transport — otherwise a stale
    // NIP-46 restore would overwrite the newer session or undo a logout, and its
    // pool would keep reconnecting to the signer relays. The boolean lets callers
    // skip their post-adoption persistence (e.g. re-saving a NIP-46 session a
    // logout just cleared).
    if (tok !== this.opToken) {
      await Promise.resolve(signer.close?.()).catch(() => {});
      return false;
    }
    this.pubkey = pubkey;
    this.signer = signer;
    // A fresh login clears any stale "logout couldn't self-encrypt" warning.
    this.logoutError = false;
    // Scope the per-event keystore to this identity (audit G2 owner-scoping).
    setActiveOwner(this.pubkey);
    // Scope the persistent app-cache to this identity too (CACHING-PLAN §3.1),
    // so owner-scoped cachedX() reads resolve against the current owner.
    setActiveCacheOwner(this.pubkey);
    // Decrypt any event-key + chat/MLS custody locked at a previous logout on
    // this device (audit UX-6), before returning — in particular, chat state
    // MUST resolve before anything calls `resolveChatIdentity`, or a
    // remote-signer account with its device key still locked would mint a
    // brand new one and fork its MLS credential (every other client would see
    // it as a stranger, having lost its old group membership — not a
    // recoverable race). Awaiting here is safe for boot latency too: a NIP-46
    // restore's decrypt round-trip is already run in the background at the
    // call site (`+layout.svelte`, audit UX-19) rather than gating first
    // paint, so slowness here doesn't reintroduce that regression.
    // Never swallow these silently: a failed unlock leaves the live store empty
    // while the real keys sit locked, and everything downstream then behaves as
    // if this user had no keys. The failure itself is non-fatal (the snapshot is
    // intact and the next login retries), but it must be diagnosable — an
    // organizer reporting "my event vanished" needs to leave a trace.
    await unlockEventKeysForLogin((ct) => signer.nip44Decrypt(pubkey, ct), pubkey).catch((e) => {
      console.warn("[session] event-key unlock failed; keys remain locked, retried next login", e);
    });
    await unlockChatIdentityForLogin(pubkey, (ct) => signer.nip44Decrypt(pubkey, ct)).catch((e) => {
      console.warn("[session] chat-identity unlock failed; device key remains locked", e);
    });
    // R21: the reactive outbox is owner-filtered but caches the PREVIOUS account's
    // items until its next poll. Clear it synchronously the moment the new owner is
    // scoped, then refresh so this account sees only its own queue — never a flash
    // of the prior identity's pending sends on a shared device.
    outbox.reset();
    void outbox.refresh();
    return true;
  }

  /** Try to restore a previous session (local key) from IndexedDB. */
  async restore(): Promise<boolean> {
    // Capture the token FIRST (H-6): if an explicit login or a logout lands while
    // this restore is still resolving its persisted signer, the adoption below is
    // dropped rather than clobbering the newer session or undoing the logout.
    const tok = this.nextOp();
    const method = await loadLoginMethod();
    if (method === "local") {
      const sk = await loadLocalKey();
      if (sk) return this.adopt(new LocalSigner(sk), tok);
    }
    // NIP-07 can be re-established silently if the extension is present.
    if (method === "nip07" && hasNip07()) {
      return this.adopt(new Nip07Signer(), tok);
    }
    // NIP-46 (Amber): reconnect the persisted bunker session (spec §5.3).
    if (method === "nip46") {
      const persisted = await loadNip46Session<Nip46Session>();
      if (persisted) {
        try {
          const signer = await Nip46Signer.fromPersisted(persisted);
          // If a newer op superseded us, adopt() dropped + closed the signer;
          // don't re-persist a session a logout may have just cleared (H-6).
          if (!(await this.adopt(signer, tok))) return false;
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
    const tok = this.nextOp();
    if (!(await this.adopt(new Nip07Signer(), tok))) return;
    await saveLoginMethod("nip07");
  }

  async loginNip46(signer: Nip46Signer): Promise<void> {
    const tok = this.nextOp();
    if (!(await this.adopt(signer, tok))) return;
    // Persist the bunker session (incl. the expected user pubkey — adopt()
    // just cached it) so the user stays logged in across refreshes.
    await saveNip46Session(signer.serialize());
  }

  /** Generate a brand-new local key (normie default), persist it, log in. */
  async createLocalKey(): Promise<void> {
    const tok = this.nextOp();
    const signer = LocalSigner.generate();
    await saveLocalKey(signer.getSecretKey());
    if (!(await this.adopt(signer, tok))) return;
    this.freshLocalKey = true;
  }

  /** Import a pasted/URL credential (nsec / ncryptsec+pw / hex) as a local key. */
  async importLocalKey(input: string, passphrase?: string): Promise<void> {
    const tok = this.nextOp();
    const sk = importCredential(input, passphrase);
    const signer = new LocalSigner(sk);
    await saveLocalKey(sk);
    if (!(await this.adopt(signer, tok))) return;
    this.freshLocalKey = false;
  }

  async logout(): Promise<void> {
    // Bump the token FIRST (H-6): any in-flight background restore/adoption is now
    // superseded and will drop itself instead of logging the user back in.
    this.nextOp();
    this.logoutError = false;
    // Self-encrypt event-key custody (E_id/E_inbox nsecs, ECKs) into an
    // on-device backup BEFORE tearing down the signer or clearing anything
    // (audit UX-6). These keys were deliberately left in plaintext forever so
    // an organizer could never lose them by logging out; this keeps that
    // guarantee — decrypt requires a signer that can authenticate as this
    // owner, so a shared device's next user can't just read them — while
    // `adopt()` transparently restores them on the next login for this
    // identity. Best-effort: a record that fails to encrypt (e.g. an
    // unreachable NIP-46 signer) is left in plaintext rather than risked.
    if (this.signer && this.pubkey) {
      const signer = this.signer;
      const pubkey = this.pubkey;
      await lockEventKeysForLogout(
        (pt) => signer.nip44Encrypt(pubkey, pt),
        // Decrypt too: locking must MERGE with any existing snapshot rather than
        // overwrite it, or a logout following a failed unlock destroys the keys.
        (ct) => signer.nip44Decrypt(pubkey, ct),
        pubkey,
        // H-5: surface, rather than swallow, a self-encrypt failure (e.g. an
        // unreachable NIP-46 signer) — the keys were left in plaintext rather
        // than risked, and the user must be told the on-device wipe was partial.
      ).catch(() => {
        this.logoutError = true;
      });
      // Same for MLS/chat state — device key, group state, key packages,
      // decrypted history (audit UX-6).
      await lockChatIdentityForLogout(pubkey, (pt) => signer.nip44Encrypt(pubkey, pt)).catch(() => {
        this.logoutError = true;
      });
    }
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
    // U1: discard this account's still-unsent outbox actions on logout. They were
    // signed by this identity; on a shared device leaving them to publish silently
    // during the next person's session is the cross-account leak we're closing. The
    // Me page warns the user first when any exist (the count is shown before this
    // runs); this is the durable teardown so every logout path drops them.
    // R21: AWAIT the discard BEFORE dropping owner scope — otherwise the discard
    // races the next login and the durable rows can outlive it — and synchronously
    // clear the reactive outbox view so the next account never sees this queue's
    // metadata or its retry/discard controls.
    if (owner) await discardQueuedForOwner(owner).catch(() => {});
    outbox.reset();
    if (owner) clearOwnerCache(owner);
    setActiveOwner(null);
    setActiveCacheOwner(null);
    clearBlindingCache();
    // Not owner-scoped stores (audit UX-6): the previous identity's event
    // titles/roles and "Pending" join markers must not linger for the next
    // person on a shared device.
    recentEvents.clear();
    clearAllJoinSent();
    this.signer = null;
    this.pubkey = null;
    this.freshLocalKey = false;
    // H-5: tell other tabs on this device to drop this identity's owner state too.
    // The self-encrypt above already wrote custody to shared IndexedDB, so the
    // receiver only tears down its live/in-memory copies (no re-encrypt, no loop).
    if (owner) broadcastLogout(owner);
  }

  /**
   * Apply a logout that happened in ANOTHER tab on this device (H-5). The
   * originating tab already self-encrypted key/chat custody into shared
   * IndexedDB, so this tab must NOT re-encrypt (no signer round-trip) or
   * re-broadcast (no loop) — it just drops its own live/in-memory owner state:
   * wipes this tab's decrypted cache mirror (and fences its in-flight async
   * writes via the generation bump inside `clearOwnerCache`), unscopes the
   * owner, and clears the session so the shell reflects logged-out. Setting
   * `pubkey`/`signer` to null reactively releases the live chat session through
   * the layout's prewarm effect, so no MLS client keeps operating as the
   * logged-out identity.
   */
  applyRemoteLogout(owner: string): void {
    // Only react when this tab holds the same identity (or none) — a tab logged
    // in as a different account must not be disturbed by another's logout.
    if (this.pubkey && this.pubkey !== owner) return;
    // Supersede any in-flight restore/adoption in THIS tab too (H-6 interplay).
    this.nextOp();
    // R21: the originating tab already discarded this owner's queued items from
    // shared IndexedDB; drop this tab's reactive outbox view synchronously so it
    // doesn't keep showing them until its next poll.
    outbox.reset();
    clearOwnerCache(owner);
    setActiveOwner(null);
    setActiveCacheOwner(null);
    clearBlindingCache();
    recentEvents.clear();
    clearAllJoinSent();
    void Promise.resolve(this.signer?.close?.()).catch(() => {});
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
    // …and from the router's in-memory route (audit UX-12): navigating away
    // pushes the current route onto the router stack, so a leftover `nsec`
    // would put the secret BACK into the URL on in-app Back — exactly like
    // Join.svelte's stripInviteCodeFromUrl clears `route.code`.
    const route = router.route;
    if (route.name === "login") route.nsec = undefined;
  }
  return true;
}
