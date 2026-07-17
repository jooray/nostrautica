# Deploying the Nostrautica PWA

The app builds to fully static output (`packages/app/build/`). Two deploy targets,
same artifact (spec §11).

## Primary: nsite (the site itself hosted on Nostr + Blossom)

Uses [`nsyte`](https://github.com/sandwichfarm/nsyte) to publish the build as an
nsite (NIP-5A: kinds 15128/35128 manifest + blobs to Blossom).

```sh
pnpm --filter @nostrautica/app build
npx nsyte deploy packages/app/build \
  --fallback /index.html \
  --relays wss://relay.primal.net,wss://relay.damus.io,wss://nos.lol
```

`--fallback /index.html` publishes the SPA fallback that nsite gateways serve
(with HTTP status 404 — which is exactly why the app uses hash routing, spec
§10.1). CI signs with a NIP-46 bunker key held in a CI secret:

```sh
npx nsyte deploy packages/app/build --fallback /index.html \
  --bunker "$NSYTE_BUNKER_URI"
```

## Mirror: conventional static host (Netlify / Cloudflare / nginx)

Serve `packages/app/build/` as static files. Header policy (spec §10.2):

- `sw.js`, `index.html`, `manifest.webmanifest` → `Cache-Control: no-cache`
- `/_app/immutable/*` (hashed assets) → `Cache-Control: public, max-age=31536000, immutable`

The service worker's `autoUpdate` + periodic/visibilitychange checks keep clients
current within one update-check interval regardless of host.
