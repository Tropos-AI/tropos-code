// web/e2e/ready.ts — opening a dashboard page in the screenshot tests: a generous navigation timeout (four workers
// share one fixture server) and a ready signal instead of fixed waits: the app has rendered and its fonts are in.
import type { Page } from "@playwright/test";

export const NAVIGATION_TIMEOUT_MS = 60_000;

export async function gotoReady(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
  await page.waitForFunction(() => document.querySelector("#root")?.childElementCount !== 0 && document.fonts.status === "loaded", undefined, { timeout: NAVIGATION_TIMEOUT_MS });
}
