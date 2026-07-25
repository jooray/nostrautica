/**
 * Signer-based NIP-59 gift wrap (spec §7.2). The protocol package's wrapRumor
 * needs a raw secret key; a NIP-07/46 user never exposes one. This builds the
 * same wire format using an AppSigner:
 *
 *   rumor (unsigned, author = user)
 *     → seal kind 13  (content = user nip44→recipient, signed by the USER)
 *     → wrap kind 1059 (content = one-time-key nip44→recipient, signed by a
 *                       fresh ephemeral key we hold locally; single p-tag)
 *
 * Unwrapping is the mirror: the recipient nip44-decrypts the wrap (from the
 * one-time author) to the seal, then the seal (from its author) to the rumor.
 * Both directions go through the signer, so every login method works.
 */
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  getEventHash,
  verifyEvent,
} from "nostr-tools/pure";
import type { Event as NostrEvent, UnsignedEvent } from "nostr-tools/pure";
import {
  KIND_GIFT_WRAP,
  KIND_SEAL,
  assertVerifiedSeal,
  finalizeUnwrappedRumor,
  nip44Encrypt,
  type RumorKind,
} from "@nostrautica/protocol";
import type { Rumor, GiftWrap } from "@nostrautica/protocol";
import type { AppSigner } from "$lib/signer/types.js";

const DAY = 24 * 60 * 60;

/** A timestamp randomized up to 2 days into the past (NIP-59). */
function randomPastTimestamp(): number {
  const now = Math.floor(Date.now() / 1000);
  return now - Math.floor(Math.random() * 2 * DAY);
}

export interface WrapInput {
  kind: RumorKind;
  content: unknown; // JSON-serializable
  tags?: string[][];
  /** Override the rumor's `created_at` (unix seconds). Needed when the payload
   *  embeds a proof that signs over this exact timestamp (e.g. the 21607 chat
   *  device attestation, NIP §10.2). Defaults to `now`. */
  created_at?: number;
}

/** Build a gift wrap addressed to `recipientPubkey`, authored via `signer`. */
export async function signerWrap(
  signer: AppSigner,
  recipientPubkey: string,
  input: WrapInput,
): Promise<GiftWrap> {
  const author = await signer.getPublicKey();

  // 1. Rumor: unsigned event with an id but no signature.
  const rumorBase = {
    pubkey: author,
    created_at: input.created_at ?? Math.floor(Date.now() / 1000),
    kind: input.kind,
    tags: input.tags ?? [],
    content:
      typeof input.content === "string" ? input.content : JSON.stringify(input.content),
  } satisfies UnsignedEvent;
  const rumor: Rumor = { ...rumorBase, id: getEventHash(rumorBase) };

  // 2. Seal (kind 13): user encrypts the rumor to the recipient and signs it.
  const sealContent = await signer.nip44Encrypt(recipientPubkey, JSON.stringify(rumor));
  const seal = await signer.signEvent({
    kind: KIND_SEAL,
    created_at: randomPastTimestamp(),
    tags: [],
    content: sealContent,
  });

  // 3. Wrap (kind 1059): a fresh one-time key encrypts the seal to the recipient.
  // Static import (not dynamic): join/DM submit must not hit a post-deploy stale
  // chunk 404 mid-flight ("Failed to fetch dynamically imported module").
  const otKey = generateSecretKey();
  const wrapContent = nip44Encrypt(otKey, recipientPubkey, JSON.stringify(seal));
  const wrap = finalizeEvent(
    {
      kind: KIND_GIFT_WRAP,
      created_at: randomPastTimestamp(),
      tags: [["p", recipientPubkey]],
      content: wrapContent,
    },
    otKey,
  );
  return wrap as GiftWrap;
}

/**
 * Unwrap a gift wrap addressed to the signer's user, returning the inner rumor.
 *
 * This must apply the SAME checks as the protocol package's `unwrapRumor` (audit
 * P1). NIP-44 decryption does not authenticate the seal author — ECDH gives both
 * parties the same conversation key — so a holder of the recipient secret can
 * forge a seal under any claimed sender pubkey. The seal's kind-13 signature is
 * the only proof of authorship, and downstream authorization treats the resulting
 * `rumor.pubkey` as authenticated. So we verify the outer 1059 wrap (defense in
 * depth), verify the seal (`assertVerifiedSeal`: complete signed kind-13, empty
 * tags, id + Schnorr), then run the shared rumor shape/binding/id/clamp checks.
 */
export async function signerUnwrap(
  signer: AppSigner,
  wrap: GiftWrap,
): Promise<Rumor> {
  if (wrap.kind !== KIND_GIFT_WRAP) throw new Error("not a gift wrap");
  if (!verifyEvent(wrap as unknown as NostrEvent)) {
    throw new Error("gift wrap signature is invalid");
  }
  const sealJson = await signer.nip44Decrypt(wrap.pubkey, wrap.content);
  const seal: unknown = JSON.parse(sealJson);
  assertVerifiedSeal(seal);
  const rumorJson = await signer.nip44Decrypt(seal.pubkey, seal.content);
  const rumor: unknown = JSON.parse(rumorJson);
  return finalizeUnwrappedRumor(rumor, seal.pubkey);
}

export { getPublicKey };
