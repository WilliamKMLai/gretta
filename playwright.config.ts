import { defineConfig, devices } from '@playwright/test';

/**
 * E2E runs against browser dev mode (`pnpm dev:web`): plain HTTP, VITE_OFFICE_MOCK=1,
 * so the full UI is exercised without a Word host (DECISIONS.md ADR-010).
 * The viewport approximates a docked Word task pane (~380px wide).
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 380, height: 720 } },
    },
  ],
  webServer: {
    command: 'pnpm run dev:web',
    url: 'http://localhost:3000/taskpane.html',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
