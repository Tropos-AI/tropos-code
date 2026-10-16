import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { makeFixture, runOne, type Fixture } from "../testing";
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
