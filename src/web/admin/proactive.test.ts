import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { adminWith, failure, makeKit, type Kit } from "./host-testkit";
import { proactiveHandlers } from "./proactive";

const TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1";
let kit: Kit;
beforeEach(async () => {
  kit = await makeKit();
});
afterEach(() => kit.close());
const admin = () => adminWith(kit, proactiveHandlers(kit.ctx));
const gatewayJson = async () => JSON.parse(await readFile(join(kit.home, "gateway.json"), "utf8")) as Record<string, any>;

test("off without Telegram, on by default once a token exists, explicit off wins", async () => {
  const a = admin();
  expect(await a.handle("proactive.get", undefined)).toEqual({
    enabled: false,
    explicit: false,
    telegram: false,
    everyHours: 4,
    maxPerDay: 1,
    activeHours: { start: "09:00", end: "21:00" },
    newProjectsDir: join(kit.userHome, "Projects"),
  });
  await writeFile(join(kit.home, "gateway.json"), JSON.stringify({ telegram: { botToken: TOKEN } }));
  expect(await a.handle("proactive.get", undefined)).toMatchObject({ enabled: true, explicit: false, telegram: true });
  expect(await a.handle("proactive.set", { enabled: false })).toMatchObject({ enabled: false, explicit: true });
  expect(await a.handle("proactive.set", { enabled: null })).toMatchObject({ enabled: true, explicit: false });
  expect((await gatewayJson()).proactive.enabled).toBeUndefined();
  expect((await gatewayJson()).telegram.botToken).toBe(TOKEN);
});

test("sets hours, cadence and the new-projects folder; null goes back to the default; each change reloads the gateway", async () => {
  const a = admin();
  const out = await a.handle("proactive.set", { activeHours: { start: "08:30", end: "20:00" }, everyHours: 6, maxPerDay: 2, newProjectsDir: join(kit.root, "code") });
  expect(out).toMatchObject({ activeHours: { start: "08:30", end: "20:00" }, everyHours: 6, maxPerDay: 2, newProjectsDir: join(kit.root, "code") });
  expect(kit.reloads).toBe(1);
  expect(await a.handle("proactive.set", { newProjectsDir: null })).toMatchObject({ newProjectsDir: join(kit.userHome, "Projects") });
  expect((await gatewayJson()).newProjectsDir).toBeUndefined();
  expect(kit.reloads).toBe(2);
});

test("refuses bad hours and keeps the file as it was", async () => {
  const a = admin();
  await writeFile(join(kit.home, "gateway.json"), JSON.stringify({ proactive: { everyHours: 5 } }));
  const before = await readFile(join(kit.home, "gateway.json"), "utf8");
  expect(await failure(a, "proactive.set", { activeHours: { start: "9", end: "21:00" } })).toContain("proactive.activeHours.start");
  expect(await failure(a, "proactive.set", { everyHours: 99 })).toContain("proactive.everyHours");
  expect(await readFile(join(kit.home, "gateway.json"), "utf8")).toBe(before);
  expect(kit.reloads).toBe(0);
});
