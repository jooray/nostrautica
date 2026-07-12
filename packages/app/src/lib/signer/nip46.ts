/**
 * NIP-46 remote signer (Amber etc.), spec §5.1 item 2.
 *
 * Two entry points:
 *  - nostrconnect (client-initiated): we generate a client key + random secret,
 *    render the `nostrconnect://` URI as a QR / deep link, and wait for the
 *    signer to connect. nostr-tools' `BunkerSigner.fromURI` verifies the
 *    `connect` response `result === secret` for us.
 *  - bunker:// paste: `parseBunkerInput` + `BunkerSigner.fromBunker`.
 *
 * After connecting we ALWAYS call `get_public_key` (BunkerSigner.getPublicKey
 * does exactly this): the remote-signer pubkey and the user pubkey are distinct
 * (Amber v6 per-connection keys). RPC transport is kind 24133 with NIP-44.
 */
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate, VerifiedEvent } from "nostr-tools/pure";
import {
  BunkerSigner,
  createNostrConnectURI,
  parseBunkerInput,
} from "nostr-tools/nip46";
import type { AppSigner } from "./types.js";

const DEFAULT_PERMS = [
  "sign_event:0",
  "sign_event:1",
  "sign_event:3",
  "sign_event:1059",
  "sign_event:31923",
  "sign_event:31600",
  "sign_event:31601",
  "sign_event:31602",
  "sign_event:31925",
  "nip44_encrypt",
  "nip44_decrypt",
];

export interface NostrConnectHandle {
  /** The `nostrconnect://` URI to render as QR / deep link. */
  uri: string;
  /** Resolves to a connected signer once the remote signer approves. */
  connected: Promise<Nip46Signer>;
}

export class Nip46Signer implements AppSigner {
  readonly method = "nip46" as const;
  private pk: string | null = null;

  private constructor(private readonly bunker: BunkerSigner) {}

  /**
   * Start a client-initiated nostrconnect flow. Renders `handle.uri` as a QR;
   * `handle.connected` resolves when the signer approves and `result === secret`.
   */
  static startNostrConnect(
    relays: string[],
    appName = "Nostrautica",
  ): NostrConnectHandle {
    const clientSk = generateSecretKey();
    const secret = crypto.randomUUID().replace(/-/g, "");
    const uri = createNostrConnectURI({
      clientPubkey: getPublicKey(clientSk),
      relays,
      secret,
      perms: DEFAULT_PERMS,
      name: appName,
    });
    const connected = BunkerSigner.fromURI(clientSk, uri).then(
      (bunker) => new Nip46Signer(bunker),
    );
    return { uri, connected };
  }

  /** Connect to a pasted `bunker://` URI. */
  static async fromBunkerUri(bunkerUri: string): Promise<Nip46Signer> {
    const clientSk = generateSecretKey();
    const pointer = await parseBunkerInput(bunkerUri);
    if (!pointer) throw new Error("Invalid bunker:// URI");
    const bunker = BunkerSigner.fromBunker(clientSk, pointer);
    await bunker.connect();
    return new Nip46Signer(bunker);
  }

  async getPublicKey(): Promise<string> {
    if (!this.pk) this.pk = await this.bunker.getPublicKey();
    return this.pk;
  }

  async signEvent(template: EventTemplate): Promise<VerifiedEvent> {
    const pubkey = await this.getPublicKey();
    return (await this.bunker.signEvent({ ...template, pubkey } as any)) as VerifiedEvent;
  }

  async nip44Encrypt(recipientPubkey: string, plaintext: string): Promise<string> {
    return this.bunker.nip44Encrypt(recipientPubkey, plaintext);
  }

  async nip44Decrypt(counterpartyPubkey: string, ciphertext: string): Promise<string> {
    return this.bunker.nip44Decrypt(counterpartyPubkey, ciphertext);
  }

  async close(): Promise<void> {
    await this.bunker.close();
  }
}
