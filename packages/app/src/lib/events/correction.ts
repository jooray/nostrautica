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

/** The correction body an attendee edits — `v`/`a` are filled in from the ctx. */
export type CorrectionInput = Omit<ProfileCorrectionContent, "v" | "a">;

/** Publish a 21608 profile correction to the event's E_inbox (gift-wrapped). */
export async function submitProfileCorrection(
  signer: AppSigner,
  ctx: EventContext,
  input: CorrectionInput,
): Promise<void> {
  const content = profileCorrectionContentSchema.parse({
    v: 1,
    a: ctx.coordinate,
    ...input,
  });
  const wrap = await signerWrap(signer, ctx.config.inbox, {
    kind: KIND_PROFILE_CORRECTION,
    content,
    tags: [["a", ctx.coordinate]],
  });
  await publishOrQueue(wrap as any, ctx.config.relays);
}
