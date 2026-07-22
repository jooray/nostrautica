/**
 * Attendee-initiated withdrawal (NIP §6.3 21610, SPECIFICATION §8 "Withdraw").
 *
 * The attendee removes THEMSELVES from an event without organizer action: a
 * gift-wrapped 21610 rumor to the event's E_inbox (the same delivery path a 21601
 * submission takes), which the coordinator handles with the full revoke effect
 * chain (roster/directory/match removal, NIP-09 deletions, ECK rotation, Marmot
 * member removal). The withdrawing client additionally, best-effort:
 *  - deletes its own Blossom blobs (uploader-authorized BUD-02 delete), and
 *  - NIP-09-deletes its 31602 per-event self-copy for the event.
 *
 * Rejoining later is a fresh 21600 join request — this does not tombstone the
 * account locally beyond dropping the event keys the caller chooses to clear.
 */
import {
  KIND_ATTENDEE_WITHDRAWAL,
  KIND_MY_PROFILE,
  KIND_DELETION,
  withdrawalContentSchema,
  blindedD,
} from "@nostrautica/protocol";
import type { AppSigner } from "$lib/signer/types.js";
import type { EventContext } from "$lib/events/event-context.js";
import { signerWrap } from "$lib/events/giftwrap.js";
import { publishOrQueue } from "$lib/nostr/publish-queue.js";
import { deriveBlindingKey } from "$lib/events/blinding.js";
import { loadSelfCopy, resolveBlossomServers, fetchUserBlossomServers } from "$lib/media/submit.js";
import { deleteBlob } from "$lib/blossom/client.js";

export interface WithdrawResult {
  /** True when the 21610 rumor went out immediately, false when queued offline. */
  sent: boolean;
  /** Blossom blobs the client attempted + succeeded to delete (best-effort). */
  blobsAttempted: number;
  blobsDeleted: number;
}

/**
 * Withdraw the signed-in attendee from `ctx`'s event. `deleteData` (default true,
 * NIP §6.3) requests the coordinator purge its stored artifacts too; `false` keeps
 * them for a cheaper later re-approval. The 21610 send is the load-bearing step and
 * uses the offline queue; the local Blossom/self-copy teardown is best-effort and
 * never blocks (or fails) the withdrawal.
 */
export async function withdrawFromEvent(
  signer: AppSigner,
  ctx: EventContext,
  opts: { deleteData?: boolean } = {},
): Promise<WithdrawResult> {
  const deleteData = opts.deleteData ?? true;
  const attendeePubkey = await signer.getPublicKey();

  // 1. The load-bearing signal: 21610 → E_inbox (gift-wrapped).
  const content = withdrawalContentSchema.parse({
    v: 2,
    a: ctx.coordinate,
    delete_data: deleteData,
  });
  const wrap = await signerWrap(signer, ctx.config.inbox, {
    kind: KIND_ATTENDEE_WITHDRAWAL,
    content,
    tags: [["a", ctx.coordinate]],
  });
  const sent = await publishOrQueue(wrap as any, ctx.config.relays);

  // 2. Best-effort local teardown — the attendee's own media + self-copy. Any
  //    failure here is swallowed: the coordinator's revoke chain is what actually
  //    removes the attendee, and Blossom deletion is never a privacy guarantee.
  let blobsAttempted = 0;
  let blobsDeleted = 0;
  try {
    const blindingKey = await deriveBlindingKey(signer);
    const self = await loadSelfCopy(signer, ctx, blindingKey).catch(() => undefined);

    // 2a. Delete own Blossom blobs by ciphertext hash across every server the media
    //     might live on (the event's + the user's own 10063 servers).
    const blobHashes = new Set<string>();
    for (const m of self?.media ?? []) if (m.x) blobHashes.add(m.x);
    if (blobHashes.size > 0) {
      const userServers = await fetchUserBlossomServers(signer).catch(() => []);
      const servers = [...new Set([...resolveBlossomServers(ctx), ...userServers])];
      for (const x of blobHashes) {
        blobsAttempted++;
        const results = await Promise.all(servers.map((s) => deleteBlob(signer, s, x)));
        if (results.some(Boolean)) blobsDeleted++;
      }
    }

    // 2b. NIP-09-delete the 31602 per-event self-copy (authored by the account key).
    const selfD = blindedD(blindingKey, ctx.coordinate, attendeePubkey);
    const deletion = await signer.signEvent({
      kind: KIND_DELETION,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["a", `${KIND_MY_PROFILE}:${attendeePubkey}:${selfD}`],
        ["k", String(KIND_MY_PROFILE)],
      ],
      content: "withdrew from event",
    });
    await publishOrQueue(deletion as any, ctx.config.relays);
  } catch {
    /* best-effort — the 21610 above is what removes the attendee */
  }

  return { sent, blobsAttempted, blobsDeleted };
}
