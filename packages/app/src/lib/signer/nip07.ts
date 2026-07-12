/**
 * NIP-07 browser-extension signer (spec §5.1 item 1). If `window.nostr` exists,
 * one-click login. We always use the NIP-44 scheme explicitly — the extension's
 * `nip44` object — never NIP-04 (banned project-wide).
 */
import type { EventTemplate, VerifiedEvent } from "nostr-tools/pure";
import { verifyEvent } from "nostr-tools/pure";
import type { AppSigner } from "./types.js";

export function hasNip07(): boolean {
  return typeof window !== "undefined" && !!window.nostr;
}

export class Nip07Signer implements AppSigner {
  readonly method = "nip07" as const;
  private pk: string | null = null;

  private get provider() {
    if (!window.nostr) throw new Error("No NIP-07 extension (window.nostr) found");
    return window.nostr;
  }

  async getPublicKey(): Promise<string> {
    if (!this.pk) this.pk = await this.provider.getPublicKey();
    return this.pk;
  }

  async signEvent(template: EventTemplate): Promise<VerifiedEvent> {
    const pubkey = await this.getPublicKey();
    const signed = (await this.provider.signEvent({ ...template, pubkey })) as VerifiedEvent;
    if (!verifyEvent(signed)) throw new Error("NIP-07 returned an invalid signature");
    return signed;
  }

  async nip44Encrypt(recipientPubkey: string, plaintext: string): Promise<string> {
    const nip44 = this.provider.nip44;
    if (!nip44) throw new Error("Extension does not support NIP-44 encryption");
    return nip44.encrypt(recipientPubkey, plaintext);
  }

  async nip44Decrypt(counterpartyPubkey: string, ciphertext: string): Promise<string> {
    const nip44 = this.provider.nip44;
    if (!nip44) throw new Error("Extension does not support NIP-44 decryption");
    return nip44.decrypt(counterpartyPubkey, ciphertext);
  }
}
