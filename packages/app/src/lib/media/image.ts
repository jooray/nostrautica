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
