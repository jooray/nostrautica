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
import { uploadAndMirror } from "$lib/blossom/client.js";

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

/** Upload a public (unencrypted) image to Blossom; returns the primary URL. */
export async function uploadPublicImage(
  signer: AppSigner,
  blob: Blob,
  eventBlossom: string[] = [],
): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const servers = unionRelays(eventBlossom, DEFAULT_BLOSSOM_SERVERS);
  const { urls } = await uploadAndMirror(signer, servers, bytes, blob.type || "image/jpeg");
  return urls[0]!;
}
