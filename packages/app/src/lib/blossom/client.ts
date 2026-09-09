/**
 * Blossom client (spec §10.3, BUD-02/04/06). Uploads encrypted blobs (ciphertext
 * addressed by ciphertext sha256), mirrors them to the event's other servers +
 * the user's 10063 servers, and downloads them for decryption.
 *
 * Servers see only AES-GCM ciphertext + sizes/hashes (spec §4.2).
 */
import { sha256Hex,
  MAX_MEDIA_FILE_BYTES,
} from "@nostrautica/protocol";
import type { AppSigner } from "$lib/signer/types.js";
import { buildAuthEvent, authHeader } from "./auth.js";

/**
 * Operation timeouts (UX-7): a hung Blossom server must never wedge Record's
 * "Uploading…" or MediaPlayer's "Decrypting…" forever. Preflights are small and
 * fast, so a server that can't answer promptly is simply skipped.
 */
export const PREFLIGHT_TIMEOUT_MS = 10_000;
export const MIRROR_TIMEOUT_MS = 30_000;

/**
 * Uploads, like downloads, are bounded by PROGRESS — not by one wall clock.
 *
 * This is the same defect the download path was rewritten away from (see
 * DOWNLOAD_STALL_TIMEOUT_MS below), and it bites harder here because uplinks
 * are several times slower than downlinks: 15 MB of ciphertext on venue Wi-Fi
 * does not fit in a 60-second budget, so the PUT was killed mid-body, and
 * `uploadAndMirror` then re-uploaded the whole blob to the next candidate server
 * and blew the same budget again — the attendee waited through several full
 * uploads to be told every server had failed, when the only thing that had
 * failed was the stopwatch.
 *
 *  - {@link UPLOAD_CONNECT_TIMEOUT_MS} bounds getting started: no bytes
 *    acknowledged at all means a dead/unreachable server, skipped promptly.
 *  - {@link UPLOAD_STALL_TIMEOUT_MS} bounds the SILENCE between upload-progress
 *    events and resets on each one, so a slow-but-moving upload runs to
 *    completion however long it takes.
 *  - {@link UPLOAD_RESPONSE_TIMEOUT_MS} covers the gap after the last byte is
 *    sent, when the server is hashing and storing what may be hundreds of MB
 *    and legitimately says nothing while it does.
 */
export const UPLOAD_CONNECT_TIMEOUT_MS = 20_000;
export const UPLOAD_STALL_TIMEOUT_MS = 30_000;
export const UPLOAD_RESPONSE_TIMEOUT_MS = 120_000;

/**
 * Whole-request budget for the no-XMLHttpRequest fallback below. Nothing there
 * reports how much of the body has gone out, so there is no stall to measure and
 * this stays a plain total. Browsers all have XHR; this path exists for
 * non-browser contexts (SSR, tests), which do not upload attendee video.
 */
export const UPLOAD_TIMEOUT_MS = 60_000;

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

/** How much of an upload's ciphertext has gone out, for a progress indicator. */
export interface UploadProgress {
  /** Ciphertext bytes handed to the network so far for the CURRENT server. */
  sent: number;
  /** Total ciphertext bytes — always known here (we hold the buffer). */
  total: number;
  /** Which server the bytes are going to; a fallback restarts the count at 0. */
  server: string;
}

export interface UploadOptions {
  /** Fires once at 0 bytes, then as the body goes out, then once at `total`. */
  onProgress?: (progress: UploadProgress) => void;
}

/**
 * Module-level upload-progress channel.
 *
 * Record's composer is several layers above the socket (Record → submit.ts's
 * uploadMedia → uploadAndMirror → upload), and threading a callback through
 * every one of them to draw one progress bar is a lot of plumbing for a screen
 * that only ever runs ONE upload at a time — the submit button is disabled for
 * its whole duration. `playback.ts` already does exactly this for downloads.
 * A subscriber gets every upload's progress; `server` says which.
 */
const uploadProgressListeners = new Set<(progress: UploadProgress) => void>();

/** Subscribe to upload progress; returns the unsubscribe. */
export function onUploadProgress(cb: (progress: UploadProgress) => void): () => void {
  uploadProgressListeners.add(cb);
  return () => uploadProgressListeners.delete(cb);
}

interface PutResult {
  ok: boolean;
  status: number;
  statusText: string;
  /** The server's X-Reason header, when it sent one. */
  reason: string | null;
  body: string;
}

/**
 * PUT the bytes with XMLHttpRequest, spending the three budgets above.
 *
 * XHR rather than fetch because `upload.onprogress` is the only broadly
 * available way to see the request BODY moving: streaming a fetch request body
 * needs `duplex: "half"` plus an HTTP/2 origin and is still not available
 * everywhere, and without progress events there is nothing to reset a stall
 * timer against — which is the whole point of this rewrite.
 */
function xhrPut(
  url: string,
  headers: Record<string, string>,
  body: Uint8Array,
  label: string,
  emit: (sent: number) => void,
): Promise<PutResult> {
  return new Promise<PutResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const done = () => {
      settled = true;
      if (timer) clearTimeout(timer);
    };
    const fail = (message: string) => {
      if (settled) return;
      done();
      // Abort re-enters as onabort, which the `settled` guard swallows.
      try {
        xhr.abort();
      } catch {
        /* already finished */
      }
      reject(new Error(message));
    };
    /** (Re)arm the single deadline. Each phase replaces the previous budget. */
    const arm = (ms: number, message: string) => {
      if (settled) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => fail(message), ms);
    };

    xhr.open("PUT", url, true);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);

    xhr.upload.onprogress = (e) => {
      arm(UPLOAD_STALL_TIMEOUT_MS, `${label} stalled: no data sent for ${UPLOAD_STALL_TIMEOUT_MS}ms`);
      emit(e.loaded);
    };
    xhr.upload.onload = () => {
      // Body fully sent; the server is now hashing/storing it, which for a large
      // blob is legitimately a long silence — a different budget, not a stall.
      emit(body.length);
      arm(
        UPLOAD_RESPONSE_TIMEOUT_MS,
        `${label} timed out after ${UPLOAD_RESPONSE_TIMEOUT_MS}ms waiting for a response`,
      );
    };
    xhr.onprogress = () => arm(UPLOAD_RESPONSE_TIMEOUT_MS, `${label} stalled reading the response`);
    xhr.onload = () => {
      if (settled) return;
      done();
      resolve({
        ok: xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
        statusText: xhr.statusText,
        reason: xhr.getResponseHeader("X-Reason"),
        body: xhr.responseText ?? "",
      });
    };
    xhr.onerror = () => fail(`${label} failed: network error`);
    xhr.ontimeout = () => fail(`${label} timed out`);
    xhr.onabort = () => fail(`${label} was aborted`);

    arm(
      UPLOAD_CONNECT_TIMEOUT_MS,
      `${label} timed out after ${UPLOAD_CONNECT_TIMEOUT_MS}ms (no connection)`,
    );
    emit(0);
    xhr.send(body as unknown as XMLHttpRequestBodyInit);
  });
}

/** Fallback PUT for contexts without XMLHttpRequest — no body progress. */
async function fetchPut(
  url: string,
  headers: Record<string, string>,
  body: Uint8Array,
  label: string,
  emit: (sent: number) => void,
): Promise<PutResult> {
  emit(0);
  const res = await fetchWithTimeout(
    url,
    { method: "PUT", headers, body: body as unknown as BodyInit },
    UPLOAD_TIMEOUT_MS,
    label,
  );
  emit(body.length);
  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    reason: res.headers.get("X-Reason"),
    body: await res.text(),
  };
}

/** BUD-02 upload: PUT the ciphertext bytes. Returns the stored blob URL. */
export async function upload(
  signer: AppSigner,
  server: string,
  ciphertext: Uint8Array,
  contentType = "application/octet-stream",
  opts: UploadOptions = {},
): Promise<BlobDescriptor> {
  const sha256 = sha256Hex(ciphertext);
  const auth = await buildAuthEvent(signer, { verb: "upload", sha256 });
  const total = ciphertext.length;
  const emit = (sent: number) => {
    const progress: UploadProgress = { sent: Math.min(sent, total), total, server };
    opts.onProgress?.(progress);
    for (const listener of uploadProgressListeners) {
      try {
        listener(progress);
      } catch {
        /* a broken subscriber must never fail the upload */
      }
    }
  };
  const put = typeof XMLHttpRequest === "undefined" ? fetchPut : xhrPut;
  const res = await put(
    `${trimServer(server)}/upload`,
    { Authorization: authHeader(auth), "Content-Type": contentType },
    ciphertext,
    `Upload to ${server}`,
    emit,
  );
  if (!res.ok) {
    throw new Error(`Upload to ${server} failed: ${res.status} ${res.reason ?? res.statusText}`);
  }
  let blob: { url?: string } = {};
  try {
    blob = JSON.parse(res.body) as { url?: string };
  } catch {
    // BUD-02 says the response is a blob descriptor, but a server that answers
    // 200 with something else still stored the blob at its content address.
  }
  // Take the server's URL only if it actually points at OUR blob (audit MED-9).
  // Blossom is content-addressed, so a descriptor URL that does not carry the
  // sha256 we uploaded is either a broken server or one substituting a different
  // blob — and this URL goes straight into the media descriptor other people
  // fetch from. The coordinator re-verifies the hash on download and would reject
  // the substitute, but the app's own players would have followed it, and there
  // is no reason to publish a pointer we can already tell is wrong.
  const serverUrl = blob.url?.includes(sha256) ? blob.url : undefined;
  return {
    url: serverUrl ?? `${trimServer(server)}/${sha256}`,
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
  opts: UploadOptions = {},
): Promise<{ urls: string[]; sha256: string; primary: string }> {
  if (servers.length === 0) throw new Error("no Blossom servers configured");
  let primary: BlobDescriptor | undefined;
  let rest: string[] = [];
  const errors: string[] = [];
  for (let i = 0; i < servers.length; i++) {
    try {
      primary = await upload(signer, servers[i]!, ciphertext, contentType, opts);
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
export const MAX_MEDIA_DOWNLOAD_BYTES = MAX_MEDIA_FILE_BYTES;

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
    throw new Error(`blob is ${contentLength} bytes, over the ${maxBytes}-byte cap (${url})`);
  }
  // Content-Length first; a cross-origin response that doesn't expose it still
  // has the descriptor's own ciphertext size to show a real percentage against.
  const total = contentLength > 0 ? contentLength : opts.expectedSize;
  const stalled = `Download from ${url} stalled: no data for ${DOWNLOAD_STALL_TIMEOUT_MS}ms`;

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
      throw new Error(`blob is ${bytes.length} bytes, over the ${maxBytes}-byte cap (${url})`);
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
      throw new Error(`blob passed the ${maxBytes}-byte download cap and was aborted (${url})`);
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
