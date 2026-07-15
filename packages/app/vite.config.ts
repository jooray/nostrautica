import { sveltekit } from "@sveltejs/kit/vite";
import { SvelteKitPWA } from "@vite-pwa/sveltekit";
import { defineConfig } from "vitest/config";

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
        // Base-aware SPA navigation fallback. After BASE_PATH moved the app under
        // /app, the default `/` is no longer in the precache (every entry is
        // /app/…), so workbox threw `non-precached-url: /` when binding the nav
        // handler. Point it at the precached base index (directoryIndex resolves
        // /app/ → /app/index.html).
        navigateFallback: (process.env.BASE_PATH || "") + "/",
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
