import { defineConfig, devices } from "@playwright/test";
import { testEnvironment } from "./tests/e2e/test-environment";

const e2eEnvironment = testEnvironment();
Object.assign(process.env, e2eEnvironment);

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [["html", { open: "never" }]],
  globalSetup: "./tests/e2e/global-setup.ts",
  globalTeardown: "./tests/e2e/global-teardown.ts",
  use: {
    baseURL: "http://localhost:4173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: "npm run dev",
      cwd: "frontend",
      url: "http://localhost:4173",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: "npm run test:db:prepare && npm run migrate && npm run dev",
      cwd: "backend",
      env: e2eEnvironment,
      url: "http://localhost:5000/api/health",
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});