# Coordinator Operator Runbook

**Status:** Executable runbook for the current implementation. Every command below
is real; the expected output is what a healthy run prints. This does not remove
the known replay, ordering, billing, and stale-work limitations documented in the
protocol NIP and the audit — it tells you how to run, verify, back up, restore,
upgrade, roll back, and detach the coordinator safely.

The coordinator is a headless Nostr client (`@nostrautica/coordinator`). It has one
binary, `nostrautica-coordinator` (`packages/coordinator/dist/main.js`), which is
both the daemon and the operator CLI:

```
nostrautica-coordinator [coordinator.toml]        # run the daemon (default verb)
nostrautica-coordinator doctor        [--config coordinator.toml]
nostrautica-coordinator backup  <dest> [--config coordinator.toml]
nostrautica-coordinator verify-backup <file> [--config coordinator.toml]
nostrautica-coordinator restore <file> [--force] [--config coordinator.toml]
```

Two environment variables locate runtime state (both optional, with the defaults
shown):

| Variable | Default | Purpose |
|---|---|---|
| `NOSTRAUTICA_COORDINATOR_DB` | `coordinator.sqlite` | SQLite database path |
| `NOSTRAUTICA_COORDINATOR_NSEC` | — | coordinator identity (nsec or hex); or use `identity.ncryptsec_file` in the TOML |

---

## 1. Install

Requirements: Node ≥ 22.5, `ffmpeg` **and** `ffprobe` on `PATH`, `pnpm`.

```sh
git clone <repo> nostrautica && cd nostrautica
pnpm install --frozen-lockfile
pnpm --filter @nostrautica/coordinator build      # emits packages/coordinator/dist/
ffmpeg -version && ffprobe -version               # both must resolve
```

Run under a dedicated unprivileged service account (`nostrautica`), never root.
Keep the identity material, Cashu wallet, provider credentials, and the SQLite
database readable only by that account (`chmod 600`, `chown nostrautica`).

## 2. Provision

Create `coordinator.toml` (see `packages/coordinator/local-test.toml` for the full
shape). Provision the identity **once** and keep it stable — the coordinator's
pubkey is the root of trust every installed event's key custody is encrypted
under, so rotating it strands every event.

```sh
# Generate a stable identity (store the nsec in a secret manager or an
# ncryptsec file referenced by identity.ncryptsec_file):
export NOSTRAUTICA_COORDINATOR_NSEC="nsec1..."
```

Configure only relays and providers you trust with event data. `config` parse
rejects insecure/credential-bearing provider and relay URLs at startup (audit §6.6).

## 3. Verify before starting — `doctor`

`doctor` is read-only: it parses config, loads the identity, integrity-checks the
database, confirms ffmpeg/ffprobe, probes every default relay, and does a
read-only provider auth check. It never publishes, spends, or subscribes. Run it
as an `ExecStartPre` gate and after every config change.

```sh
nostrautica-coordinator doctor --config coordinator.toml
```

Expected output on a healthy host:

```
[doctor] nostrautica-coordinator v0.1.0 (schema v1)
  [ok]   config parse — coordinator.toml
  [ok]   identity load — npub1...
  [ok]   database integrity — 3 event(s), schema v1
  [ok]   protected-row decryption — 3 event row(s) decrypt under the identity
  [ok]   ffmpeg/ffprobe
  [ok]   relays — 4/4 reachable
  [ok]   Venice auth — 104 model(s) listed
[doctor] all checks passed
```

Exit code 0 = all clear; 1 = a check failed (systemd/CI can gate on it). A missing
database on first run is a `[warn]`, not a failure.

## 4. Start (systemd, sandboxed)

The daemon processes attacker-controlled media through ffmpeg, so it MUST run under
the sandboxing and resource limits below (audit §6, item 4). Adjust paths to your
install.

`/etc/systemd/system/nostrautica-coordinator.service`:

```ini
[Unit]
Description=Nostrautica coordinator
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=nostrautica
Group=nostrautica
WorkingDirectory=/home/nostrautica/nostrautica/packages/coordinator
Environment=NOSTRAUTICA_COORDINATOR_DB=/home/nostrautica/state/coordinator.sqlite
EnvironmentFile=/home/nostrautica/state/coordinator.env   # holds NOSTRAUTICA_COORDINATOR_NSEC etc.

# Refuse to start if the environment is unhealthy.
ExecStartPre=/usr/bin/node dist/main.js doctor --config /home/nostrautica/state/coordinator.toml
ExecStart=/usr/bin/node dist/main.js /home/nostrautica/state/coordinator.toml

Restart=on-failure
RestartSec=5
# Graceful drain: the daemon drains the in-flight job (bounded) on the first
# SIGTERM and force-exits on a second. Give the drain room before SIGKILL.
KillSignal=SIGTERM
TimeoutStopSec=45

# ── Sandboxing (audit §6, item 4) ──────────────────────────────────────────
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictNamespaces=true
LockPersonality=true
MemoryDenyWriteExecute=true
# Only the state directory is writable; everything else is read-only.
ReadWritePaths=/home/nostrautica/state
# ── Resource limits ─────────────────────────────────────────────────────────
MemoryMax=2G
TasksMax=256
LimitNOFILE=4096

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now nostrautica-coordinator
journalctl -u nostrautica-coordinator -f
```

Healthy startup logs the identity, per-role provider routes, the single-daemon
lock, and `running — watching for installs, submissions, admin commands`. **Test
ffmpeg under these restrictions before production** — `PrivateTmp` in particular
must not break the audio pipeline (the daemon sweeps its own temp dirs at boot).

A second daemon on the same database fails fast with the single-daemon-lock error
— never run two against one SQLite file.

## 5. Back up — `backup`

The database is more than a cache. Relay-backed records and derived artifacts are
usually reconstructible (at relay/provider cost), but the job/dedupe/invite-claim
records, the Cashu payment journal, and the Marmot `marmot_kv` / group-admin state
are durable operational state whose loss replays work, leaves payments ambiguous,
or orphans the coordinator's MLS admin role. Back it up.

```sh
nostrautica-coordinator backup /home/nostrautica/backups/$(date +%F-%H%M).sqlite \
  --config /home/nostrautica/state/coordinator.toml
```

`backup` takes a crash-consistent snapshot via `VACUUM INTO` (WAL snapshot
isolation, so it is safe to run against the live daemon — it records
`quiesced: false` when a daemon is up), runs `integrity_check`, proves every
protected `E_inbox`/ECK row decrypts under the loaded identity, and writes a
`<dest>.meta.json` sidecar with the schema version, coordinator pubkey, release
revision, event count, and the snapshot's SHA-256 checksum. Expected:

```
[backup] wrote .../2026-07-23-0400.sqlite (+ .../2026-07-23-0400.sqlite.meta.json)
  coordinator   npub1...
  release       v0.1.0
  schema        v1
  events        3
  checksum      a3c0e0b7...
  quiesced      true
[backup] OK
```

Keep the snapshot **and** its `.meta.json` together, encrypt them at rest, and keep
the coordinator identity that decrypts the protected columns. A backup you have
never verified and restored is not a recovery plan — schedule a periodic drill
(§9).

Verify a backup any time, off-host, without touching production:

```sh
nostrautica-coordinator verify-backup /path/to/snapshot.sqlite --config coordinator.toml
# → [verify] OK   (checksum match, integrity ok, every event row decrypts, pubkey match)
```

`verify-backup` never publishes or calls a provider. It exits non-zero on any
failed gate (checksum mismatch, corruption, wrong identity, newer schema).

## 6. Restore

Restore refuses to run against a live daemon (it must hold the single-daemon
lock), refuses a snapshot from a newer schema than the binary understands, and
refuses to overwrite an existing database without `--force`.

```sh
sudo systemctl stop nostrautica-coordinator
nostrautica-coordinator verify-backup /path/to/snapshot.sqlite --config coordinator.toml
nostrautica-coordinator restore /path/to/snapshot.sqlite --force --config coordinator.toml
sudo systemctl start nostrautica-coordinator
journalctl -u nostrautica-coordinator -f     # confirm it resumes cleanly
```

On restore, `-wal`/`-shm`/`-journal` sidecars of the target are cleared so the
snapshot opens clean. After starting, run `doctor` again to confirm integrity and
decryption.

## 7. Upgrade

```sh
sudo systemctl stop nostrautica-coordinator
nostrautica-coordinator backup /home/nostrautica/backups/pre-upgrade-$(date +%F).sqlite --config coordinator.toml
git pull && pnpm install --frozen-lockfile && pnpm --filter @nostrautica/coordinator build
nostrautica-coordinator doctor --config coordinator.toml   # confirm the new binary is healthy
sudo systemctl start nostrautica-coordinator
```

**Preserve the same coordinator identity** across upgrades unless an event
migration has been designed and tested. Schema migrations run in place on first
open and bump `PRAGMA user_version`; a newer binary reads an older database, but
an older binary refuses a snapshot from a newer schema (that is what the version
gate protects).

## 8. Roll back

If a new release misbehaves:

```sh
sudo systemctl stop nostrautica-coordinator
git checkout <previous-tag> && pnpm install --frozen-lockfile && pnpm --filter @nostrautica/coordinator build
# If the newer binary had already migrated the DB to a newer schema, restore the
# pre-upgrade backup taken in §7 (the old binary will refuse the migrated DB):
nostrautica-coordinator restore /home/nostrautica/backups/pre-upgrade-<date>.sqlite --force --config coordinator.toml
sudo systemctl start nostrautica-coordinator
```

This is why §7 takes a backup *before* the upgrade — it is your rollback point.

## 9. Recovery, MLS admin, and detach

**Coordinator DB loss.** Restore the most recent verified backup (§6). The relay
world re-converges the reconstructible artifacts; the backup restores the durable
state (jobs, journal, custody, Marmot admin).

**Second MLS admin (automatic).** For every chat-enabled event, the coordinator
keeps the group's admin set equal to *itself plus every active chat device of
every approved organizer-role attendee*. It sets this at group creation and
re-reconciles it whenever an organizer is approved, attests or revokes a chat
device, or is removed (and re-asserts it on each `ensureGroup`, so an organizer
approved while chat was offline is promoted on the next install/config reload).
This is deliberate recovery insurance: if the coordinator's DB (hence its MLS
admin state) is lost and no backup exists, an **organizer's own device is still a
group admin** and can add/remove members and rotate metadata. There is nothing to
enroll by hand — promotion is automatic for organizer-role attendees. Keeping a
current backup is still the primary recovery path; organizer co-admin is the
backstop when a backup is unavailable.

**Detach / reassignment.** Coordinator detachment has known implementation limits.
A config edit alone is not a verified immediate erasure of coordinator custody —
after an operational detach, verify subscriptions closed, stored event state, and
the coordinator logs. Before decommissioning, define who retains group
administration and confirm the handoff.

**Periodic restore drill.** On a schedule, `verify-backup` the latest snapshot and
`restore` it onto an isolated host with subscriptions and provider calls disabled;
confirm it opens, decrypts, and publishes/spends nothing. A drill that publishes or
spends is a failed drill.

## 10. Operations

- Rotate logs; monitor disk, database growth, provider errors, and poisoned jobs
  (surfaced to organizers via kind-21606, logged as `[status] surfaced poisoned …`).
- Billing is enforced by a persisted `evaluating → ok | grace | blocked` state
  machine evaluated against `E_id`; a blocked event parks paid processing but
  still allows revoke, detach, and status publication. Cashu crash recovery
  quarantines an ambiguous reservation (it does not query the mint to reconcile).
- Prefer a controlled maintenance window for restarts: a restart drops in-flight
  jobs and re-subscribes from stored state; the retry/resume logic handles it, but
  avoid restarting during an active matching/transcription run for a live event.

## 11. Incident response

1. Stop new deployment activity; preserve logs and a database snapshot (`backup`).
2. Classify: provider exposure, key custody, relay delivery, payment ambiguity, or
   MLS state.
3. Attendee revocation: use the product flow and verify ECK rotation, roster
   publication, and Marmot removal where chat is enabled.
4. Suspected coordinator identity compromise: rotate infrastructure credentials,
   assess every installed event's key custody, and coordinate event-owner
   migration before restarting under a replacement identity.
5. Record the event coordinate, coordinator pubkey, deployed release revision
   (from `doctor`'s header or the startup log), affected relays, and the verified
   outcome.
