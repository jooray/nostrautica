import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config (§13.7). Multi-context browsers exercise the organizer /
 * attendee / outsider roles against the built static PWA.
 *
 * Relay / Blossom / HTTPS-proxy / coordinator infrastructure is owned by the
 * ORCHESTRATOR (`e2e/orchestrator.mjs`) — run a tier with `pnpm e2e:smoke |
 * e2e:integration | e2e:chat | e2e:full` from the repo root. The orchestrator
 * sets NOSTRAUTICA_E2E_RELAY once the relay is confirmed up, so the integration
 * specs RUN; bare `playwright test` (e.g. the workspace `test` script) leaves it
 * unset and only the preview-only smoke specs run (the relay-bound ones skip).
 *
 * The `webServer` below owns `vite preview` in BOTH paths (a single owner, so it
 * is never double-bound) and sets PUBLIC_CSP_EXTRA_CONNECT at run time (gotcha
 * #1) so the shell CSP allows local ws/http. `reuseExistingServer: true` lets a
 * dev reuse a manually-started preview. It assumes an existing app build — the
 * orchestrator builds first (relay tiers bake VITE_NOSTRAUTICA_RELAYS/_BLOSSOM).
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  // Relay-bound steps (publish → fetch round-trips) routinely exceed the 5s
  // default on slow hosts; the walking skeleton chains ~6 of them, so it also
  // needs more than the 30s default per-test budget.
  timeout: 120_000,
  expect: { timeout: 15_000 },
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  // Serialize spec FILES for the relay-bound tiers (integration/chat/full — the
  // orchestrator sets NOSTRAUTICA_E2E_RELAY only once that infra is up). Without
  // this, Playwright's default worker count (half the logical CPUs — 6 on a
  // 12-core box) runs several spec files concurrently against the SAME shared
  // nak relay/Blossom/coordinator double the orchestrator started, all fighting
  // over one process's event loop and one SQLite-backed store.
  //
  // Stabilization pass (2026-07-23): 2 baseline `pnpm e2e:integration` runs with
  // the default worker count each failed 3/11, but a DIFFERENT 3 each time
  // (run1: join-approve-directory, members-only-posts, organizer-pages; run2:
  // intro-composer, join-approve-directory, organizer-pages) — not a
  // deterministic bug in one spec. 4 of the 6 failures were the identical
  // shape: "Send join request" stuck `disabled` for the full 120s test budget.
  // That button is gated on Join.svelte's own-profile fetch (profile-load.ts
  // canSubmitLoggedIn) settling out of "loading"; the fetch itself is bounded
  // to 8s (stream.ts `streamEvents` timeoutMs), but once it lands on "failed"/
  // "empty" under relay contention, canSubmitLoggedIn stays false forever with
  // no further retry — so a single missed 8s window strands the button for the
  // rest of the test, not just 8 extra seconds. The other 2 failures were a
  // `toPass` roster-propagation poll expiring in join-approve-directory.spec.ts
  // — same shape (a relay round trip that normally lands well inside its
  // window taking too long once six spec files are hammering the relay at
  // once). `workers: 1` (relay-bound tiers only — smoke never starts a relay,
  // so it keeps Playwright's default parallelism) removes the contention this
  // was tracing back to; see e2e/tests/helpers.ts for the accompanying
  // relay-ack-based fix to the specific own-profile race.
  workers: process.env.NOSTRAUTICA_E2E_RELAY ? 1 : undefined,
  use: {
    baseURL: process.env.NOSTRAUTICA_URL ?? "http://127.0.0.1:4173",
    trace: "on-first-retry",
    // Mobile-first viewport (feature-verification 2026-07-16 §A): Nostrautica is
    // primarily a phone PWA; 390x844 matches the screenshot pass convention.
    viewport: { width: 390, height: 844 },
    // The intro/talk record flow needs a camera+mic without OS permission
    // prompts (E2E-TESTING-GUIDE §1.3) — harmless for specs that never touch it.
    permissions: ["camera", "microphone"],
    // The media descriptor schema is https-only (audit C3); a from-scratch local
    // Blossom stand-in only has a self-signed cert (E2E-TESTING-GUIDE §1.1) — a
    // real deployment's Blossom origin has a real cert, so this is test-only.
    ignoreHTTPSErrors: true,
    launchOptions: {
      args: [
        // Headless Chromium blocks ws://localhost from a localhost page
        // (ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS) — the local relay/blossom
        // are unreachable without this.
        "--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults",
        // Synthetic camera/mic for Record.svelte's video/audio modes (§1.3).
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--ignore-certificate-errors",
      ],
    },
  },
  webServer: {
    command:
      'PUBLIC_CSP_EXTRA_CONNECT=" ws: wss: http: https:" pnpm --filter @nostrautica/app preview --host 127.0.0.1 --port 4173 --strictPort',
    url: "http://127.0.0.1:4173",
    // Reuse the orchestrator's preview when present (never double-bind); start one
    // for a bare `playwright test`. Assumes an existing app build.
    reuseExistingServer: true,
    cwd: "..",
    timeout: 120_000,
  },
  // Chromium runs every tier. Firefox + WebKit are SMOKE-ONLY (audit U18): the
  // engines differ materially in service-worker timing, storage, image decoding, and
  // Web Locks, so the preview-only smoke set (identity creation, backup card, hash
  // routing, no-relay idle) is verified on all three. They are `testDir`-scoped to
  // tests/smoke AND selected by the orchestrator's `--project` flags only on the
  // smoke tier, so a bare `playwright test tests/integration` can't pull them in.
  //
  // The top-level `use` carries Chromium-only launch flags (fake camera, the
  // local-network-access bypass) and camera/mic permissions that Firefox/WebKit
  // reject; each non-Chromium project therefore RESETS launchOptions.args and
  // permissions. Smoke never records or opens a websocket, so neither is needed there.
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    {
      name: "firefox",
      testDir: "./tests/smoke",
      use: { ...devices["Desktop Firefox"], permissions: [], launchOptions: { args: [] } },
    },
    {
      name: "webkit",
      testDir: "./tests/smoke",
      use: { ...devices["Desktop Safari"], permissions: [], launchOptions: { args: [] } },
    },
  ],
});
