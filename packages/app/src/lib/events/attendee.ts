/**
 * Attendee-side flows (spec §8). Receive ECK grants (21602), then decrypt the
 * roster (31604) and per-attendee directory entries (31603) — all under the ECK,
 * addressed by blinded d's the attendee can now compute.
 */
import {
  KIND_GIFT_WRAP,
  KIND_KEY_GRANT,
  KIND_DIRECTORY_ENTRY,
  KIND_ROSTER,
  giftwrapSince,
  eckDecrypt,
  base64ToBytes,
  keyGrantContentSchema,
  directoryEntryContentSchema,
  rosterContentSchema,
  parseCoordinate,
  type DirectoryEntryContent,
  type RosterContent,
} from "@nostrautica/protocol";
import type { GiftWrap } from "@nostrautica/protocol";
import type { AppSigner } from "$lib/signer/types.js";
import type { EventContext } from "./event-context.js";
import { signerUnwrap } from "./giftwrap.js";
import { addEckVersions, loadEventKeys, currentEck } from "./keystore.js";
import { directoryPublisher } from "./organizer.js";
import { fetchEvents } from "$lib/nostr/ndk.js";

/**
 * Scan for ECK grants addressed to the user and fold them into the local key
 * store. Returns the coordinates the user now holds a key for.
 */
export async function receiveGrants(signer: AppSigner): Promise<string[]> {
  const pubkey = await signer.getPublicKey();
  const wraps = (await fetchEvents({
    kinds: [KIND_GIFT_WRAP],
    "#p": [pubkey],
    since: giftwrapSince(),
  })) as unknown as GiftWrap[];

  const coordinates = new Set<string>();
  for (const wrap of wraps) {
    let rumor;
    try {
      rumor = await signerUnwrap(signer, wrap);
    } catch {
      continue;
    }
    if (rumor.kind !== KIND_KEY_GRANT) continue;
    let grant;
    try {
      grant = keyGrantContentSchema.parse(JSON.parse(rumor.content));
    } catch {
      continue;
    }
    await addEckVersions(
      grant.a,
      grant.eck,
      grant.role === "organizer" ? "organizer" : "attendee",
    );
    coordinates.add(grant.a);
  }
  return [...coordinates];
}

/** True if the user holds an ECK for this event (i.e. is approved). */
export async function isApproved(coordinate: string): Promise<boolean> {
  const keys = await loadEventKeys(coordinate);
  return !!currentEck(keys);
}

async function eckBytesFor(coordinate: string): Promise<Uint8Array | undefined> {
  const keys = await loadEventKeys(coordinate);
  const eck = currentEck(keys);
  return eck ? base64ToBytes(eck.key) : undefined;
}

/** Fetch + decrypt the roster. Returns undefined if the user isn't approved. */
export async function fetchRoster(ctx: EventContext): Promise<RosterContent | undefined> {
  const eck = await eckBytesFor(ctx.coordinate);
  if (!eck) return undefined;
  const publisher = directoryPublisher(ctx);
  const { identifier } = parseCoordinate(ctx.coordinate);
  const events = await fetchEvents(
    { kinds: [KIND_ROSTER], authors: [publisher], "#d": [identifier] },
    ctx.config.relays,
  );
  const latest = events.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
  if (!latest) return { v: 1, eck_current: 1, attendees: [] };
  try {
    return rosterContentSchema.parse(JSON.parse(eckDecrypt(eck, latest.content)));
  } catch {
    return undefined;
  }
}

/** Fetch + decrypt every directory entry listed in the roster. */
export async function fetchDirectory(
  ctx: EventContext,
): Promise<DirectoryEntryContent[]> {
  const eck = await eckBytesFor(ctx.coordinate);
  if (!eck) return [];
  const roster = await fetchRoster(ctx);
  if (!roster || roster.attendees.length === 0) return [];

  const publisher = directoryPublisher(ctx);
  const ds = roster.attendees.map((a) => a.d);
  const events = await fetchEvents(
    { kinds: [KIND_DIRECTORY_ENTRY], authors: [publisher], "#d": ds },
    ctx.config.relays,
  );
  // Keep the latest event per blinded d.
  const latestByD = new Map<string, (typeof events)[number]>();
  for (const e of events) {
    const d = e.tags.find((t) => t[0] === "d")?.[1];
    if (!d) continue;
    const prev = latestByD.get(d);
    if (!prev || (e.created_at ?? 0) > (prev.created_at ?? 0)) latestByD.set(d, e);
  }

  const entries: DirectoryEntryContent[] = [];
  for (const e of latestByD.values()) {
    try {
      entries.push(directoryEntryContentSchema.parse(JSON.parse(eckDecrypt(eck, e.content))));
    } catch {
      /* skip entries we can't decrypt (e.g. published under a newer ECK) */
    }
  }
  return entries;
}

/** Fetch + decrypt a single attendee's directory entry by pubkey. */
export async function fetchDirectoryEntry(
  ctx: EventContext,
  attendeePubkey: string,
): Promise<DirectoryEntryContent | undefined> {
  const all = await fetchDirectory(ctx);
  return all.find((e) => e.pubkey === attendeePubkey);
}
