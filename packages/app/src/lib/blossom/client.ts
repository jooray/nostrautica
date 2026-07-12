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

function trimServer(url: string): string {
  return url.replace(/\/+$/, "");
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
    const res = await fetch(`${trimServer(server)}/upload`, {
      method: "HEAD",
      headers: {
        Authorization: authHeader(auth),
        "X-SHA-256": blob.sha256,
        "X-Content-Length": String(blob.size),
        "X-Content-Type": blob.type,
      },
    });
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
  const res = await fetch(`${trimServer(server)}/upload`, {
    method: "PUT",
    headers: {
      Authorization: authHeader(auth),
      "Content-Type": contentType,
    },
    body: ciphertext as unknown as BodyInit,
  });
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
    const res = await fetch(`${trimServer(server)}/mirror`, {
      method: "PUT",
      headers: {
        Authorization: authHeader(auth),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: sourceUrl }),
    });
    if (!res.ok) return null;
    const blob = (await res.json().catch(() => ({}))) as { url?: string };
    return blob.url ?? `${trimServer(server)}/${sha256}`;
  } catch {
    return null;
  }
}

/**
 * Upload to the first server, then mirror to the rest (spec §8, §10.3). Returns
 * every URL the ciphertext is reachable at (primary first).
 */
export async function uploadAndMirror(
  signer: AppSigner,
  servers: string[],
  ciphertext: Uint8Array,
  contentType: string,
): Promise<{ urls: string[]; sha256: string; primary: string }> {
  if (servers.length === 0) throw new Error("no Blossom servers configured");
  const [primaryServer, ...rest] = servers;
  const primary = await upload(signer, primaryServer!, ciphertext, contentType);
  const urls = [primary.url];
  for (const server of rest) {
    const url = await mirror(signer, server, primary.url, primary.sha256);
    if (url) urls.push(url);
  }
  return { urls, sha256: primary.sha256, primary: primary.url };
}

/**
 * Download a blob's ciphertext, trying each mirror URL in turn. Verifies the
 * ciphertext hash against the expected sha256 (x).
 */
export async function downloadBlob(
  urls: string[],
  expectedSha256: string,
): Promise<Uint8Array> {
  let lastErr: unknown;
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        lastErr = new Error(`${res.status} from ${url}`);
        continue;
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (sha256Hex(bytes) !== expectedSha256) {
        lastErr = new Error(`hash mismatch from ${url}`);
        continue;
      }
      return bytes;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`Could not fetch blob: ${lastErr}`);
}
