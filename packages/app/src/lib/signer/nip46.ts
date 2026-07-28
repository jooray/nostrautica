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
import { signerRelays } from "$lib/nostr/relays.js";
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
  "sign_event:5", // deletion request
  "sign_event:13", // NIP-59 seal (gift-wrap join requests + NIP-17 DMs)
  "sign_event:10000", // mute list
  "sign_event:10050", // preferred DM relays
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
/** A transport probe is machine-paced and must not consume the human approval budget. */
const PROBE_TIMEOUT_MS = 12_000;

const HEX_PUBKEY = /^[0-9a-f]{64}$/;

function validPubkey(value: unknown): value is string {
  return typeof value === "string" && HEX_PUBKEY.test(value);
}

function requirePubkey(value: unknown, context: string): string {
  if (!validPubkey(value)) throw new Error(`${context}: signer returned an invalid pubkey`);
  return value;
}

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

/** A signer relay's socket either opened or dropped. */
type RelayTransition = "up" | "down";

/**
 * Live view of a NIP-46 pool's socket health. Owns the pool's connection hooks
 * (plain public fields on AbstractSimplePool that `SimplePool`'s constructor type
 * doesn't accept), so BOTH consumers below share one owner — the fields are
 * single-assignment, so nothing else may set them for this pool.
 *
 *  - `unreachable()` names the signer relays we currently can't open, so a failed
 *    wait can say *which* relay is down instead of only "your signer didn't
 *    respond". Without it a relay outage (measured 2026-07-25: `wss://relay.nsec.app`
 *    answering the upgrade with HTTP 502, 3/3 probes) is indistinguishable from a
 *    signer app that is simply closed. The hooks fire from both the subscribe and
 *    the publish path, so inbound and outbound failures are both covered; a relay
 *    that failed once and then came up is removed again.
 *  - `subscribe()` reports socket transitions. Kind-24133 replies are EPHEMERAL:
 *    one the signer publishes while our socket is down is gone for good, not
 *    replayable on reconnect. The visibility-based recovery elsewhere only fires
 *    on a mobile tab handoff; a socket that drops and returns WITHOUT one — a
 *    relay restart, a desktop network blip, a signer running on a separate phone
 *    while this tab stays foreground — is exactly the flaky-relay case it misses.
 *    A consumer watches for a drop-then-recover during its pending window and
 *    re-drives the request then, instead of riding out the full timeout.
 */
interface PoolHealth {
  unreachable: () => string[];
  subscribe: (listener: (event: RelayTransition) => void) => () => void;
}

function trackPoolHealth(pool: SimplePool): PoolHealth {
  const failed = new Set<string>();
  const listeners = new Set<(event: RelayTransition) => void>();
  // Copy before iterating: a listener may unsubscribe itself on the event it receives.
  const emit = (event: RelayTransition) => {
    for (const l of [...listeners]) l(event);
  };
  pool.onRelayConnectionFailure = (url) => {
    failed.add(url);
    emit("down");
  };
  pool.onRelayConnectionSuccess = (url) => {
    failed.delete(url);
    emit("up");
  };
  return {
    // Hostnames, not URLs: "relay.nsec.app" is what a user can recognise and
    // repeat back to us; "wss://relay.nsec.app/" is noise in an error banner.
    unreachable: () => [...failed].map((u) => u.replace(/^wss?:\/\//i, "").replace(/\/+$/, "")),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * The message for a signer wait that ran out of time. Evaluated LAZILY at the
 * moment of failure (see `withTimeout`) — relay health is unknown when the wait
 * starts and only becomes known as sockets fail, so building the string up front
 * would always report "no relays failed".
 */
const timeoutMessage = (unreachable?: () => string[]) => {
  const down = unreachable?.() ?? [];
  return down.length
    ? t("error.signerRelaysUnreachable", { relays: down.join(", ") })
    : t("error.signerTimeout");
};

/**
 * True when the input is *meant* to be a `bunker://` URI, regardless of whether
 * it is well-formed yet. This is the routing question ("is the user pasting a
 * bunker link or a private key?"), deliberately looser than
 * `looksLikeBunkerUri` — a half-typed `bunker://<pubkey>` with no `?relay=` yet
 * must still route to the bunker path so the user gets "that doesn't look like a
 * valid bunker link" rather than a bech32 decode error from the key importer.
 *
 * Case-insensitive because iOS auto-capitalises the first character of a typed
 * field, so a hand-typed link arrives as `Bunker://…`. The sign-in UI used to do
 * its own case-SENSITIVE `startsWith("bunker://")`, which sent exactly that
 * input to "Import key" and failed with an unrelated bech32 error. Both the UI
 * and the connect path now call into this file so they cannot drift again.
 */
export function isBunkerScheme(input: string): boolean {
  return /^bunker:\/\//i.test(input.trim());
}

/**
 * Fold a user-supplied bunker link into the exact shape nostr-tools will accept.
 *
 * nostr-tools' `BUNKER_REGEX` is `/^bunker:\/\/([0-9a-f]{64})…/` — case
 * SENSITIVE on both the scheme and the pubkey — and `parseBunkerInput` silently
 * falls through to a NIP-05 lookup (then returns null) when it doesn't match. So
 * `Bunker://…` (iOS auto-capitalisation) and an uppercase-hex pubkey (some QR
 * encoders uppercase payloads to reach QR's compact alphanumeric mode) both got
 * rejected as "not a valid bunker link" even though they name a perfectly good
 * signer. Only the scheme and the pubkey are lowered: the query string carries
 * relay URLs and the connect secret, which are case-significant.
 */
export function normalizeBunkerUri(input: string): string {
  return input
    .trim()
    .replace(/^bunker:\/\/([0-9a-fA-F]{64})/i, (_m, pk: string) =>
      `bunker://${pk.toLowerCase()}`,
    );
}

/** A syntactically valid `bunker://` URI: 64-hex pubkey + at least one relay. */
export function looksLikeBunkerUri(input: string): boolean {
  const m = input.match(/^bunker:\/\/([0-9a-f]{64})\b/i);
  if (!m) return false;
  try {
    return new URL(input).searchParams.getAll("relay").length > 0;
  } catch {
    return false;
  }
}

/**
 * Reject if a connect/wait doesn't finish within `ms`; `abort` also rejects it.
 * `message` may be a thunk so the text can describe the state at failure time
 * (which relays were unreachable) rather than at call time.
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  abort: AbortSignal | undefined,
  message: string | (() => string),
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(typeof message === "function" ? message() : message)),
      ms,
    );
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
function connectWithRecovery(
  bunker: BunkerSigner,
  connect = () => bunker.connect(CLIENT_METADATA),
  health?: PoolHealth,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubHealth: (() => void) | undefined;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (onVisible) document.removeEventListener("visibilitychange", onVisible);
      unsubHealth?.();
      fn();
    };
    // Re-send `connect` and probe with `ping`; whichever answers first settles.
    // Shared by the foreground-handoff and relay-reconnect recovery paths.
    const retry = () => {
      if (settled) return;
      connect().then(() => settle(resolve), () => {});
      bunker.ping().then(() => settle(resolve), () => {});
    };
    const onVisible =
      typeof document === "undefined"
        ? null
        : () => {
            if (settled || document.visibilityState !== "visible") return;
            retry();
          };
    if (onVisible) document.addEventListener("visibilitychange", onVisible);
    // A signer relay that dropped and came back may have swallowed the ack while
    // it was down. Re-drive once a recover FOLLOWS a drop during this wait — a
    // socket merely finishing its initial connect (an "up" with no prior "down")
    // must not trigger a spurious re-send.
    if (health) {
      let dropped = false;
      unsubHealth = health.subscribe((event) => {
        if (event === "down") dropped = true;
        else if (dropped) retry();
      });
    }
    connect().then(
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

/** Only let signer-provided approval links reach window.open or an href. */
export function safeNip46AuthUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

/**
 * Handle a remote signer's `auth_url` challenge: open the URL so the user can
 * approve out of band. The RPC then completes on the same request id.
 *
 * `window.open` is the fast path. The URL is also handed to registered UI
 * listeners so the persistent shell retains a tappable approval link after
 * login, including when a mobile browser blocks the popup.
 */
function onAuth(url: string): void {
  if (typeof window === "undefined") return;
  const safeUrl = safeNip46AuthUrl(url);
  if (!safeUrl) return;
  let popup: Window | null = null;
  try {
    // No "noopener" in the features string: with it, window.open returns null
    // even on SUCCESS, which would defeat blocked-popup detection. Severing
    // the opener by hand gives the same protection (the new tab starts as
    // same-origin about:blank, so the assignment is allowed).
    popup = window.open(safeUrl, "_blank");
    if (popup) popup.opener = null;
  } catch {
    popup = null;
  }
  for (const listener of authUrlListeners) listener(safeUrl);
}

/**
 * Never let `switch_relays` decide our transport (2026-07-28 login incident).
 *
 * nostr-tools' `switchRelays()` does `this.bp.relays = <whatever the signer
 * answered>` and re-subscribes on exactly that set — it REPLACES, it does not
 * union. `fromURI` calls it internally before resolving (raced against a 1s
 * timer, so whether it lands at all is non-deterministic), and we used to call
 * it again on the bunker-paste and restore paths.
 *
 * The effect was that a freshly-connected session ran on the signer's relay
 * list ALONE, silently discarding the `signerRelays()` union that every other
 * path applies — while the SAME account after one refresh got
 * `pointer ∪ NIP46_RELAYS` back from `fromPersisted`. That asymmetry is
 * indefensible for a transport whose replies are ephemeral and unreplayable:
 * kind-24133 only lands if a socket we share with the signer is open in the
 * exact window it publishes, which is the entire reason NIP46_RELAYS is four
 * independent operators (see relays.ts). Handing that decision to the signer
 * can narrow four sockets to one — and Amber's own default list still names
 * `wss://relay.nsec.app`, which has answered every WebSocket upgrade with HTTP
 * 502 since 2026-07-25.
 *
 * So: `skipSwitchRelays` on every construction, and `signerRelays()` stays the
 * single authority on which relays we talk to. The signer answered our
 * handshake on these relays, so it is demonstrably listening on them; a signer
 * that wants to move can do so by advertising a different pointer next time.
 */
const NO_SWITCH_RELAYS = { skipSwitchRelays: true } as const;

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
    /**
     * Shared health view for this signer's pool. Carried onto the instance so
     * post-connect RPCs (`rpcWithForegroundRetry`) get the same relay
     * drop-then-recover recovery the connect handshake does.
     */
    private readonly health?: PoolHealth,
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
    // `pointer` stays the faithful record of what the signer advertised (it is
    // what `serialize()` writes back), while the TRANSPORT also gets our own
    // signer relays unioned in — restore used to use the stored relays alone, so
    // a session established against a since-dead relay could never come back.
    // Keeping the two apart means the union is re-derived from the current
    // NIP46_RELAYS on every restore instead of being frozen into storage.
    const transport: BunkerPointer = { ...pointer, relays: signerRelays(pointer.relays) };
    const pool = makePool();
    const health = trackPoolHealth(pool);
    const bunker = BunkerSigner.fromBunker(clientSk, transport, {
      onauth: onAuth,
      pool,
      ...NO_SWITCH_RELAYS,
    });
    // An authorized persisted channel remains usable after its one-time connect
    // secret has been consumed. Probe it first; only fall back to a bounded
    // connect for signers that require a fresh handshake.
    try {
      let authorized = false;
      try {
        await withTimeout(bunker.ping(), RESTORE_TIMEOUT_MS, undefined, () =>
          timeoutMessage(health.unreachable),
        );
        authorized = true;
      } catch {
        // The fallback retains lost-ack foreground recovery but is independently bounded.
      }
      if (!authorized) {
        await withTimeout(connectWithRecovery(bunker, undefined, health), RESTORE_TIMEOUT_MS, undefined, () =>
          timeoutMessage(health.unreachable),
        );
      }
      // Identity check: never trust that the reconnected bunker still answers
      // for the same user. A session without `userPubkey` is pre-upgrade —
      // accepted once; session.restore() backfills it immediately after.
      const pk = requirePubkey(await withTimeout(
        bunker.getPublicKey(),
        RESTORE_TIMEOUT_MS,
        undefined,
        () => timeoutMessage(health.unreachable),
      ), "NIP-46 restore");
      if (session.userPubkey && pk !== session.userPubkey) {
        throw new Nip46IdentityMismatchError();
      }
      const signer = new Nip46Signer(
        bunker,
        clientSk,
        { ...pointer, relays: [...pointer.relays] },
        pool,
        health,
      );
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
    const pool = makePool();
    const health = trackPoolHealth(pool);
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

    /*
     * WHY THIS DOESN'T LEAN ON nostr-tools' AbortSignal.
     *
     * `fromURI` forwards our signal into the pool, which wires it by ASSIGNING
     * `onabort` — `opts.abort.onabort = reject` in AbstractRelay.connect and
     * `params.abort.onabort = () => sub.close(…)` in AbstractRelay.subscribe
     * (nostr-tools 2.23.9). One signal, N relays: each assignment overwrites the
     * previous one, so only the LAST relay ever sees the abort. Its subscription
     * closes, but `subscribeMap`'s `handleClose` only fires `params.onclose` once
     * ALL N relays have closed — so `fromURI`'s promise stays pending forever.
     *
     * Reproduced against a real SimplePool + real BunkerSigner.fromURI over a
     * fake WebSocket: with 2 or 3 relays the promise is still pending after
     * abort; only with exactly 1 relay does it reject. Which means, before this
     * change: Cancel did nothing, the 120s timeout did nothing, `await
     * handle.connected` never settled (the QR and "waiting for the signer…" sat
     * there forever with no error), and because `.finally()` never ran, every
     * Retry tap left behind another live SimplePool with `enableReconnect` and a
     * 29s ping on three sockets. Navigating away leaked the same way.
     *
     * So the outcome is decided HERE: a deferred we can reject ourselves, raced
     * against `fromURI`. The signal is still passed along — dropping it would
     * change the library's own timeout maths (with no signal `maxWait` defaults
     * to 5 min, which stretches each relay's connect timeout from 3s to ~299s and
     * would stop `trackPoolHealth` from ever naming a dead relay inside our
     * 120s budget) — but nothing depends on it working.
     */
    let outcome: "pending" | "connected" | "abandoned" = "pending";
    let giveUp: (reason: Error) => void = () => {};
    const abandoned = new Promise<never>((_, reject) => {
      giveUp = reject;
    });
    // Forward-declared: `release` has to clear this timer, but the timer's own
    // callback is one of the paths that calls `release`.
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    /**
     * The single teardown path. `destroyPool` is false only on success, where the
     * pool is handed to the returned signer (which destroys it in `close()`);
     * every other exit destroys it here, exactly once, because `outcome` gates
     * every caller.
     */
    const release = (destroyPool: boolean) => {
      clearTimeout(timer);
      if (onVisible) document.removeEventListener("visibilitychange", onVisible);
      if (destroyPool) {
        // Courtesy only — see above, this reaches at most one relay. The
        // destroy() below is what actually closes the sockets and stops
        // `enableReconnect` from re-opening them.
        controller.abort();
        try {
          pool.destroy();
        } catch {
          /* already destroyed */
        }
      }
    };
    /** Settle `connected` on our terms (timeout or Cancel) and tear everything down. */
    const abandon = (reason: Error) => {
      // Once a signer has connected, the pool belongs to it: Cancel must not
      // close its transport. This matters in practice — SignInOptions' onMount
      // teardown calls cancel() on unmount, which is exactly what a successful
      // sign-in triggers as it navigates away.
      if (outcome !== "pending") return;
      outcome = "abandoned";
      release(true);
      giveUp(reason);
    };

    // fromURI installs its REQ synchronously, but nostr-tools exposes no EOSE or
    // relay-ready promise for it. Do not pretend the same-device deep link is
    // ready after an arbitrary delay: foreground socket nudging plus the visible
    // fresh-code retry are the reliable public-API recovery available here.
    const connecting = BunkerSigner.fromURI(
      clientSk,
      uri,
      { onauth: onAuth, pool, ...NO_SWITCH_RELAYS },
      controller.signal,
    );
    // `connecting` may settle long after we've stopped waiting on it (destroying
    // the pool closes every subscription, which is what finally makes it reject).
    // Attach terminal handlers now: an unobserved rejection would surface as an
    // unhandled promise rejection, and a late SUCCESS would leave a live
    // BunkerSigner holding listeners nobody owns.
    void connecting.then(
      (bunker) => {
        if (outcome === "abandoned") void bunker.close().catch(() => {});
      },
      () => {},
    );

    // Independent timeout: fromURI's own budget is 5 min; fail sooner + friendly.
    // The message is composed inside the callback, so it can name the relays that
    // turned out to be unreachable during the wait.
    timer = setTimeout(() => abandon(new Error(timeoutMessage(health.unreachable))), timeoutMs);
    const cancel = () => abandon(new Error("Cancelled"));

    const connected = Promise.race([connecting, abandoned]).then(
      (bunker) => {
        outcome = "connected";
        release(false);
        // Capture the pointer into our own field NOW. The remote-signer pubkey
        // is only known from the signer's connect reply, so it can't be built
        // ahead of time — but `bp` is typed public API here, so a nostr-tools
        // rename is a compile error, not a silent persistence break.
        const pointer: BunkerPointer = {
          pubkey: bunker.bp.pubkey,
          // The relays the handshake ACTUALLY completed on — i.e. the ones we
          // advertised in the QR and the signer answered on. `switch_relays` is
          // suppressed (see NO_SWITCH_RELAYS), so this is never a signer-chosen
          // set that quietly replaced ours.
          relays: [...bunker.bp.relays],
          secret,
        };
        return new Nip46Signer(bunker, clientSk, pointer, pool, health);
      },
      (e: unknown) => {
        // fromURI failed on its own (e.g. every relay closed) — same teardown.
        if (outcome === "pending") {
          outcome = "abandoned";
          release(true);
        }
        throw e instanceof Error ? e : new Error(String(e));
      },
    );
    return { uri, connected, cancel };
  }

  /**
   * Connect to a pasted `bunker://` URI. `abort` (from a Cancel button) rejects
   * the returned promise. Malformed input fails with a human message before any
   * crypto runs. nostr-tools' connect() hardcodes an empty permissions field,
   * so this path uses its public sendRequest() to ask for the same permissions
   * as the QR flow.
   */
  static async fromBunkerUri(
    bunkerUri: string,
    abort?: AbortSignal,
  ): Promise<Nip46Signer> {
    // Normalize BEFORE validating: a typed link arrives from iOS as `Bunker://…`
    // and some QR encoders uppercase the hex pubkey, neither of which
    // nostr-tools' case-sensitive BUNKER_REGEX accepts.
    const normalized = normalizeBunkerUri(bunkerUri);
    if (!looksLikeBunkerUri(normalized)) {
      throw new Error(t("error.badBunkerLink"));
    }
    const clientSk = generateSecretKey();
    const pointer = await parseBunkerInput(normalized);
    if (!pointer || !pointer.relays.length) {
      throw new Error(t("error.badBunkerLink"));
    }
    // Talk to the signer on its own relays PLUS ours (see signerRelays): a link
    // whose single advertised relay is down used to fail outright. `pointer` is
    // what gets persisted, so the union is policy re-applied per connect, not
    // state baked into the session.
    const transport: BunkerPointer = { ...pointer, relays: signerRelays(pointer.relays) };
    const pool = makePool();
    const health = trackPoolHealth(pool);
    let bunker: BunkerSigner;
    try {
      // Throws "bad point: is not on curve" for a valid-hex but off-curve pubkey.
      bunker = BunkerSigner.fromBunker(clientSk, transport, {
        onauth: onAuth,
        pool,
        ...NO_SWITCH_RELAYS,
      });
    } catch {
      pool.destroy();
      throw new Error(t("error.badBunkerLink"));
    }
    try {
      const connect = () =>
        bunker.sendRequest("connect", [
          pointer.pubkey,
          pointer.secret ?? "",
          DEFAULT_PERMS.join(","),
          JSON.stringify(CLIENT_METADATA),
        ]).then(() => undefined);
      await withTimeout(connectWithRecovery(bunker, connect, health), CONNECT_TIMEOUT_MS, abort, () =>
        timeoutMessage(health.unreachable),
      );
    } catch (e) {
      await bunker.close().catch(() => {});
      pool.destroy();
      throw e;
    }
    return new Nip46Signer(
      bunker,
      clientSk,
      { ...pointer, relays: [...pointer.relays] },
      pool,
      health,
    );
  }

  async getPublicKey(): Promise<string> {
    if (!this.pk) {
      this.pk = requirePubkey(
        await this.rpcWithForegroundRetry(() => this.bunker.getPublicKey()),
        "NIP-46 get_public_key",
      );
    }
    return this.pk;
  }

  // Every bunker RPC is time-bounded: with the signer relay unreachable, an
  // unbounded await freezes whatever UI initiated it ("Decrypting…" forever —
  // prod report 2026-07-16). 60s is generous enough for a human approving the
  // request in their signer app, and turns a dead relay into a visible error.
  private static readonly RPC_TIMEOUT_MS = 60_000;

  /**
   * An ephemeral RPC reply can be lost two ways: a mobile signer handoff
   * (the tab backgrounds while the user approves in the signer app), or a signer
   * relay dropping and recovering mid-request without any handoff — a relay
   * restart, a desktop network blip, or a signer on a separate phone while this
   * tab stays foreground. Either signal wins the race against the first attempt:
   * probe the re-established transport, then retry exactly once. Both attempts
   * and the probe have explicit deadlines, so neither path can wedge.
   *
   * The relay path only fires on a recover that FOLLOWS a drop during THIS
   * request, so a socket finishing its initial connect can't provoke a spurious
   * duplicate — the same restraint the visibility path gets from `hiddenWhilePending`.
   */
  private async rpcWithForegroundRetry<T>(operation: () => Promise<T>): Promise<T> {
    const hasDocument = typeof document !== "undefined";
    // Nothing to recover against: no foreground handoff signal and no relay health.
    if (!hasDocument && !this.health) {
      return withTimeout(operation(), Nip46Signer.RPC_TIMEOUT_MS, undefined, () =>
        timeoutMessage(this.health?.unreachable),
      );
    }

    let resume!: () => void;
    const resumed = new Promise<symbol>((resolve) => {
      resume = () => resolve(Symbol.for("nip46-resumed"));
    });

    let hiddenWhilePending = hasDocument && document.visibilityState === "hidden";
    const onVisibility = () => {
      if (document.visibilityState === "hidden") hiddenWhilePending = true;
      else if (hiddenWhilePending) resume();
    };
    if (hasDocument) document.addEventListener("visibilitychange", onVisibility);

    let droppedWhilePending = false;
    const unsubHealth = this.health?.subscribe((event) => {
      if (event === "down") droppedWhilePending = true;
      else if (droppedWhilePending) resume();
    });

    try {
      const first = withTimeout(operation(), Nip46Signer.RPC_TIMEOUT_MS, undefined, () =>
        timeoutMessage(this.health?.unreachable),
      );
      const result = await Promise.race([first, resumed]);
      if (typeof result !== "symbol") return result;

      // The library has no request cancellation API. The abandoned first request
      // may still answer, but its bounded wrapper is observed to avoid an
      // unhandled rejection; the user-visible operation has one controlled retry.
      void first.catch(() => {});
      await withTimeout(this.bunker.ping(), PROBE_TIMEOUT_MS, undefined, () =>
        timeoutMessage(this.health?.unreachable),
      );
      return await withTimeout(operation(), Nip46Signer.RPC_TIMEOUT_MS, undefined, () =>
        timeoutMessage(this.health?.unreachable),
      );
    } finally {
      if (hasDocument) document.removeEventListener("visibilitychange", onVisibility);
      unsubHealth?.();
    }
  }

  async signEvent(template: EventTemplate): Promise<VerifiedEvent> {
    const pubkey = await this.getPublicKey();
    const requested = {
      kind: template.kind,
      created_at: template.created_at,
      content: template.content,
      tags: JSON.stringify(template.tags),
    };
    const signed = await this.rpcWithForegroundRetry(() => this.bunker.signEvent(template));
    if (
      signed.pubkey !== pubkey ||
      signed.kind !== requested.kind ||
      signed.created_at !== requested.created_at ||
      signed.content !== requested.content ||
      JSON.stringify(signed.tags) !== requested.tags
    ) {
      throw new Error("NIP-46 sign_event: signer returned a different event");
    }
    return signed;
  }

  async nip44Encrypt(recipientPubkey: string, plaintext: string): Promise<string> {
    return this.rpcWithForegroundRetry(() =>
      this.bunker.nip44Encrypt(recipientPubkey, plaintext),
    );
  }

  async nip44Decrypt(counterpartyPubkey: string, ciphertext: string): Promise<string> {
    return this.rpcWithForegroundRetry(() =>
      this.bunker.nip44Decrypt(counterpartyPubkey, ciphertext),
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
