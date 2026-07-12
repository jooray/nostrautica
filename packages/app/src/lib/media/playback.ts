/**
 * Media playback (spec §10.3): fetch ciphertext → verify sha256 → decrypt →
 * object URL. AES-GCM whole-file means no range/streaming playback (accepted v1
 * limitation, §3.8) — we materialize the whole decrypted blob then play it.
 *
 * Decrypted blobs are cached in-memory (by ciphertext hash) so re-opening a
 * person's intro doesn't re-download/re-decrypt.
 */
import { decryptMedia, type MediaDescriptor } from "@nostrautica/protocol";
import { downloadBlob } from "$lib/blossom/client.js";

const objectUrlCache = new Map<string, string>();

/** Fetch + decrypt a media descriptor into a playable object URL. */
export async function resolveMediaUrl(descriptor: MediaDescriptor): Promise<string> {
  const cached = objectUrlCache.get(descriptor.x);
  if (cached) return cached;

  const ciphertext = await downloadBlob(descriptor.url, descriptor.x);
  const plaintext = await decryptMedia(descriptor, ciphertext);
  const blob = new Blob([plaintext as unknown as BlobPart], { type: descriptor.m });
  const url = URL.createObjectURL(blob);
  objectUrlCache.set(descriptor.x, url);
  return url;
}

/** Release a cached object URL (call when a component using it unmounts). */
export function releaseMediaUrl(descriptor: MediaDescriptor): void {
  const url = objectUrlCache.get(descriptor.x);
  if (url) {
    URL.revokeObjectURL(url);
    objectUrlCache.delete(descriptor.x);
  }
}
