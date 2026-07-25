/**
 * Exit-forensics tests (production outage 2026-07-25). These are worth having as
 * unit tests despite looking trivial: the code they cover only ever runs while the
 * daemon is dying, so a mistake in it (a missing `exit`, a handler that throws
 * before it logs, `[object Object]` instead of a stack) is invisible until the next
 * incident — which is precisely when it has to work. `installExitLogging` takes the
 * process + logger it drives, so a fake stands in for both; nothing in the daemon
 * was reshaped for testability.
 */
import { describe, it, expect } from "vitest";
import { installExitLogging, fatalLine, exitLine, type ProcessLike } from "./lifecycle.js";

type Listener = (...args: any[]) => void;

class FakeProcess implements ProcessLike {
  pid = 4242;
  exits: number[] = [];
  private listeners = new Map<string, Listener[]>();
  private up = 173.5;

  on(event: string, listener: Listener): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }
  exit(code = 0): void {
    this.exits.push(code);
  }
  uptime(): number {
    return this.up;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(event) ?? []) l(...args);
  }
  handlerCount(event: string): number {
    return (this.listeners.get(event) ?? []).length;
  }
}

function fakeLogger() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    logger: { log: (m: string) => out.push(m), error: (m: string) => err.push(m) },
  };
}

const ISO_PREFIX = /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[coordinator\] /;

describe("installExitLogging", () => {
  it("registers exactly the three exit paths that bypass main().catch", () => {
    const proc = new FakeProcess();
    installExitLogging(proc, fakeLogger().logger);
    expect(proc.handlerCount("uncaughtException")).toBe(1);
    expect(proc.handlerCount("unhandledRejection")).toBe(1);
    expect(proc.handlerCount("exit")).toBe(1);
    // Signals stay with main.ts's shutdown() — see the module comment.
    expect(proc.handlerCount("SIGTERM")).toBe(0);
    expect(proc.handlerCount("SIGINT")).toBe(0);
  });

  it("logs an uncaughtException with its stack, then exits 1", () => {
    const proc = new FakeProcess();
    const { err, logger } = fakeLogger();
    installExitLogging(proc, logger);

    const boom = new Error("relay socket exploded");
    proc.emit("uncaughtException", boom, "uncaughtException");

    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(ISO_PREFIX);
    expect(err[0]).toContain("FATAL");
    expect(err[0]).toContain("uncaughtException");
    expect(err[0]).toContain("origin: uncaughtException");
    expect(err[0]).toContain("pid 4242");
    expect(err[0]).toContain("relay socket exploded");
    expect(err[0]).toContain("lifecycle.test.ts"); // the stack, not just the message
    expect(proc.exits).toEqual([1]);
  });

  it("logs an unhandledRejection and exits 1 (Node's own default code)", () => {
    const proc = new FakeProcess();
    const { err, logger } = fakeLogger();
    installExitLogging(proc, logger);

    proc.emit("unhandledRejection", new Error("provider fetch never settled"));

    expect(err[0]).toContain("unhandledRejection");
    expect(err[0]).toContain("provider fetch never settled");
    expect(proc.exits).toEqual([1]);
  });

  it("still exits when the logging itself throws", () => {
    // An uncaughtException handler suppresses Node's die-on-throw, so a failing
    // write (EPIPE on a rotated log fd) must not leave the daemon running in an
    // unknown state with the exception swallowed.
    const proc = new FakeProcess();
    const brokenLogger = {
      log: () => {
        throw new Error("EPIPE");
      },
      error: () => {
        throw new Error("EPIPE");
      },
    };
    installExitLogging(proc, brokenLogger);
    expect(() => proc.emit("uncaughtException", new Error("x"))).toThrow("EPIPE");
    expect(proc.exits).toEqual([1]);
  });

  it("logs a single line on ANY exit, including an unexplained clean one", () => {
    // The backstop for 2026-07-25: a code-0 exit nobody asked for is exactly what
    // `Restart=on-failure` would have ignored and what the log never showed.
    const proc = new FakeProcess();
    const { out, logger } = fakeLogger();
    installExitLogging(proc, logger);

    proc.emit("exit", 0);

    expect(out).toHaveLength(1);
    expect(out[0].split("\n")).toHaveLength(1);
    expect(out[0]).toMatch(ISO_PREFIX);
    expect(out[0]).toContain("EXIT code 0");
    expect(out[0]).toContain("pid 4242");
    expect(out[0]).toContain("up 173.5s");
  });
});

describe("line formatting", () => {
  const proc = new FakeProcess();

  it("renders a non-Error rejection readably instead of [object Object]", () => {
    const line = fatalLine("unhandledRejection", { status: 502, body: "bad gateway" }, proc);
    expect(line).toContain("non-Error value");
    expect(line).toContain("502");
    expect(line).toContain("bad gateway");
    expect(line).not.toContain("[object Object]");
  });

  it("keeps the full ISO date, not just wall-clock time", () => {
    // An append-only log spans many deploys; `hh:mm:ss` alone cannot be tied to
    // "the deploy at 06:38 on the 25th".
    expect(exitLine(1, proc)).toMatch(ISO_PREFIX);
    expect(fatalLine("uncaughtException", new Error("e"), proc)).toMatch(ISO_PREFIX);
  });

  it("names the exit code it is about to use so the log matches systemd's view", () => {
    expect(fatalLine("uncaughtException", new Error("e"), proc)).toContain("exiting 1");
    expect(exitLine(137, proc)).toContain("EXIT code 137");
  });
});
