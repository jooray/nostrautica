# Versioning and Release Policy

Nostrautica keeps **independent package versions** bound together at deploy time by
a **release manifest** (audit §13.9, Option B). Package versions carry semantic
meaning per package; the manifest is what ties one deployed set of artifacts to a
single product release.

## The versions and how they bump

| Field | Source | Bump when |
|---|---|---|
| Product release | `package.json` (root) `version` + the git tag/SHA | Any deploy: it labels the release, not any one package. |
| `@nostrautica/app` | `packages/app/package.json` | The PWA changes (UI, client logic, service worker). Also the SW-precache input. |
| `@nostrautica/protocol` | `packages/protocol/package.json` | The shared protocol **package API** (types/schemas/helpers) changes. |
| `@nostrautica/coordinator` | `packages/coordinator/package.json` | The coordinator **package API/behavior** changes. |
| Android `versionName` | `android/app/build.gradle.kts` | Every Android release. Must equal the root `version`: `assembleRelease` fails otherwise. |
| Android `versionCode` | `android/app/build.gradle.kts` | Every Android release, above the last `android-v*` GitHub release's (Android and Zapstore refuse an equal or lower one). `android/tools/release-check.sh` enforces it. |
| Wire protocol `v` | `PROTOCOL_VERSION` in `packages/protocol/src/schemas.ts` | The **on-the-wire payload contract** changes. This is deliberately separate: package versions can move without a wire change, and a wire change is a compatibility event for every peer. Currently `2`. |
| Store schema | `SCHEMA_VERSION` in `packages/coordinator/src/store/db.ts` | The coordinator's durable SQLite shape changes in a way a downgrade can't tolerate (drives the open-time and backup/restore downgrade guards). Bumped at every downgrade-incompatible boundary via a numbered migration (see below). Currently `7`. |

Do **not** infer compatibility from equal or unequal package versions. Compatibility
is defined by the wire protocol version (and the protocol registry,
`docs/PROTOCOL-REGISTRY.md`) and by the specific tested release commit: never by a
package number.

## Store schema migrations (`SCHEMA_VERSION`)

The coordinator's SQLite schema uses a **numbered, ordered migration model** (audit
O3). It has two parts:

- **Baseline DDL** runs unconditionally on every read-write open. Every statement is
  idempotent (`CREATE TABLE IF NOT EXISTS`, `ALTER … ADD COLUMN` guarded against
  "column exists"), so it brings *any* historical database up to full column
  completeness regardless of exactly which columns a past binary had added. This
  matters because many pre-v2 databases were all stamped `user_version = 1` with
  differing column sets.
- **Numbered migrations** carry the downgrade-incompatible boundaries. Each runs in a
  single transaction and advances `PRAGMA user_version` at its boundary.

The boundaries so far (`MIGRATIONS` in `db.ts`): keep this list in step with the
code, because it is what an operator reads before deciding a rollback is safe:

| `user_version` | Migration | What it changes |
|---|---|---|
| `2` | `applyRemediationDDL` | Adds the audit C3/C5 tables: inbound rate accounting, and the reference-count tables retention deletion needs. The first downgrade-incompatible boundary. |
| `3` | `applyMembershipSubjectMerge` | Re-keys `command_watermarks`: the separate `pubkey:` and `withdraw:` subject namespaces merge into one membership subject, so an approve and a withdrawal for the same person are ordered against each other instead of in parallel. |
| `4` | `applyArtifactLegacyQuarantine` | Adds `pipeline_artifacts.quarantined_at` and stamps every artifact that no `artifact_refs` row owns, so pre-ownership artifacts can be garbage-collected after a grace window instead of growing forever. |
| `5` | `applyInviteUsagePerRedeemer` | Re-keys `invite_usage` on `(coordinate, invite_pubkey, used_by)` so a reusable invite code records one row per redeemer. Required by the `uses`/`exp` invite fields. |
| `6` | `applyDetachedEventsLedger` | Adds `detached_events`, the purge ledger for detached events (audit SB-16): a detach records when the event's attendee data falls due (its retention deadline, the next sweep if that has passed, or 7 days out if it has none), and the retention sweep purges it then. A version boundary although it only adds a table: an older binary would re-install an event without clearing its row. The migration also backfills a row, due 7 days after it runs, for every coordinate that still holds attendee data but has no `events` row (events detached before v6). |
| `7` | `applyMemberRevocations` | Adds `member_revocations`, the durable organizer-revocation tombstone (audit 2026-10-22, R-01). `attendees.status = 'revoked'` was the only record of a removal and the join handler's own enrollment upsert overwrote it with `pending`, so a removed member could re-admit themselves with their original invite code or `member_of` proof and receive the ECK version minted to exclude them. The tombstone is written by an organizer revoke, cleared only by an organizer approve, kept across the member's own `delete_data` purge (so withdrawing cannot launder a revocation), and deleted with the event. Backfills every row already at `status = 'revoked'` — which includes past self-withdrawals, so those members now need an organizer approve to return. A version boundary because an older binary would ignore the table and reopen the hole. |

Adding a migration means: append to `MIGRATIONS`, bump `SCHEMA_VERSION`, and add a
row above. A migration is **one-way**: once applied, no older binary will open the
file (see the refusal below), so take the backup first (operator guide §7).

The open path **refuses** a database whose `user_version` is greater than the binary's
`SCHEMA_VERSION` (a database written by a newer coordinator), with a clear operator
message to upgrade the coordinator first. From v2 onward the same refusal applies at
`Store` open **and** at backup verify/restore (`schemaTooNew`): an older binary can no
longer silently open or restore a database a newer binary has migrated. The residual
risk that a *pre-remediation* (pre-v2) binary rewrites the marker back to `1` is
inherent to those old binaries and unfixable from here; the operational rule is simply
**do not run superseded binaries against a migrated database**. Take the pre-upgrade
backup (operator guide §7) so a rollback restores a schema the old binary accepts.

## The release manifest

`scripts/release-manifest.mjs` computes a JSON manifest at build time:

```json
{
  "releaseId": "<see the fallback chain below>",
  "swRevision": "<releaseId>+<12-char sha>",
  "gitSha": "<full commit sha>",
  "appVersion": "…", "protocolVersion": "…", "coordinatorVersion": "…",
  "wireProtocolVersion": 2,
  "basePath": "/app",
  "buildTimestamp": "<git commit time ISO, or build time>"
}
```

`releaseId` is the first of these that is non-empty:

1. `NOSTRAUTICA_RELEASE_ID`, an explicit override.
2. `git describe --tags --always --dirty`, or without `--dirty` when there is no
   work tree. On a tagged commit this is the bare tag name (`v0.12.0`).
3. The first 12 characters of the commit SHA. This rung matters: the production
   build runs in the deploy hook with `GIT_DIR` pointing at a bare repo, where the
   `--dirty` form fails. Before this rung existed the chain fell straight to the
   package version, every deploy got the same id, and installed PWAs stayed on a
   four-day-old shell (2026-07-28). Do not remove it.
4. `v<root package version>`, when there is no git at all.

- **PWA:** `packages/app/vite.config.ts` embeds it via a `__RELEASE_MANIFEST__`
  define (read through `src/lib/release.ts`). It is shown in **Settings → About** and
  logged once to the console at startup (`nostrautica <releaseId> …`).
- **Coordinator:** `packages/coordinator/src/release.ts` computes it at startup,
  logs it (`[coordinator] nostrautica-coordinator <releaseId> …`), and appends the
  release id to its kind-31611 announcement's `about` text (the announce wire schema
  has no version field, so this is the natural place: the schema is unchanged).
- **Backups:** every `backup` snapshot's `.meta.json` records the release id.

`NOSTRAUTICA_RELEASE_ID` overrides the computed id: set it in the coordinator's
service environment on a host that runs from rsync'd source without `.git`, so the
logged/announced id is the real release rather than the `v<pkg>` fallback.
`NOSTRAUTICA_BUILD_TIMESTAMP` similarly pins the timestamp.

## Reproducible service-worker revision

The PWA's service-worker precache revision for the shell is `releaseManifest.swRevision`,
**not** `Date.now()` and **not** `releaseId` on its own. It is `releaseId` followed by
`+` and the 12-character commit SHA (just the SHA when `releaseId` already is one).
The same commit + `BASE_PATH` therefore builds the **same** revision (a rebuild no
longer looks like a new release), while every commit changes it, which is what
drives the auto-update + refresh mechanism.

The SHA suffix is what makes it per-commit. `releaseId` on a tagged commit is the
bare tag name, so a release re-cut under the same version (`git tag -f vX.Y.Z` onto
a fixed commit) would otherwise produce a byte-identical `sw.js`, and installed PWAs
would never pick up the fix. With no git at all, `swRevision` falls back to
`v<pkg>+build-<build time>`: not reproducible, but never constant, and the build log
warns. `scripts/release-manifest.test.mjs` pins all of this and runs in `pnpm test`.

## Where to find the deployed revision

- **App:** open Settings → About, or read the startup console line, or inspect the
  service worker's precache entry for `index.html` (`revision` = `swRevision`). The
  last one works from outside, and names the exact commit that is live:

  ```sh
  curl -s https://<host>/app/sw.js | grep -oE 'index.html",revision:"[^"]*"'
  ```

  `/_app/version.json` is SvelteKit's own build timestamp, not the release. It
  changes when *a* build lands (and on a no-op rebuild), but it cannot tell you
  which one.
- **Coordinator:** the startup log line, `doctor`'s header line, or the `about` field
  of its kind-31611 announcement.

For a release record, capture the git commit/tag, the release manifest (from either
diagnostic surface), the deployed app URL, and the coordinator revision together.
