/**
 * Media playback (spec §10.3): fetch ciphertext → verify sha256 → decrypt →
 * object URL. AES-GCM whole-file means no range/streaming playback (accepted v1
 * limitation, §3.8) — we materialize the whole decrypted blob then play it.
 *
 * Decrypted blobs are cached in-memory (by ciphertext hash) so re-opening a
 * person's intro doesn't re-download/re-decrypt.
 *
 * Cache discipline (audit APPR-4 / UX-28):
 *  - REF-COUNTED per `x`: resolveMediaUrl acquires, releaseMediaUrl decrements.
 *    A URL is revoked only when nothing references it (or the LRU evicts it) —
 *    one MediaPlayer's unmount can no longer revoke a URL another mounted
 *    player is still using (the old cache revoked on first release).
 *  - BOUNDED LRU (8 entries): when over capacity the least-recently-used
 *    ZERO-REF entry is evicted + revoked. In-use entries are never evicted —
 *    that would reintroduce the revocation race; the bound goes soft only while
 *    more than 8 URLs are genuinely mounted at once.
 *  - DOWNLOADS ARE CAPPED: the ciphertext fetch enforces a hard byte cap (see
 *    blossom/client.ts) and a descriptor claiming more than the cap is rejected
 *    up front.
 */
import { decryptMedia, type MediaDescriptor } from "@nostrautica/protocol";
import { downloadBlob, MAX_MEDIA_DOWNLOAD_BYTES } from "$lib/blossom/client.js";

interface ObjectUrlEntry {
  url: string;
  refs: number;
  lastUsed: number;
}

const MAX_CACHED_OBJECT_URLS = 8;
const objectUrlCache = new Map<string, ObjectUrlEntry>();

/** Evict + revoke least-recently-used zero-ref entries until within the bound. */
function trimCache(): void {
  while (objectUrlCache.size > MAX_CACHED_OBJECT_URLS) {
    let oldestKey: string | undefined;
    let oldest = Infinity;
    for (const [key, entry] of objectUrlCache) {
      if (entry.refs === 0 && entry.lastUsed < oldest) {
        oldest = entry.lastUsed;
        oldestKey = key;
      }
    }
    if (!oldestKey) return; // everything is mounted — soft-bound until a release
    URL.revokeObjectURL(objectUrlCache.get(oldestKey)!.url);
    objectUrlCache.delete(oldestKey);
  }
}

/** Fetch + decrypt a media descriptor into a playable object URL. */
export async function resolveMediaUrl(descriptor: MediaDescriptor): Promise<string> {
  const cached = objectUrlCache.get(descriptor.x);
  if (cached) {
    cached.refs++;
    cached.lastUsed = Date.now();
    return cached.url;
  }

  // A descriptor already claiming more than the cap is rejected before any
  // network traffic (the download itself is capped too — this just fails fast).
  if (descriptor.size > MAX_MEDIA_DOWNLOAD_BYTES) {
    throw new Error(
      `This media claims to be ${Math.round(descriptor.size / 1024 / 1024)} MB — over the ${Math.round(MAX_MEDIA_DOWNLOAD_BYTES / 1024 / 1024)} MB limit, not downloading it.`,
    );
  }
  const ciphertext = await downloadBlob(descriptor.url, descriptor.x, {
    expectedSize: descriptor.size,
  });
  const plaintext = await decryptMedia(descriptor, ciphertext);
  const blob = new Blob([plaintext as unknown as BlobPart], { type: descriptor.m });
  const url = URL.createObjectURL(blob);
  objectUrlCache.set(descriptor.x, { url, refs: 1, lastUsed: Date.now() });
  trimCache();
  return url;
}

/** Release one reference to a cached object URL (call on component unmount). */
export function releaseMediaUrl(descriptor: MediaDescriptor): void {
  const entry = objectUrlCache.get(descriptor.x);
  if (!entry) return;
  entry.refs--;
  entry.lastUsed = Date.now();
  trimCache();
}
