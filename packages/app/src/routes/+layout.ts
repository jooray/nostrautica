// SPA mode: no SSR, no prerender — a single static fallback page served for
// every path, with client-side hash routing on top (spec §10.1).
export const ssr = false;
export const prerender = false;
export const trailingSlash = "ignore";

// Packaging gate (Phase 2): a lazy loader for the Marmot chat module. Keeping the
// dynamic import() here forces Vite to emit the marmot-ts chunk during the
// production build, proving the vendored library bundles. Only ever invoked on an
// event with `chat=marmot`, so chat-off events never download it.
export const loadMarmotProbe = () => import("$lib/chat/marmot-probe");
