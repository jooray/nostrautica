/**
 * Event image helpers. Public images (event banners, profile pics) upload
 * UNENCRYPTED to Blossom (spec §5.4) — unlike intro videos, they're meant to be
 * seen by anyone, including external NIP-52 clients.
 *
 * Default: a deterministic gradient banner derived from the title, so an event
 * always has a sane image even if the organizer doesn't upload one.
 */
import { sha256Hex, utf8ToBytes } from "@nostrautica/protocol";
import type { AppSigner } from "$lib/signer/types.js";
import { DEFAULT_BLOSSOM_SERVERS, unionRelays } from "$lib/nostr/relays.js";
import { uploadAndMirror, isAcceptedBlossomUrl } from "$lib/blossom/client.js";
import { fetchUserBlossomServers } from "./submit.js";

/** Two deterministic gradient hues derived from a seed string. */
function hues(seed: string): [number, number] {
  const hash = sha256Hex(utf8ToBytes(seed || "event"));
  const h1 = (parseInt(hash.slice(0, 2), 16) * 360) / 255;
  const h2 = (h1 + 40 + (parseInt(hash.slice(2, 4), 16) % 80)) % 360;
  return [h1, h2];
}

function dataUri(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg.replace(/\n/g, ""))}`;
}

/** A deterministic wide gradient banner (SVG data-URI) from a seed string. */
export function defaultEventBanner(seed: string): string {
  const [h1, h2] = hues(seed);
  return dataUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 480">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="hsl(${h1.toFixed(0)},60%,22%)"/>
<stop offset="1" stop-color="hsl(${h2.toFixed(0)},55%,14%)"/>
</linearGradient></defs>
<rect width="1200" height="480" fill="url(#g)"/>
<path d="M600 150l24 62 66 5-50 43 15 65-55-35-55 35 15-65-50-43 66-5z" fill="hsl(${h1.toFixed(0)},70%,65%)" opacity="0.9"/>
</svg>`);
}

/** A deterministic square icon (gradient + the title's initial) from a seed. */
export function defaultEventIcon(seed: string, label = ""): string {
  const [h1, h2] = hues(seed);
  const initial = (label.trim()[0] ?? "✦").toUpperCase();
  return dataUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="hsl(${h1.toFixed(0)},60%,30%)"/>
<stop offset="1" stop-color="hsl(${h2.toFixed(0)},55%,20%)"/>
</linearGradient></defs>
<rect width="96" height="96" rx="22" fill="url(#g)"/>
<text x="48" y="63" font-family="system-ui,sans-serif" font-size="46" font-weight="700" fill="hsl(${h1.toFixed(0)},80%,80%)" text-anchor="middle">${initial}</text>
</svg>`);
}

/** Avatars upload as a 512px square JPEG (audit APPR-3). */
export const AVATAR_SIZE = 512;

/**
 * Square-crop + scale a profile photo for upload (audit APPR-3). A camera
 * original is megabytes at full resolution and carries EXIF metadata (incl.
 * GPS); every roster row would then download the full file. The canvas
 * decode/re-encode strips EXIF BY CONSTRUCTION (canvas pixels have no metadata)
 * and bounds the file to a 512px JPEG.
 *
 * FAIL CLOSED, unlike {@link cropScaleImage}'s upload-as-is fallback: an
 * undecodable or unprocessable image is a readable ERROR, never a silent upload
 * of the raw original — the raw file is exactly what this exists to keep off
 * Blossom.
 */
export async function prepareAvatarImage(file: Blob): Promise<Blob> {
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("That photo couldn't be read — please choose a different one.");
  }
  try {
    // Cover-crop math (same construction as cropScaleImage): center-crop the
    // largest square the source covers, scaled to AVATAR_SIZE.
    const scale = Math.max(AVATAR_SIZE / bitmap.width, AVATAR_SIZE / bitmap.height);
    const sw = AVATAR_SIZE / scale;
    const sh = AVATAR_SIZE / scale;
    const sx = (bitmap.width - sw) / 2;
    const sy = (bitmap.height - sh) / 2;
    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_SIZE;
    canvas.height = AVATAR_SIZE;
    const c2d = canvas.getContext("2d");
    if (!c2d) throw new Error("no 2d canvas context");
    c2d.drawImage(bitmap, sx, sy, sw, sh, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.9),
    );
    if (!blob) throw new Error("canvas encode failed");
    return blob;
  } catch {
    throw new Error("That photo couldn't be processed — please choose a different one.");
  } finally {
    bitmap?.close?.();
  }
}

/**
 * Center-crop ("cover") + scale an image to an exact target size on a canvas.
 * The create form crops uploads to the aspect ratio the pages actually render
 * (banner 5:2, icon 1:1), so the preview IS what attendees will see — no more
 * uploading blind (user feedback 2026-07-16). Transparent sources keep PNG;
 * photos become JPEG.
 */
export async function cropScaleImage(
  file: Blob,
  targetW: number,
  targetH: number,
): Promise<Blob> {
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file);
    const scale = Math.max(targetW / bitmap.width, targetH / bitmap.height);
    const sw = targetW / scale;
    const sh = targetH / scale;
    const sx = (bitmap.width - sw) / 2;
    const sy = (bitmap.height - sh) / 2;
    const canvas = document.createElement("canvas");
    canvas.width = targetW;
    canvas.height = targetH;
    const c2d = canvas.getContext("2d");
    if (!c2d) return file;
    c2d.drawImage(bitmap, sx, sy, sw, sh, 0, 0, targetW, targetH);
    const type = file.type === "image/png" ? "image/png" : "image/jpeg";
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, type, 0.9),
    );
    return blob ?? file;
  } catch {
    return file; // undecodable input — upload as-is rather than fail
  } finally {
    bitmap?.close?.();
  }
}

/**
 * Upload a public (unencrypted) image to Blossom; returns the primary URL.
 * Unlike encrypted media (submit.ts resolveBlossomServers), this honors the
 * user's own kind 10063 server list — ordinary images are exactly what those
 * general-purpose pins are for, and don't hit the ciphertext content-type
 * rejections encrypted uploads do.
 */
export async function uploadPublicImage(
  signer: AppSigner,
  blob: Blob,
  eventBlossom: string[] = [],
): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const userServers = await fetchUserBlossomServers(signer);
  // https: only (audit APPR-8) — backstop for event-config/10063 URLs.
  const servers = unionRelays(eventBlossom, userServers, DEFAULT_BLOSSOM_SERVERS).filter(
    isAcceptedBlossomUrl,
  );
  const { urls } = await uploadAndMirror(signer, servers, bytes, blob.type || "image/jpeg");
  return urls[0]!;
}

/**
 * Normalize an image URL the organizer pasted instead of uploading a file
 * (organizer feedback 2026-08-29). Event artwork usually already lives
 * somewhere — a CDN, the organizer's own site, an earlier Blossom upload — and
 * re-uploading it to Blossom just to reference it wastes bytes and creates a
 * second copy that can rot independently of the original.
 *
 * Returns the normalized URL, or null if it isn't usable. https only and no
 * embedded credentials, the same rule external talk URLs follow
 * (media/external.ts) and the media descriptor's C3 SSRF hardening: an
 * `https://user:pass@host/banner.png` icon is never legitimate, and since the
 * icon/banner ship in the PUBLIC kind-0/31923 tags it would hand those
 * credentials to everyone who renders the event, not just attendees.
 */
export function externalImageUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}
