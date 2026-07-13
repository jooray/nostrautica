/**
 * NIP-17 private direct messages (spec §7.2, rumor kind 14). Messages are
 * never signed as kind 14 — they travel sealed (13) and gift-wrapped (1059)
 * via the signer-based NIP-59 path, so they work with remote signers too.
 * Every send produces TWO wraps — one to the recipient, one to the sender's
 * own pubkey — so sent history is recoverable on any device. Plain NIP-17:
 * conversations continue in 0xchat/Amethyst/any NIP-17 client.
 */
import { KIND_DM, KIND_GIFT_WRAP } from "@nostrautica/protocol";
import type { AppSigner } from "$lib/signer/types.js";
import type { GiftWrap } from "@nostrautica/protocol";
import { signerWrap, signerUnwrap } from "./giftwrap.js";
import { fetchEvents } from "$lib/nostr/ndk.js";
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

/** Send `text` to `recipient`: one wrap to them, one to self. */
export async function sendDm(
  signer: AppSigner,
  recipient: string,
  text: string,
): Promise<void> {
  const input = {
    kind: KIND_DM as typeof KIND_DM,
    content: text,
    tags: [["p", recipient]],
  };
  const toRecipient = await signerWrap(signer, recipient, input);
  const toSelf = await signerWrap(signer, await signer.getPublicKey(), input);
  await Promise.all([
    publishOrQueue(toRecipient as never),
    publishOrQueue(toSelf as never),
  ]);
}

/**
 * Fetch and unwrap the user's DMs. Non-DM rumors (grants etc.) and wraps we
 * can't decrypt are skipped silently; copies are deduped by rumor id.
 */
export async function fetchDms(signer: AppSigner): Promise<DmMessage[]> {
  const me = await signer.getPublicKey();
  const wraps = (await fetchEvents({
    kinds: [KIND_GIFT_WRAP],
    "#p": [me],
    limit: 500,
  })) as unknown as GiftWrap[];

  const byId = new Map<string, DmMessage>();
  for (const wrap of wraps) {
    try {
      const rumor = await signerUnwrap(signer, wrap);
      if (rumor.kind !== KIND_DM) continue;
      const recipient = rumor.tags.find((t) => t[0] === "p")?.[1];
      if (!recipient) continue;
      const peer = rumor.pubkey === me ? recipient : rumor.pubkey;
      if (peer === me && rumor.pubkey !== me) continue; // malformed
      byId.set(rumor.id, {
        id: rumor.id,
        peer,
        from: rumor.pubkey,
        text: rumor.content,
        at: rumor.created_at,
      });
    } catch {
      // not for us / not decryptable / different rumor family — skip
    }
  }
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
