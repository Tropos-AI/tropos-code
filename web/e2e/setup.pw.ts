// web/e2e/setup.pw.ts — the Setup page (welcome, the Telegram owner-link step with its QR, done) at phone, tablet and
// desktop widths in both system schemes. The app is light-only: the QR keeps dark modules on a light surface under the
// dark scheme, nothing overflows, and every step header is reachable with Tab. Screenshots land in web/e2e/out/.
import { expect, test, type Browser, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gotoReady } from "./ready";

const OUT = join(import.meta.dirname, "out");
const WIDTHS = [320, 375, 768, 1024, 1440];
const SCHEMES = ["light", "dark"] as const;
const PAPER = "rgb(250, 250, 249)";
const STEPS = ["welcome", "telegram", "done"] as const;
const key = () => readFileSync(join(OUT, "device.key"), "utf8").trim();

async function open(browser: Browser, width: number, scheme: "light" | "dark", reducedMotion?: "reduce"): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height: 860 }, colorScheme: scheme, reducedMotion, hasTouch: width <= 430 });
  const page = await context.newPage();
  await page.addInitScript(([k, v]) => localStorage.setItem(k!, v!), ["tropos.deviceKey", key()]);
  return page;
}

const header = (page: Page, id: string) => page.locator(`button[aria-controls="setup-step-${id}"]`);

/** Opens the step; for Telegram the fixture already has an owner, so ask to claim from another account to see link + QR. */
async function show(page: Page, step: (typeof STEPS)[number]): Promise<void> {
  await expect(page.getByRole("heading", { level: 1, name: "Setup" })).toBeVisible();
  if (step !== "welcome") {
    await header(page, step).click();
    if (step === "telegram") {
      await page.getByRole("button", { name: "Claim from another account" }).click();
      await expect(page.getByLabel("QR code for your Telegram bot")).toBeVisible();
      await expect(page.getByText(/t\.me\/tropos_e2e_bot\?start=/)).toBeVisible();
    }
  }
  await expect(page.locator(`#setup-step-${step === "welcome" ? "welcome" : step}`)).toBeVisible();
}

for (const scheme of SCHEMES)
  for (const width of WIDTHS)
    for (const step of STEPS) {
      test(`setup ${step} ${width} ${scheme}`, async ({ browser, baseURL }) => {
        const page = await open(browser, width, scheme);
        await gotoReady(page, `${baseURL}/#/setup`);
        await show(page, step);
        await page.waitForLoadState("networkidle");

        const overflow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
        expect(overflow.scroll, `page is ${overflow.scroll}px wide in a ${overflow.inner}px viewport`).toBeLessThanOrEqual(overflow.inner);
        expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(PAPER);

        // Everything inside the open panel stays inside the viewport (long links must wrap, not push the page).
        const outside = await page.evaluate((id) => {
          const panel = document.getElementById(`setup-step-${id}`)!;
          return [...panel.querySelectorAll<HTMLElement>("*")]
            .map((el) => ({ el, r: el.getBoundingClientRect() }))
            .filter(({ r }) => r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1))
            .map(({ el }) => `${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 30)}"`);
        }, step);
        expect(outside, "content outside the viewport").toEqual([]);

        if (step === "telegram") {
          // Dark modules on a light surface in both schemes: the nearest painted background behind the QR is light.
          const bg = await page.evaluate(() => {
            let el: Element | null = document.querySelector('[aria-label="QR code for your Telegram bot"]');
            while (el) {
              const c = getComputedStyle(el).backgroundColor;
              const m = c.match(/\d+(\.\d+)?/g)?.map(Number);
              if (m && (m[3] ?? 1) > 0.5) return m.slice(0, 3);
              el = el.parentElement;
            }
            return [0, 0, 0];
          });
          expect(Math.min(...bg), `QR background rgb(${bg.join(",")}) is not light`).toBeGreaterThan(200);
        }
        if (width <= 430) {
          const small = await page.evaluate(() =>
            [...document.querySelectorAll<HTMLElement>("button, a[href], input")]
              .filter((el) => el.offsetParent !== null && !el.closest("[inert]"))
              .map((el) => ({ el, r: el.getBoundingClientRect() }))
              .filter(({ r }) => r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1))
              .map(({ el }) => `${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 30)}"`),
          );
          expect(small, "controls outside the viewport").toEqual([]);
        }
        await page.screenshot({ path: join(OUT, `setup-${step}-${width}-${scheme}.png`), fullPage: true });
        await page.context().close();
      });
    }

test("keyboard: every step header is reachable with Tab and opens with Enter or Space", async ({ browser, baseURL }) => {
  const page = await open(browser, 1024, "light");
  await gotoReady(page, `${baseURL}/#/setup`);
  await expect(page.getByRole("heading", { level: 1, name: "Setup" })).toBeVisible();
  await expect(page.locator('button[aria-controls^="setup-step-"]')).toHaveCount(10);
  const ids = await page.locator('button[aria-controls^="setup-step-"]').evaluateAll((els) => els.map((e) => e.getAttribute("aria-controls")!));
  expect(ids.length).toBe(10);
  const reached = new Set<string>();
  for (let i = 0; i < 80 && reached.size < ids.length; i++) {
    await page.keyboard.press("Tab");
    const id = await page.evaluate(() => document.activeElement?.getAttribute("aria-controls") ?? "");
    if (id.startsWith("setup-step-")) reached.add(id);
  }
  expect([...reached].sort()).toEqual([...ids].sort());
  const target = header(page, "identity");
  await target.focus();
  const before = await target.getAttribute("aria-expanded");
  await page.keyboard.press("Enter");
  await expect(target).toHaveAttribute("aria-expanded", before === "true" ? "false" : "true");
  await page.keyboard.press("Space");
  await expect(target).toHaveAttribute("aria-expanded", before);
  await page.context().close();
});

test("reduced motion: an opened step panel is fully visible at once, with nothing animating", async ({ browser, baseURL }) => {
  const page = await open(browser, 375, "light", "reduce");
  await gotoReady(page, `${baseURL}/#/setup`);
  await header(page, "done").click();
  const panel = page.locator("#setup-step-done");
  await expect(panel).toBeVisible();
  const state = await panel.evaluate((el) => {
    const moving = el.getAnimations({ subtree: true }).filter((a) => a.playState === "running" && Number.isFinite(a.effect?.getComputedTiming().endTime ?? 0) && Number(a.effect?.getComputedTiming().duration) > 0);
    return { opacity: getComputedStyle(el).opacity, transform: getComputedStyle(el).transform, moving: moving.length };
  });
  expect(state).toEqual({ opacity: "1", transform: "none", moving: 0 });
  await page.context().close();
});
