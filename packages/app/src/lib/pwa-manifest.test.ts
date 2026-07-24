/**
 * PWA installability artifact test (audit U6). The manifest is generated but was
 * never linked from the built HTML, so Chromium never treated the app as
 * installable (`beforeinstallprompt` never fired). This asserts the manifest
 * link exists and is consistent with the manifest, the SW registration, and the
 * icons — both in the SOURCE templates (always) and, when a build is present, in
 * the actual `build/` artifact (the BASE_PATH=/app production output).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => readFileSync(resolve(pkgRoot, p), "utf8");

describe("PWA manifest is linked (audit U6) — source templates", () => {
  it("app.html links the manifest with a base-path-correct href", () => {
    const html = read("src/app.html");
    // %sveltekit.assets% resolves to the base path (empty locally, /app in prod),
    // exactly like the favicon link right above it.
    expect(html).toMatch(
      /<link\s+rel="manifest"\s+href="%sveltekit\.assets%\/manifest\.webmanifest"\s*\/?>/,
    );
  });

  it("the vite manifest declares relative start_url/scope and both icons", () => {
    const cfg = read("vite.config.ts");
    expect(cfg).toMatch(/start_url:\s*"\.\/"/);
    expect(cfg).toMatch(/scope:\s*"\.\/"/);
    expect(cfg).toMatch(/icon-192\.png/);
    expect(cfg).toMatch(/icon-512\.png/);
  });
});

// Full artifact assertions run only when a build exists (produced by
// `BASE_PATH=/app pnpm build`). They are the real "artifact check" — the source
// assertions above always run so the suite is green without a prior build.
const buildIndex = resolve(pkgRoot, "build/index.html");
const hasBuild = existsSync(buildIndex);

describe.runIf(hasBuild)("PWA manifest artifact (audit U6) — built output", () => {
  const index = hasBuild ? read("build/index.html") : "";

  it("built index.html links the manifest at the same base as the favicon", () => {
    const manifestHref = index.match(/<link\s+rel="manifest"\s+href="([^"]+)"/)?.[1];
    const faviconHref = index.match(/<link\s+rel="icon"\s+href="([^"]+)"/)?.[1];
    expect(manifestHref, "no manifest link in built index.html").toBeTruthy();
    expect(manifestHref!.endsWith("manifest.webmanifest")).toBe(true);
    // Base-path consistency: the manifest lives beside the favicon.
    const base = (s: string) => s.slice(0, s.lastIndexOf("/"));
    expect(base(manifestHref!)).toBe(base(faviconHref!));
  });

  it("the built manifest has scope, start_url, and icons that exist on disk", () => {
    const manifest = JSON.parse(read("build/manifest.webmanifest")) as {
      start_url?: string;
      scope?: string;
      icons?: { src: string }[];
    };
    expect(manifest.start_url).toBe("./");
    expect(manifest.scope).toBe("./");
    expect(manifest.icons?.length).toBeGreaterThanOrEqual(2);
    for (const icon of manifest.icons ?? []) {
      expect(existsSync(resolve(pkgRoot, "build", icon.src)), `missing icon ${icon.src}`).toBe(true);
    }
  });

  it("the service worker precaches the shell + manifest and registers navigation", () => {
    const sw = read("build/sw.js");
    expect(sw).toMatch(/manifest\.webmanifest/);
    expect(sw).toMatch(/index\.html/);
    expect(sw).toMatch(/NavigationRoute/);
  });
});
