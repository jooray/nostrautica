import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // These are integration tests: each one drives real Ed25519 signing, NIP-44,
    // gift-wrap crypto, an in-memory SQLite store, and the full job pipeline —
    // an order of magnitude heavier than a unit test. A single heavy case runs
    // in ~1s in isolation, but the whole monorepo suite (`pnpm -r test`) starts
    // the app suite's worker pool alongside this one, and on a 2-core box that
    // oversubscribes the CPU ~4x. Under that starvation a correct, already-green
    // test (measured: "partial batch failure" at 1002ms with one core busy,
    // "durably rate-drops a flooding sender" spiking to 5106ms) crosses Vitest's
    // default 5000ms per-test budget and fails as a phantom timeout — the victim
    // varies run to run, always whichever compute-heavy test happened to be
    // starved. The work is deterministic and bounded (the job runner has no
    // unbounded waits), so a generous budget only ever removes that flake; a real
    // hang still fails, just at 30s. hookTimeout matches because `setup()` does
    // the same crypto up front.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
