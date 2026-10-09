import { defineConfig, devices } from "@playwright/test";

// Playwright E2E config — runs against `bun run dev` (Vite).
// Keep this scoped to /e2e so it never picks up Vitest unit tests under /src.

const chromiumExecutablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
  testDir: "./e2e",
  // The PR #182 local-only sync exception has its own config/runner.
  testIgnore: ["realtime-client-sync.spec.ts"],
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // Flakes are regressions: every project and spec runs once.
  retries: 0,
  workers: 1,
  reporter: process.env.CI
    ? [["github"], ["list"], ["html", { outputFolder: "playwright-report", open: "never" }]]
    : "list",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:8080",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  // Cross-browser matrix: filter via `--project=<name>` or PLAYWRIGHT_PROJECT.
  // CI runs all three; local dev defaults to chromium only.
  projects: (() => {
    const all = [
      {
        name: "chromium",
        use: {
          ...devices["Desktop Chrome"],
          ...(chromiumExecutablePath ? { launchOptions: { executablePath: chromiumExecutablePath } } : {}),
        },
      },
      { name: "firefox", use: { ...devices["Desktop Firefox"] } },
      { name: "webkit", use: { ...devices["Desktop Safari"] } },
    ];
    if (process.env.PLAYWRIGHT_PROJECT) {
      return all.filter((p) => p.name === process.env.PLAYWRIGHT_PROJECT);
    }
    return process.env.CI ? all : [all[0]];
  })(),
  webServer: {
    command: "bun run dev",
    url: "http://localhost:8080",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
