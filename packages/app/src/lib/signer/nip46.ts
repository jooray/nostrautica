/**
 * NIP-46 remote signer (Amber etc.), spec §5.1 item 2.
 *
 * Two entry points:
 *  - nostrconnect (client-initiated): we generate a client key + random secret,
 *    render the `nostrconnect://` URI as a QR / deep link, and wait for the
 *    signer to connect. nostr-tools' `BunkerSigner.fromURI` verifies the
 *    `connect` response `result === secret` for us.
 *  - bunker:// paste: `parseBunkerInput` + `BunkerSigner.fromBunker`.
 *
 * After connecting we ALWAYS call `get_public_key` (BunkerSigner.getPublicKey
 * does exactly this): the remote-signer pubkey and the user pubkey are distinct
 * (Amber v6 per-connection keys). RPC transport is kind 24133 with NIP-44.
 */
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate, VerifiedEvent } from "nostr-tools/pure";
import {
  BunkerSigner,
  createNostrConnectURI,
  parseBunkerInput,
  type BunkerPointer,
} from "nostr-tools/nip46";
import { SimplePool } from "nostr-tools/pool";
import { bytesToHex, hexToBytes } from "@nostrautica/protocol";
import type { AppSigner } from "./types.js";
import { t } from "$lib/i18n/i18n.svelte.js";

/**
 * Serializable NIP-46 session for persistence across refreshes.
 *
 * SECURITY (audit U17): this is a BEARER CAPABILITY, not a secret vault. The
 * `clientSkHex` (our client key) plus the bunker `secret` together let anyone
 * holding this blob speak to the remote signer AS this app connection until the
 * user disconnects it in their signer — so it is not meaningfully protected from
 * a same-origin script compromise (an XSS that runs in this origin can read
 * IndexedDB directly, and could equally proxy the live signer). We therefore do
 * NOT pretend IndexedDB is secret storage; instead we (1) label it plainly here,
 * (2) never expose the account's actual private key (the remote signer holds
 * that — this app can only ask it to sign), and (3) clear this capability
 * predictably: `clearKeystore()` on every logout path (see session.logout) and
 * on a detected bunker identity swap (Nip46IdentityMismatchError). We did not
 * wrap it under a WebCrypto non-extractable key: it would only defend against an
 * offline IndexedDB dump (not the dominant same-origin-script threat) while
 * adding a decrypt round-trip to the delicate boot-time session restore — a poor
 * trade for the marginal gain. Users who want the capability gone can disconnect
 * in the signer or log out. See docs/ENCRYPTION-AND-PRIVACY.md for the disclosure.
 */
export interface Nip46Session {
  clientSkHex: string;
  bunker: { pubkey: string; relays: string[]; secret?: string };
  /**
   * The USER pubkey this session was established for (distinct from the
   * remote-signer pubkey in `bunker.pubkey`). Checked on restore so a hostile
   * or identity-switched bunker can't silently swap which user the app is.
   * Optional: pre-upgrade sessions lack it — accepted once, then backfilled.
   */
  userPubkey?: string;
}

/** Restore found the bunker answering for a DIFFERENT user than persisted. */
export class Nip46IdentityMismatchError extends Error {
  constructor() {
    super("NIP-46 restore: bunker returned a different user pubkey");
    this.name = "Nip46IdentityMismatchError";
  }
}

/**
 * Permissions requested up front so a real signer (Amber, nsec.app) can grant
 * once instead of prompting per event. These are the kinds this app signs
 * DIRECTLY through the signer (gift-wrap outer 1059 is signed with a local
 * ephemeral key, so it is not listed; the seal, kind 13, is signed by the user).
 * Attendee flows are the common case; a couple of organizer kinds are included
 * so an organizer on a remote signer isn't re-prompted mid-create.
 */
const DEFAULT_PERMS = [
  "sign_event:0", // profile (kind-0 metadata)
  "sign_event:3", // contacts / follow list
  "sign_event:13", // NIP-59 seal (gift-wrap join requests + NIP-17 DMs)
  "sign_event:10002", // relay list (NIP-65)
  "sign_event:24242", // Blossom auth
  "sign_event:30078", // app data (settings, key backups)
  "sign_event:31600", // event config
  "sign_event:31601", // invite list
  "sign_event:31602", // my-event profile (self-encrypted)
  "sign_event:31923", // calendar event (organizer create)
  "sign_event:31925", // public RSVP
  "nip44_encrypt",
  "nip44_decrypt",
];

/** Client metadata shown on the signer's approval screen (spec: name/url). */
const CLIENT_METADATA = {
  name: "Nostrautica",
  url: typeof location !== "undefined" ? location.origin : "https://nostrautica.app",
};

/** How long to wait for a signer to answer a `bunker://` connect before giving up. */
const CONNECT_TIMEOUT_MS = 45_000;
/**
 * The nostrconnect QR wait is human-paced (open signer app, approve, switch
 * back — often with this tab backgrounded in between), so it gets a longer
 * budget than the machine-paced bunker connect. Cancel is always available.
 */
const NOSTRCONNECT_TIMEOUT_MS = 120_000;
/** Shorter budget on app boot: a dead bunker must not wedge the shell. */
const RESTORE_TIMEOUT_MS = 12_000;
/** Courtesy `logout` RPC budget — not every signer answers it; don't stall logout. */
const LOGOUT_TIMEOUT_MS = 3_000;

/**
 * Pool for the NIP-46 RPC transport. Kind-24133 replies are EPHEMERAL — a
 * reply published while our socket is down is lost forever, and mobile
 * browsers throttle/drop sockets the moment the tab is backgrounded behind the
 * signer app. So the socket is treated as hostile: auto-reconnect + resubscribe
 * on close, and a keepalive ping so idle sockets aren't reaped by mobile radios
 * or proxies while we wait for the user to approve. nostr-tools' default pool
 * does neither (`enableReconnect` and `enablePing` are both off by default).
 */
const makePool = () => new SimplePool({ enableReconnect: true, enablePing: true });

const timeoutMessage = () => t("error.signerTimeout");

/** A syntactically valid `bunker://` URI: 64-hex pubkey + at least one relay. */
function looksLikeBunkerUri(input: string): boolean {
  const m = input.match(/^bunker:\/\/([0-9a-f]{64})\b/i);
  if (!m) return false;
  try {
    return new URL(input).searchParams.getAll("relay").length > 0;
  } catch {
    return false;
  }
}

/** Reject if a connect/wait doesn't finish within `ms`; `abort` also rejects it. */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  abort: AbortSignal | undefined,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    const onAbort = () => reject(new Error("Cancelled"));
    if (abort) {
      if (abort.aborted) return onAbort();
      abort.addEventListener("abort", onAbort, { once: true });
    }
    promise.then(
      (v) => {
        clearTimeout(timer);
        abort?.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        abort?.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/**
 * `connect` with lost-ack recovery. If the tab was backgrounded (user approving
 * in the signer app) when the signer published its ack, the ephemeral reply is
 * gone for good — it can't be re-fetched after reconnecting. On return to
 * foreground, while still pending, re-send `connect` (client-initiated, safe to
 * repeat) and probe with `ping`: the ping answers if the signer already
 * authorized us and only the ack was lost (some bunkers, e.g. nak, rotate the
 * connect secret after first use, so a re-sent connect alone can fail even
 * though we ARE connected). Sending also forces the pool to re-open any dropped
 * socket immediately instead of waiting out the reconnect backoff. Failures of
 * recovery attempts are ignored; only the first attempt's error is surfaced.
 */
function connectWithRecovery(bunker: BunkerSigner): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (onVisible) document.removeEventListener("visibilitychange", onVisible);
      fn();
    };
    const onVisible =
      typeof document === "undefined"
        ? null
        : () => {
            if (settled || document.visibilityState !== "visible") return;
            bunker.connect(CLIENT_METADATA).then(
              () => settle(resolve),
              () => {},
            );
            bunker.ping().then(
              () => settle(resolve),
              () => {},
            );
          };
    if (onVisible) document.addEventListener("visibilitychange", onVisible);
    bunker.connect(CLIENT_METADATA).then(
      () => settle(resolve),
      (e) => {
        // A failure while backgrounded is most likely the throttled socket
        // itself — stay pending and let the foreground recovery decide (the
        // caller's overall timeout still bounds the wait).
        if (typeof document !== "undefined" && document.visibilityState === "hidden")
          return;
        settle(() => reject(e instanceof Error ? e : new Error(String(e))));
      },
    );
  });
}

export interface NostrConnectHandle {
  /** The `nostrconnect://` URI to render as QR / deep link. */
  uri: string;
  /** Resolves to a connected signer once the remote signer approves. */
  connected: Promise<Nip46Signer>;
  /** Abort the wait (Cancel button) — rejects `connected` with "Cancelled". */
  cancel: () => void;
}

/**
 * The sign-in UI registers here so a popup-blocked `auth_url` can be surfaced
 * as a tappable link (mobile browsers block `window.open` outside a user
 * gesture, and auth_url arrives asynchronously). Returns an unsubscribe fn.
 */
type AuthUrlListener = (url: string) => void;
const authUrlListeners = new Set<AuthUrlListener>();
export function onNip46AuthUrl(listener: AuthUrlListener): () => void {
  authUrlListeners.add(listener);
  return () => {
    authUrlListeners.delete(listener);
  };
}

/**
 * Handle a remote signer's `auth_url` challenge: open the URL so the user can
 * approve out of band. The RPC then completes on the same request id.
 *
 * `window.open` is the fast path; when it's blocked (returns null / throws —
 * typical on mobile since this runs outside a user gesture) the URL is handed
 * to any registered UI listener to render as a real tappable link.
 */
function onAuth(url: string): void {
  if (typeof window === "undefined") return;
  let popup: Window | null = null;
  try {
    // No "noopener" in the features string: with it, window.open returns null
    // even on SUCCESS, which would defeat blocked-popup detection. Severing
    // the opener by hand gives the same protection (the new tab starts as
    // same-origin about:blank, so the assignment is allowed).
    popup = window.open(url, "_blank");
    if (popup) popup.opener = null;
  } catch {
    popup = null;
  }
  if (!popup) for (const listener of authUrlListeners) listener(url);
}

export class Nip46Signer implements AppSigner {
  readonly method = "nip46" as const;
  private pk: string | null = null;

  private constructor(
    private readonly bunker: BunkerSigner,
    private readonly clientSk: Uint8Array,
    /**
     * Our own copy of the bunker pointer, captured at construction. Session
     * persistence serializes from THIS — never from nostr-tools' internal
     * state, so a library refactor can't silently break restore.
     */
    private readonly bp: BunkerPointer,
    private readonly pool?: SimplePool,
  ) {}

  /** Serialize the session so it can be restored after a refresh (spec §5.3). */
  serialize(): Nip46Session {
    return {
      clientSkHex: bytesToHex(this.clientSk),
      bunker: {
        pubkey: this.bp.pubkey,
        relays: this.bp.relays,
        secret: this.bp.secret ?? undefined,
      },
      userPubkey: this.pk ?? undefined,
    };
  }

  /** Reconnect a persisted NIP-46 session (same client key → same Amber connection). */
  static async fromPersisted(session: Nip46Session): Promise<Nip46Signer> {
    const clientSk = hexToBytes(session.clientSkHex);
    const pointer: BunkerPointer = {
      pubkey: session.bunker.pubkey,
      relays: session.bunker.relays,
      secret: session.bunker.secret ?? null,
    };
    const pool = makePool();
    const bunker = BunkerSigner.fromBunker(clientSk, pointer, {
      onauth: onAuth,
      pool,
    });
    // Bounded so a dead bunker can't block app boot forever (spec §5.3).
    // connectWithRecovery: a PWA resuming from background hits the same
    // lost-ack gap on restore as on first connect.
    try {
      await withTimeout(
        connectWithRecovery(bunker),
        RESTORE_TIMEOUT_MS,
        undefined,
        timeoutMessage(),
      );
      // Identity check: never trust that the reconnected bunker still answers
      // for the same user. A session without `userPubkey` is pre-upgrade —
      // accepted once; session.restore() backfills it immediately after.
      const pk = await withTimeout(
        bunker.getPublicKey(),
        RESTORE_TIMEOUT_MS,
        undefined,
        timeoutMessage(),
      );
      if (session.userPubkey && pk !== session.userPubkey) {
        throw new Nip46IdentityMismatchError();
      }
      const signer = new Nip46Signer(bunker, clientSk, pointer, pool);
      signer.pk = pk;
      return signer;
    } catch (e) {
      await bunker.close().catch(() => {});
      pool.destroy();
      throw e;
    }
  }

  /**
   * Start a client-initiated nostrconnect flow. Renders `handle.uri` as a QR;
   * `handle.connected` resolves when the signer approves and `result === secret`.
   * `handle.cancel()` aborts the wait.
   */
  static startNostrConnect(
    relays: string[],
    timeoutMs = NOSTRCONNECT_TIMEOUT_MS,
  ): NostrConnectHandle {
    const clientSk = generateSecretKey();
    const secret = crypto.randomUUID().replace(/-/g, "");
    const uri = createNostrConnectURI({
      clientPubkey: getPublicKey(clientSk),
      relays,
      secret,
      perms: DEFAULT_PERMS,
      name: CLIENT_METADATA.name,
      url: CLIENT_METADATA.url,
    });
    const controller = new AbortController();
    // Both the timeout and the user's Cancel abort the same wait; this flag lets
    // us map the resulting rejection to the right message.
    let userCancelled = false;
    const pool = makePool();
    // On return to foreground, force an immediate reconnect of any dropped
    // socket instead of waiting out the pool's backoff — the signer may be
    // about to publish (or re-publish) its ephemeral reply.
    const onVisible =
      typeof document === "undefined"
        ? null
        : () => {
            if (document.visibilityState !== "visible") return;
            for (const url of relays) void pool.ensureRelay(url).catch(() => {});
          };
    if (onVisible) document.addEventListener("visibilitychange", onVisible);
    const connected = BunkerSigner.fromURI(
      clientSk,
      uri,
      { onauth: onAuth, pool },
      controller.signal,
    ).then((bunker) => {
      // Capture the pointer into our own field NOW. The remote-signer pubkey
      // is only known from the signer's connect reply, so it can't be built
      // ahead of time — but `bp` is typed public API here, so a nostr-tools
      // rename is a compile error, not a silent persistence break.
      const pointer: BunkerPointer = { pubkey: bunker.bp.pubkey, relays, secret };
      return new Nip46Signer(bunker, clientSk, pointer, pool);
    });
    // Independent timeout: fromURI's own budget is 5 min; fail sooner + friendly.
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const guarded = connected
      .finally(() => {
        clearTimeout(timer);
        if (onVisible) document.removeEventListener("visibilitychange", onVisible);
      })
      .catch((e) => {
        pool.destroy();
        if (userCancelled) throw new Error("Cancelled");
        throw controller.signal.aborted ? new Error(timeoutMessage()) : e;
      });
    const cancel = () => {
      userCancelled = true;
      controller.abort();
    };
    return { uri, connected: guarded, cancel };
  }

  /**
   * Connect to a pasted `bunker://` URI. `abort` (from a Cancel button) rejects
   * the returned promise. Malformed input fails with a human message before any
   * crypto runs.
   */
  static async fromBunkerUri(
    bunkerUri: string,
    abort?: AbortSignal,
  ): Promise<Nip46Signer> {
    if (!looksLikeBunkerUri(bunkerUri)) {
      throw new Error(t("error.badBunkerLink"));
    }
    const clientSk = generateSecretKey();
    const pointer = await parseBunkerInput(bunkerUri);
    if (!pointer || !pointer.relays.length) {
      throw new Error(t("error.badBunkerLink"));
    }
    const pool = makePool();
    let bunker: BunkerSigner;
    try {
      // Throws "bad point: is not on curve" for a valid-hex but off-curve pubkey.
      bunker = BunkerSigner.fromBunker(clientSk, pointer, { onauth: onAuth, pool });
    } catch {
      pool.destroy();
      throw new Error(t("error.badBunkerLink"));
    }
    try {
      await withTimeout(
        connectWithRecovery(bunker),
        CONNECT_TIMEOUT_MS,
        abort,
        timeoutMessage(),
      );
    } catch (e) {
      await bunker.close().catch(() => {});
      pool.destroy();
      throw e;
    }
    return new Nip46Signer(bunker, clientSk, pointer, pool);
  }

  async getPublicKey(): Promise<string> {
    if (!this.pk) this.pk = await this.bunker.getPublicKey();
    return this.pk;
  }

  // Every bunker RPC is time-bounded: with the signer relay unreachable, an
  // unbounded await freezes whatever UI initiated it ("Decrypting…" forever —
  // prod report 2026-07-16). 60s is generous enough for a human approving the
  // request in their signer app, and turns a dead relay into a visible error.
  private static readonly RPC_TIMEOUT_MS = 60_000;

  async signEvent(template: EventTemplate): Promise<VerifiedEvent> {
    const pubkey = await this.getPublicKey();
    return (await withTimeout(
      this.bunker.signEvent({ ...template, pubkey } as any),
      Nip46Signer.RPC_TIMEOUT_MS,
      undefined,
      timeoutMessage(),
    )) as VerifiedEvent;
  }

  async nip44Encrypt(recipientPubkey: string, plaintext: string): Promise<string> {
    return withTimeout(
      this.bunker.nip44Encrypt(recipientPubkey, plaintext),
      Nip46Signer.RPC_TIMEOUT_MS,
      undefined,
      timeoutMessage(),
    );
  }

  async nip44Decrypt(counterpartyPubkey: string, ciphertext: string): Promise<string> {
    return withTimeout(
      this.bunker.nip44Decrypt(counterpartyPubkey, ciphertext),
      Nip46Signer.RPC_TIMEOUT_MS,
      undefined,
      timeoutMessage(),
    );
  }

  /**
   * Tear down the transport. Tries a courtesy NIP-46 `logout` RPC first
   * (nostr-tools' BunkerSigner.logout sends it, then closes the local side);
   * bounded because not every signer answers it. Always destroys the dedicated
   * pool so `enableReconnect` stops re-opening sockets to the signer relays.
   * Never throws — local logout must complete regardless of network state.
   */
  async close(): Promise<void> {
    try {
      await withTimeout(
        this.bunker.logout(),
        LOGOUT_TIMEOUT_MS,
        undefined,
        "logout RPC timed out",
      );
    } catch {
      // Courtesy call failed or timed out — still close the local side.
      await this.bunker.close().catch(() => {});
    }
    try {
      this.pool?.destroy();
    } catch {
      /* already destroyed */
    }
  }
}
