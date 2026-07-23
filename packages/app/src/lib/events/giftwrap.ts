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
} from "nostr-tools/pure";
import type { UnsignedEvent } from "nostr-tools/pure";
import {
  KIND_GIFT_WRAP,
  KIND_SEAL,
  RUMOR_MAX_CLOCK_SKEW_SEC,
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
  const otKey = generateSecretKey();
  const { nip44Encrypt } = await import("@nostrautica/protocol");
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

/** Unwrap a gift wrap addressed to the signer's user, returning the inner rumor. */
export async function signerUnwrap(
  signer: AppSigner,
  wrap: GiftWrap,
): Promise<Rumor> {
  if (wrap.kind !== KIND_GIFT_WRAP) throw new Error("not a gift wrap");
  const sealJson = await signer.nip44Decrypt(wrap.pubkey, wrap.content);
  const seal = JSON.parse(sealJson);
  if (seal.kind !== KIND_SEAL) throw new Error("inner event is not a seal");
  const rumorJson = await signer.nip44Decrypt(seal.pubkey, seal.content);
  const rumor = JSON.parse(rumorJson) as Rumor;
  // Bind the rumor's claimed author to the seal's verified author (NIP-59).
  if (rumor.pubkey !== seal.pubkey) throw new Error("rumor/seal author mismatch");
  // created_at is unauthenticated but drives first-come/latest-wins ordering
  // (invite approval, replaceable events): clamp future-dated rumors to at most
  // now + skew (PROTO-8), mirroring the protocol package's unwrapRumor clamp so
  // the signer path gets the same protection.
  const maxCreatedAt = Math.floor(Date.now() / 1000) + RUMOR_MAX_CLOCK_SKEW_SEC;
  if (rumor.created_at > maxCreatedAt) rumor.created_at = maxCreatedAt;
  return rumor;
}

export { getPublicKey };
