#!/usr/bin/env node
/**
 * Re-vendor @internet-privacy/marmot-ts into packages/vendor/marmot-ts — one
 * command, repeatable, so pulling in a newer upstream fix is not a hand-copy.
 *
 *   node scripts/vendor-marmot.mjs                         # default repo + ref (below)
 *   node scripts/vendor-marmot.mjs --ref <branch|tag|sha>
 *   node scripts/vendor-marmot.mjs --repo <git url> --ref <ref>
 *   node scripts/vendor-marmot.mjs --src <existing checkout>   # skip the clone (must be clean)
 *
 * What it does, in order:
 *   1. clones the repo at the ref (plus the `ts-mls` submodule; the `refs/*`
 *      submodules are documentation and are not fetched), or uses `--src`;
 *   2. `pnpm install --frozen-lockfile` and `pnpm run build` there — upstream's
 *      build bundles its ts-mls fork into `dist/vendor/ts-mls` with rewritten
 *      specifiers, so one package carries both layers;
 *   3. replaces packages/vendor/marmot-ts/lib with that dist (no sourcemaps, no
 *      sourceMappingURL comments; `lib/` because `dist/` is gitignored repo-wide);
 *   4. applies every packages/vendor/patches/*.patch (our carried NOSTRAUTICA
 *      PATCHes) and fails if any does not apply cleanly;
 *   5. regenerates packages/vendor/marmot-ts/package.json from upstream's
 *      (exports rewritten to lib/, optional crypto peers made real deps, the
 *      patches' extra deps added, the source pin recorded under "vendoredFrom");
 *   6. copies both upstream LICENSE files;
 *   7. rewrites packages/vendor/INTEGRITY.sha256 and runs `pnpm install` so the
 *      lockfile follows any dependency change.
 *
 * Then: read `git diff --stat packages/vendor`, run `pnpm check`, commit.
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR_DIR = join(REPO_ROOT, "packages/vendor/marmot-ts");
const LIB_DIR = join(VENDOR_DIR, "lib");
const PATCH_DIR = join(REPO_ROOT, "packages/vendor/patches");

/** jooray/marmot-ts `nostrautica-vendor` = upstream master + our open upstream PRs. */
const DEFAULT_REPO = "https://github.com/jooray/marmot-ts.git";
const DEFAULT_REF = "nostrautica-vendor";

/**
 * Dependencies our patches add on top of upstream's. `@hpke/dhkem-x25519` is the
 * pure-JS X25519 KEM the 0002 patch falls back to on browsers without WebCrypto
 * X25519.
 */
const PATCH_DEPENDENCIES = { "@hpke/dhkem-x25519": "1.8.0" };

function parseArgs(argv) {
  const out = { repo: DEFAULT_REPO, ref: DEFAULT_REF, src: undefined, install: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") out.repo = argv[++i];
    else if (a === "--ref") out.ref = argv[++i];
    else if (a === "--src") out.src = argv[++i];
    else if (a === "--no-install") out.install = false;
    else if (a === "-h" || a === "--help") {
      console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
      process.exit(0);
    } else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

function run(cmd, args, cwd, opts = {}) {
  console.log(`$ (${relative(REPO_ROOT, cwd) || "."}) ${cmd} ${args.join(" ")}`);
  return execFileSync(cmd, args, {
    cwd,
    stdio: opts.capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
    // HTTP/2 to github has been flaky from this network; 1.1 is reliable.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

const git = (args, cwd, capture = false) =>
  run("git", ["-c", "http.version=HTTP/1.1", ...args], cwd, { capture });

function checkout({ repo, ref }) {
  const dir = mkdtempSync(join(tmpdir(), "marmot-ts-vendor-"));
  git(["clone", "--quiet", repo, dir], REPO_ROOT);
  git(["checkout", "--quiet", ref], dir);
  git(["submodule", "update", "--init", "--quiet", "ts-mls"], dir);
  return dir;
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function copyDist(src) {
  const dist = join(src, "dist");
  if (!existsSync(join(dist, "index.js"))) throw new Error(`no build output at ${dist}`);
  rmSync(LIB_DIR, { recursive: true, force: true });
  cpSync(dist, LIB_DIR, {
    recursive: true,
    filter: (p) => !p.endsWith(".map") && !p.endsWith(".tsbuildinfo"),
  });
  // The maps are gone, so the comments pointing at them are lies; drop them.
  for (const file of walk(LIB_DIR)) {
    if (!/\.(js|d\.ts)$/.test(file)) continue;
    const text = readFileSync(file, "utf8");
    const stripped = text.replace(/\n?\/\/# sourceMappingURL=\S+\s*$/, "\n");
    if (stripped !== text) writeFileSync(file, stripped);
  }
}

function applyPatches() {
  const patches = readdirSync(PATCH_DIR)
    .filter((n) => n.endsWith(".patch"))
    .sort();
  for (const name of patches) {
    // `patch` rather than `git apply`: lib/ is not tracked at this point in a
    // fresh re-vendor, and plain patch has no opinion about the index.
    run("patch", ["-p1", "--forward", "--batch", "-d", LIB_DIR, "-i", join(PATCH_DIR, name)], REPO_ROOT);
  }
  const marked = walk(LIB_DIR).filter((f) => readFileSync(f, "utf8").includes("NOSTRAUTICA PATCH"));
  if (marked.length !== patches.length) {
    throw new Error(`expected ${patches.length} patched files, found ${marked.length} NOSTRAUTICA PATCH markers`);
  }
  for (const orig of walk(LIB_DIR).filter((f) => f.endsWith(".orig") || f.endsWith(".rej"))) rmSync(orig);
}

function writePackageJson(src, pin) {
  const upstream = JSON.parse(readFileSync(join(src, "package.json"), "utf8"));
  const exportsMap = JSON.parse(JSON.stringify(upstream.exports).replaceAll("./dist/", "./lib/"));
  const pkg = {
    name: upstream.name,
    version: upstream.version,
    description:
      `Vendored build of ${upstream.name} ${upstream.version} (${pin.repo} @ ${pin.commit.slice(0, 7)}), ` +
      "bundling its ts-mls fork under lib/vendor/ts-mls. Committed pre-built and re-generated only by " +
      "scripts/vendor-marmot.mjs — see packages/vendor/README.md.",
    type: "module",
    private: true,
    license: upstream.license,
    vendoredFrom: pin,
    exports: exportsMap,
    main: "./lib/index.js",
    types: "./lib/index.d.ts",
    files: ["lib", "LICENSE"],
    // Upstream's optional crypto peers are imported dynamically by the bundled
    // ts-mls; declaring them as real deps keeps them resolvable for Vite and Node
    // exactly as the old separately-vendored ts-mls package did.
    dependencies: Object.fromEntries(
      Object.entries({
        ...upstream.dependencies,
        ...(upstream.peerDependencies ?? {}),
        ...PATCH_DEPENDENCIES,
      }).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
  };
  writeFileSync(join(VENDOR_DIR, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const src = args.src ?? checkout(args);
  const dirty = git(["status", "--porcelain", "--untracked-files=no"], src, true).trim();
  if (dirty) throw new Error(`source checkout has local changes; refusing to vendor:\n${dirty}`);
  const commit = git(["rev-parse", "HEAD"], src, true).trim();
  const tsMlsCommit = git(["rev-parse", "HEAD:ts-mls"], src, true).trim();

  if (!existsSync(join(src, "ts-mls", "package.json"))) {
    git(["submodule", "update", "--init", "--quiet", "ts-mls"], src);
  }
  run("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"], src);
  run("pnpm", ["run", "build"], src);

  copyDist(src);
  applyPatches();
  writePackageJson(src, {
    repo: args.src ? "(local checkout)" : args.repo,
    ref: args.src ? undefined : args.ref,
    commit,
    tsMlsCommit,
  });
  cpSync(join(src, "LICENSE"), join(VENDOR_DIR, "LICENSE"));
  cpSync(join(src, "ts-mls", "LICENSE"), join(LIB_DIR, "vendor", "ts-mls", "LICENSE"));

  run("node", ["scripts/vendor-manifest.mjs", "--write"], REPO_ROOT);
  if (args.install) run("pnpm", ["install"], REPO_ROOT);

  if (!args.src) rmSync(src, { recursive: true, force: true });
  console.log(`\nvendored ${args.repo}@${args.ref} = ${commit} (ts-mls ${tsMlsCommit})`);
  console.log("next: git diff --stat packages/vendor && pnpm check, then update the pins in packages/vendor/README.md");
}

main();
