/**
 * Printable invite sheet (spec §13 organizer QoL). Renders each UNUSED invite code
 * as a QR of its join URL plus a label, N per page. Pure filtering here so "only
 * unused codes" is unit-tested; the rendering lives in components/InviteSheet.svelte.
 */
import { decode } from "nostr-tools/nip19";
import { getPublicKey } from "nostr-tools/pure";
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
 * The invites to print: every generated code whose invite-pubkey is NOT in
 * `usedPubkeys` (codes already redeemed by an approved attendee). With no usage
 * signal (the default empty set) every freshly-minted code is unused, so they all
 * print — the filter matters once a caller can supply redeemed pubkeys.
 */
export function invitesForSheet(
  generated: GeneratedInvite[],
  usedPubkeys: ReadonlySet<string> = new Set(),
): GeneratedInvite[] {
  if (usedPubkeys.size === 0) return generated;
  return generated.filter((inv) => {
    const pk = invitePubkey(inv);
    return !pk || !usedPubkeys.has(pk);
  });
}
