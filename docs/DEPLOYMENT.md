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

Three nginx specifics, each of which bit the reference deployment:

- **`manifest.webmanifest` needs an explicit content type.** nginx's stock
  `mime.types` has no `webmanifest` entry, so it goes out as
  `application/octet-stream`, which is a documented cause of a PWA refusing to
  install. Force it per-location with an EMPTY `types { }` block plus
  `default_type application/manifest+json`, an empty block avoids replacing the
  inherited type map for anything else.
- **Never use `add_header` in one of these locations.** nginx drops every
  INHERITED `add_header` at any level that defines its own, so a single
  `add_header Cache-Control …` silently strips HSTS, `X-Frame-Options`,
  `X-Content-Type-Options` and `Referrer-Policy` from the site-wide security
  snippet for those responses. Use the `expires` directive, which does not have
  this effect. The cost is that you cannot add the `immutable` cache hint; a long
  `max-age` on content-hashed filenames is the right trade.
- **An exact-match location outranks a regex one** regardless of file order,
  which is what keeps a generic `\.(js|css|…)$` rule from putting `expires 1d` on
  `sw.js` and letting browsers answer their own update checks from cache.

## Coordinator

### Log rotation

`packages/coordinator/nostrautica-coordinator.logrotate` is the reference
logrotate fragment; install it as `/etc/logrotate.d/nostrautica-coordinator`.

It uses `copytruncate`, and that is not optional: the systemd unit writes with
`StandardOutput=append:`, which holds the file open for the life of the process
and never reopens it, so a rename-based rotation would leave the daemon writing
to an unlinked inode and the live log would silently stop growing. The daemon's
stdout descriptor carries `O_APPEND`, so after truncation its next write goes to
offset 0 rather than leaving a large sparse hole.

Without this the log simply grows forever, the reference deployment reached
~37 MB over seven weeks before anyone looked, on a filesystem shared with other
services. Note that `restart-coordinator.sh` greps this exact path for the
daemon's readiness marker, so the path must stay stable, and a rotation landing
inside a deploy's readiness window can make that grep miss.

### Startup time

`restart-coordinator.sh` waits for the daemon's own readiness line
(`watching for installs, submissions, admin commands`) and reports how long it
took. Two thresholds, doing different jobs:

| | default | override | on breach |
|---|---|---|---|
| soft | 60 s | `COORDINATOR_READY_WARN` | prints a warning, deploy still succeeds |
| hard | 240 s | `COORDINATOR_READY_TIMEOUT` | fails the deploy step |

The hard limit is deliberately far above anything normal. It does **not** bound a
crash (the readiness loop fails within a second when the unit goes inactive,
whatever the limit is). It bounds a daemon that is alive and never becomes ready.
A limit set too *short* is the worse failure: the script does not kill anything,
so the daemon starts normally while the deploy prints "coordinator is NOT
running" and sends whoever pushed into an incident that is not happening.

The soft threshold is the part worth watching. The limit was 45 s until a
2026-09-04 deploy came in at 44 s, which is not a margin.

**What actually drives it is per-event startup work, not inbox backfill.** That
correction is worth stating plainly, because this section previously blamed the
coordinator's own inbox backfill growing with the daemon's wrap history (98
wraps on one boot, 153 two months later) and told you to go read the `[boot] …
backfill` counts. A 2026-09-10 restart measured 52 s with the wrap count *down*
to 45 — startup rose while the thing it was blamed on fell, so that story cannot
be the explanation.

**You no longer have to reconstruct this from timestamps.** The daemon now times
its own boot and prints the breakdown immediately before the readiness line — so
it is inside the window the deploy measures and cannot flatter it:

```
[boot] ready in 1.2s — 4 event(s); phases:
[boot]   install:config-fetch 1.2s ×4
[boot]   install:chat 1.2s ×4
[boot]   chat:roster-scan 1.2s ×4
[boot]   install:inbox-backfill 1.2s ×4
[boot]   boot:restore-events 0.9s
[boot]   boot:coordinator-inbox 0.3s
```

Phases nest (`install:chat` contains `chat:roster-scan`), so an enclosing phase
legitimately exceeds the sum of the lines under it, and `×N` is the number of
events that phase ran for. When the soft warning fires, read these lines.

#### What the 9–12 s per event was

Measured against a restart with four chat-enabled events of twelve members each,
over a transport charging 300 ms per relay read. (The measurement harness was a
throwaway; what ships is a regression test asserting the *structure* — one read
per roster, several events in flight at once — because a wall-clock assertion in
CI is a flake generator.)

| | before | after |
|---|---|---|
| ready in | 17.2 s | 1.2 s |
| relay reads | 57 | 13 |
| `chat:roster-scan` | 14.5 s (84% of the boot) | 1.2 s |

and at eight events of twenty-five members: **67.9 s → 2.2 s**, 225 relay reads
→ 25. Two things were wrong. The first accounts for most of it (17.2 s → 4.0 s on
its own); the second took the remainder (4.0 s → 1.2 s):

- **The roster scan read key packages one member at a time.** `backfillApproved`
  called `syncMember` per approved attendee and each opened its own kind-30443
  fetch for a single author — so the cost was O(events × members) serialized
  round trips, which is why it grew without ever coming back down. A relay filter
  takes an author list, so the whole roster is now one read; `syncMember` still
  filters the result to its own member's authorized identities, so nobody sees a
  key package they did not see before.
- **Events restored strictly one after another.** They are independent — a
  different inbox, a different MLS group, a different config — so up to
  `RESTORE_CONCURRENCY` (4, in `coordinator.ts`, with the reasoning next to it)
  now restore at once. Four rather than unbounded because every restoring event's
  reads multiplex over the same relay sockets, and a forty-event daemon fanning
  out unbounded would put ~120 concurrent REQs on each one.

Everything genuinely shared was already serialized a layer down and still is:
`node:sqlite` is synchronous, `MarmotClientMls` chains MLS commits per group, and
the roster walk takes the per-member subject lock. The per-member work *within*
one event stays serial on purpose — what is left after the batched read is a
local membership check and, for a member needing repair, an MLS Add, and Adds
against one group serialize anyway (the concurrent-commit hazard), so concurrency
there would buy queueing rather than speed.

The other two costs from the 2026-09-10 measurement are untouched, and are now a
much larger share of a much smaller total: the coordinator-inbox backfill (~5 s
at 45 wraps) and the kind 31611 announce publish (up to ~4.4 s). The announce
remains the cheap lever if one is ever needed: `main.ts` `await`s it between `coordinator.start()`
and the readiness line, and `NostrClient.publish` resolves on the first relay ack
— but when *no* relay acks (all five timed out on that boot) it pays nostr-tools'
full publish timeout before the daemon reports ready. Nothing waits on that
announcement.

To read a real boot:

```sh
ssh <coordinator-host> 'grep -a "\[boot\]" ~/log/nostrautica-coordinator.log | tail -20'
```

If the slowest line is a per-event phase and there are simply more events than
there used to be, the next lever is `RESTORE_CONCURRENCY` — not deferring work
past the readiness line, which only makes the metric lie.

### Runtime

The Dockerfile and systemd unit are reference deployment material, not a complete production runbook. The coordinator needs Node 22.5+, ffmpeg/ffprobe, protected provider credentials, a stable coordinator identity, relay connectivity, and durable writable SQLite storage.

The SQLite volume is not disposable when Marmot chat or Cashu is enabled. See [COORDINATOR-OPERATOR-GUIDE.md](COORDINATOR-OPERATOR-GUIDE.md) for backup, restore, lifecycle, and operational limitations.

## Reference Production Instance

The public reference instance is an operator-managed conventional static host plus coordinator deployment. Its host-specific commands, identities, and secrets are intentionally private and are not a portable deployment recipe. Do not assume that its deployment mechanics or HTTP headers apply to an nsite deployment.

## Release Verification

1. Run `pnpm check`.
2. Build the PWA and run a **clean-context coordinator Docker build**: it must succeed from a checkout with no working-tree state:

   ```sh
   rel="$(git describe --tags --always --dirty)"; sha="$(git rev-parse HEAD)"; ts="$(git show -s --format=%cI HEAD)"
   git archive HEAD | (mkdir -p /tmp/cc && tar -x -C /tmp/cc)
   docker build -f docker/coordinator.Dockerfile \
     --build-arg RELEASE_ID="$rel" --build-arg GIT_SHA="$sha" --build-arg BUILD_TIMESTAMP="$ts" \
     /tmp/cc
   ```

   The image's dependency layer copies the lockfile, `patches/`, and the vendored Marmot/MLS workspace packages before `pnpm install --frozen-lockfile`, and pins the base image by digest, so this build is reproducible from a clean checkout. Keep it in the release gate. A `git archive` checkout has no `.git`, so the coordinator's own git-describe provenance is unavailable inside the container: pass the `RELEASE_ID`/`GIT_SHA`/`BUILD_TIMESTAMP` build args (as above) so the running daemon reports the real release instead of `v<pkg>` / `gitSha: unknown`. OCI image labels (`org.opencontainers.image.*`) are set from the same args.
3. Verify app and landing HTTP status, CSP/header policy for the chosen host, and service-worker update behavior.
4. Exercise an event flow appropriate to the release: join, approval, media where applicable, and coordinator health.
5. Record the Git revision and deployed app/coordinator versions.

## Rollback

Every deployment mechanism in this document is one-directional: it describes how
to ship a newer build and says nothing about getting back to an older one. That
is the wrong shape for an incident, where the decision is usually "put back what
worked" and the time to discover the procedure is not while the site is down.

**Decide first whether the coordinator database has migrated.** This is the only
step that is not reversible by re-deploying code. The store refuses to open a
database whose `user_version` exceeds what the binary knows, so rolling the
coordinator back past a schema bump means restoring a database file, not just an
older build:

```sh
# On the coordinator host — what schema does the live DB carry?
sqlite3 -readonly "$HOME/nostrautica/packages/coordinator/coordinator.sqlite" "PRAGMA user_version;"
# What does the build you want to roll back TO know?
git show <target-ref>:packages/coordinator/src/store/db.ts | grep 'SCHEMA_VERSION ='
```

If the live number is higher, you need the pre-migration backup (the operator
notes' migration checklist takes one before every schema-bumping push, named for
the version it CONTAINS). No backup, no rollback, go forward with a fix instead.

**Static site (landing / `/app` / `/docs`).** The build is a pure function of the
commit, so rolling back is re-deploying the older commit; nothing on the serving
host holds state.

```sh
git push origin <good-sha>:main --force-with-lease
```

`--force-with-lease`, not `--force`: it refuses if someone else has pushed since
you last fetched, which during an incident is exactly the case you cannot afford
to guess about. Then verify the served bundle is the one you meant, using the
marker-grep in the release-verification section above: the OK markers only prove
a build ran.

**Coordinator.** The same push redeploys and restarts it. Two things to check
afterwards, in this order:

```sh
ssh <coordinator-host> 'systemctl --user is-active nostrautica-coordinator;
  systemctl --user show nostrautica-coordinator -p NRestarts --value'
```

`NRestarts` climbing means the daemon is dying and being respawned, with
`Restart=always` that looks identical to "up" from the outside, and a rollback
onto a database it cannot open is one of the ways to get there.

**Restoring a database.** Stop the daemon first: a copy taken or placed while it
holds the WAL is not a consistent database.

```sh
ssh <coordinator-host> 'set -e
  systemctl --user stop nostrautica-coordinator
  DB="$HOME/nostrautica/packages/coordinator/coordinator.sqlite"
  mv "$DB" "$DB.failed-$(date +%Y%m%d-%H%M%S)"   # keep it — it is the only copy of what went wrong
  rm -f "$DB-wal" "$DB-shm"                       # stale WAL/shm belong to the file you just moved
  cp "$HOME/coordinator.sqlite.vN-<timestamp>.bak" "$DB"
  systemctl --user start nostrautica-coordinator'
```

Keep the failed database rather than deleting it. It is the only record of the
state the incident happened in, and a migration that corrupted data is diagnosed
from it, not from the backup that replaced it.

**What a rollback does not undo.** Anything already published to relays (a
roster, a directory entry, a match list, a coordinator status) is out and stays
out; replaceable events can be superseded but not withdrawn, and gift wraps
cannot be recalled at all. Provider spend is likewise spent. So a rollback
restores the code and the local state, not the world's view of what happened,
which is worth saying to an organizer before they ask.
