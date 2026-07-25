# Deployment

This document separates supported deployment modes. They use the same static PWA artifact but do not offer the same HTTP-header or operational guarantees.

## PWA Modes

### nsite reference workflow

`.github/workflows/deploy.yml` builds tagged releases and publishes with `nsyte` using a NIP-46 bunker capability. This is a reference Nostr-native delivery path. It uses an SPA fallback and hash routing.

nsite gateways control their response headers. They cannot be assumed to provide the same CSP, anti-framing, cache-control, or other HTTP-header policy as a conventional host. Treat nsite as a delivery option, not as equivalent to a configured web origin.

### Conventional static host

Serve `packages/app/build/` from a configured static host such as nginx, Cloudflare Pages, or Netlify. This is the appropriate mode when the operator needs explicit response headers.

- `sw.js`, `index.html`, and `manifest.webmanifest`: `Cache-Control: no-cache`.
- Hashed immutable assets: long-lived immutable cache control.
- Send CSP and `frame-ancestors` as HTTP headers where supported. A meta CSP cannot enforce anti-framing.
- Verify the service worker update path after every deploy; users must not need a hard refresh.

## Coordinator

The Dockerfile and systemd unit are reference deployment material, not a complete production runbook. The coordinator needs Node 22.5+, ffmpeg/ffprobe, protected provider credentials, a stable coordinator identity, relay connectivity, and durable writable SQLite storage.

The SQLite volume is not disposable when Marmot chat or Cashu is enabled. See [COORDINATOR-OPERATOR-GUIDE.md](COORDINATOR-OPERATOR-GUIDE.md) for backup, restore, lifecycle, and operational limitations.

## Reference Production Instance

The public reference instance is an operator-managed conventional static host plus coordinator deployment. Its host-specific commands, identities, and secrets are intentionally private and are not a portable deployment recipe. Do not assume that its deployment mechanics or HTTP headers apply to an nsite deployment.

## Release Verification

1. Run `pnpm check`.
2. Build the PWA and run a **clean-context coordinator Docker build** — it must succeed from a checkout with no working-tree state:

   ```sh
   rel="$(git describe --tags --always --dirty)"; sha="$(git rev-parse HEAD)"; ts="$(git show -s --format=%cI HEAD)"
   git archive HEAD | (mkdir -p /tmp/cc && tar -x -C /tmp/cc)
   docker build -f docker/coordinator.Dockerfile \
     --build-arg RELEASE_ID="$rel" --build-arg GIT_SHA="$sha" --build-arg BUILD_TIMESTAMP="$ts" \
     /tmp/cc
   ```

   The image's dependency layer copies the lockfile, `patches/`, and the vendored Marmot/MLS workspace packages before `pnpm install --frozen-lockfile`, and pins the base image by digest, so this build is reproducible from a clean checkout. Keep it in the release gate. A `git archive` checkout has no `.git`, so the coordinator's own git-describe provenance is unavailable inside the container — pass the `RELEASE_ID`/`GIT_SHA`/`BUILD_TIMESTAMP` build args (as above) so the running daemon reports the real release instead of `v<pkg>` / `gitSha: unknown`. OCI image labels (`org.opencontainers.image.*`) are set from the same args.
3. Verify app and landing HTTP status, CSP/header policy for the chosen host, and service-worker update behavior.
4. Exercise an event flow appropriate to the release: join, approval, media where applicable, and coordinator health.
5. Record the Git revision and deployed app/coordinator versions.
