import { afterEach, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { byId, makeFixture, runOne, type Fixture } from "../testing";
import { settingsCheck } from "./settings";

let fx: Fixture;
afterEach(() => fx?.close());

test("no settings files is fine", async () => {
  fx = await makeFixture();
  const r = await runOne(fx, settingsCheck);
  expect(r.findings[0]).toMatchObject({ level: "ok" });
});

test("valid user settings parse", async () => {
  fx = await makeFixture();
  await fx.write("settings.json", JSON.stringify({ theme: "dark" }));
  const r = await runOne(fx, settingsCheck);
  expect(r.findings[0]!.message).toContain("1 settings file");
});

test("a broken user file and a broken project file are both reported with file and reason", async () => {
  fx = await makeFixture();
  const user = await fx.write("settings.json", "{ nope");
  const project = join(fx.root, ".tropos", "settings.json");
  await Bun.write(project, JSON.stringify({ theme: "purple" }));
  const r = await runOne(fx, settingsCheck);
  expect(r.summary.error).toBe(2);
  const u = r.findings.find((f) => f.id === "settings.parse.user")!;
  expect(u.message).toContain(user);
  expect(u.detail).toBeTruthy();
  const p = r.findings.find((f) => f.id === "settings.parse.project")!;
  expect(p.message).toContain(project);
  expect(p.detail).toContain("theme");
});

test("--fix moves a broken user settings file aside and keeps its valid keys", async () => {
  fx = await makeFixture();
  const path = await fx.write("settings.json", JSON.stringify({ theme: "dark", effort: "turbo" }));
  const plain = await runOne(fx, settingsCheck);
  expect(byId(plain, "settings.parse.user")).toMatchObject({ fixable: true, safe: false, data: { path } });
  const r = await runOne(fx, settingsCheck, { fix: true });
  expect(byId(r, "settings.parse.user")).toMatchObject({ fixed: true });
  expect(byId(r, "settings.parse.user")!.fixMessage).toContain("kept the valid settings; the old file is at ");
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ theme: "dark" });
  expect((await readdir(fx.home)).some((n) => /^settings\.json\.broken-\d{14}$/.test(n))).toBe(true);
});

test("unparsable user settings become {} with a backup; a broken repo file is not fixable", async () => {
  fx = await makeFixture();
  const path = await fx.write("settings.json", "{ nope");
  const project = join(fx.root, ".tropos", "settings.json");
  await Bun.write(project, JSON.stringify({ theme: "purple" }));
  const r = await runOne(fx, settingsCheck, { fix: true });
  expect(byId(r, "settings.parse.user")).toMatchObject({ fixed: true });
  expect(await readFile(path, "utf8")).toBe("{}\n");
  const backup = (await readdir(fx.home)).find((n) => n.startsWith("settings.json.broken-"))!;
  expect(await readFile(join(fx.home, backup), "utf8")).toBe("{ nope");
  const p = byId(r, "settings.parse.project")!;
  expect(p.fixable).toBeUndefined();
  expect(p.fixed).toBeUndefined();
  expect(await readFile(project, "utf8")).toContain("purple");
});
