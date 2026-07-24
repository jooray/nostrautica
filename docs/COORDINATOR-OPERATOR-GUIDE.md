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
nostrautica-coordinator verify-backup <file> [--allow-unsigned] [--config coordinator.toml]
nostrautica-coordinator restore <file> [--force] [--allow-unsigned] [--config coordinator.toml]
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

**The database is only partially encrypted at rest — file permissions are your main
protection (audit C7).** Key material (`E_inbox` nsec, ECKs), Cashu proofs, and
selected MLS/pipeline values are NIP-44-encrypted under the coordinator identity, but
the attendee-derived data the coordinator materializes — profiles, AI profiles,
transcripts, corrections, summaries, pair reasoning, and talk data — is stored as
**plaintext SQLite fields**. `chmod 600` is access control, **not** encryption:
anyone who can read the database file (a disk image, a stray copy, an unencrypted
backup) reads that attendee content *without* the coordinator identity key. Encrypt
the volume and every backup at rest, and treat the database as sensitive personal
data. If your deployment's data sensitivity warrants stronger at-rest protection,
run it on an encrypted filesystem with separate key custody.

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

Configure only relays and providers you trust with event data. Config parse
validates every configured URL at startup and **fails fast** on a bad one (audit
O4): provider base URLs (`providers.venice.base_url`, `providers.routstr.node_url`,
`providers.routstr.mint`), `coordinator.terms_url`, `coordinator.picture`, and
`pricing.checkout_url` **must be `https://`**; every `relays.default` **must be
`wss://`**. URLs carrying embedded credentials (`https://user:pass@…`) or a fragment
(`#…`) are rejected outright, and loopback/private/link-local hosts are refused.

Two security knobs (both under `[security]`, both safe defaults):

| Key | Default | Purpose |
|---|---|---|
| `security.allow_insecure_urls` | `false` | **Dev only.** Permits `http://`/`ws://` schemes and loopback/private hosts for provider URLs and relays — for a local test stack (self-signed Blossom proxy, `nak serve` on localhost). **Never set on a public coordinator.** |
| `security.relay_allowlist` | `[]` (empty) | When non-empty, any relay URL taken from untrusted event input (event config `relays`, grant `config_relays`, inbox NIP-65 lists, key-package discovery) is dropped unless its host is listed. Empty = accept any *public* `wss://` host (still SSRF-guarded). Set this for a public coordinator that should only ever connect to known relays. |

Beyond syntactic checks, relay WebSocket connections are SSRF-guarded at connect
time (DNS-pinned, private/rebinding/mixed-answer addresses refused), the same
protection HTTP media fetches already had.

## 3. Verify before starting — `doctor`

`doctor` is **genuinely read-only** (audit O2): it opens SQLite with a read-only
connection and never migrates the schema, encrypts legacy columns, changes the
journal mode, or bumps `user_version` — a doctor run leaves an old-schema database
byte-identical. It parses config, loads the identity, integrity-checks the database,
proves the protected rows decrypt under the identity, confirms ffmpeg/ffprobe, probes
every default relay, and does a read-only provider auth check. It never publishes,
spends, subscribes, or writes. Because it doesn't migrate, it is safe as an
`ExecStartPre` gate; the actual schema migration happens only on a normal read-write
startup (§7). Run it as a gate and after every config change.

```sh
nostrautica-coordinator doctor --config coordinator.toml
```

Expected output on a healthy host:

```
[doctor] nostrautica-coordinator v0.1.0 (schema v2)
  [ok]   config parse — coordinator.toml
  [ok]   identity load — npub1...
  [ok]   database integrity — 3 event(s), schema v2
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
sandboxing and resource limits (audit O5). **Use the checked-in canonical unit** —
do not hand-write your own and do not run the coordinator from a detached shell
script. The repo ships one tested, hardened unit,
`packages/coordinator/nostrautica-coordinator.service`, built for an
**`/opt` + `/var/lib` + `/etc`** layout so it avoids the old
`WorkingDirectory=/home` + `ProtectHome=true` contradiction (which could make the
code unreadable):

- **Code:** `/opt/nostrautica` — read-only under `ProtectSystem=strict`.
- **State:** `/var/lib/nostrautica` via `StateDirectory=nostrautica` — the only
  writable path (SQLite lives here; if you use `providers.routstr.wallet_db`, give it
  an **absolute** path under `/var/lib/nostrautica`, since the working dir is
  read-only).
- **Config:** `/etc/nostrautica/{coordinator.toml,coordinator.env}` — the env file
  holds `NOSTRAUTICA_COORDINATOR_NSEC` etc.

Install and verify it:

```sh
sudo install -Dm644 packages/coordinator/nostrautica-coordinator.service \
  /etc/systemd/system/nostrautica-coordinator.service
sudo systemctl daemon-reload
systemd-analyze verify   nostrautica-coordinator.service   # syntax/settings
systemd-analyze security nostrautica-coordinator.service   # expect a low exposure score
sudo systemctl enable --now nostrautica-coordinator
journalctl -u nostrautica-coordinator -f
```

The unit is the sole lifecycle owner: `Restart=on-failure` with a start-limit
gives crash supervision, and `KillSignal=SIGTERM` + `KillMode=mixed` +
`TimeoutStopSec=45` match the daemon's 30-second job drain (a value under the drain
would SIGKILL mid-job). It applies the full systemd sandbox
(`NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`,
`PrivateDevices`, kernel/clock/cgroup/hostname/proc protections, dropped
capabilities, `RestrictAddressFamilies`, `SystemCallFilter=@system-service`) plus
`MemoryHigh`/`MemoryMax`/`TasksMax` resource caps.

One deliberate exception: `MemoryDenyWriteExecute` is **left off** (commented in the
unit). V8's JIT maps writable-then-executable pages and Node crashes under it
(it would require `node --jitless`, far too slow). Do **not** "harden" it back on —
it breaks the daemon.

The unit's `ExecStartPre` runs the read-only `doctor` (§3) as a preflight gate.
Healthy startup logs the identity, per-role provider routes, the single-daemon
lock, and `running — watching for installs, submissions, admin commands`. **Test
ffmpeg under these restrictions before production** — `PrivateTmp` in particular
must not break the audio pipeline (the daemon sweeps its own temp dirs at boot).

A second daemon on the same database fails fast with the single-daemon-lock error
— never run two against one SQLite file. Prefer the canonical systemd unit over any
detached restart script: a script that SIGTERMs the old daemon and immediately
starts a replacement can leave *no* daemon running (the old process holds the
single-daemon lock while it drains for up to 30 s, so the replacement can't acquire
it) — systemd, waiting for the old unit to stop before starting the new one, avoids
that race.

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
revision, event count, the snapshot's SHA-256 (a **corruption** check), and an
**HMAC-SHA256 authentication tag** keyed from the coordinator identity secret over
the canonical manifest — which includes that checksum, so the tag authenticates the
snapshot digest too (audit C10). The tag is what makes tampering detectable:
recomputing the plain SHA-256 after altering a snapshot no longer passes, because
forging the tag requires the coordinator identity key. Expected:

```
[backup] wrote .../2026-07-23-0400.sqlite (+ .../2026-07-23-0400.sqlite.meta.json)
  coordinator   npub1...
  release       v0.1.0
  schema        v2
  events        3
  checksum      a3c0e0b7...
  auth          hmac-sha256 (a1b2c3d4...)
  quiesced      true
[backup] OK
```

Keep the snapshot **and** its `.meta.json` together, encrypt them at rest, and keep
the coordinator identity that decrypts the protected columns. A backup you have
never verified and restored is not a recovery plan — schedule a periodic drill
(§9).

**Backups outlive deletion.** When an attendee withdraws or an event's retention
window expires, the coordinator performs an event-wide local purge of its own copies
(profiles, AI profiles, transcripts, pair reasoning, talks, summaries) and deletes
the relay records across all historical ECK versions (audit C5). It **cannot** reach
your external backup files — a snapshot taken *before* a purge still contains the
purged data, so honoring a deletion means **rotating and expiring old backups**
yourself. One nuance of the purge: content-addressed payloads shared by dedupe are
**reference-counted** — a payload still referenced by *another* event survives this
event's purge and is dropped only when its last reference is gone.

Verify a backup any time, off-host, without touching production:

```sh
nostrautica-coordinator verify-backup /path/to/snapshot.sqlite --config coordinator.toml
# → [verify] OK   (checksum match, integrity ok, every event row decrypts, pubkey match)
```

`verify-backup` never publishes or calls a provider. It exits non-zero on any
failed gate (corruption-check mismatch, integrity failure, wrong identity, newer
schema, **or a missing/invalid authentication tag**). Authentication is
**fail-closed**: a snapshot whose HMAC tag is *present but invalid* (tampered) is
**always** refused and cannot be overridden. A **legacy unsigned** backup — one
written before C10, with no tag at all — is also refused by default; pass
`--allow-unsigned` to `verify-backup`/`restore` to accept such a pre-signing backup
deliberately. Re-run `backup` on the current binary to produce an authenticated
snapshot and retire the unsigned ones.

## 6. Restore

Restore refuses to run against a live daemon (it must hold the single-daemon
lock), refuses a snapshot from a newer schema than the binary understands, refuses
a tampered snapshot and (by default) an unsigned legacy one — pass `--allow-unsigned`
to accept a pre-C10 backup deliberately (§5) — and refuses to overwrite an existing
database without `--force`.

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
migration has been designed and tested. Schema migrations are **numbered, ordered,
and transactional** (see `docs/VERSIONING.md`): they run in place on the first
read-write open and advance `PRAGMA user_version` at each boundary (the schema is at
`v2`). A newer binary reads and upgrades an older database, but an older binary now
**refuses to open *or* restore a database written by a newer one** (`user_version`
greater than the binary's `SCHEMA_VERSION`) with a clear "upgrade the coordinator"
message — the downgrade guard applies at open time, not only at restore. This is
exactly why you take a pre-upgrade backup below: it is a schema the old binary still
accepts if you roll back (§8).

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
