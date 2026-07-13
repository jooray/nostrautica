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
    launchOptions: {
      // Headless Chromium blocks ws://localhost from a localhost page
      // (ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS) — the local relay/blossom
      // are unreachable without this.
      args: [
        "--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults",
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
