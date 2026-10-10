/**
 * The coordinator's Marmot identity (MARMOT-GROUP-CHAT §4): a plain secret key
 * (`coordSk`).
 *
 * marmot-ts wants an applesauce `EventSigner` — `getPublicKey` / `signEvent` /
 * `nip44.{encrypt,decrypt}`. We build one over `coordSk` with nostr-tools +
 * protocol NIP-44. The same `signEvent` produces the kind-450 account identity
 * proof (`marmot.member.account-identity-proof.v2`, component 0x8009) that every
 * KeyPackage and leaf the coordinator creates carries, which is what lets strict
 * clients (White Noise / MDK) accept the groups it runs.
 */
import { getPublicKey, finalizeEvent } from "nostr-tools/pure";
import { nip44Encrypt, nip44Decrypt } from "@nostrautica/protocol";

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

