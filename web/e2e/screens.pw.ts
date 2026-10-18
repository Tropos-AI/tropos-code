// web/e2e/screens.pw.ts — the dashboard at phone, tablet and desktop widths, in the system's light and dark schemes
// (the app is light-only: dark must not half-apply). Each screen must fit the viewport, keep the paper background and,
// on phones, keep the permission buttons tappable. Screenshots land in web/e2e/out/ (ignored by git).
import { expect, test, type Browser, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(import.meta.dirname, "out");
const WIDTHS = [320, 375, 768, 1024, 1440];
const SCHEMES = ["light", "dark"] as const;
const SCREENS = {
  login: "/",
  setup: "/#/setup",
  chat: "/#/chat",
  status: "/#/status/health",
  settings: "/#/settings/channels",
  phone: "/#/settings/phone",
};
const DEVICE_KEY_STORAGE = "tropos.deviceKey";
const PAPER = "rgb(250, 250, 249)";
const PROCEED = "Do you want to proceed?";
const key = () => readFileSync(join(OUT, "device.key"), "utf8").trim();

async function open(browser: Browser, opts: { width: number; scheme?: "light" | "dark"; reducedMotion?: "reduce"; loggedIn?: boolean }): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: opts.width, height: 860 },
    colorScheme: opts.scheme ?? "light",
    reducedMotion: opts.reducedMotion,
    hasTouch: opts.width <= 430,
  });
  const page = await context.newPage();
  if (opts.loggedIn !== false) await page.addInitScript(([k, v]) => localStorage.setItem(k!, v!), [DEVICE_KEY_STORAGE, key()]);
  // Setup opens by itself once per browser session; these tests are about the other pages, so it has already.
  await page.addInitScript(() => sessionStorage.setItem("tropos.firstRun.opened", "1"));
  return page;
}

async function startChat(page: Page): Promise<void> {
  await page.getByRole("combobox", { name: "Message" }).fill("install deps");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("group", { name: PROCEED })).toBeVisible();
}

for (const scheme of SCHEMES)
  for (const width of WIDTHS)
    for (const [name, path] of Object.entries(SCREENS)) {
      test(`${name} ${width} ${scheme}`, async ({ browser, baseURL }) => {
        const page = await open(browser, { width, scheme, loggedIn: name !== "login" });
        await page.goto(baseURL + path);
        if (name === "login") await expect(page.getByLabel("Login code")).toBeVisible();
        if (name === "chat") await startChat(page);
        if (name === "phone") await expect(page.getByText(/mac\.tail1234\.ts\.net/).first()).toBeVisible();
        if (name === "settings") await expect(page.getByText("Safari on iPhone").first()).toBeVisible();
        if (name === "status") await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await page.waitForLoadState("networkidle");

        const overflow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
        expect(overflow.scroll, `page is ${overflow.scroll}px wide in a ${overflow.inner}px viewport`).toBeLessThanOrEqual(overflow.inner);
        expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(PAPER);

        if (name !== "login") {
          // The top bar's page title must not be pushed under the model chip and undo buttons.
          const bar = await page.evaluate(() => {
            const header = document.querySelector("header")!;
            const title = header.querySelector("p")!.getBoundingClientRect();
            const cluster = header.lastElementChild!.getBoundingClientRect();
            return { titleRight: title.right, clusterLeft: cluster.left, text: header.querySelector("p")!.textContent };
          });
          expect(bar.titleRight, `top bar: "${bar.text}" runs under the controls`).toBeLessThanOrEqual(bar.clusterLeft + 0.5);
        }
        if (name === "chat" && width <= 430) {
          for (const b of await page.getByRole("group", { name: PROCEED }).getByRole("button").all()) {
            const box = (await b.boundingBox())!;
            expect(box.height, `"${(await b.innerText()).trim().slice(0, 30)}" is ${box.height}px tall`).toBeGreaterThanOrEqual(44);
            expect(box.x + box.width).toBeLessThanOrEqual(width);
          }
        }
        if (width <= 430) {
          // Anything tappable that sticks out of the viewport can't be reached without scrolling sideways.
          const outside = await page.evaluate(() =>
            [...document.querySelectorAll<HTMLElement>("a[href], button, input, textarea, select, [role=tab]")]
              .filter((el) => el.offsetParent !== null && !el.closest("[inert], [role=tablist]"))
              .map((el) => ({ el, r: el.getBoundingClientRect() }))
              .filter(({ r }) => r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1))
              .map(({ el }) => `${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 30)}"`),
          );
          expect(outside, "controls outside the viewport").toEqual([]);
        }
        await page.screenshot({ path: join(OUT, `${name}-${width}-${scheme}.png`), fullPage: true });
        await page.context().close();
      });
    }

test("keyboard only: Tab to the code field, type a fresh code, Enter → the app", async ({ browser, baseURL }) => {
  const page = await open(browser, { width: 1024, loggedIn: false });
  const code = await (await fetch("http://127.0.0.1:4392/")).text();
  expect(code).toMatch(/^\d{6}$/);
  await page.goto(baseURL!);
  const field = page.getByLabel("Login code");
  await expect(field).toBeVisible();
  // It starts focused; Tab around until the keyboard has landed on it (never touching the mouse).
  for (let i = 0; i < 6 && !(await field.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
  await expect(field).toBeFocused();
  await page.keyboard.type(code);
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Login code")).toHaveCount(0);
  await expect(page.getByRole("navigation").first()).toBeVisible();
  expect(await page.evaluate((k) => localStorage.getItem(k), DEVICE_KEY_STORAGE)).toBeTruthy();
  await page.context().close();
});

test("reduced motion: the Settings tabs switch without animation and nothing is hidden", async ({ browser, baseURL }) => {
  const page = await open(browser, { width: 375, reducedMotion: "reduce" });
  await page.goto(`${baseURL}/#/settings/channels`);
  await expect(page.getByRole("tablist", { name: "Settings sections" })).toBeVisible();
  for (const label of ["Phone access", "Autonomy", "Backups", "Channels & devices"]) {
    await page.getByRole("tab", { name: label }).click();
    await expect(page.getByRole("tab", { name: label })).toHaveAttribute("aria-selected", "true");
    const panel = page.getByRole("tabpanel");
    await expect(panel).toBeVisible();
    const state = await panel.evaluate((el) => {
      const s = getComputedStyle(el);
      const moving = document.getAnimations().filter((a) => {
        const t = a.effect?.getComputedTiming();
        return a.playState === "running" && t && Number.isFinite(t.endTime) && Number(t.duration) > 0;
      });
      return { opacity: s.opacity, filter: s.filter, moving: moving.length };
    });
    expect(state).toEqual({ opacity: "1", filter: expect.stringMatching(/^(none|blur\(0px\))$/), moving: 0 });
  }
  await page.context().close();
});

test("approve on a phone-width screen runs the command", async ({ browser, baseURL }) => {
  const page = await open(browser, { width: 375 });
  await page.goto(`${baseURL}/#/chat`);
  await startChat(page);
  const yes = page.getByRole("group", { name: PROCEED }).getByRole("button", { name: /^Yes/ }).first();
  // A tap that lands while the dialog is still opening is lost, so tap again until the prompt closes.
  await expect(async () => {
    await yes.tap({ timeout: 1000 });
    await expect(page.getByRole("group", { name: PROCEED })).toHaveCount(0, { timeout: 1000 });
  }).toPass({ timeout: 8000 });
  // The command ran: the prompt is gone and the model's next turn ("Done.") arrived.
  await expect(page.getByRole("group", { name: PROCEED })).toHaveCount(0);
  await expect(page.getByText("Done.").first()).toBeVisible();
  await page.context().close();
});
