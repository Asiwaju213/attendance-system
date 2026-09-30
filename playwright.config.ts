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
      // Pinned for the same reason as the backend below: E2E must not inherit a
      // LAN-mode or custom-port frontend/.env, because the baseURL above and the
      // specs assume loopback on port 4173 proxying to the loopback API.
      env: {
        ...process.env,
        VITE_DEV_HOST: "127.0.0.1",
        VITE_DEV_PORT: "4173",
        VITE_API_PROXY_TARGET: "http://127.0.0.1:5000",
      },
      url: "http://localhost:4173",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: "npm run test:db:prepare && npm run migrate && npm run dev",
      cwd: "backend",
      // Pinned so a developer's backend/.env (including a LAN-mode HOST or a
      // different PORT) cannot stop the E2E API from matching the health-check URL
      // below. E2E always runs against loopback on this machine.
      env: { ...e2eEnvironment, HOST: "127.0.0.1", PORT: "5000" },
      url: "http://localhost:5000/api/health",
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});