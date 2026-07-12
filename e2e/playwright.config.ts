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
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: process.env.NOSTRAUTICA_URL ?? "http://localhost:4173",
    trace: "on-first-retry",
  },
  webServer: {
    command: "pnpm --filter @nostrautica/app preview --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    cwd: "..",
    timeout: 120_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
