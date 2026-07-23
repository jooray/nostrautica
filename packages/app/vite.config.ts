import { sveltekit } from "@sveltejs/kit/vite";
import { SvelteKitPWA } from "@vite-pwa/sveltekit";
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { computeReleaseManifest } from "../../scripts/release-manifest.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// The release manifest (§13.9): git identity + package/wire versions + BASE_PATH,
// computed once at build. `releaseId` is deterministic per commit, so it drives a
// reproducible service-worker revision (below) instead of the old Date.now().
const releaseManifest = computeReleaseManifest({ repoRoot, basePath: process.env.BASE_PATH || "" });

export default defineConfig({
  define: {
    __RELEASE_MANIFEST__: JSON.stringify(releaseManifest),
  },
  plugins: [
    sveltekit(),
    // Never stuck on an old version (spec §10.2): autoUpdate sets skipWaiting +
    // clientsClaim; cleanupOutdatedCaches drops stale precaches. The periodic
    // + visibilitychange update checks are wired in the client registration.
    SvelteKitPWA({
      registerType: "autoUpdate",
      workbox: {
        cleanupOutdatedCaches: true,
        // Precache only the shell + static assets, NOT every JS/CSS chunk (audit
        // §7.4.2). The old glob precached all 30+ content-hashed route chunks
        // (~1.9 MB) on install — including admin/settings/chat/editor code most
        // visitors never open. Route chunks are content-hashed and immutable, so
        // a CacheFirst runtimeCaching rule (below) caches each one the first time
        // it's actually fetched and never serves it stale (a new deploy = a new
        // hash = a cache miss = a fresh fetch). The shell's precached index.html
        // still carries a per-build revision, so its manifest change is what
        // drives the service worker update + auto-refresh — that mechanism is
        // unchanged, only the precache payload shrank.
        // MUST be a `client/`-prefixed pattern: @vite-pwa/sveltekit appends its
        // own `client/**/*.{js,css,...}` default (precaching everything) UNLESS
        // our patterns already include a `client/` entry — so listing only the
        // static shell assets here is what actually keeps the route JS/CSS OUT of
        // the precache. Those are runtime-cached by the rule below.
        globPatterns: ["client/**/*.{ico,png,svg,webmanifest,woff2}"],
        runtimeCaching: [
          {
            // Content-hashed app chunks — safe to cache-first (immutable URLs).
            urlPattern: ({ url }: { url: URL }) => url.pathname.includes("/_app/immutable/"),
            handler: "CacheFirst",
            options: {
              cacheName: "app-immutable",
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
        // SPA navigation fallback. adapter-static writes the fallback index.html
        // only into `build/`, but the SW is generated from the client output
        // (which has NO html), so the plugin never precaches the shell — yet it
        // still registers a NavigationRoute to it. That mismatch threw
        // `non-precached-url` at SW load, aborting the whole service worker
        // (prod console 2026-07-17). Explicitly precache the shell and point the
        // fallback at it so `createHandlerBoundToURL` resolves and the SW
        // installs. We precache the explicit `index.html` FILE (not the bare
        // "<base>/" directory): it's a real 200 blob on BOTH deploy targets —
        // nginx and nsite — whereas nsite only serves its SPA fallback for
        // unknown deep paths with a 404 (which a precache fetch would reject),
        // and "<base>/" directory-indexing isn't guaranteed. The per-build
        // `revision` refreshes the shell on deploy (drives auto-update).
        navigateFallback: (process.env.BASE_PATH || "") + "/index.html",
        additionalManifestEntries: [
          {
            url: (process.env.BASE_PATH || "") + "/index.html",
            // Reproducible per commit (§13.9): the same commit + BASE_PATH builds
            // the same revision, and every release changes it. Replaces the old
            // `${pkg.version}-${Date.now()}`, which changed on every rebuild.
            revision: releaseManifest.releaseId,
          },
        ],
      },
      manifest: {
        name: "Nostrautica",
        short_name: "Nostrautica",
        description: "Meet the right people at events — Nostr-native matchmaking.",
        theme_color: "#0b0b12",
        background_color: "#0b0b12",
        display: "standalone",
        start_url: "./",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
        ],
      },
    }),
  ],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
