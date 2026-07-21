/**
 * Relay policy (spec §5.4, §10.1). The effective relay set for any operation is
 * app defaults ∪ event 31600 relays ∪ user 10002.
 */

/**
 * Build-time overrides for local dev / e2e / screenshot runs: point the whole
 * app at a dockerized relay + Blossom (docker/docker-compose.yml) so test
 * traffic never touches public infrastructure. Comma-separated URLs.
 */
const ENV_RELAYS = (import.meta.env?.VITE_NOSTRAUTICA_RELAYS as string | undefined)
  ?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ENV_BLOSSOM = (import.meta.env?.VITE_NOSTRAUTICA_BLOSSOM as string | undefined)
  ?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * App default relays — free, open-write, widely-reachable public relays.
 *
 * Probed 2026-07-21 (connect + NIP-11 `limitation` + a live kind-31600 read).
 * Two relays were serving events one day and refusing connections the next
 * (damus 503, nostr.band timeout), and a two-relay default meant a single
 * outage left effectively one relay carrying the app — so the set is wider now
 * and deliberately spread across operators. Anything requiring payment or auth
 * is excluded: attendees must be able to publish without an account somewhere.
 */
export const DEFAULT_RELAYS = ENV_RELAYS ?? [
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://relay.nostr.net",
  "wss://nostr.mom",
  "wss://nostr.oxtr.dev",
];

/**
 * Read-oriented relays included in defaults for discovery breadth.
 * (relay.nostr.band was here until 2026-07-21, when it stopped accepting
 * connections entirely — every page load paid its full connect timeout.)
 */
export const DEFAULT_READ_RELAYS = ENV_RELAYS ? [] : ["wss://purplerelay.com"];

/**
 * Relays the Whitenoise Marmot/MLS client publishes its key packages and group
 * traffic to (confirmed via its own "seen on relays" key-package screen,
 * 2026-07-20). Without these in a chat-enabled event's relay set, the
 * coordinator never discovers a Whitenoise attendee's key package, and even a
 * found one can't route group messages back to a Whitenoise client whose own
 * relay list doesn't overlap ours. Unioned into new chat-enabled events'
 * relays at creation (create.ts) so both directions work by default.
 */
export const WHITENOISE_RELAYS = ["wss://relay.us.whitenoise.chat", "wss://relay.eu.whitenoise.chat"];

/**
 * Relays advertised in the `nostrconnect://` URI (NIP-46). Dedicated signer
 * relays handle the ephemeral kind-24133 traffic without the rate limits
 * general-purpose relays impose; `relay.nsec.app` is the de-facto signer relay
 * (nsec.app / Amber / nostrconnect.org). Two widely-reachable general relays
 * add redundancy (relay.nsec.app has had EU flakiness) — but note redundancy
 * only helps while our sockets are open; the pool's reconnect + foreground
 * recovery in signer/nip46.ts is what covers backgrounded-tab drops.
 * Honors VITE_NOSTRAUTICA_RELAYS so local e2e keeps working.
 */
export const NIP46_RELAYS = ENV_RELAYS ?? [
  // Subscribed in parallel (SimplePool) — the signer publishes its reply to all
  // of them, so any one working relay is enough; a failed socket (e.g. the
  // often-flaky relay.nsec.app, kept for signers that default to it) is harmless.
  "wss://relay.primal.net",
  "wss://nos.lol",
  "wss://relay.nsec.app",
];

/**
 * Fallback Blossom servers when an event/user configures none (spec §11).
 *
 * The primary (first) MUST accept arbitrary BUD-02 blobs with permissive CORS —
 * Nostrautica uploads AES-GCM CIPHERTEXT as `application/octet-stream`, and
 * `uploadAndMirror` fails the whole upload if the primary rejects it. Both of
 * these are the hzrd149 blossom-server implementation (same as our local test
 * infra), which stores blobs by hash without media-type validation and sends
 * `Access-Control-Allow-Origin: *`. (The previous defaults — blossom.primal.net
 * and cdn.satellite.earth — 415'd encrypted octet-stream / required payment, so
 * every intro-video upload failed: prod report 2026-07-17.)
 */
export const DEFAULT_BLOSSOM_SERVERS = ENV_BLOSSOM ?? [
  "https://blossom.band",
  "https://nostr.download",
];

/**
 * NIP-17 DM-relay defaults (kind 10050) published for app-generated keys so
 * gift-wrapped DMs (and future group chat) reliably reach the user in other
 * clients. These are inboxes where the user agrees to receive kind-1059 wraps —
 * a small set of widely-reachable write relays. Honors VITE_NOSTRAUTICA_RELAYS
 * so local e2e keeps working.
 */
export const DM_RELAY_LIST: string[] =
  ENV_RELAYS ?? ["wss://relay.primal.net", "wss://nos.lol", "wss://relay.nostr.net"];

/** NIP-65 relay-list defaults published for new users (spec §5.4 item 2). */
export const ONBOARDING_RELAY_LIST: { url: string; read: boolean; write: boolean }[] =
  ENV_RELAYS
    ? ENV_RELAYS.map((url) => ({ url, read: true, write: true }))
    : [
        { url: "wss://nos.lol", read: true, write: true },
        { url: "wss://relay.primal.net", read: true, write: true },
        { url: "wss://relay.nostr.net", read: true, write: true },
        { url: "wss://nostr.mom", read: true, write: true },
        { url: "wss://nostr.oxtr.dev", read: true, write: false },
      ];

/** Union of relay URL lists, de-duplicated, preserving first-seen order. */
export function unionRelays(...lists: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const url of list) {
      const norm = url.trim().replace(/\/+$/, "");
      if (norm && !seen.has(norm)) {
        seen.add(norm);
        out.push(norm);
      }
    }
  }
  return out;
}
