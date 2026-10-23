/**
 * The "accepted" watermark (audit R-29): per owner and replaceable/addressable
 * address, the highest created_at a relay has ACCEPTED from this client.
 *
 * Unlike monotonic.ts's publish watermark, which is bumped before the publish
 * and so also counts events that only ever sat in the outbox, this one names an
 * event that exists on at least one relay: a reader that sees something older
 * is looking at a relay that is behind, never at a publish that was lost.
 *
 * Its own module because both writers need it: `publishMonotonic` (an
 * immediate publish) and the outbox flush (a queued one delivered later), and
 * monotonic.ts already imports publish-queue.ts.
 */
import { cacheGet, cacheSet, activeCacheOwner, ANON } from "$lib/cache/persist.js";

/** The address a replaceable/addressable event occupies: `kind:pubkey[:d]`. */
export function eventAddress(kind: number, author: string, identifier?: string): string {
  return identifier !== undefined ? `${kind}:${author}:${identifier}` : `${kind}:${author}`;
}

function acceptedKey(address: string): string {
  return `mono-accepted:${address}`;
}

/** The accepted watermark for `address` (0 if none). */
export function acceptedWatermark(address: string, owner?: string): number {
  return cacheGet<number>(acceptedKey(address), owner ?? activeCacheOwner() ?? ANON)?.data ?? 0;
}

/** Record that a relay accepted `createdAt` at `address`. Latest-wins, never regresses. */
export function noteAccepted(address: string, createdAt: number, owner?: string): void {
  cacheSet(acceptedKey(address), createdAt, createdAt, owner ?? activeCacheOwner() ?? ANON);
}

/**
 * {@link noteAccepted} for a signed event, when it occupies an address at all:
 * replaceable kinds (0, 3, 10000–19999) and addressable ones (30000–39999).
 * Anything else is a no-op.
 */
export function noteAcceptedEvent(
  event: { kind: number; pubkey: string; created_at: number; tags?: string[][] },
  owner?: string,
): void {
  const k = event.kind;
  const replaceable = k === 0 || k === 3 || (k >= 10000 && k < 20000);
  const addressable = k >= 30000 && k < 40000;
  if (!replaceable && !addressable) return;
  const d = addressable ? (event.tags?.find((t) => t[0] === "d")?.[1] ?? "") : undefined;
  noteAccepted(eventAddress(k, event.pubkey, d), event.created_at, owner);
}
