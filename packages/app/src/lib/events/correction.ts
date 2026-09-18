/**
 * AI-profile correction / hide (spec F3, audit U9). An attendee corrects, hides
 * specific fields of, or hides entirely the coordinator-generated `ai_profile` on
 * their own directory entry. The signal is a gift-wrapped 21608 rumor sent to the
 * event's E_inbox — the same delivery path a 21601 profile submission takes — so
 * the coordinator (which reads E_inbox) applies it when publishing the 31603.
 *
 * The seal author (bound by NIP-59 unwrap on the coordinator) is the subject, so
 * an attendee can only correct THEIR OWN profile. The coordinator stores the
 * correction durably and re-applies it every publish, so it survives reprocessing.
 */
import {
  KIND_PROFILE_CORRECTION,
  profileCorrectionContentSchema,
  type ProfileCorrectionContent,
} from "@nostrautica/protocol";
import type { AppSigner } from "$lib/signer/types.js";
import type { EventContext } from "$lib/events/event-context.js";
import { signerWrap } from "$lib/events/giftwrap.js";
import { publishOrQueue } from "$lib/nostr/publish-queue.js";
import { deriveBlindingKey } from "$lib/events/blinding.js";
import { claimCorrectionRev } from "$lib/media/submit.js";

/** The correction body an attendee edits — `v`/`a`/`rev` are filled in here. */
export type CorrectionInput = Omit<ProfileCorrectionContent, "v" | "a" | "rev">;

/**
 * Publish a 21608 profile correction to the event's E_inbox (gift-wrapped).
 * Returns true when it went out immediately, false when queued for the offline
 * flush (audit UX-15) so the UI can say "will send when you're back online".
 */
export async function submitProfileCorrection(
  signer: AppSigner,
  ctx: EventContext,
  input: CorrectionInput,
): Promise<boolean> {
  // The `rev` comes from the relay-backed 31602 self-copy as well as this device's
  // own high-water mark (audit A-5). It used to be a purely device-local counter,
  // so a second device — or the same one after a storage clear — started again from
  // 0 while the coordinator still held rev 3 from the first. Its §3.3 ordering then
  // discarded every edit the new device made, and the UI said "saved" because the
  // gift wrap really had been delivered: delivery succeeded, application did not,
  // and nothing anywhere said so.
  const blindingKey = await deriveBlindingKey(signer);
  const { rev, record } = await claimCorrectionRev(signer, ctx, blindingKey);
  const content = profileCorrectionContentSchema.parse({
    v: 2,
    a: ctx.coordinate,
    rev,
    ...input,
  });
  const wrap = await signerWrap(signer, ctx.config.inbox, {
    kind: KIND_PROFILE_CORRECTION,
    content,
    tags: [["a", ctx.coordinate]],
  });
  const published = await publishOrQueue(wrap as any, ctx.config.relays);
  // Record the rev where the NEXT device will find it. Best-effort on purpose: the
  // correction itself is already sent, and the local high-water mark (written by
  // claimCorrectionRev before this) means a failure here can only cost the next
  // device a stale floor, never this edit.
  await record().catch((e: unknown) => {
    console.warn("[correction] could not record the correction rev on the self-copy:", e);
  });
  return published;
}
