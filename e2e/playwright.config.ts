import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config (IMPLEMENTATION_PLAN §2). Multi-context browsers exercise the
 * organizer / attendee / outsider roles against the built static PWA, backed by
 * the dockerized strfry relay + blossom-server.
 *
 * CI: `docker compose -f docker/docker-compose.yml up -d` → build the app →
 * `pnpm --filter @nostrautica/e2e test`.
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
  use: {
    baseURL: process.env.NOSTRAUTICA_URL ?? "http://localhost:4173",
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
    // vite preview SSRs the shell at request time, so %sveltekit.env% CSP
    // substitution needs the env var HERE, not only at build time.
    command:
      'PUBLIC_CSP_EXTRA_CONNECT=" ws: http:" pnpm --filter @nostrautica/app preview --port 4173 --strictPort',
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    cwd: "..",
    timeout: 120_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
