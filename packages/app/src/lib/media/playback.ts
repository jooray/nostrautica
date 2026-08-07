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
import {
  downloadBlob,
  MAX_MEDIA_DOWNLOAD_BYTES,
  type DownloadProgress,
} from "$lib/blossom/client.js";

interface ObjectUrlEntry {
  url: string;
  refs: number;
  lastUsed: number;
}

const MAX_CACHED_OBJECT_URLS = 8;
const objectUrlCache = new Map<string, ObjectUrlEntry>();

/**
 * In-flight downloads keyed by ciphertext hash (audit App-3). Without this, two
 * concurrent `resolveMediaUrl(sameX)` calls both miss the cache, both
 * download/decrypt, both `createObjectURL`, and the second `set()` orphans the
 * first URL (leak) and clobbers its ref count. Followers instead await the
 * leader's single download and then acquire their own reference.
 */
const inflight = new Map<string, Promise<string>>();

/**
 * Progress listeners per in-flight ciphertext hash. Callers that get coalesced
 * onto someone else's download (see `inflight`) still need byte counts, or their
 * progress bar sits at 0% for the whole transfer — so progress is broadcast to
 * everyone waiting on `x`, not handed to whoever happened to start it.
 */
const progressListeners = new Map<string, Set<(p: DownloadProgress) => void>>();

/** Subscribe to `x`'s download progress; returns the unsubscribe. */
function listenProgress(x: string, fn?: (p: DownloadProgress) => void): () => void {
  if (!fn) return () => {};
  let set = progressListeners.get(x);
  if (!set) {
    set = new Set();
    progressListeners.set(x, set);
  }
  set.add(fn);
  return () => {
    set.delete(fn);
    if (set.size === 0) progressListeners.delete(x);
  };
}

function emitProgress(x: string, p: DownloadProgress): void {
  const set = progressListeners.get(x);
  if (!set) return;
  for (const fn of set) fn(p);
}

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

/** Acquire a reference to an already-cached entry, if present. */
function acquireCached(x: string): string | undefined {
  const cached = objectUrlCache.get(x);
  if (!cached) return undefined;
  cached.refs++;
  cached.lastUsed = Date.now();
  return cached.url;
}

export interface ResolveMediaOptions {
  /**
   * Ciphertext download progress, for a progress bar. Fires only while bytes are
   * moving — decryption afterwards reports nothing, so a caller showing a bar
   * should switch to a "decrypting" state once `received` reaches `total`.
   */
  onProgress?: (progress: DownloadProgress) => void;
}

/** Fetch + decrypt a media descriptor into a playable object URL. */
export async function resolveMediaUrl(
  descriptor: MediaDescriptor,
  opts: ResolveMediaOptions = {},
): Promise<string> {
  const hit = acquireCached(descriptor.x);
  if (hit) return hit;

  const unlisten = listenProgress(descriptor.x, opts.onProgress);
  try {
    // Coalesce concurrent resolves of the same ciphertext onto one download; each
    // caller still acquires its own ref count (matched by its own releaseMediaUrl).
    const pending = inflight.get(descriptor.x);
    if (pending) {
      await pending;
      const acquired = acquireCached(descriptor.x);
      if (acquired) return acquired;
      // The entry was evicted between the leader finishing and us acquiring (its
      // caller released immediately and a zero-ref trim ran) — download our own.
    }

    const download = (async () => {
      // A descriptor already claiming more than the cap is rejected before any
      // network traffic (the download itself is capped too — this just fails fast).
      if (descriptor.size > MAX_MEDIA_DOWNLOAD_BYTES) {
        throw new Error(
          `This media claims to be ${Math.round(descriptor.size / 1024 / 1024)} MB — over the ${Math.round(MAX_MEDIA_DOWNLOAD_BYTES / 1024 / 1024)} MB limit, not downloading it.`,
        );
      }
      const ciphertext = await downloadBlob(descriptor.url, descriptor.x, {
        expectedSize: descriptor.size,
        onProgress: (p) => emitProgress(descriptor.x, p),
      });
      const plaintext = await decryptMedia(descriptor, ciphertext);
      const blob = new Blob([plaintext as unknown as BlobPart], { type: descriptor.m });
      const url = URL.createObjectURL(blob);
      objectUrlCache.set(descriptor.x, { url, refs: 1, lastUsed: Date.now() });
      trimCache();
      return url;
    })();
    inflight.set(descriptor.x, download);
    try {
      return await download;
    } finally {
      inflight.delete(descriptor.x);
    }
  } finally {
    unlisten();
  }
}

/** Release one reference to a cached object URL (call on component unmount). */
export function releaseMediaUrl(descriptor: MediaDescriptor): void {
  const entry = objectUrlCache.get(descriptor.x);
  if (!entry) return;
  entry.refs--;
  entry.lastUsed = Date.now();
  trimCache();
}
