/**
 * Centralised monotonic publication for replaceable/addressable events (wire v2
 * §3.1, audit P3).
 *
 * The wire rule is that a publisher of a replaceable/addressable event MUST use
 * `created_at = max(now, previous_created_at + 1)` so its update always wins the
 * §3.1 tie-break (higher created_at, or equal created_at with a lower id) against
 * whatever is currently authoritative. Publishing with a bare wall-clock second
 * loses that race whenever two writes land in the same second (an "Approve all"
 * loop, a detach in the same second as the previous config, a rapid edit): the
 * new event can tie on created_at and then LOSE on the id comparison, silently
 * leaving a stale event current. One-second timestamp resolution makes this
 * common, not theoretical.
 *
 * `publishMonotonic` centralises the read-before-write:
 *  1. Fetch the RELAY-ONLY current winner for the address (the dexie cache/EOSE
 *     race can hide a just-published event, so this must not be cache-served).
 *  2. Combine it with a durable, owner+address-scoped local watermark — the
 *     highest created_at THIS client has published for the address — so a fresh
 *     publish is monotonic even before the previous one has propagated back from
 *     relays (or when it only ever landed in the offline queue).
 *  3. Compute `created_at = max(now, max(relayWinner, watermark) + 1)`, hand it
 *     to the caller's `sign`, publish (or queue) the signed event, and advance
 *     the watermark — BEFORE the publish resolves, so an offline/queued publish
 *     still bumps the floor for the next call.
 *
 * The relay-winner read in step 1 is also the reconciliation the audit asks for:
 * if another authorised writer (a co-organizer, another device) has published a
 * newer event, this read sees it and the next publish steps above it rather than
 * fighting it with a stale timestamp. `publishSigned` surfaces no structured
 * per-relay "replaced by newer" response, so read-before-write is the mechanism.
 */
import type { VerifiedEvent } from "nostr-tools/pure";
import { pickLatest } from "@nostrautica/protocol";
import { fetchEventsRelayOnly } from "./ndk.js";
import { publishOrQueue } from "./publish-queue.js";
import { cacheGet, cacheSet, activeCacheOwner, ANON } from "$lib/cache/persist.js";

/** The address a replaceable/addressable event occupies: `kind:pubkey[:d]`. */
export function eventAddress(kind: number, author: string, identifier?: string): string {
  return identifier !== undefined ? `${kind}:${author}:${identifier}` : `${kind}:${author}`;
}

function watermarkKey(address: string): string {
  return `mono:${address}`;
}

/** The durable owner-scoped created_at watermark for an address (0 if none). */
export function publishWatermark(address: string, owner?: string): number {
  return cacheGet<number>(watermarkKey(address), owner ?? activeCacheOwner() ?? ANON)?.data ?? 0;
}

/**
 * Record that this client published `createdAt` for `address`. The persist layer
 * is latest-wins on `at`, so a stale write can never regress the watermark, even
 * across tabs.
 */
function bumpWatermark(address: string, createdAt: number, owner?: string): void {
  cacheSet(watermarkKey(address), createdAt, createdAt, owner ?? activeCacheOwner() ?? ANON);
}

export interface MonotonicInput {
  /** The event kind (must be replaceable or addressable). */
  kind: number;
  /** The AUTHOR pubkey of the event (E_id for organizer events, the account key
   *  for the user's own lists) — used to read the current relay winner. */
  author: string;
  /** The `d` identifier for addressable kinds (30000–39999); omit for plain
   *  replaceable kinds (0, 3, 10000–19999). */
  identifier?: string;
  /** Event relays to read the winner from and publish to. */
  relays?: string[];
  /** Watermark scope; defaults to the active cache owner (the logged-in
   *  identity), falling back to the anon scope so it never silently no-ops. */
  owner?: string;
  /** Build AND sign the event for the computed `created_at`. Kept as a callback
   *  so the timestamp is decided before signing (it is part of the signed id). */
  sign: (createdAt: number) => VerifiedEvent | Promise<VerifiedEvent>;
}

export interface MonotonicResult {
  /** True when the event went out immediately, false when it was queued. */
  published: boolean;
  /** The monotonic created_at actually used (also the new watermark). */
  createdAt: number;
}

/**
 * Publish a replaceable/addressable event with a §3.1-monotonic created_at. See
 * the module header for the full rationale.
 */
export async function publishMonotonic(input: MonotonicInput): Promise<MonotonicResult> {
  const address = eventAddress(input.kind, input.author, input.identifier);
  const owner = input.owner ?? activeCacheOwner() ?? ANON;

  let relayAt = 0;
  try {
    const filter =
      input.identifier !== undefined
        ? { kinds: [input.kind], authors: [input.author], "#d": [input.identifier] }
        : { kinds: [input.kind], authors: [input.author] };
    const winner = pickLatest(
      (await fetchEventsRelayOnly(filter, input.relays)) as unknown as {
        id: string;
        created_at?: number;
      }[],
    );
    relayAt = winner?.created_at ?? 0;
  } catch {
    /* offline / no relays — the local watermark alone still bounds us */
  }

  const floor = Math.max(publishWatermark(address, owner), relayAt);
  const createdAt = Math.max(Math.floor(Date.now() / 1000), floor + 1);

  const event = await input.sign(createdAt);
  // Advance the watermark BEFORE awaiting the publish: a queued (offline) publish
  // must still raise the floor so the next call for this address is above it.
  bumpWatermark(address, createdAt, owner);
  const published = await publishOrQueue(event, input.relays);
  return { published, createdAt };
}
