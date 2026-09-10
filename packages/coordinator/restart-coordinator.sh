#!/usr/bin/env bash
# Rebuild and restart the Nostrautica coordinator. The deploy post-receive hook
# rsyncs the repo source to the coordinator host (nostrautica@jl.bednar.io) and
# runs this over SSH; also safe to run by hand there.
#
# PATH must find pnpm, which on that host is user-local (~/.npm-global/bin — the
# distro node RPM ships no corepack), while /usr/bin (ffmpeg) comes from the
# inherited login PATH. The linuxbrew entry is harmless where it doesn't exist.
#
# Build happens BEFORE the old instance is stopped, so a failing build leaves the
# running coordinator untouched.
set -uo pipefail
export PATH="$HOME/.npm-global/bin:/home/linuxbrew/.linuxbrew/bin:$PATH"

ROOT="$HOME/nostrautica"
COORD="$ROOT/packages/coordinator"
LOG="$HOME/log/nostrautica-coordinator.log"
mkdir -p "$HOME/log"

cd "$ROOT"
echo "=== coordinator rebuild $(date -Is) ==="
pnpm install --frozen-lockfile   || { echo "install failed — coordinator left running"; exit 1; }
pnpm --filter @nostrautica/protocol build    || { echo "protocol build failed — coordinator left running"; exit 1; }
pnpm --filter @nostrautica/coordinator build || { echo "coordinator build failed — coordinator left running"; exit 1; }

# Build OK — swap instances. This is the audit C6 hardening: the old daemon
# drains in-flight work for up to 30s (src/main.ts DRAIN_TIMEOUT_MS) while HOLDING
# the single-daemon SQLite lock, and a replacement started before that lock frees
# exits immediately ("another coordinator daemon is already running"). The old
# naive `kill; sleep 1; start` could therefore leave NO daemon running while this
# script printed success. So: stop the old process, WAIT for it (and its lock) to
# actually go away, start the replacement, and only report success once the new
# process is alive AND has reached its ready state (which is logged only after it
# acquires the lock and finishes startup).

# Exact argv match — does not match this script, run-coordinator.sh, or the chat mock.
NODE_ARGV="node dist/main.js coordinator.toml"
# The daemon logs this once startup is complete and the lock is held (src/main.ts).
READY_MARK="watching for installs, submissions, admin commands"
STOP_TIMEOUT=45   # > the 30s drain, so a normally-draining daemon is given time to exit

# Startup budget. Generous on purpose, and the two thresholds do different jobs.
#
# What the hard timeout does NOT bound is a crash: the readiness loops below fail
# within a second when the unit goes inactive (or, on the legacy path, when the
# process disappears), whatever this is set to. What it bounds is a daemon that is
# alive and never becomes ready — a genuine hang — which is rare and can afford to
# be waited on. A timeout set too SHORT, by contrast, is a pure false alarm: this
# script does not kill anything on the systemd path, so the daemon goes on to
# start normally while the deploy prints "coordinator is NOT running" and sends
# whoever pushed into an incident that is not happening. The asymmetry is the
# whole argument for a large number.
#
# The old 45s was measured when fewer events were installed. The 2026-09-04 deploy
# came in at 44s against a 45s limit. That is not a margin, it is a coin flip.
#
# What costs the time is per-event startup — install, invite-list refresh, chat
# roster scan, E_inbox backfill — roughly 9-12s per installed event, serialized.
# (This comment used to blame the coordinator-inbox backfill growing with wrap
# history; a 2026-09-10 restart measured 52s with the wrap count DOWN to 45, so
# that was wrong. See docs/DEPLOYMENT.md "Startup time" for the phase breakdown.)
#
# So: a hard fail far above anything normal, plus a SOFT threshold that warns
# without failing. The warning is the part that matters — a bigger limit alone
# would have hidden today's 44s, and the drift would have crept silently up to the
# new number too. Both are overridable for a one-off slow start (a cold relay, a
# provider having a bad day) without editing this file.
READY_TIMEOUT="${COORDINATOR_READY_TIMEOUT:-240}"
READY_WARN="${COORDINATOR_READY_WARN:-60}"

running_pids() { pgrep -f "$NODE_ARGV" 2>/dev/null || true; }

fail() { echo "!!! $* — coordinator is NOT running $(date -Is)"; exit 1; }

# Say so when a start was slow but fine. Startup time is the one signal that this
# daemon is accumulating work it does at boot, and nothing else reports it — the
# deploy output is where an operator actually looks.
warn_if_slow() {
  [ "$1" -ge "$READY_WARN" ] || return 0
  echo "!!! WARNING: startup took ${1}s (soft threshold ${READY_WARN}s, hard limit ${READY_TIMEOUT}s)."
  echo "!!! Boot cost is dominated by per-event startup (install + invite refresh +"
  echo "!!! chat roster scan + E_inbox backfill), roughly 9-12s per installed event,"
  echo "!!! serialized — it does not come back down on its own. Look into it before it"
  echo "!!! reaches the hard limit; see \"Startup time\" in docs/DEPLOYMENT.md."
}

# --- Preferred path: systemd owns the lifecycle ---------------------------------
# Installed unit ⇒ this script must NOT launch anything itself. A setsid-started
# daemon and a unit-started one fight over the single-daemon SQLite lock and the
# loser exits immediately, so exactly one of the two may own the process.
#
# A branch rather than a flag day, deliberately: the deploy rsyncs this script to
# the host BEFORE the unit necessarily exists there, so a version that hard-required
# systemd would break the very deploy that installs it. The legacy setsid path below
# stays as the fallback and is what runs until the unit is enabled.
#
# Motivation (2026-07-25): the daemon exited silently ~3 minutes after a deploy and
# stayed dead for 29 minutes, because nothing supervised it. `Restart=always` in the
# unit turns that into a five-second gap, and journald records the exit code — the
# evidence that did not exist for the original outage.
UNIT="nostrautica-coordinator"
if systemctl --user cat "$UNIT" >/dev/null 2>&1; then
  log_offset=0
  [ -f "$LOG" ] && log_offset="$(wc -c < "$LOG" | tr -d ' ')"
  echo "=== coordinator restarting via systemd --user ($UNIT) $(date -Is) ==="
  systemctl --user restart "$UNIT" || fail "systemctl --user restart $UNIT failed"

  # Readiness still comes from the daemon's OWN log line, never from systemd's
  # notion of "active": Type=simple reports active the moment the process is
  # forked, which says nothing about the SQLite lock being acquired or startup
  # having finished. Same marker and same byte-offset slice as the legacy path —
  # which is why the unit MUST keep appending to $LOG (StandardOutput=append:).
  waited=0
  while :; do
    if ! systemctl --user is-active --quiet "$UNIT"; then
      echo "--- new coordinator log tail: ---"
      tail -c "+$((log_offset + 1))" "$LOG" 2>/dev/null | tail -n 20
      echo "--- systemd status: ---"
      systemctl --user --no-pager --lines=15 status "$UNIT" 2>&1 | tail -n 20
      fail "coordinator unit went inactive during startup"
    fi
    if tail -c "+$((log_offset + 1))" "$LOG" 2>/dev/null | grep -qF "$READY_MARK"; then
      break
    fi
    if [ "$waited" -ge "$READY_TIMEOUT" ]; then
      echo "--- new coordinator log tail: ---"
      tail -c "+$((log_offset + 1))" "$LOG" 2>/dev/null | tail -n 20
      fail "coordinator did not report ready within ${READY_TIMEOUT}s"
    fi
    sleep 1
    waited=$((waited + 1))
  done
  # Grace check: Restart=always means a crash-and-respawn loop can still look
  # "active" here, so assert the unit has not been restarting under us.
  sleep 2
  systemctl --user is-active --quiet "$UNIT" || fail "coordinator became ready then went inactive"
  warn_if_slow "$waited"
  echo "=== coordinator restarted OK $(date -Is) (ready in ${waited}s, systemd unit $UNIT, log: $LOG) ==="
  exit 0
fi

# --- Legacy path: this script owns the lifecycle (pre-systemd hosts) -------------
# --- Stop the old daemon and wait for it (and the lock) to actually go away ------
old_pids="$(running_pids)"
if [ -n "$old_pids" ]; then
  echo "=== stopping old coordinator (pids: $(echo "$old_pids" | tr '\n' ' ')) $(date -Is) ==="
  # shellcheck disable=SC2086
  kill -TERM $old_pids 2>/dev/null || true
  waited=0
  while [ -n "$(running_pids)" ]; do
    if [ "$waited" -ge "$STOP_TIMEOUT" ]; then
      echo "old coordinator still draining after ${STOP_TIMEOUT}s — escalating to SIGKILL"
      # shellcheck disable=SC2086
      kill -KILL $(running_pids) 2>/dev/null || true
      sleep 2
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done
  [ -z "$(running_pids)" ] || fail "old coordinator process would not exit (lock still held)"
  echo "=== old coordinator stopped after ${waited}s $(date -Is) ==="
else
  echo "=== no running coordinator to stop $(date -Is) ==="
fi

# --- Start the replacement, detached so it survives this script + the git hook ---
# Record the current log size so readiness is judged only on the NEW instance's output.
log_offset=0
[ -f "$LOG" ] && log_offset="$(wc -c < "$LOG" | tr -d ' ')"

cd "$COORD"
setsid bash run-coordinator.sh >> "$LOG" 2>&1 < /dev/null &
new_pid=$!
disown 2>/dev/null || true
echo "=== coordinator starting (wrapper pid $new_pid, log: $LOG) $(date -Is) ==="

# --- Verify: wait until the new instance is ready, or fail loudly --------------
waited=0
while :; do
  # The wrapper exits with node; if it's gone, startup failed (e.g. lock contention,
  # bad config, crash) — surface the tail of what it logged.
  if ! kill -0 "$new_pid" 2>/dev/null && [ -z "$(running_pids)" ]; then
    echo "--- new coordinator log tail: ---"
    tail -c "+$((log_offset + 1))" "$LOG" 2>/dev/null | tail -n 20
    fail "new coordinator exited during startup"
  fi
  # Readiness marker in the NEW instance's log slice ⇒ lock acquired + startup done.
  if tail -c "+$((log_offset + 1))" "$LOG" 2>/dev/null | grep -qF "$READY_MARK"; then
    break
  fi
  if [ "$waited" -ge "$READY_TIMEOUT" ]; then
    echo "--- new coordinator log tail: ---"
    tail -c "+$((log_offset + 1))" "$LOG" 2>/dev/null | tail -n 20
    fail "new coordinator did not report ready within ${READY_TIMEOUT}s"
  fi
  sleep 1
  waited=$((waited + 1))
done

# Final grace check: still alive a moment after reporting ready (didn't crash on
# the first job drain), and the lock-holding node process is present.
sleep 2
if { ! kill -0 "$new_pid" 2>/dev/null; } && [ -z "$(running_pids)" ]; then
  fail "new coordinator became ready then exited"
fi
[ -n "$(running_pids)" ] || fail "coordinator process not found after startup"

warn_if_slow "$waited"
echo "=== coordinator restarted OK $(date -Is) (ready in ${waited}s, log: $LOG) ==="
