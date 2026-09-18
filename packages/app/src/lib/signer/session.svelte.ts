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
import { clearInboxRelayCache } from "$lib/events/attendee.js";
import { setActiveCacheOwner, clearOwnerCache } from "$lib/cache/persist.js";
import { discardQueuedForOwner } from "$lib/nostr/publish-queue.js";
import { outbox } from "$lib/stores/outbox.svelte.js";
import { recentEvents } from "$lib/stores/recent-events.svelte.js";
import { clearAllJoinSent, setJoinSentOwner } from "$lib/stores/join-sent.svelte.js";
import { ownStatusStore } from "$lib/stores/own-status.svelte.js";
import { mutes } from "$lib/stores/mutes.svelte.js";
import { setInviteOwner } from "$lib/stores/invite-store.js";
import { router } from "$lib/router/router.svelte.js";
import { broadcastLogout } from "./session-broadcast.js";

/**
 * How long ONE logout custody-lock step may take before the local teardown goes
 * ahead without it.
 *
 * Each step is an encrypt through the active signer, and for NIP-46 that means
 * `rpcWithForegroundRetry`: a 60 s deadline, or up to ~132 s if a visibility
 * flip triggers the retry path. Two of them serially is up to ~4.4 minutes
 * during which the UI still says the user is logged in — on a SHARED DEVICE,
 * where "log out" is the one action that must be immediate and trustworthy. The
 * person handing the phone over cannot know the wait is a dead signer relay
 * rather than a broken button, and the natural response is to hand it over
 * anyway.
 *
 * So each step gets a short budget of its own. A step that misses it leaves that
 * custody record in plaintext — which is precisely the pre-existing best-effort
 * policy for an unreachable signer — and sets `logoutError`, the banner that
 * already exists to say the on-device wipe was partial.
 */
const LOGOUT_LOCK_TIMEOUT_MS = 12_000;

/** Reject after `ms` if `p` hasn't settled. The work is left running. */
function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

class Session {
  signer = $state<AppSigner | null>(null);
  pubkey = $state<string | null>(null);
  /** Event custody has been fully unlocked and can be read authoritatively. */
  custodyReady = $state(false);
  /** Bumps after each successful custody unlock, including same-owner restores. */
  custodyGeneration = $state(0);
  /** A persisted session is still being restored in the background. */
  restoring = $state(false);
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
   * A persisted session was found but could not be re-established (chiefly a
   * NIP-46 bunker that didn't answer inside the restore budget).
   *
   * This used to be `return false` with no log, no state and no retry: the user
   * landed on the sign-in CTA as though they had never logged in, and the only
   * way forward that the UI offered was a fresh QR pairing — a new client key
   * and a new approval in the signer, discarding a session that would very
   * likely have worked on a second attempt (the usual cause is one signer relay
   * being slow at exactly the wrong moment). Support had nothing to go on
   * either, because nothing was written anywhere.
   *
   * The persisted session is deliberately NOT cleared for a transient failure
   * (only an identity mismatch clears it), so retrying is a real option — this
   * flag is what lets the shell offer it.
   */
  restoreError = $state(false);
  /**
   * WHY the restore failed, so the shell can say the right sentence.
   * "signer" = a persisted bunker that did not answer; "extension" = a NIP-07
   * login whose extension is not injected (yet). The second used to produce no
   * error at all: `restore()` fell straight through to `return false` and the
   * user was SILENTLY logged out, on a machine where their key is right there in
   * the extension. The visible consequence is worse than "logged out" — the app's
   * sign-in flow then offers to make a NEW local identity, which is how someone
   * ends up with two.
   */
  restoreErrorKind = $state<"signer" | "extension" | null>(null);
  /** Human-readable reason for the failed restore, for the retry surface. */
  restoreErrorMessage = $state<string | null>(null);

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
    // Both awaits stay, and the cost is real — N locked events means N serial
    // signer decrypts before the UI moves at all, which on Amber is N round
    // trips. It buys different things on each line, and only one of them is
    // load-bearing. The EVENT-KEY unlock must be awaited: `custodyReady` is
    // published in the same tick as the identity below precisely so nothing
    // reads custody in a window where the snapshot is still encrypted, and
    // returning early would put that window back. The CHAT unlock's ordering
    // guarantee, by contrast, comes from `unlockInFlight` inside
    // `unlockChatIdentityForLogin` — it is registered synchronously and
    // `ensureChatDeviceKey` waits on it (and fails closed if a locked snapshot
    // survives), so merely CALLING it before publishing the identity is what
    // prevents the MLS-credential fork; the await is defence in depth. Dropping
    // it would save exactly one round trip out of N+1, so it is not worth
    // trading a belt-and-braces guarantee against an unrecoverable failure for.
    // Never swallow these silently: a failed unlock leaves the live store empty
    // while the real keys sit locked, and everything downstream then behaves as
    // if this user had no keys. The failure itself is non-fatal (the snapshot is
    // intact and the next login retries), but it must be diagnosable — an
    // organizer reporting "my event vanished" needs to leave a trace.
    let custodyReady = false;
    try {
      custodyReady = await unlockEventKeysForLogin((ct) => signer.nip44Decrypt(pubkey, ct), pubkey);
    } catch (e) {
      console.warn("[session] event-key unlock failed; keys remain locked, retried next login", e);
    }
    await unlockChatIdentityForLogin(pubkey, (ct) => signer.nip44Decrypt(pubkey, ct)).catch((e) => {
      console.warn("[session] chat-identity unlock failed; device key remains locked", e);
    });
    // Do not expose a live identity until custody has settled. Event pages react
    // to pubkey/signer and previously made a permanent visitor decision in this
    // window while the organizer snapshot was still encrypted.
    if (tok !== this.opToken) {
      await Promise.resolve(signer.close?.()).catch(() => {});
      return false;
    }
    // Close the signer we are REPLACING (audit 2026-09-04). Dropping the
    // reference was never enough for NIP-46: its SimplePool is built with
    // `enableReconnect` + `enablePing`, so the orphan keeps re-opening sockets to
    // the signer relays and pinging them for the rest of the page's life — and
    // the bearer capability it holds stays live and usable. An account switch
    // that goes login→login (no logout in between: an imported nsec, a second
    // bunker paste, an `#/login?nsec=` deep link while already signed in) hit
    // exactly this. Fire-and-forget: `close()` is bounded and never throws, and
    // making the new login wait on the old signer's courtesy logout RPC would be
    // the wrong trade.
    const replaced = this.signer;
    if (replaced && replaced !== signer) {
      void Promise.resolve(replaced.close?.()).catch(() => {});
    }
    this.pubkey = pubkey;
    this.signer = signer;
    this.custodyReady = custodyReady;
    if (custodyReady) this.custodyGeneration += 1;
    // A fresh login clears any stale "logout couldn't self-encrypt" warning, and
    // any "we couldn't bring your session back" banner — we just did.
    this.logoutError = false;
    this.restoreError = false;
    this.restoreErrorMessage = null;
    this.restoreErrorKind = null;
    // Scope owner-backed stores only after custody has settled, matching the
    // reactive session publication above.
    setActiveOwner(pubkey);
    setActiveCacheOwner(pubkey);
    recentEvents.setOwner(pubkey);
    // Stores that are NOT owner-keyed internally and survived an account switch
    // (audit EV-16). `logout()` cleared some of them; `adopt()` is the OTHER way an
    // identity changes — importing a key, or signing in as someone else without
    // logging out first — and it cleared none. Each of these is idempotent for the
    // same owner, so a session RESTORE keeps what it had. What leaked without them,
    // on a shared device: A's private "your profile failed" notices rendered for B
    // (and, since the readiness journey started deriving from them, B's own stepper
    // saying B had failed), A's mute list silently hiding people from B, A's
    // "Pending" join markers on events B has never opened, and A's unredeemed
    // invite nsec — a single-use auto-approve credential — handed to B.
    ownStatusStore.setOwner(pubkey);
    mutes.setOwner(pubkey);
    setJoinSentOwner(pubkey);
    setInviteOwner(pubkey);
    // R21: the reactive outbox is owner-filtered but caches the PREVIOUS account's
    // items until its next poll. Clear it synchronously the moment the new owner is
    // scoped, then refresh so this account sees only its own queue — never a flash
    // of the prior identity's pending sends on a shared device.
    outbox.reset();
    void outbox.refresh();
    return true;
  }

  /**
   * Try to restore a previous session (local key / NIP-07 / persisted bunker)
   * from IndexedDB. A transient failure sets `restoreError` rather than
   * disappearing — see that field and {@link retryRestore}.
   */
  async restore(): Promise<boolean> {
    // Capture the token FIRST (H-6): if an explicit login or a logout lands while
    // this restore is still resolving its persisted signer, the adoption below is
    // dropped rather than clobbering the newer session or undoing the logout.
    const tok = this.nextOp();
    this.restoring = true;
    // "My events" is per-identity, and until `adopt()` runs we do not have one.
    // Hold it — see `RecentEvents.pendingIdentity` for what rendering the
    // logged-out list in this window looked like from the outside.
    recentEvents.awaitIdentity();
    this.restoreError = false;
    this.restoreErrorMessage = null;
    this.restoreErrorKind = null;
    try {
      const method = await loadLoginMethod();
      if (method === "local") {
        const sk = await loadLocalKey();
        if (sk) return this.adopt(new LocalSigner(sk), tok);
      }
      // NIP-07 can be re-established silently if the extension is present.
      if (method === "nip07") {
        if (hasNip07()) return this.adopt(new Nip07Signer(), tok);
        // Not injected. Extensions inject `window.nostr` at document_start, but a
        // cold profile, a slow extension host or a disabled/removed extension all
        // land here — and falling through silently tells a logged-in user they are
        // logged out. Say so, and keep the persisted method on disk so Retry can
        // pick it up once the extension appears.
        if (tok === this.opToken) {
          this.restoreError = true;
          this.restoreErrorKind = "extension";
          this.restoreErrorMessage = "no NIP-07 extension is available in this browser";
        }
        return false;
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
              console.warn("[session] persisted bunker answered for a different user; cleared", e);
              return false;
            }
            // Everything else is transient by assumption, and the persisted
            // session is still on disk. Leave a trace (support had none) and a
            // state the shell can offer a retry from, instead of silently
            // dropping the user on the sign-in CTA where the only visible way
            // forward is a fresh pairing.
            console.warn("[session] NIP-46 restore failed; session kept for retry", e);
            if (tok === this.opToken) {
              this.restoreError = true;
              this.restoreErrorKind = "signer";
              this.restoreErrorMessage = e instanceof Error ? e.message : String(e);
            }
            return false;
          }
        }
      }
      return false;
    } finally {
      if (tok === this.opToken) {
        this.restoring = false;
        // Whatever the outcome — adopted, failed, no stored session — the answer
        // is now in. `adopt()` already settled this via `setOwner`; this is the
        // path where there was nobody to adopt, and it is idempotent.
        recentEvents.identitySettled();
      }
    }
  }

  /**
   * User-driven second attempt at the persisted session (the Retry beside the
   * failed-restore banner). Just `restore()` — the persisted bunker session was
   * deliberately left on disk — but named so a caller doesn't have to know that,
   * and a no-op when a session is already live.
   */
  async retryRestore(): Promise<boolean> {
    if (this.loggedIn) return true;
    return this.restore();
  }

  /**
   * Every login helper answers whether a session actually resulted (H-6). They
   * used to return `void`, so a superseded adoption — the `adopt()` opToken
   * check dropping this login because a newer one, or a logout, landed while it
   * awaited the signer — was indistinguishable from success to the caller:
   * `SignInOptions` fired `onSignedIn()` and navigated to Home while logged out,
   * where the user was told to sign in again. `false` means "no session; do not
   * treat this as a login".
   */
  async loginNip07(): Promise<boolean> {
    if (!hasNip07()) throw new Error("No NIP-07 extension found");
    const tok = this.nextOp();
    if (!(await this.adopt(new Nip07Signer(), tok))) return false;
    await saveLoginMethod("nip07");
    return true;
  }

  async loginNip46(signer: Nip46Signer): Promise<boolean> {
    const tok = this.nextOp();
    if (!(await this.adopt(signer, tok))) return false;
    // Persist the bunker session (incl. the expected user pubkey — adopt()
    // just cached it) so the user stays logged in across refreshes.
    await saveNip46Session(signer.serialize());
    return true;
  }

  /** Generate a brand-new local key (normie default), persist it, log in. */
  async createLocalKey(): Promise<boolean> {
    const tok = this.nextOp();
    const signer = LocalSigner.generate();
    await saveLocalKey(signer.getSecretKey());
    if (!(await this.adopt(signer, tok))) return false;
    this.freshLocalKey = true;
    return true;
  }

  /** Import a pasted/URL credential (nsec / ncryptsec+pw / hex) as a local key. */
  async importLocalKey(input: string, passphrase?: string): Promise<boolean> {
    const tok = this.nextOp();
    const sk = importCredential(input, passphrase);
    const signer = new LocalSigner(sk);
    await saveLocalKey(sk);
    if (!(await this.adopt(signer, tok))) return false;
    this.freshLocalKey = false;
    return true;
  }

  async logout(): Promise<void> {
    // Bump the token FIRST (H-6): any in-flight background restore/adoption is now
    // superseded and will drop itself instead of logging the user back in.
    this.nextOp();
    this.restoring = false;
    this.custodyReady = false;
    this.logoutError = false;
    // An explicit logout answers the failed-restore banner: there is no session
    // left to bring back, so offering a retry would be nonsense.
    this.restoreError = false;
    this.restoreErrorMessage = null;
    this.restoreErrorKind = null;
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
      // Both steps are BOUNDED (see LOGOUT_LOCK_TIMEOUT_MS). An unreachable
      // remote signer used to be able to hold the whole logout for minutes with
      // the UI still showing a live session; the wipe is best-effort by design,
      // so a step that can't finish in time is recorded and skipped rather than
      // waited on.
      await withDeadline(
        lockEventKeysForLogout(
          (pt) => signer.nip44Encrypt(pubkey, pt),
          // Decrypt too: locking must MERGE with any existing snapshot rather than
          // overwrite it, or a logout following a failed unlock destroys the keys.
          (ct) => signer.nip44Decrypt(pubkey, ct),
          pubkey,
        ),
        LOGOUT_LOCK_TIMEOUT_MS,
        "logout: event-key custody lock",
        // H-5: surface, rather than swallow, a self-encrypt failure (e.g. an
        // unreachable NIP-46 signer) — the keys were left in plaintext rather
        // than risked, and the user must be told the on-device wipe was partial.
      ).catch((e: unknown) => {
        console.warn("[session] logout could not lock event-key custody", e);
        this.logoutError = true;
      });
      // Same for MLS/chat state — device key, group state, key packages,
      // decrypted history (audit UX-6).
      await withDeadline(
        lockChatIdentityForLogout(pubkey, (pt) => signer.nip44Encrypt(pubkey, pt)),
        LOGOUT_LOCK_TIMEOUT_MS,
        "logout: chat-identity lock",
      ).catch((e: unknown) => {
        console.warn("[session] logout could not lock chat identity", e);
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
    // Per-session, pubkey-keyed memo of the account's own NIP-17 inbox relays
    // (used to widen the grant scan's read set). Public data, so this is hygiene
    // rather than isolation — but a session-lifetime cache should not outlive
    // the session that created it.
    clearInboxRelayCache();
    // Not owner-scoped stores (audit UX-6): the previous identity's event
    // titles/roles and "Pending" join markers must not linger for the next
    // person on a shared device.
    recentEvents.setOwner(null);
    clearAllJoinSent();
    ownStatusStore.setOwner(null);
    mutes.setOwner(null);
    setInviteOwner(null);
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
    this.restoring = false;
    this.custodyReady = false;
    this.restoreError = false;
    this.restoreErrorMessage = null;
    this.restoreErrorKind = null;
    // R21: the originating tab already discarded this owner's queued items from
    // shared IndexedDB; drop this tab's reactive outbox view synchronously so it
    // doesn't keep showing them until its next poll.
    outbox.reset();
    clearOwnerCache(owner);
    setActiveOwner(null);
    setActiveCacheOwner(null);
    clearBlindingCache();
    clearInboxRelayCache();
    recentEvents.setOwner(null);
    clearAllJoinSent();
    ownStatusStore.setOwner(null);
    mutes.setOwner(null);
    setInviteOwner(null);
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
