// web/e2e/playwright.config.ts — screenshots and layout checks of the built dashboard (`bun run test:screens`).
// Files are *.pw.ts so `bun test` never picks them up; the fixture server runs under Bun, the tests under Node.
import { defineConfig } from "@playwright/test";
import { join } from "node:path";

const PORT = 4391;
const out = join(import.meta.dirname, "out");

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: /.*\.pw\.ts/,
  outputDir: join(out, "results"),
  fullyParallel: true,
  workers: 4,
  reporter: "list",
  // Four workers share one fixture server: a page can take a while to arrive, so waits are for signals, not times.
  timeout: 90_000,
  expect: { timeout: 10_000 },
  use: {
    navigationTimeout: 60_000,
    baseURL: `http://127.0.0.1:${PORT}`,
    // Optional: a Chromium already on this machine, when the revision this Playwright wants isn't downloaded.
    launchOptions: process.env.E2E_CHROMIUM ? { executablePath: process.env.E2E_CHROMIUM } : {},
  },
  webServer: {
    command: "bun web/e2e/fixture-server.ts",
    cwd: join(import.meta.dirname, "..", ".."),
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { E2E_PORT: String(PORT), E2E_KEY_FILE: join(out, "device.key"), E2E_CODE_FILE: join(out, "login.code") },
  },
});
