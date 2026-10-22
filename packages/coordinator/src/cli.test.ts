/**
 * `doctor`'s pipeline report.
 *
 * The tool used to check config, identity, database integrity, ffmpeg, relays and
 * the provider — six questions about whether the daemon CAN work — and then print
 * "all checks passed" over a queue in which two attendees had been poisoned since
 * mid-July. Seven weeks, on production. These cases pin the questions about whether
 * it IS working, and in particular that an old poisoned row is never rendered as ok.
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipelineChecks, runCli, STALE_POISON_MS, type DoctorCheck } from "./cli.js";
import type { PipelineInspection } from "./store/db.js";

const NOW = 1_800_000_000_000;

function inspection(over: Partial<PipelineInspection> = {}): PipelineInspection {
  return {
    counts: {},
    oldestPending: null,
    oldestRunning: null,
    poisonJobs: [],
    poisonStatuses: [],
    lastCompletedStartedAt: null,
    ...over,
  };
}

const find = (checks: DoctorCheck[], label: string): DoctorCheck | undefined =>
  checks.find((c) => c.label === label);

describe("doctor pipeline checks", () => {
  it("an idle, healthy queue is all-ok and says the daemon is up", () => {
    const checks = pipelineChecks(inspection({ counts: { done: 12 }, lastCompletedStartedAt: NOW - 60_000 }), {
      now: NOW,
      daemonRunning: true,
    });
    expect(checks.every((c) => c.level === "ok")).toBe(true);
    expect(find(checks, "daemon")!.detail).toMatch(/holds the single-daemon lock/);
    expect(find(checks, "job queue")!.detail).toMatch(/0 pending, 0 running, .*12 done/);
    expect(find(checks, "last completed job")!.detail).toMatch(/started 1m ago/);
  });

  it("a poisoned job is a WARNING and carries its coordinate, stage and age", () => {
    // The production state this whole check exists for.
    const checks = pipelineChecks(
      inspection({
        counts: { poison: 2 },
        poisonJobs: [
          {
            id: 41,
            type: "process_attendee",
            attempts: 26,
            coordinate: "31923:aaaa:my-event",
            pubkey: "b".repeat(64),
            last_error: "provider returned a malformed ai_profile",
            claimed_at: NOW - 49 * 24 * 3600_000,
          },
        ],
        poisonStatuses: [
          {
            coordinate: "31923:aaaa:my-event",
            stage: "process_attendee",
            pubkey: "b".repeat(64),
            attempts: 26,
            error_category: "provider_contract",
            updated_at: NOW - 49 * 24 * 3600_000,
          },
        ],
      }),
      { now: NOW, daemonRunning: true },
    );
    // Nothing about a poisoned row may render as "ok".
    const poisonLines = checks.filter((c) => /poison/i.test(c.label));
    expect(poisonLines.length).toBeGreaterThan(0);
    expect(poisonLines.every((c) => c.level === "warn")).toBe(true);
    expect(find(checks, "poisoned jobs")!.detail).toMatch(/1 older than a day \(unnoticed\)/);
    const detail = poisonLines.map((c) => c.detail).join("\n");
    expect(detail).toMatch(/process_attendee/);
    expect(detail).toMatch(/31923:aaaa:my-event/);
    expect(detail).toMatch(/provider_contract/);
    expect(detail).toMatch(/49d 0h ago/);
    expect(detail).toMatch(/\[STALE: over a day old\]/);
  });

  it("a poisoned row younger than a day is still a warning, just not flagged stale", () => {
    const checks = pipelineChecks(
      inspection({
        counts: { poison: 1 },
        poisonJobs: [
          {
            id: 9,
            type: "process_talk",
            attempts: 3,
            coordinate: "31923:aaaa:e",
            pubkey: null,
            last_error: "boom",
            claimed_at: NOW - STALE_POISON_MS / 2,
          },
        ],
      }),
      { now: NOW, daemonRunning: true },
    );
    expect(find(checks, "poisoned jobs")!.level).toBe("warn");
    expect(find(checks, "poisoned jobs")!.detail).not.toMatch(/older than a day/);
  });

  it("a running job whose lease has expired is called out as stranded", () => {
    const checks = pipelineChecks(
      inspection({
        counts: { running: 1 },
        oldestRunning: { id: 7, type: "process_attendee", claimed_at: NOW - 900_000, lease_until: NOW - 600_000 },
      }),
      { now: NOW, daemonRunning: true },
    );
    const running = find(checks, "running job")!;
    expect(running.level).toBe("warn");
    expect(running.detail).toMatch(/lease EXPIRED 10m ago/);
  });

  it("a pending job the live daemon has left runnable for ages is a warning", () => {
    const checks = pipelineChecks(
      inspection({
        counts: { pending: 3 },
        oldestPending: { id: 2, type: "score_batch", next_run_at: NOW - 40 * 60_000, attempts: 1 },
      }),
      { now: NOW, daemonRunning: true },
    );
    const oldest = find(checks, "oldest pending job")!;
    expect(oldest.level).toBe("warn");
    expect(oldest.detail).toMatch(/runnable for 40m/);
  });

  it("a pending job that is merely backing off is fine", () => {
    const checks = pipelineChecks(
      inspection({
        counts: { pending: 1 },
        oldestPending: { id: 2, type: "score_batch", next_run_at: NOW + 4 * 3600_000, attempts: 9 },
      }),
      { now: NOW, daemonRunning: true },
    );
    const oldest = find(checks, "oldest pending job")!;
    expect(oldest.level).toBe("ok");
    expect(oldest.detail).toMatch(/next run in 4h 0m/);
  });

  it("says so when no daemon holds the lock", () => {
    const checks = pipelineChecks(inspection(), { now: NOW, daemonRunning: false });
    expect(find(checks, "daemon")!.detail).toMatch(/NOT running/);
  });

  it("parked work is surfaced — it is invisible everywhere else", () => {
    const checks = pipelineChecks(inspection({ counts: { waiting: 4 } }), { now: NOW, daemonRunning: true });
    const parked = find(checks, "parked jobs")!;
    expect(parked.level).toBe("warn");
    expect(parked.detail).toMatch(/4 job\(s\) in 'waiting'/);
  });

  it("work queued against a pipeline that has never completed anything is a warning", () => {
    const checks = pipelineChecks(inspection({ counts: { pending: 2 } }), { now: NOW, daemonRunning: true });
    const last = find(checks, "last completed job")!;
    expect(last.level).toBe("warn");
    expect(last.detail).toMatch(/never completed a job/);
  });
});

/**
 * Audit R-58: the system unit's ExecStartPre ran the full doctor, so a relay or
 * Venice outage failed the PREFLIGHT and burned the unit's start-limit budget.
 * `doctor --local` keeps the local preconditions and skips the network.
 */
describe("doctor --local", () => {
  const tmp: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function doctor(extra: string[]): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "doctor-local-"));
    tmp.push(dir);
    const cfg = join(dir, "coordinator.toml");
    // A relay that cannot resolve (.invalid) and a Venice key variable that is not set: both
    // network checks fail whenever they run.
    writeFileSync(
      cfg,
      `[relays]\ndefault = ["wss://relay.invalid"]\n[providers.venice]\napi_key_env = "DOCTOR_TEST_UNSET_KEY"\n` +
        `[models]\nsummary = { provider = "venice", model = "m" }\nmatch = { provider = "venice", model = "m" }\n` +
        `embed = { provider = "venice", model = "m" }\n`,
    );
    vi.stubEnv("NOSTRAUTICA_COORDINATOR_DB", join(dir, "absent.sqlite"));
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await runCli("doctor", ["--config", cfg, ...extra]);
    return lines.join("\n");
  }

  it("every CLI verb runs under an owner-only umask (audit R-60)", async () => {
    const before = process.umask(0o022);
    let during: number;
    try {
      await doctor(["--local"]);
    } finally {
      during = process.umask(before); // setting returns the previous mask
    }
    expect(during).toBe(0o077);
  });

  it("runs the network checks by default", async () => {
    const out = await doctor([]);
    expect(out).toMatch(/\[FAIL\] relays/);
    expect(out).toMatch(/\[FAIL\] Venice auth/);
  });

  it("skips relays and provider auth, and says so, under --local", async () => {
    const out = await doctor(["--local"]);
    expect(out).toMatch(/\[skip\] relays, provider auth/);
    expect(out).not.toMatch(/\] relays —/);
    expect(out).not.toMatch(/Venice auth/);
    expect(out).toMatch(/\[ok\] {3}config parse/); // local checks still run
  });
});
