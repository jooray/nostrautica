/**
 * Cross-tab logout broadcast (H-5). One BroadcastChannel per browser profile so
 * that logging out in one tab tears down the same identity's live/in-memory
 * owner state in every other tab of this device — otherwise a second tab would
 * keep serving decrypted cache, a live MLS chat client, and a usable signer for
 * an identity the user believes they logged out.
 *
 * The originating tab has ALREADY self-encrypted key/chat custody into the
 * shared IndexedDB before broadcasting, so receivers only drop their own
 * in-memory copies (`session.applyRemoteLogout`) — they never re-encrypt (no
 * signer round-trip) and never re-broadcast (no loop).
 *
 * The channel is injectable so the unit tests exercise the wire without a real
 * BroadcastChannel (absent in the jsdom/node test env); production defaults to
 * the global. Real two-tab behaviour needs the e2e phase.
 */

const CHANNEL = "nostrautica-session";

type SessionMsg = { t: "logout"; owner: string };

/** The subset of `BroadcastChannel` this module uses. */
export interface SessionChannelLike {
  postMessage(msg: unknown): void;
  addEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
  close(): void;
}

let channel: SessionChannelLike | null = null;
let handler: ((owner: string) => void) | null = null;

function defaultChannel(): SessionChannelLike | null {
  if (typeof BroadcastChannel === "undefined") return null;
  return new BroadcastChannel(CHANNEL);
}

/**
 * Start listening for other tabs' logouts. Idempotent — safe to call from the
 * layout's onMount. `createChannel` is injected by tests; production uses the
 * global BroadcastChannel.
 */
export function initSessionBroadcast(
  onRemoteLogout: (owner: string) => void,
  createChannel: () => SessionChannelLike | null = defaultChannel,
): void {
  handler = onRemoteLogout;
  if (channel) return;
  channel = createChannel();
  channel?.addEventListener("message", (ev) => {
    const m = ev.data as SessionMsg | null;
    if (m && m.t === "logout" && typeof m.owner === "string") handler?.(m.owner);
  });
}

/** Tell other tabs this identity just logged out here. No-op if uninitialised. */
export function broadcastLogout(owner: string): void {
  channel?.postMessage({ t: "logout", owner } satisfies SessionMsg);
}

/** Test-only: drop the channel + handler so each case starts clean. */
export function __resetSessionBroadcastForTests(): void {
  channel?.close();
  channel = null;
  handler = null;
}
