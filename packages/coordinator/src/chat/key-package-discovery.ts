/**
 * KeyPackage discovery beyond the event's own relays (Marmot spec,
 * transports/nostr.md "KeyPackage publication"): "KeyPackage relay discovery
 * uses the account's kind 10002 NIP-65 relay list. [...] There is no
 * dedicated KeyPackage relay list."
 *
 * The coordinator's live 30443 watcher only listens on the event's configured
 * relays — the right fast path for our own app's chat clients, which publish
 * their key package there (client.ts). A spec-compliant third-party Marmot
 * client (e.g. Whitenoise) publishes ONLY to the account's own NIP-65 relays,
 * which need not overlap with the event's at all — so an attested external
 * identity (chat/attest.ts) could publish a perfectly valid key package that
 * the coordinator would never see (prod report 2026-07-20: nsec/npub imported
 * into Whitenoise, never joined the group).
 *
 * This is the pull-based fallback used by MarmotAdmin.syncMember (called on
 * attendee approval and on every new 21607 attestation, chat/admin.ts): for
 * any author with no key package on the primary relays, resolve their kind
 * 10002 (bootstrapped off the primary + a broad well-known relay set — the
 * same practical bootstrap every NIP-65-aware client uses to find a relay
 * list it doesn't have yet) and check there too.
 */
import type { Event as NostrEvent } from "nostr-tools/core";
import { KIND_RELAY_LIST } from "@nostrautica/protocol";
import { sanitizeRelayUrls, type RelayPolicy } from "../net/relay-urls.js";

/** Addressable MLS key-package event (Marmot / NIP-104). */
const KIND_KEY_PACKAGE = 30443;

/** Per-author fan-out cap for NIP-65 lookups (audit COORD-16). */
const MAX_NIP65_RELAYS_PER_AUTHOR = 5;

export interface KeyPackageTransport {
  fetch(filter: unknown, relays?: string[]): Promise<NostrEvent[]>;
}

/** The `d` tag of an addressable event ("" when absent — NIP-01's default slot). */
function dTagOf(e: NostrEvent): string {
  return e.tags.find((t) => t[0] === "d")?.[1] ?? "";
}

/**
 * Collapse a multi-relay result set to ONE key package per (author, `d`) slot:
 * the newest `created_at` wins, and the lexicographically-smaller event id breaks
 * a same-second tie so the choice is deterministic across restarts.
 *
 * kind-30443 is ADDRESSABLE — one live event per (author, `d`) by definition — but
 * relays are not a single store, and a fetch across N of them happily returns the
 * superseded copy alongside the current one. Nothing here deduped, so the caller
 * saw both, and `syncMember` acted on whichever the fetch happened to list first.
 *
 * That is not a cosmetic ordering bug. A device that just re-enrolled has rotated
 * its key package: same `d`, new event id, new init key. Invite it with the OLD
 * copy still sitting on a lagging relay and the coordinator commits an Add and
 * sends a Welcome encrypted to init-key material the device has already thrown
 * away — an undecryptable Welcome, a leaf the coordinator holds and believes in,
 * and a member who is stuck (their client sees no group, the coordinator sees a
 * member) until they reload and press Rejoin. Newest-wins makes the stale copy
 * unreachable as long as the fresh one is visible ANYWHERE we looked.
 */
function newestPerSlot(events: NostrEvent[]): NostrEvent[] {
  const best = new Map<string, NostrEvent>();
  for (const e of events) {
    const slot = `${e.pubkey}\u001f${dTagOf(e)}`;
    const prev = best.get(slot);
    if (!prev) {
      best.set(slot, e);
      continue;
    }
    const newer =
      (e.created_at ?? 0) > (prev.created_at ?? 0) ||
      ((e.created_at ?? 0) === (prev.created_at ?? 0) && e.id < prev.id);
    if (newer) best.set(slot, e);
  }
  return [...best.values()];
}

/**
 * Every current kind-30443 for `authors`: first on `primaryRelays` (fast path
 * — this event's configured relays), then, for any author still missing one,
 * on their own kind-10002 NIP-65 relays (resolved via `primaryRelays` +
 * `fallbackRelays`). An author with more than one key package (multi-device)
 * whose FIRST is found on the primary relays is not re-checked against their
 * own NIP-65 list — a deliberate simplification; the case this exists for is
 * "found nowhere on the primary relays", not "find every last device".
 *
 * The result is deduped per (author, `d`) slot, newest-wins — see
 * {@link newestPerSlot} for why serving a stale copy is worse than serving none.
 */
export async function discoverKeyPackages(
  transport: KeyPackageTransport,
  authors: string[],
  primaryRelays: string[],
  fallbackRelays: string[],
  relayPolicy: RelayPolicy = {},
): Promise<NostrEvent[]> {
  if (authors.length === 0) return [];
  const onPrimary = await transport.fetch({ kinds: [KIND_KEY_PACKAGE], authors }, primaryRelays);
  const found = new Set(onPrimary.map((e) => e.id));
  const covered = new Set(onPrimary.map((e) => e.pubkey));
  const remaining = authors.filter((a) => !covered.has(a));
  // Dedupe even on this early return: `transport.fetch` is already a multi-relay
  // read, so the stale-copy race lives entirely inside the primary relay set — the
  // NIP-65 fallback below is not needed to reproduce it.
  if (remaining.length === 0) return newestPerSlot(onPrimary);

  const relayLists = await transport.fetch(
    { kinds: [KIND_RELAY_LIST], authors: remaining },
    [...primaryRelays, ...fallbackRelays],
  );
  const latest = new Map<string, NostrEvent>();
  for (const e of relayLists) {
    const prev = latest.get(e.pubkey);
    if (!prev || (e.created_at ?? 0) > (prev.created_at ?? 0)) latest.set(e.pubkey, e);
  }

  const extraLists = await Promise.all(
    [...latest.values()].map((e) => {
      // Untrusted input (audit COORD-16): wss-only, well-formed, deduped — and
      // capped per author so a hostile 10002 can't fan the daemon out to
      // arbitrary endpoints.
      const relays = sanitizeRelayUrls(
        e.tags
          .filter((t) => t[0] === "r")
          .map((t) => t[1])
          .filter((u): u is string => !!u),
        { ...relayPolicy, cap: MAX_NIP65_RELAYS_PER_AUTHOR },
      );
      if (relays.length === 0) return Promise.resolve<NostrEvent[]>([]);
      return transport.fetch({ kinds: [KIND_KEY_PACKAGE], authors: [e.pubkey] }, relays);
    }),
  );

  const out = [...onPrimary];
  for (const list of extraLists) {
    for (const e of list) {
      if (!found.has(e.id)) {
        found.add(e.id);
        out.push(e);
      }
    }
  }
  return newestPerSlot(out);
}
