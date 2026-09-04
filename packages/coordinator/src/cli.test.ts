/**
 * `doctor`'s pipeline report.
 *
 * The tool used to check config, identity, database integrity, ffmpeg, relays and
 * the provider — six questions about whether the daemon CAN work — and then print
 * "all checks passed" over a queue in which two attendees had been poisoned since
 * mid-July. Seven weeks, on production. These cases pin the questions about whether
 * it IS working, and in particular that an old poisoned row is never rendered as ok.
 */
import { describe, it, expect } from "vitest";
import { pipelineChecks, STALE_POISON_MS, type DoctorCheck } from "./cli.js";
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
