// SPA mode: no SSR, no prerender — a single static fallback page served for
// every path, with client-side hash routing on top (spec §10.1).
export const ssr = false;
export const prerender = false;
export const trailingSlash = "ignore";
