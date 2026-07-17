/**
 * Media descriptor build/parse (spec §6.2). A descriptor carries everything needed
 * to fetch and decrypt one media blob; field names follow NIP-17 kind-15 conventions.
 * The AES-GCM key travels *inside* the descriptor — never as its own event.
 */
import {
  aesGcmEncrypt,
  aesGcmDecrypt,
  sha256Hex,
  bytesToBase64,
  base64ToBytes,
} from "./crypto.js";
import { mediaDescriptorDraftSchema, type MediaDescriptor } from "./schemas.js";

export interface EncryptMediaInput {
  kind: "intro" | "talk";
  data: Uint8Array; // plaintext media bytes
  mime: string;
  duration?: number;
  /** Blossom URLs where the ciphertext is/will be stored (first = primary). */
  urls: string[];
}

/**
 * Encrypt media bytes and produce both the ciphertext (to upload to Blossom) and
 * the descriptor (to embed in an encrypted payload). The descriptor's `url`s are
 * filled from `urls`; callers may append mirror URLs after BUD-04.
 */
export async function encryptMedia(
  input: EncryptMediaInput,
): Promise<{ ciphertext: Uint8Array; descriptor: MediaDescriptor }> {
  const { ciphertext, key, nonce } = await aesGcmEncrypt(input.data);
  const descriptor: MediaDescriptor = {
    kind: input.kind,
    // May be empty pre-upload; the caller fills real https URLs after BUD-02/04
    // and re-validates against the strict schema.
    url: input.urls,
    x: sha256Hex(ciphertext),
    ox: sha256Hex(input.data),
    size: ciphertext.length,
    m: input.mime,
    ...(input.duration !== undefined ? { duration: input.duration } : {}),
    "encryption-algorithm": "aes-gcm",
    "decryption-key": bytesToBase64(key),
    "decryption-nonce": bytesToBase64(nonce),
  };
  return { ciphertext, descriptor: mediaDescriptorDraftSchema.parse(descriptor) as MediaDescriptor };
}

/**
 * Decrypt a media blob given its descriptor and the fetched ciphertext.
 * Verifies the ciphertext hash (`x`) and, after decryption, the plaintext hash (`ox`).
 */
export async function decryptMedia(
  descriptor: MediaDescriptor,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  if (sha256Hex(ciphertext) !== descriptor.x) {
    throw new Error("ciphertext sha256 mismatch (x)");
  }
  const key = base64ToBytes(descriptor["decryption-key"]);
  const nonce = base64ToBytes(descriptor["decryption-nonce"]);
  const plaintext = await aesGcmDecrypt(ciphertext, key, nonce);
  if (sha256Hex(plaintext) !== descriptor.ox) {
    throw new Error("plaintext sha256 mismatch (ox)");
  }
  return plaintext;
}

/**
 * Re-key a descriptor's blob into a fresh ciphertext ("fresh copy", spec §6.2):
 * decrypt then re-encrypt with a new key/IV, producing a new blob hash that no
 * longer links the attendee's presence across events.
 */
export async function freshCopy(
  descriptor: MediaDescriptor,
  ciphertext: Uint8Array,
  newUrls: string[] = [],
): Promise<{ ciphertext: Uint8Array; descriptor: MediaDescriptor }> {
  const plaintext = await decryptMedia(descriptor, ciphertext);
  return encryptMedia({
    kind: descriptor.kind,
    data: plaintext,
    mime: descriptor.m,
    ...(descriptor.duration !== undefined ? { duration: descriptor.duration } : {}),
    urls: newUrls.length ? newUrls : descriptor.url,
  });
}

export type { MediaDescriptor };
