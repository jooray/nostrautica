import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    // Static-only output with a single SPA fallback (spec §10.1). Hash routing
    // means every deep link resolves inside this one fallback page — which is
    // exactly what nsite's 404-status fallback requires.
    adapter: adapter({
      fallback: "index.html",
      precompress: false,
      strict: false,
    }),
    // No server routes; everything is client-side hash routing.
    prerender: { entries: [] },
    // Deep links like /#/e/... never hit the server; a single fallback covers all.
    // BASE_PATH lets the same artifact serve from a subdirectory (e.g.
    // https://host/app/) — assets resolve under that prefix.
    paths: { base: process.env.BASE_PATH || "", relative: true },
  },
};

export default config;
