/**
 * Exit forensics for the coordinator daemon (production outage 2026-07-25).
 *
 * That morning the daemon exited ~3 minutes after a deploy and stayed dead for 29
 * minutes, and the log it appends to contained NOT ONE LINE about it. It was not
 * OOM (13 GB free) and it was not `main()`'s `.catch` fatal path: that path does a
 * `console.error` first, stdout/stderr are redirected to a FILE (so those writes
 * are synchronous and cannot be lost to a buffered pipe the way a dying process
 * loses a pipe), and no such message was ever written. So the process left through
 * a path that logs nothing at all — an `uncaughtException` or an
 * `unhandledRejection` (both kill Node without ever touching `main().catch`), or a
 * plain `process.exit`/event-loop-drain nobody asked for. Root cause is still
 * unknown and no longer reproducible, which is the whole problem: there was no
 * evidence to reason from.
 *
 * These handlers make a silent exit impossible next time. Every departure — crash,
 * signal, or a clean code 0 — writes one timestamped, labelled line saying which
 * path it took. The `exit` hook in particular is the backstop for the paths nobody
 * has thought of yet, including the one that killed us: it fires whatever the
 * reason, so "no FATAL line but an EXIT code 0 line" is itself a diagnosis.
 *
 * SIGINT/SIGTERM are deliberately NOT handled here — `main.ts`'s `shutdown()` owns
 * them (it drains the in-flight job, releases the daemon lock, then exits 0). A
 * second listener here would not stop that drain, but it would print a misleading
 * "exiting" line seconds before the daemon actually does, and an operator reading
 * the log during an incident should not have to know which of two handlers lied.
 * Registering an early signal logger would be actively harmful: the FIRST listener
 * is what suppresses Node's default terminate-on-signal, so a signal arriving
 * during startup (before `shutdown()` is wired) would be swallowed instead of
 * killing the daemon, and systemd would sit through its whole stop timeout before
 * SIGKILLing. That startup window is therefore an accepted gap in this file's "no
 * silent exit" guarantee — a signal death there runs no `exit` handler at all, so
 * nothing lands in the log; it is journald (`code=killed, status=15/TERM` from the
 * service manager) that covers it, which is one more reason the daemon belongs
 * under a unit rather than a detached `setsid`.
 */
import { inspect } from "node:util";

/**
 * `[2026-07-25T06:41:12.004Z] ` — the FULL ISO timestamp, unlike the `hh:mm:ss`
 * `stamp()` used in `pipeline/jobs.ts` / `providers/http.ts`. These particular
 * lines get read days later out of an append-only log spanning many deploys, where
 * a bare wall-clock time cannot be correlated with "the deploy at 06:38" without
 * guessing the date.
 */
function stamp(): string {
  return new Date().toISOString();
}

/** The subset of `process` these handlers touch, so tests can pass a fake. */
export interface ProcessLike {
  on(event: string, listener: (...args: any[]) => void): unknown;
  exit(code?: number): void;
  pid: number;
  uptime(): number;
}

/** The subset of `console` these handlers touch. */
export interface ExitLogger {
  log(msg: string): void;
  error(msg: string): void;
}

/**
 * Render an arbitrary thrown/rejected value for the log. `String(err)` is not good
 * enough: a rejected plain object stringifies to `[object Object]`, which is
 * exactly as useless during an incident as the empty log we actually got. Errors
 * contribute their stack (which already starts with `Name: message`), everything
 * else goes through `util.inspect` so at least its shape survives.
 */
function describe(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  return `non-Error value thrown/rejected: ${inspect(err, { depth: 3 })}`;
}

/** The loud line a crash path writes before exiting non-zero. */
export function fatalLine(
  handler: "uncaughtException" | "unhandledRejection",
  err: unknown,
  proc: ProcessLike,
  origin?: string,
): string {
  const where = origin ? ` (origin: ${origin})` : "";
  return (
    `[${stamp()}] [coordinator] FATAL — ${handler}${where} killed the daemon ` +
    `(pid ${proc.pid}, up ${proc.uptime().toFixed(1)}s), exiting 1: ${describe(err)}`
  );
}

/** The one-line backstop written on EVERY exit, whatever caused it. */
export function exitLine(code: number, proc: ProcessLike): string {
  return (
    `[${stamp()}] [coordinator] EXIT code ${code} (pid ${proc.pid}, up ${proc.uptime().toFixed(1)}s)` +
    ` — if no FATAL or signal line precedes this, nothing in the daemon asked to exit`
  );
}

/**
 * Install the exit-forensics handlers. Call once, as early in the daemon's life as
 * possible; the operator CLI verbs (`doctor`, `backup`, …) deliberately do not get
 * these — they are attended, they already surface failures through `main().catch`
 * plus an exit code, and `doctor`'s output is documented byte-for-byte in the
 * operator guide.
 */
export function installExitLogging(proc: ProcessLike = process, logger: ExitLogger = console): void {
  proc.on("uncaughtException", (err: unknown, origin?: string) => {
    try {
      logger.error(fatalLine("uncaughtException", err, proc, origin));
    } finally {
      // Exit from `finally`, not after the log call: installing an
      // uncaughtException handler suppresses Node's own die-on-throw, so if the
      // write itself throws (EPIPE against a rotated/closed log fd, say) we would
      // otherwise keep running with a swallowed exception and unknowable state.
      proc.exit(1);
    }
  });

  proc.on("unhandledRejection", (reason: unknown) => {
    try {
      logger.error(fatalLine("unhandledRejection", reason, proc));
    } finally {
      // Same exit code Node's own default (`--unhandled-rejections=throw`) would
      // have used, so systemd's Restart= semantics see no change — only the log
      // gains an explanation.
      proc.exit(1);
    }
  });

  proc.on("exit", (code: number) => {
    // MUST stay synchronous: at `exit` the event loop is already closed, so a
    // promise, a `setImmediate`, or a write to anything async silently never runs.
    // `console.log` to a file/tty is a synchronous write, which is why this works.
    logger.log(exitLine(code, proc));
  });
}
