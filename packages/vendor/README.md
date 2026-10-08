# Vendored dependencies

These are **committed, pre-built** copies of third-party packages that cannot be consumed
from npm as-is. They exist so `pnpm install --frozen-lockfile` (used by the deploy hook) and
the app/coordinator builds work from the committed files alone — no git submodule init, no
extra build step at install time.

See `docs/MARMOT-GROUP-CHAT.md`, "Library: vendored marmot-ts and the 0x8009 flag day".

## Packages

- **`marmot-ts/`** — `@internet-privacy/marmot-ts`, built from
  [`jooray/marmot-ts`](https://github.com/jooray/marmot-ts) branch **`nostrautica-vendor`**:
  upstream `marmot-protocol/marmot-ts` master plus the upstream PRs we need that have not
  merged yet. The exact commit (and the bundled ts-mls commit) is recorded in
  `marmot-ts/package.json` under `"vendoredFrom"` — that field, not this README, is the pin.
  At the time of writing: `0ab8336` = upstream master `71999f56` + our 22 open interop PRs,
  `#81`, `#83`–`#99` and `#101`–`#104` (every one except third-party work). PR `#82` is not
  carried: upstream fixed the same problem in `7b59a722`/`162239da` — GREASE ids stay in the
  `mls_proposals` tag, tag and leaf must match exactly at invite/eligibility, and the
  GREASE-stripped tags older builds publish stay accepted as a legacy mode — and this branch
  keeps our `key-package-event-validate` tag check in lockstep with upstream's
  `checkKeyPackageProposalsTag` so GREASE-carrying tags pass both. The pre-rebase tip is kept
  as branch `nostrautica-vendor-pre-71999f56` on the fork. The PRs came from a
  message-by-message comparison against MDK 0.11.0 and HEAD and cover AppDataUpdate
  extension order, KeyPackage tags/last-resort/relays, encrypted media v2 (0x800b) and
  the group image (0x8002), strict app-event and kind-445 decoding, past-epoch message
  retention, Welcome/join and commit-legality checks that match MDK, and fork ranking. The PR
  list is `gh pr list --repo marmot-protocol/marmot-ts --author jooray`.

  This generation produces the **current Marmot profile**: KeyPackages and leaves carry the
  `marmot.member.account-identity-proof.v2` component (**0x8009**, a kind-450 event signed by
  the client's own `signEvent`), and groups are classified by that profile. That is what
  White Noise / MDK (0.11+) require, and it is NOT wire-compatible with the previous vendored
  0.6.0 (`2f60dbb`), which emitted the legacy 0xF2F1 proof. Groups and KeyPackages from that
  generation are retired on upgrade (see that MARMOT-GROUP-CHAT section).

  Upstream's build bundles its ts-mls fork (`hzrd149/ts-mls`, a git submodule) into
  `lib/vendor/ts-mls` with specifiers rewritten, so there is no separate ts-mls package any
  more: import MLS types/primitives from `@internet-privacy/marmot-ts/mls`.

Pure TypeScript (no WASM). All *other* dependencies (`@noble/*`, `@hpke/*`, `@scure/base`,
`applesauce-*`, `@noble/post-quantum`, …) are ordinary published packages resolved normally.
`marmot-ts/package.json` declares upstream's optional crypto peers as real dependencies
(the bundled ts-mls imports them dynamically) plus `@hpke/dhkem-x25519` for our X25519 patch.

## Re-vendoring (one command)

```sh
node scripts/vendor-marmot.mjs                          # jooray/marmot-ts@nostrautica-vendor
node scripts/vendor-marmot.mjs --ref <branch|tag|sha>
node scripts/vendor-marmot.mjs --repo <url> --ref <ref>
node scripts/vendor-marmot.mjs --src <clean local checkout>
```

It clones (with the `ts-mls` submodule), runs upstream's `pnpm install --frozen-lockfile` +
`pnpm run build`, replaces `marmot-ts/lib` with the build (no sourcemaps), applies every
`patches/*.patch` (failing if one does not apply), regenerates `marmot-ts/package.json`
(exports rewritten to `lib/`, the `vendoredFrom` pin), copies both upstream `LICENSE` files,
rewrites `INTEGRITY.sha256`, and runs `pnpm install`. Then read
`git diff --stat packages/vendor`, run `pnpm check` and the chat e2e tier, and commit.

Treat every bump as a mini-audit (marmot-ts is alpha; ts-mls is a from-scratch TS MLS), and
check `docs/MARMOT-GROUP-CHAT.md` if the bump changes the wire profile again.

## Carried patches (`patches/`, applied by the script)

Grep for `NOSTRAUTICA PATCH` to find them in `lib/`:

- **`0001-ts-mls-ed25519-webcrypto-probe.patch`** —
  `lib/vendor/ts-mls/crypto/implementation/default/makeNobleSignatureImpl.js`: the Ed25519
  WebCrypto path is gated on a real capability probe, not on `crypto.subtle` existing.
  Upstream chooses WebCrypto whenever `subtle` is defined, but Chromium/WebView < 137
  (Firefox < 129, Safari < 17) has WebCrypto without Ed25519 and throws
  `Algorithm: Unrecognized name`, making MLS key-package creation impossible on those
  browsers. The patch probes (`importKey` of a raw public key) and falls through to the
  existing pure-JS `@noble/curves` branch when unsupported.
- **`0002-ts-mls-x25519-webcrypto-probe.patch`** —
  `lib/vendor/ts-mls/crypto/implementation/default/makeDhKem.js`: same class of fix for the
  X25519 KEM (WebCrypto-only upstream; unsupported in Chromium/WebView < 133): probe, then
  fall back to the pure-JS `@hpke/dhkem-x25519`.

Regression coverage: `packages/app/src/lib/chat/mls-crypto-fallback.test.ts` (stubs
`crypto.subtle` to reject both algorithm names; fails if either fallback is lost).

When upstream changes one of these files the patch stops applying and the script fails;
regenerate the patch against the new upstream file (`diff -u`) rather than hand-editing `lib/`.

## Layout conventions

- Built JS + `.d.ts` live under **`lib/`**, not `dist/` — the repo `.gitignore` excludes
  `dist/` at every level, so a `dist/` here would be silently untracked.
- Only upstream's export map is exposed (`.`, `./mls`, `./client`, `./core`, `./engine`,
  `./audit`, `./extra`, `./utils`). There is no `./lib/*` deep-import escape hatch any more:
  the proposal builders the coordinator needs are exported as `Proposals` from `./client`.
- The package is `private` and joined to the workspace via `pnpm-workspace.yaml`
  (`packages/vendor/*`). `app`/`coordinator` depend on `@internet-privacy/marmot-ts:
  workspace:*`.

## Integrity manifest

`INTEGRITY.sha256` records a SHA-256 for every file under `marmot-ts/lib/`, and
`node scripts/vendor-manifest.mjs --check` runs in the release gate.

This does **not** prove the bytes match an upstream build. The re-vendor script makes the
build repeatable from a pinned commit, but the output still depends on the toolchain
upstream's lockfile resolves, so it is not byte-reproducible across machines. What the
manifest does is make a change to these bytes impossible to land unnoticed — this is the
MLS engine and the Marmot layer over it, committed as ~480 files of built output, the single
most valuable place to hide something and the least likely directory to be read in review.

`vendor-marmot.mjs` rewrites the manifest itself. A `--check` failure in CI outside a
deliberate re-vendor is a change nobody announced: read the diff before anything else.

## Licences

`marmot-ts/LICENSE` (marmot-ts) and `marmot-ts/lib/vendor/ts-mls/LICENSE` (ts-mls) are copied
from the upstream repositories at the vendored commit by the re-vendor script.
