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
} from "nostr-tools/nip46";
import { SimplePool } from "nostr-tools/pool";
import { bytesToHex, hexToBytes } from "@nostrautica/protocol";
import type { AppSigner } from "./types.js";
import { t } from "$lib/i18n/i18n.svelte.js";

/** Serializable NIP-46 session for persistence across refreshes. */
export interface Nip46Session {
  clientSkHex: string;
  bunker: { pubkey: string; relays: string[]; secret?: string };
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
 * Handle a remote signer's `auth_url` challenge: open the URL so the user can
 * approve out of band. The RPC then completes on the same request id.
 */
function onAuth(url: string): void {
  if (typeof window !== "undefined") window.open(url, "_blank", "noopener");
}

export class Nip46Signer implements AppSigner {
  readonly method = "nip46" as const;
  private pk: string | null = null;

  private constructor(
    private readonly bunker: BunkerSigner,
    private readonly clientSk: Uint8Array,
    private readonly pool?: SimplePool,
  ) {}

  /** Serialize the session so it can be restored after a refresh (spec §5.3). */
  serialize(): Nip46Session | null {
    const bp = (this.bunker as any).bp;
    if (!bp?.pubkey || !bp?.relays) return null;
    return {
      clientSkHex: bytesToHex(this.clientSk),
      bunker: { pubkey: bp.pubkey, relays: bp.relays, secret: bp.secret },
    };
  }

  /** Reconnect a persisted NIP-46 session (same client key → same Amber connection). */
  static async fromPersisted(session: Nip46Session): Promise<Nip46Signer> {
    const clientSk = hexToBytes(session.clientSkHex);
    const pool = makePool();
    const bunker = BunkerSigner.fromBunker(clientSk, session.bunker as any, {
      onauth: onAuth,
      pool,
    });
    // Bounded so a dead bunker can't block app boot forever (spec §5.3).
    try {
      await withTimeout(
        bunker.connect(CLIENT_METADATA),
        RESTORE_TIMEOUT_MS,
        undefined,
        timeoutMessage(),
      );
    } catch (e) {
      await bunker.close().catch(() => {});
      pool.destroy();
      throw e;
    }
    return new Nip46Signer(bunker, clientSk, pool);
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
    ).then((bunker) => new Nip46Signer(bunker, clientSk, pool));
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
    return new Nip46Signer(bunker, clientSk, pool);
  }

  async getPublicKey(): Promise<string> {
    if (!this.pk) this.pk = await this.bunker.getPublicKey();
    return this.pk;
  }

  async signEvent(template: EventTemplate): Promise<VerifiedEvent> {
    const pubkey = await this.getPublicKey();
    return (await this.bunker.signEvent({ ...template, pubkey } as any)) as VerifiedEvent;
  }

  async nip44Encrypt(recipientPubkey: string, plaintext: string): Promise<string> {
    return this.bunker.nip44Encrypt(recipientPubkey, plaintext);
  }

  async nip44Decrypt(counterpartyPubkey: string, ciphertext: string): Promise<string> {
    return this.bunker.nip44Decrypt(counterpartyPubkey, ciphertext);
  }

  async close(): Promise<void> {
    await this.bunker.close();
    this.pool?.destroy();
  }
}
