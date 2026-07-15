# Vendored dependencies

These are **committed, pre-built** copies of third-party packages that cannot be consumed
from npm as-is. They exist so `pnpm install --frozen-lockfile` (used by the deploy hook) and
the app/coordinator builds work from the committed files alone — no git submodule init, no
extra build step at install time.

See `docs/MARMOT-GROUP-CHAT.md` §2.1 for the full decision record.

## Packages

- **`marmot-ts/`** — `@internet-privacy/marmot-ts` v0.6.0, the built output of
  `marmot-protocol/marmot-ts` master @ `2f60dbb`. This is the version that emits the current
  Marmot v2 wire format (kind **30443**) and carries the mandatory
  `marmot.account-identity-proof.v1` leaf needed for Whitenoise/MDK interop. The npm-published
  `0.5.1` lacks that leaf; 0.6.0 is only published via a git submodule + unpublished ts-mls
  fork, which the deploy hook cannot resolve — hence vendoring.
- **`ts-mls/`** — `ts-mls` @ `hzrd149/ts-mls` commit `2ca5c43` (branch `marmot-required-ext`,
  v2.0.0-rc.14), the MLS engine 0.6.0 depends on via a `./ts-mls` path dep. Not published to
  npm on this branch.

Both are pure TypeScript (no WASM). All *other* dependencies (`@noble/*`, `@hpke/*`,
`@scure/base`, `applesauce-*`, `@noble/post-quantum`, …) are ordinary published packages
resolved normally; only these two are vendored.

## Layout conventions

- Built JS + `.d.ts` live under **`lib/`**, not `dist/` — the repo `.gitignore` excludes
  `dist/` at every level, so a `dist/` here would be silently untracked. The `exports` maps
  in each `package.json` point at `lib/`. Sourcemaps and `.tsbuildinfo` are stripped.
- `marmot-ts/package.json` adds a `"./lib/*": "./lib/*"` wildcard export so symbols upstream
  forgot to export (e.g. `proposeRemoveUser`) can be deep-imported. Prefer named exports;
  the wildcard is the escape hatch.
- Each package is `private` and joined to the workspace via `pnpm-workspace.yaml`
  (`packages/vendor/*`). `app`/`coordinator` depend on `@internet-privacy/marmot-ts:
  workspace:*`.

## Regenerating (when bumping the vendored version)

```sh
git clone https://github.com/marmot-protocol/marmot-ts.git
cd marmot-ts
git submodule update --init ts-mls          # pinned fork commit
pnpm install --ignore-scripts
pnpm --filter ts-mls build                  # → ts-mls/dist/src
pnpm run build                              # → dist
# then copy dist → packages/vendor/marmot-ts/lib and
#      ts-mls/dist/src → packages/vendor/ts-mls/lib (drop *.map, *.tsbuildinfo),
# re-check the exports maps and the dependency versions in each package.json,
# and re-run: pnpm install && pnpm --filter @nostrautica/app build
```

Treat every bump as a mini-audit (marmot-ts is alpha; ts-mls is a from-scratch TS MLS).
