# Versioning and Release Policy

Nostrautica keeps **independent package versions** bound together at deploy time by
a **release manifest** (audit §13.9, Option B). Package versions carry semantic
meaning per package; the manifest is what ties one deployed set of artifacts to a
single product release.

## The versions and how they bump

| Field | Source | Bump when |
|---|---|---|
| Product release | `package.json` (root) `version` + the git tag/SHA | Any deploy — it labels the release, not any one package. |
| `@nostrautica/app` | `packages/app/package.json` | The PWA changes (UI, client logic, service worker). Also the SW-precache input. |
| `@nostrautica/protocol` | `packages/protocol/package.json` | The shared protocol **package API** (types/schemas/helpers) changes. |
| `@nostrautica/coordinator` | `packages/coordinator/package.json` | The coordinator **package API/behavior** changes. |
| Wire protocol `v` | `PROTOCOL_VERSION` in `packages/protocol/src/schemas.ts` | The **on-the-wire payload contract** changes. This is deliberately separate: package versions can move without a wire change, and a wire change is a compatibility event for every peer. Currently `2`. |
| Store schema | `SCHEMA_VERSION` in `packages/coordinator/src/store/db.ts` | The coordinator's durable SQLite shape changes in a way a downgrade can't tolerate (drives the backup/restore downgrade guard). Currently `1`. |

Do **not** infer compatibility from equal or unequal package versions. Compatibility
is defined by the wire protocol version (and the protocol registry,
`docs/PROTOCOL-REGISTRY.md`) and by the specific tested release commit — never by a
package number.

## The release manifest

`scripts/release-manifest.mjs` computes a JSON manifest at build time:

```json
{
  "releaseId": "<git describe --tags --always --dirty, or v<root pkg>>",
  "gitSha": "<full commit sha>",
  "appVersion": "…", "protocolVersion": "…", "coordinatorVersion": "…",
  "wireProtocolVersion": 2,
  "basePath": "/app",
  "buildTimestamp": "<git commit time ISO, or build time>"
}
```

- **PWA:** `packages/app/vite.config.ts` embeds it via a `__RELEASE_MANIFEST__`
  define (read through `src/lib/release.ts`). It is shown in **Settings → About** and
  logged once to the console at startup (`nostrautica <releaseId> …`).
- **Coordinator:** `packages/coordinator/src/release.ts` computes it at startup,
  logs it (`[coordinator] nostrautica-coordinator <releaseId> …`), and appends the
  release id to its kind-31611 announcement's `about` text (the announce wire schema
  has no version field, so this is the natural place — the schema is unchanged).
- **Backups:** every `backup` snapshot's `.meta.json` records the release id.

`NOSTRAUTICA_RELEASE_ID` overrides the computed id — set it in the coordinator's
service environment on a host that runs from rsync'd source without `.git`, so the
logged/announced id is the real release rather than the `v<pkg>` fallback.
`NOSTRAUTICA_BUILD_TIMESTAMP` similarly pins the timestamp.

## Reproducible service-worker revision

The PWA's service-worker precache revision for the shell is `releaseManifest.releaseId`
(a git identity), **not** `Date.now()`. The same commit + `BASE_PATH` therefore builds
the **same** revision — a rebuild no longer looks like a new release — while every
real release changes it, which is what drives the auto-update + refresh mechanism.

## Where to find the deployed revision

- **App:** open Settings → About, or read the startup console line, or inspect the
  service worker's precache entry for `index.html` (`revision` = release id).
- **Coordinator:** the startup log line, `doctor`'s header line, or the `about` field
  of its kind-31611 announcement.

For a release record, capture the git commit/tag, the release manifest (from either
diagnostic surface), the deployed app URL, and the coordinator revision together.
