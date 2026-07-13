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

/** App default relays — sensible, widely-reachable public relays. */
export const DEFAULT_RELAYS = ENV_RELAYS ?? [
  "wss://relay.primal.net",
  "wss://relay.damus.io",
  "wss://nos.lol",
];

/** Read-oriented relay included in defaults for discovery breadth. */
export const DEFAULT_READ_RELAYS = ENV_RELAYS ? [] : ["wss://relay.nostr.band"];

/** Fallback Blossom servers when an event/user configures none (spec §11). */
export const DEFAULT_BLOSSOM_SERVERS = ENV_BLOSSOM ?? [
  "https://blossom.primal.net",
  "https://cdn.satellite.earth",
];

/** NIP-65 relay-list defaults published for new users (spec §5.4 item 2). */
export const ONBOARDING_RELAY_LIST: { url: string; read: boolean; write: boolean }[] =
  ENV_RELAYS
    ? ENV_RELAYS.map((url) => ({ url, read: true, write: true }))
    : [
        { url: "wss://relay.primal.net", read: true, write: true },
        { url: "wss://relay.damus.io", read: true, write: true },
        { url: "wss://nos.lol", read: true, write: true },
        { url: "wss://relay.nostr.band", read: true, write: false },
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
