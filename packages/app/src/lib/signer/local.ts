/**
 * Generated / imported local-key signer (spec §5.1 item 3, §5.2). The secp256k1
 * key is generated on first use and lives in IndexedDB (never a localStorage
 * string, spec §14). This is the normie default — no jargon required to start.
 */
import { finalizeEvent, getPublicKey, generateSecretKey } from "nostr-tools/pure";
import type { EventTemplate } from "nostr-tools/pure";
import { nip44Encrypt, nip44Decrypt } from "@nostrautica/protocol";
import type { AppSigner } from "./types.js";

export class LocalSigner implements AppSigner {
  readonly method = "local" as const;
  private readonly sk: Uint8Array;
  private readonly pk: string;

  constructor(secretKey: Uint8Array) {
    if (secretKey.length !== 32) throw new Error("secret key must be 32 bytes");
    this.sk = secretKey;
    this.pk = getPublicKey(secretKey);
  }

  static generate(): LocalSigner {
    return new LocalSigner(generateSecretKey());
  }

  async getPublicKey(): Promise<string> {
    return this.pk;
  }

  async signEvent(template: EventTemplate) {
    return finalizeEvent(template, this.sk);
  }

  async nip44Encrypt(recipientPubkey: string, plaintext: string): Promise<string> {
    return nip44Encrypt(this.sk, recipientPubkey, plaintext);
  }

  async nip44Decrypt(counterpartyPubkey: string, ciphertext: string): Promise<string> {
    return nip44Decrypt(this.sk, counterpartyPubkey, ciphertext);
  }

  getSecretKey(): Uint8Array {
    return this.sk;
  }
}
