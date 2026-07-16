/**
 * NIP-17 private direct messages (spec §7.2, rumor kind 14). Messages are
 * never signed as kind 14 — they travel sealed (13) and gift-wrapped (1059)
 * via the signer-based NIP-59 path, so they work with remote signers too.
 * Every send produces TWO wraps — one to the recipient, one to the sender's
 * own pubkey — so sent history is recoverable on any device. Plain NIP-17:
 * conversations continue in 0xchat/Amethyst/any NIP-17 client.
 */
import { KIND_DM, KIND_GIFT_WRAP, KIND_DM_RELAY_LIST } from "@nostrautica/protocol";
import type { AppSigner } from "$lib/signer/types.js";
import type { GiftWrap } from "@nostrautica/protocol";
import { signerWrap, signerUnwrap } from "./giftwrap.js";
import { fetchEvents } from "$lib/nostr/ndk.js";
import { streamEvents } from "$lib/nostr/stream.js";
import { DEFAULT_RELAYS, unionRelays } from "$lib/nostr/relays.js";
import { publishOrQueue } from "$lib/nostr/publish-queue.js";

export interface DmMessage {
  id: string; // rumor id (stable across the recipient/self copies)
  peer: string; // the other party
  from: string; // author (== peer for received, == me for sent)
  text: string;
  at: number; // rumor created_at (wrap timestamps are randomized, NIP-59)
}

export interface DmThread {
  peer: string;
  last: DmMessage;
  count: number;
}

/** Extract the relay URLs from a NIP-17 DM relay list's (`["relay", url]`) tags. */
export function relayUrlsFromDmList(tags: string[][]): string[] {
  return tags.filter((t) => t[0] === "relay" && !!t[1]).map((t) => t[1]);
}

/**
 * Where to deliver a gift-wrap addressed to `pubkey`: the recipient's declared
 * NIP-17 inboxes (kind-10050) UNIONED with sensible app defaults, so the DM
 * reaches the recipient's other clients while still landing on relays we know
 * are reachable. Falls back to defaults alone when the recipient has no 10050.
 */
export function selectDmRelays(
  recipientDmRelays: string[],
  defaults: string[] = DEFAULT_RELAYS,
): string[] {
  return unionRelays(recipientDmRelays, defaults);
}

/** Fetch a pubkey's kind-10050 DM relay list; [] if they've published none. */
export async function fetchDmRelays(pubkey: string): Promise<string[]> {
  const events = await fetchEvents({ kinds: [KIND_DM_RELAY_LIST], authors: [pubkey] });
  const latest = events.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
  return latest ? relayUrlsFromDmList(latest.tags) : [];
}

/**
 * Send `text` to `recipient`: one wrap to them, one to self. Each wrap is
 * published to that party's declared kind-10050 DM inboxes (union defaults) so
 * NIP-17 messages reach the recipient's other clients and the sender's own
 * sent-history copy lands on the sender's inboxes (audit G4). Missing 10050s
 * degrade gracefully to the default relays.
 */
export async function sendDm(
  signer: AppSigner,
  recipient: string,
  text: string,
): Promise<void> {
  const me = await signer.getPublicKey();
  const input = {
    kind: KIND_DM as typeof KIND_DM,
    content: text,
    tags: [["p", recipient]],
  };
  const [recipientRelays, selfRelays] = await Promise.all([
    fetchDmRelays(recipient).catch(() => []),
    fetchDmRelays(me).catch(() => []),
  ]);
  const toRecipient = await signerWrap(signer, recipient, input);
  const toSelf = await signerWrap(signer, me, input);
  await Promise.all([
    publishOrQueue(toRecipient as never, selectDmRelays(recipientRelays)),
    publishOrQueue(toSelf as never, selectDmRelays(selfRelays)),
  ]);
}

/**
 * Fetch and unwrap the user's DMs. Non-DM rumors (grants etc.) and wraps we
 * can't decrypt are skipped silently; copies are deduped by rumor id.
 */
// Per-wrap unwrap memo (keyed by wrap id, per identity): a wrap's plaintext never
// changes, and the 5s DM poll otherwise re-runs a signer decrypt per wrap per
// tick — for a remote signer (Amber/NIP-46) that's a prompt-or-roundtrip storm,
// and one unreachable bunker relay froze the DM screens entirely (user report
// 2026-07-16). `null` = not a DM of ours; cached failures don't retry.
let unwrapCacheOwner = "";
const unwrapCache = new Map<string, DmMessage | null>();

export async function fetchDms(signer: AppSigner): Promise<DmMessage[]> {
  const me = await signer.getPublicKey();
  if (unwrapCacheOwner !== me) {
    unwrapCache.clear();
    unwrapCacheOwner = me;
  }
  // Streamed relay-only read: gift wraps must not be lost to the dexie
  // cache/EOSE race (see ndk.ts), and the read must TERMINATE even when a relay
  // never answers — first EOSE + grace, hard timeout. The 5s poll makes any
  // single missed late event a non-issue.
  const events = (await streamEvents(
    { kinds: [KIND_GIFT_WRAP], "#p": [me], limit: 500 },
    { relays: DEFAULT_RELAYS, relayOnly: true, timeoutMs: 10_000 },
  ).ready) as unknown as GiftWrap[];

  for (const wrap of events) {
    if (unwrapCache.has(wrap.id)) continue;
    try {
      const rumor = await signerUnwrap(signer, wrap);
      if (rumor.kind !== KIND_DM) {
        unwrapCache.set(wrap.id, null);
        continue;
      }
      const recipient = rumor.tags.find((t) => t[0] === "p")?.[1];
      if (!recipient) {
        unwrapCache.set(wrap.id, null);
        continue;
      }
      const peer = rumor.pubkey === me ? recipient : rumor.pubkey;
      if (peer === me && rumor.pubkey !== me) {
        unwrapCache.set(wrap.id, null); // malformed
        continue;
      }
      unwrapCache.set(wrap.id, {
        id: rumor.id,
        peer,
        from: rumor.pubkey,
        text: rumor.content,
        at: rumor.created_at,
      });
    } catch {
      // not for us / not decryptable / different rumor family — skip for good
      unwrapCache.set(wrap.id, null);
    }
  }
  const byId = new Map<string, DmMessage>();
  for (const m of unwrapCache.values()) if (m) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.at - b.at);
}

/** Group messages into per-peer threads, newest thread first. */
export function threadsOf(messages: DmMessage[]): DmThread[] {
  const byPeer = new Map<string, DmThread>();
  for (const m of messages) {
    const t = byPeer.get(m.peer);
    if (!t) byPeer.set(m.peer, { peer: m.peer, last: m, count: 1 });
    else {
      t.count += 1;
      if (m.at >= t.last.at) t.last = m;
    }
  }
  return [...byPeer.values()].sort((a, b) => b.last.at - a.last.at);
}
