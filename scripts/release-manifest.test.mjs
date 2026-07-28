/**
 * Tests for the release manifest's `releaseId` — which is also the PWA's
 * service-worker precache revision for the shell `index.html`.
 *
 * Why this file exists: on 2026-07-28 production had been serving a 4-day-old
 * shell to Firefox users. `releaseId` had collapsed to the constant `v0.7.0`
 * because `git describe --tags --always --dirty` returns "" under the deploy
 * hook's bare `GIT_DIR` (no work tree), and the fallback chain went straight to
 * the package version. Nothing else in the generated precache manifest varies
 * per commit, so `sw.js` came out byte-identical on every deploy, the browser's
 * update check saw no change, and the precached shell froze forever — while
 * `rsync --delete` removed the content-hashed chunks it referenced. The
 * invariant these tests pin is simply: **two different commits must never
 * produce the same releaseId.**
 *
 * Run: node --test scripts/release-manifest.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeReleaseManifest, gitInfo } from "./release-manifest.mjs";

/** A throwaway repo with two commits and no tags — the production shape. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "relman-"));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: dir,
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    })
      .toString()
      .trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.7.0" }));
  git("add", "-A");
  git("commit", "-qm", "one");
  writeFileSync(join(dir, "a.txt"), "a");
  git("add", "-A");
  git("commit", "-qm", "two");
  return { dir, git };
}

test("releaseId differs between commits in an untagged repo", () => {
  const { dir, git } = makeRepo();
  try {
    const second = computeReleaseManifest({ repoRoot: dir }).releaseId;
    git("checkout", "-q", "HEAD~1");
    const first = computeReleaseManifest({ repoRoot: dir }).releaseId;
    assert.notEqual(first, second, "two commits must not share a service-worker revision");
    assert.notEqual(second, "v0.7.0", "must not collapse to the package version");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("releaseId still varies when --dirty is unavailable (bare GIT_DIR deploy hook)", () => {
  const { dir, git } = makeRepo();
  const bare = mkdtempSync(join(tmpdir(), "relman-bare-"));
  try {
    execFileSync("git", ["clone", "-q", "--bare", dir, bare], { stdio: "ignore" });
    // Reproduce the post-receive environment: GIT_DIR points at the bare repo,
    // so every `git describe --dirty` in the build dies "must be run in a work
    // tree" while `rev-parse HEAD` succeeds.
    const prev = process.env.GIT_DIR;
    process.env.GIT_DIR = bare;
    try {
      const head = computeReleaseManifest({ repoRoot: dir });
      assert.notEqual(head.releaseId, "v0.7.0", "bare GIT_DIR must not fall back to the version");
      assert.ok(gitInfo(dir).gitSha !== "unknown");
      // Move the bare repo's HEAD back one commit and confirm the id follows it.
      execFileSync("git", ["--git-dir", bare, "update-ref", "HEAD", "HEAD~1"], { stdio: "ignore" });
      const older = computeReleaseManifest({ repoRoot: dir });
      assert.notEqual(head.releaseId, older.releaseId);
    } finally {
      if (prev === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = prev;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
});

test("NOSTRAUTICA_RELEASE_ID overrides everything", () => {
  const { dir } = makeRepo();
  const prev = process.env.NOSTRAUTICA_RELEASE_ID;
  process.env.NOSTRAUTICA_RELEASE_ID = "pinned-1";
  try {
    assert.equal(computeReleaseManifest({ repoRoot: dir }).releaseId, "pinned-1");
  } finally {
    if (prev === undefined) delete process.env.NOSTRAUTICA_RELEASE_ID;
    else process.env.NOSTRAUTICA_RELEASE_ID = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no git at all still yields a releaseId (rsync'd source)", () => {
  const dir = mkdtempSync(join(tmpdir(), "relman-nogit-"));
  const prev = process.env.GIT_DIR;
  // Point GIT_DIR at a nonexistent path so git can't discover an ancestor repo.
  process.env.GIT_DIR = join(dir, "nope.git");
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.7.0" }));
    const m = computeReleaseManifest({ repoRoot: dir });
    assert.equal(m.releaseId, "v0.7.0");
    assert.equal(m.gitSha, "unknown");
  } finally {
    if (prev === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
