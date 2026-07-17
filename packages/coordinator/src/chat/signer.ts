/**
 * The coordinator's Marmot identity (MARMOT-GROUP-CHAT §4). Unlike Amber/NIP-46
 * attendees, the coordinator holds a plain secret key (`coordSk`) and can raw-sign
 * BIP-340, so its account-identity proof is trivial (`signAccountIdentityProof`).
 *
 * marmot-ts wants an applesauce `EventSigner` — `getPublicKey` / `signEvent` /
 * `nip44.{encrypt,decrypt}`. We build one over `coordSk` with nostr-tools +
 * protocol NIP-44, and an `accountProofSigner` over the same key.
 */
import { getPublicKey, finalizeEvent } from "nostr-tools/pure";
import { nip44Encrypt, nip44Decrypt } from "@nostrautica/protocol";
import {
  signAccountIdentityProof,
  type AccountIdentityProofSigner,
} from "@internet-privacy/marmot-ts/core";

/** A structural applesauce-`EventSigner` (we avoid a direct applesauce-core dep). */
export interface CoordinatorEventSigner {
  getPublicKey(): string;
  signEvent(draft: { kind: number; content: string; tags: string[][]; created_at?: number }): unknown;
  nip44: {
    encrypt(pubkey: string, plaintext: string): string;
    decrypt(pubkey: string, ciphertext: string): string;
  };
}

/** Build the coordinator's Marmot signer from its raw secret key. */
export function makeCoordinatorSigner(coordSk: Uint8Array): CoordinatorEventSigner {
  const pubkey = getPublicKey(coordSk);
  return {
    getPublicKey: () => pubkey,
    signEvent: (draft) =>
      finalizeEvent(
        {
          kind: draft.kind,
          content: draft.content,
          tags: draft.tags,
          created_at: draft.created_at ?? Math.floor(Date.now() / 1000),
        },
        coordSk,
      ),
    nip44: {
      encrypt: (pk, plaintext) => nip44Encrypt(coordSk, pk, plaintext),
      decrypt: (pk, ciphertext) => nip44Decrypt(coordSk, pk, ciphertext),
    },
  };
}

/**
 * The account-identity-proof signer: raw BIP-340 over the marmot digest with
 * `coordSk`. Every KeyPackage and leaf the coordinator publishes carries a valid
 * `marmot.account-identity-proof.v1` extension, so strict (Whitenoise/MDK) clients
 * accept the group.
 */
export function makeCoordinatorProofSigner(coordSk: Uint8Array): AccountIdentityProofSigner {
  return (request) => signAccountIdentityProof(request, coordSk);
}
