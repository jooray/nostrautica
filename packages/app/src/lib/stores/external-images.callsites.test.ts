/**
 * Audit DS41-020. safeImageSrc() enforces the "load images from other sites"
 * opt-out and no-referrer, but only where it is called. Event icons on Home and
 * in the DM list, post header images and images inside quoted notes put wire
 * URLs straight into <img src>, so turning the setting off still contacted
 * those hosts, with a referrer naming the open event page. The quoted-note URL
 * is chosen by an arbitrary note author.
 *
 * This pins the rule at the call sites: every <img> in pages/ and components/
 * carries the external referrer policy (which in practice means its src went
 * through safeImageSrc), unless its source is one of the listed local previews.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join } from "node:path";

const libRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Images whose source is not a third-party wire URL: QR codes and crop
 * previews are data:/blob: URLs made on this device, and the rest preview an
 * image the viewer is uploading or typing in for their own profile or event
 * right now. Hiding those under the opt-out would make the upload look lost.
 */
const LOCAL_SOURCES: Record<string, string[]> = {
  "pages/Login.svelte": ["picPreview"],
  "pages/Join.svelte": ["newPicPreview"],
  "pages/Create.svelte": ["previewIcon", "previewBanner"],
  "pages/EventSettings.svelte": ["metadataPreviewIcon", "metadataPreviewBanner"],
  "components/PostEditor.svelte": ["image"],
  "components/ImageCropper.svelte": ["objectUrl"],
  "components/QrCode.svelte": ["dataUrl"],
};

function svelteFiles(dir: string): string[] {
  return readdirSync(resolve(libRoot, dir))
    .filter((f) => f.endsWith(".svelte"))
    .map((f) => join(dir, f));
}

describe("third-party image call sites", () => {
  it("every <img> goes through the external-image policy or is a local preview", () => {
    const offenders: string[] = [];
    for (const f of [...svelteFiles("pages"), ...svelteFiles("components")]) {
      const src = readFileSync(resolve(libRoot, f), "utf8");
      for (const m of src.matchAll(/<img\b[^>]*>/g)) {
        const tag = m[0];
        if (/referrerpolicy=\{EXTERNAL_IMG_REFERRER_POLICY\}/.test(tag)) continue;
        const expr = /\bsrc=\{([^}]*)\}/.exec(tag)?.[1]?.trim();
        if (expr && LOCAL_SOURCES[f]?.includes(expr)) continue;
        // InviteSheet mentions "<img>" inside a CSS comment.
        if (!/\bsrc=|\{src\}/.test(tag)) continue;
        offenders.push(`${f}: ${tag.replace(/\s+/g, " ").slice(0, 90)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
