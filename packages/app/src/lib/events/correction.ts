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

/** The correction body an attendee edits — `v`/`a`/`rev` are filled in here. */
export type CorrectionInput = Omit<ProfileCorrectionContent, "v" | "a" | "rev">;

// Per-(coordinate) correction revision counter (NIP §3.3). Corrections have no
// relay-backed per-event record to read a revision off (unlike the 21601 self-copy
// or a published talk), so the client keeps this monotonic counter in its own
// device-local storage and bumps it on every correction. A same-rev cross-device
// race is still resolved deterministically by the coordinator's (rev, created_at,
// id) total order.
const CORRECTION_REV_PREFIX = "nostrautica:correction-rev:";
function nextCorrectionRev(coordinate: string): number {
  const key = `${CORRECTION_REV_PREFIX}${coordinate}`;
  let prev = -1;
  try {
    const raw = localStorage.getItem(key);
    const n = raw != null ? Number(raw) : NaN;
    if (Number.isInteger(n) && n >= 0) prev = n;
  } catch {
    /* storage unavailable (private mode) — start from 0 */
  }
  const rev = prev + 1;
  try {
    localStorage.setItem(key, String(rev));
  } catch {
    /* best-effort — a lost bump only risks a same-rev tie the coordinator breaks */
  }
  return rev;
}

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
  const content = profileCorrectionContentSchema.parse({
    v: 2,
    a: ctx.coordinate,
    rev: nextCorrectionRev(ctx.coordinate),
    ...input,
  });
  const wrap = await signerWrap(signer, ctx.config.inbox, {
    kind: KIND_PROFILE_CORRECTION,
    content,
    tags: [["a", ctx.coordinate]],
  });
  return publishOrQueue(wrap as any, ctx.config.relays);
}
