/**
 * Printable invite sheet (spec §13 organizer QoL). Renders each UNUSED invite code
 * as a QR of its join URL plus a label, N per page. Pure filtering here so "only
 * unused codes" is unit-tested; the rendering lives in components/InviteSheet.svelte.
 */
import { decode } from "nostr-tools/nip19";
import { getPublicKey } from "nostr-tools/pure";
import { inviteHash } from "@nostrautica/protocol";
import type { InviteUsage } from "./invite-export.js";
import type { GeneratedInvite } from "./organizer.js";

/** The invite key's pubkey (hex) for a generated code, or undefined if malformed. */
export function invitePubkey(inv: GeneratedInvite): string | undefined {
  try {
    const decoded = decode(inv.nsec);
    if (decoded.type !== "nsec") return undefined;
    return getPublicKey(decoded.data);
  } catch {
    return undefined;
  }
}

/**
 * Bridge the redemption report onto this module's pubkey-keyed filter: which of
 * THESE in-session codes the used-set says have been redeemed.
 *
 * Two different identities for one code, and mixing them up is the whole hazard
 * this function exists to contain. The report (invite-export.ts) is keyed by the
 * PUBLISHED hash `h = sha256(invite-pubkey)`, because that is all a relay ever
 * sees. The sheet filter is keyed by the invite PUBKEY, because that is what it
 * can derive from a code it holds. So each code goes nsec → pubkey → hash to be
 * looked up, and it is the PUBKEY that goes into the returned set. Returning
 * hashes instead would type-check perfectly and match nothing ever, which reads
 * as "the feature does nothing" rather than as a bug — hence the explicit test.
 *
 * POSITIVE EVIDENCE ONLY. A code is included only when the used-set actually
 * records its hash. A missing/not-yet-computed report (`undefined`, or `{}`
 * before the first refresh lands) yields an empty set, so the sheet prints
 * everything rather than silently hiding codes the organizer still needs to hand
 * out. Same rule as the persistence layer: absence of evidence is never evidence.
 * A code whose nsec won't decode is likewise not included — see invitePubkey.
 */
export function redeemedInvitePubkeys(
  generated: readonly GeneratedInvite[],
  used: InviteUsage | undefined,
): Set<string> {
  const out = new Set<string>();
  if (!used) return out;
  for (const inv of generated) {
    const pk = invitePubkey(inv);
    if (pk && used[inviteHash(pk)]) out.add(pk);
  }
  return out;
}

/**
 * The invites to print: every generated code whose invite-pubkey is NOT in
 * `usedPubkeys` (codes already redeemed by an approved attendee). With no usage
 * signal (the default empty set) every freshly-minted code is unused, so they all
 * print. Callers get that set from {@link redeemedInvitePubkeys} — the door case
 * is an organizer who displays the sheet, watches walk-ins scan it for an hour,
 * and re-opens it expecting the spent codes to be gone.
 */
export function invitesForSheet(
  generated: GeneratedInvite[],
  usedPubkeys: ReadonlySet<string> = new Set(),
): GeneratedInvite[] {
  if (usedPubkeys.size === 0) return generated;
  return generated.filter((inv) => {
    // A multi-use code is not spent by being used — that is the entire point of
    // it. The used-set says "somebody redeemed this", which for a shared door
    // code is the expected steady state, not a reason to stop printing it.
    if ((inv.uses ?? 1) !== 1) return true;
    const pk = invitePubkey(inv);
    return !pk || !usedPubkeys.has(pk);
  });
}
