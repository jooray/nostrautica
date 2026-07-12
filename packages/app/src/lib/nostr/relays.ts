/**
 * Relay policy (spec §5.4, §10.1). The effective relay set for any operation is
 * app defaults ∪ event 31600 relays ∪ user 10002.
 */

/** App default relays — sensible, widely-reachable public relays. */
export const DEFAULT_RELAYS = [
  "wss://relay.primal.net",
  "wss://relay.damus.io",
  "wss://nos.lol",
];

/** Read-oriented relay included in defaults for discovery breadth. */
export const DEFAULT_READ_RELAYS = ["wss://relay.nostr.band"];

/** NIP-65 relay-list defaults published for new users (spec §5.4 item 2). */
export const ONBOARDING_RELAY_LIST: { url: string; read: boolean; write: boolean }[] = [
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
