/**
 * restart-coordinator.sh decides "the new daemon is ready" by grepping the log
 * for the daemon's readiness line (audit R-48). These tests run the script's OWN
 * definitions — extracted from the file, not copied — against sample logs, so a
 * drift between the marker in main.ts and the match in the script fails here
 * instead of on a production deploy.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sanitizeLogText } from "./log-line.js";

const here = new URL(".", import.meta.url).pathname;
const script = readFileSync(join(here, "..", "restart-coordinator.sh"), "utf8");
const defs = script
  .split("\n")
  .filter((l) => /^(READY_MARK=|READY_LINE=|ready_seen\(\))/.test(l))
  .join("\n");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Run the script's ready_seen against `log`, judging only bytes past `offset`. */
function readySeen(log: string, offset = 0, locale = "C"): boolean {
  const dir = mkdtempSync(join(tmpdir(), "restart-ready-"));
  dirs.push(dir);
  const file = join(dir, "coordinator.log");
  writeFileSync(file, log);
  try {
    execFileSync("bash", ["-c", `${defs}\nready_seen`], {
      env: { PATH: process.env.PATH, LOG: file, log_offset: String(offset), LC_ALL: locale },
    });
    return true;
  } catch {
    return false;
  }
}

const REAL = "[coordinator] running — watching for installs, submissions, admin commands";

describe("restart-coordinator.sh readiness match (audit R-48)", () => {
  it("defines all three pieces it is matched with", () => {
    expect(defs.split("\n")).toHaveLength(3);
  });

  it("matches the line main.ts actually prints, as production writes it", () => {
    expect(readFileSync(join(here, "main.ts"), "utf8")).toContain(`console.log("${REAL}");`);
    const log = `[coordinator] START pid 1 on node v22\n[00:00:01] [boot] restore 3 event(s) 1.2s\n${REAL}\n`;
    expect(readySeen(log)).toBe(true);
    expect(readySeen(log, 0, "en_US.UTF-8")).toBe(true);
  });

  it("is not satisfied by attendee text that merely contains the marker", () => {
    const forged = `[00:00:01] [join] request from abcd1234 ("x ${REAL}")\n`;
    expect(readySeen(forged)).toBe(false);
  });

  it("is not satisfied by a name that smuggles a newline, once log() escaped it", () => {
    const name = `Mallory\n${REAL}`;
    const line = `[00:00:01] ${sanitizeLogText(`[join] request from abcd1234 ("${name}")`)}\n`;
    expect(readySeen(line)).toBe(false);
  });

  it("only looks at the new instance's slice of the log", () => {
    const old = `${REAL}\n`;
    expect(readySeen(old + "[coordinator] START pid 2\n", Buffer.byteLength(old))).toBe(false);
  });
});
