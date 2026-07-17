import { sveltekit } from "@sveltejs/kit/vite";
import { SvelteKitPWA } from "@vite-pwa/sveltekit";
import { defineConfig } from "vitest/config";
import { createRequire } from "node:module";

const pkg = createRequire(import.meta.url)("./package.json") as { version: string };

export default defineConfig({
  plugins: [
    sveltekit(),
    // Never stuck on an old version (spec §10.2): autoUpdate sets skipWaiting +
    // clientsClaim; cleanupOutdatedCaches drops stale precaches. The periodic
    // + visibilitychange update checks are wired in the client registration.
    SvelteKitPWA({
      registerType: "autoUpdate",
      workbox: {
        cleanupOutdatedCaches: true,
        globPatterns: ["**/*.{js,css,html,ico,png,svg,webmanifest,woff2}"],
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
            revision: `${pkg.version}-${Date.now()}`,
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
