/**
 * Signer abstraction for the login ladder (spec §5.1).
 *
 * Every signer can produce the user's pubkey, sign events, and perform NIP-44
 * encryption/decryption to an arbitrary counterparty (self-encryption = passing
 * the user's own pubkey). NIP-04 is banned project-wide; the scheme is always
 * NIP-44 explicitly (IMPLEMENTATION_PLAN §3.1).
 *
 * Only the local signer exposes the raw secret key — it's needed for the
 * protocol helpers that operate on 32-byte keys directly (ECK ops, blinded-d
 * from the self-conversation key). NIP-07/46 signers keep the key remote, so the
 * app derives an equivalent per-user blinding secret out of band (see session).
 */
import type { EventTemplate, VerifiedEvent } from "nostr-tools/pure";

export type SignerMethod = "nip07" | "nip46" | "local";

export interface AppSigner {
  readonly method: SignerMethod;

  /** User pubkey (hex). Distinct from any remote-signer pubkey for NIP-46. */
  getPublicKey(): Promise<string>;

  /** Sign an event template, returning a fully signed & verified event. */
  signEvent(template: EventTemplate): Promise<VerifiedEvent>;

  /** NIP-44 encrypt `plaintext` to `recipientPubkey` (self = own pubkey). */
  nip44Encrypt(recipientPubkey: string, plaintext: string): Promise<string>;

  /** NIP-44 decrypt `ciphertext` from `counterpartyPubkey`. */
  nip44Decrypt(counterpartyPubkey: string, ciphertext: string): Promise<string>;

  /**
   * Raw 32-byte secret key — ONLY the local signer. Undefined for remote signers.
   * Callers that need it must handle its absence (or require a local key).
   */
  getSecretKey?(): Uint8Array;

  /**
   * Tear down any live transport (NIP-46 keeps a dedicated auto-reconnecting
   * relay pool). Optional: local and NIP-07 signers hold no connections.
   * Implementations must not throw.
   */
  close?(): Promise<void>;
}
