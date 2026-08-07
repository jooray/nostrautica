/**
 * Blossom client (spec §10.3, BUD-02/04/06). Uploads encrypted blobs (ciphertext
 * addressed by ciphertext sha256), mirrors them to the event's other servers +
 * the user's 10063 servers, and downloads them for decryption.
 *
 * Servers see only AES-GCM ciphertext + sizes/hashes (spec §4.2).
 */
import { sha256Hex } from "@nostrautica/protocol";
import type { AppSigner } from "$lib/signer/types.js";
import { buildAuthEvent, authHeader } from "./auth.js";

/**
 * Operation timeouts (UX-7): a hung Blossom server must never wedge Record's
 * "Uploading…" or MediaPlayer's "Decrypting…" forever. Uploads get the biggest
 * budget — videos can be large on slow links; preflights are small/fast, so a
 * server that can't answer promptly is simply skipped.
 */
export const PREFLIGHT_TIMEOUT_MS = 10_000;
export const UPLOAD_TIMEOUT_MS = 60_000;
export const MIRROR_TIMEOUT_MS = 30_000;

/**
 * Downloads are bounded by PROGRESS, not by total wall clock.
 *
 * Prod report 2026-08-07: a video intro failed with "Download from … timed out
 * after 20000ms" on a slow connection. The old single budget covered the
 * response headers AND the whole streamed body, so a blob that was arriving
 * perfectly well but needed more than 20s of transfer was indistinguishable
 * from a dead server — and every mirror failed the same way, since the limit was
 * the link, not the host. A 12 MB intro needs ~96s on a 1 Mbit/s phone link.
 *
 *  - {@link DOWNLOAD_TIMEOUT_MS} now bounds only the response headers, so a
 *    server that never answers at all is still skipped in 20s as before.
 *  - {@link DOWNLOAD_STALL_TIMEOUT_MS} bounds the SILENCE between body chunks
 *    and resets on every chunk, so a slow-but-moving download runs to
 *    completion however long that takes.
 *
 * A server dribbling one byte per stall window can hold a download open for a
 * long time; MAX_MEDIA_DOWNLOAD_BYTES bounds what that can cost, and with
 * `onProgress` wired to the player the user can see it crawling and leave.
 */
export const DOWNLOAD_TIMEOUT_MS = 20_000;
export const DOWNLOAD_STALL_TIMEOUT_MS = 30_000;

/**
 * Wall-clock budget for the no-ReadableStream fallback (old webviews). Nothing
 * there exposes chunk boundaries to measure a stall against, so this is a plain
 * total — generous enough that a legitimately slow download still finishes.
 */
export const DOWNLOAD_WHOLE_BODY_TIMEOUT_MS = 10 * 60_000;

/**
 * Reject with `message` — and abort `controller` — if `promise` doesn't settle
 * in time. The rejection is always a plain Error (never a bare AbortError), so
 * callers' existing catch paths work and even a fetch implementation that
 * ignores the signal still settles.
 *
 * The controller comes from the caller so one request can spend several
 * independent budgets on a single fetch (headers, then per-chunk) rather than
 * one budget for all of it.
 */
function raceTimeout<T>(
  message: string,
  timeoutMs: number,
  controller: AbortController,
  promise: Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(message));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Run `work` under a single all-in timeout (UX-7). */
async function withTimeout<T>(
  label: string,
  timeoutMs: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  return raceTimeout(
    `${label} timed out after ${timeoutMs}ms`,
    timeoutMs,
    controller,
    work(controller.signal),
  );
}

function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  label: string,
): Promise<Response> {
  return withTimeout(label, timeoutMs, (signal) => fetch(url, { ...init, signal }));
}

function trimServer(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * A Blossom server URL the app will talk to (audit APPR-8): https: only. The
 * protocol package already drops non-https URLs from the 31600 parse, but
 * server lists also arrive via the user's (unvalidated) kind 10063 tags and
 * announcements already on relays predate the schema rule — filter at the app
 * boundary too.
 */
export function isAcceptedBlossomUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

export interface PreflightResult {
  server: string;
  ok: boolean;
  status: number;
  message?: string;
}

/**
 * BUD-06 preflight: ask the server whether it will accept this blob (size/type)
 * BEFORE uploading. Limits vary per server, so always preflight (§3.13).
 */
export async function preflight(
  signer: AppSigner,
  server: string,
  blob: { sha256: string; size: number; type: string },
): Promise<PreflightResult> {
  const auth = await buildAuthEvent(signer, { verb: "upload", sha256: blob.sha256 });
  try {
    const res = await fetchWithTimeout(
      `${trimServer(server)}/upload`,
      {
        method: "HEAD",
        headers: {
          Authorization: authHeader(auth),
          "X-SHA-256": blob.sha256,
          "X-Content-Length": String(blob.size),
          "X-Content-Type": blob.type,
        },
      },
      PREFLIGHT_TIMEOUT_MS,
      `Preflight at ${server}`,
    );
    return {
      server,
      ok: res.ok,
      status: res.status,
      message: res.ok ? undefined : res.headers.get("X-Reason") ?? res.statusText,
    };
  } catch (e) {
    return { server, ok: false, status: 0, message: String(e) };
  }
}

export interface BlobDescriptor {
  url: string;
  sha256: string;
  size: number;
  type: string;
}

/** BUD-02 upload: PUT the ciphertext bytes. Returns the stored blob URL. */
export async function upload(
  signer: AppSigner,
  server: string,
  ciphertext: Uint8Array,
  contentType = "application/octet-stream",
): Promise<BlobDescriptor> {
  const sha256 = sha256Hex(ciphertext);
  const auth = await buildAuthEvent(signer, { verb: "upload", sha256 });
  const res = await fetchWithTimeout(
    `${trimServer(server)}/upload`,
    {
      method: "PUT",
      headers: {
        Authorization: authHeader(auth),
        "Content-Type": contentType,
      },
      body: ciphertext as unknown as BodyInit,
    },
    UPLOAD_TIMEOUT_MS,
    `Upload to ${server}`,
  );
  if (!res.ok) {
    throw new Error(
      `Upload to ${server} failed: ${res.status} ${res.headers.get("X-Reason") ?? res.statusText}`,
    );
  }
  const blob = (await res.json()) as { url?: string; sha256?: string; size?: number };
  return {
    url: blob.url ?? `${trimServer(server)}/${sha256}`,
    sha256,
    size: ciphertext.length,
    type: contentType,
  };
}

/**
 * BUD-04 mirror: ask `server` to fetch an already-uploaded blob from `sourceUrl`.
 * Returns the mirror URL, or null if the server declined.
 */
export async function mirror(
  signer: AppSigner,
  server: string,
  sourceUrl: string,
  sha256: string,
): Promise<string | null> {
  const auth = await buildAuthEvent(signer, { verb: "upload", sha256 });
  try {
    const res = await fetchWithTimeout(
      `${trimServer(server)}/mirror`,
      {
        method: "PUT",
        headers: {
          Authorization: authHeader(auth),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url: sourceUrl }),
      },
      MIRROR_TIMEOUT_MS,
      `Mirror to ${server}`,
    );
    if (!res.ok) return null;
    const blob = (await res.json().catch(() => ({}))) as { url?: string };
    return blob.url ?? `${trimServer(server)}/${sha256}`;
  } catch {
    return null;
  }
}

/**
 * Upload to the first server that accepts it, then mirror to the remaining
 * candidates (spec §8, §10.3). Preflight only predicts which server is likely to
 * accept the blob — a server preflight couldn't rule out (CORS-blocked HEAD) can
 * still 415/CORS-block the real PUT, so a failed upload falls through to the next
 * candidate instead of failing the whole operation (prod report 2026-07-20: a
 * stale per-user/event Blossom server pinned an incompatible primary and had no
 * fallback). Returns every URL the ciphertext is reachable at (primary first).
 */
export async function uploadAndMirror(
  signer: AppSigner,
  servers: string[],
  ciphertext: Uint8Array,
  contentType: string,
): Promise<{ urls: string[]; sha256: string; primary: string }> {
  if (servers.length === 0) throw new Error("no Blossom servers configured");
  let primary: BlobDescriptor | undefined;
  let rest: string[] = [];
  const errors: string[] = [];
  for (let i = 0; i < servers.length; i++) {
    try {
      primary = await upload(signer, servers[i]!, ciphertext, contentType);
      rest = servers.slice(i + 1);
      break;
    } catch (e) {
      errors.push(`${servers[i]}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (!primary) {
    throw new Error(`Upload failed on every candidate server: ${errors.join("; ")}`);
  }
  // Mirrors race in parallel (UX-7): a hung mirror used to serialize the whole
  // operation behind its timeout while healthy mirrors waited idle.
  const mirrored = await Promise.all(
    rest.map((server) => mirror(signer, server, primary.url, primary.sha256)),
  );
  const urls = [primary.url, ...mirrored.filter((u): u is string => !!u)];
  return { urls, sha256: primary.sha256, primary: primary.url };
}

/**
 * BUD-02 delete: ask `server` to drop the blob at `sha256`, authorized by a
 * kind-24242 `delete` auth event signed by the uploader (NIP §6.3 21610: a
 * withdrawing attendee tears down their own media). Best-effort — returns true on
 * a 2xx (or 404, already gone), false on any other failure — so a single
 * unreachable server never blocks the withdrawal. Never throws.
 */
export async function deleteBlob(
  signer: AppSigner,
  server: string,
  sha256: string,
): Promise<boolean> {
  try {
    const auth = await buildAuthEvent(signer, { verb: "delete", sha256 });
    const res = await fetchWithTimeout(
      `${trimServer(server)}/${sha256}`,
      { method: "DELETE", headers: { Authorization: authHeader(auth) } },
      MIRROR_TIMEOUT_MS,
      `Delete from ${server}`,
    );
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

/**
 * Hard cap on a media download (audit APPR-4): a malicious directory entry can
 * point at a multi-GB endpoint, and a whole-file `arrayBuffer()` would take the
 * tab down. 250 MB is far above any legit intro/talk video.
 */
export const MAX_MEDIA_DOWNLOAD_BYTES = 250 * 1024 * 1024;

/** How much of a blob's ciphertext has arrived, for a progress indicator. */
export interface DownloadProgress {
  /** Ciphertext bytes received so far from the mirror currently being read. */
  received: number;
  /**
   * Total ciphertext bytes, when known — the response's Content-Length, else the
   * descriptor's claimed size. Undefined only when neither is available, in
   * which case a caller can show bytes-so-far but no percentage.
   */
  total?: number;
}

export interface DownloadOptions {
  /** Abort past this many bytes (default {@link MAX_MEDIA_DOWNLOAD_BYTES}). */
  maxBytes?: number;
  /**
   * The descriptor's claimed ciphertext size, when known — a claim already past
   * the cap is rejected without any network traffic, and it gives the progress
   * indicator a denominator even when the server sends no Content-Length.
   */
  expectedSize?: number;
  /**
   * Called once the response headers land (with `received: 0`) and then after
   * every body chunk. Restarts from 0 if a mirror fails and the next is tried.
   */
  onProgress?: (progress: DownloadProgress) => void;
}

/**
 * Read a response body with a running byte counter, aborting past `maxBytes`.
 * Content-Length is checked up front when present; the streamed count is the
 * real guard (a lying/chunked endpoint is caught mid-stream).
 *
 * Each `read()` is bounded by {@link DOWNLOAD_STALL_TIMEOUT_MS} — the budget is
 * per chunk, not for the whole body, so only an actually-silent server fails.
 */
async function readCapped(
  res: Response,
  maxBytes: number,
  url: string,
  controller: AbortController,
  opts: Pick<DownloadOptions, "expectedSize" | "onProgress">,
): Promise<Uint8Array> {
  const contentLength = Number(res.headers.get("content-length") ?? 0);
  if (contentLength > maxBytes) {
    throw new Error(`blob is ${contentLength} bytes — over the ${maxBytes}-byte cap (${url})`);
  }
  // Content-Length first; a cross-origin response that doesn't expose it still
  // has the descriptor's own ciphertext size to show a real percentage against.
  const total = contentLength > 0 ? contentLength : opts.expectedSize;
  const stalled = `Download from ${url} stalled — no data for ${DOWNLOAD_STALL_TIMEOUT_MS}ms`;

  const reader = res.body?.getReader();
  if (!reader) {
    // No stream API (old webview): whole-read under one generous budget, then
    // enforce the cap on the result. No chunk boundaries, so no progress either.
    const bytes = new Uint8Array(
      await raceTimeout(
        `Download from ${url} timed out after ${DOWNLOAD_WHOLE_BODY_TIMEOUT_MS}ms`,
        DOWNLOAD_WHOLE_BODY_TIMEOUT_MS,
        controller,
        res.arrayBuffer(),
      ),
    );
    if (bytes.length > maxBytes) {
      throw new Error(`blob is ${bytes.length} bytes — over the ${maxBytes}-byte cap (${url})`);
    }
    return bytes;
  }

  opts.onProgress?.({ received: 0, total });
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await raceTimeout(
      stalled,
      DOWNLOAD_STALL_TIMEOUT_MS,
      controller,
      reader.read(),
    );
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`blob passed the ${maxBytes}-byte download cap — aborted (${url})`);
    }
    chunks.push(value);
    opts.onProgress?.({ received, total });
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Download a blob's ciphertext, trying each mirror URL in turn. Verifies the
 * ciphertext hash against the expected sha256 (x). Downloads are size-capped
 * (audit APPR-4) — an over-cap mirror is skipped like any other failure.
 */
export async function downloadBlob(
  urls: string[],
  expectedSha256: string,
  opts: DownloadOptions = {},
): Promise<Uint8Array> {
  const maxBytes = opts.maxBytes ?? MAX_MEDIA_DOWNLOAD_BYTES;
  if (opts.expectedSize !== undefined && opts.expectedSize > maxBytes) {
    throw new Error(
      `refusing to download: the descriptor claims ${opts.expectedSize} bytes, over the ${maxBytes}-byte cap`,
    );
  }
  let lastErr: unknown;
  for (const url of urls) {
    // One controller, two budgets (see DOWNLOAD_STALL_TIMEOUT_MS): the headers
    // have to arrive promptly, the body only has to keep moving.
    const controller = new AbortController();
    try {
      const res = await raceTimeout(
        `Download from ${url} timed out after ${DOWNLOAD_TIMEOUT_MS}ms`,
        DOWNLOAD_TIMEOUT_MS,
        controller,
        fetch(url, { signal: controller.signal }),
      );
      if (!res.ok) throw new Error(`${res.status} from ${url}`);
      const bytes = await readCapped(res, maxBytes, url, controller, opts);
      if (sha256Hex(bytes) !== expectedSha256) throw new Error(`hash mismatch from ${url}`);
      return bytes;
    } catch (e) {
      lastErr = e;
      // Release any body still streaming from the mirror we're giving up on.
      controller.abort();
    }
  }
  throw new Error(`Could not fetch blob: ${lastErr}`);
}
