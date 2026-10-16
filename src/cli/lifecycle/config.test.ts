// src/cli/lifecycle/config.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import run from "./config";
import { makeFixture, type Fixture } from "./lifecycle-fixture";

let f: Fixture;
beforeEach(async () => {
  f = await makeFixture();
  await mkdir(f.ctx.home, { recursive: true });
});
afterEach(() => f.cleanup());

const settings = () => join(f.ctx.home, "settings.json");

describe("tcode config", () => {
  test("set parses JSON, validates, prints before/after and keeps a backup", async () => {
    await writeFile(settings(), JSON.stringify({ theme: "light" }));
    expect(await run(["set", "theme", '"dark"'], f.ctx)).toBe(0);
    expect(f.stdout()).toContain('before: "light"');
    expect(f.stdout()).toContain('after:  "dark"');
    expect(JSON.parse(await readFile(`${settings()}.bak`, "utf8"))).toEqual({ theme: "light" });
    expect(await run(["set", "snapshots", "false"], f.ctx)).toBe(0);
    expect(JSON.parse(await readFile(settings(), "utf8")).snapshots).toBe(false);
    expect(await run(["set", "model", "some-model"], f.ctx)).toBe(0);
    expect(JSON.parse(await readFile(settings(), "utf8")).model).toBe("some-model");
  });

  test("set with an invalid value fails and changes nothing", async () => {
    await writeFile(settings(), JSON.stringify({ theme: "light" }));
    expect(await run(["set", "theme", "purple"], f.ctx)).toBe(1);
    expect(f.stderr()).toContain("theme");
    expect(JSON.parse(await readFile(settings(), "utf8"))).toEqual({ theme: "light" });
  });

  test("get, unset and show (secrets masked)", async () => {
    await writeFile(settings(), JSON.stringify({ theme: "dark", env: { MY_API_KEY: "hunter2" }, providers: { x: { baseURL: "https://x.test" } } }));
    expect(await run(["get", "theme"], f.ctx)).toBe(0);
    expect(f.stdout()).toBe("dark\n");
    expect(await run(["get", "nope"], f.ctx)).toBe(1);
    expect(await run(["get", "env.MY_API_KEY"], f.ctx)).toBe(0);
    expect(f.stdout()).not.toContain("hunter2");
    expect(await run(["show", "--json"], f.ctx)).toBe(0);
    expect(f.stdout()).not.toContain("hunter2");
    expect(await run(["unset", "theme"], f.ctx)).toBe(0);
    expect(JSON.parse(await readFile(settings(), "utf8")).theme).toBeUndefined();
    expect(JSON.parse(await readFile(settings(), "utf8")).env.MY_API_KEY).toBe("hunter2");
  });

  test("gateway file uses the same commands", async () => {
    expect(await run(["set", "--file", "gateway", "idleMinutes", "5"], f.ctx)).toBe(0);
    expect(JSON.parse(await readFile(join(f.ctx.home, "gateway.json"), "utf8"))).toEqual({ idleMinutes: 5 });
    expect(await run(["set", "--file", "gateway", "idleMinutes", "0"], f.ctx)).toBe(1);
  });

  test("validate names the file and the reason, exit 1", async () => {
    await writeFile(settings(), JSON.stringify({ effort: "ludicrous" }));
    expect(await run(["validate"], f.ctx)).toBe(1);
    expect(f.stderr()).toContain(settings());
    expect(f.stderr()).toContain("effort");
    expect(await run(["validate", "--file", "gateway"], f.ctx)).toBe(0);
  });

  test("path, schema and usage errors", async () => {
    expect(await run(["path", "--file", "gateway"], f.ctx)).toBe(0);
    expect(f.stdout()).toBe(`${join(f.ctx.home, "gateway.json")}\n`);
    expect(await run(["schema"], f.ctx)).toBe(0);
    expect(JSON.parse(f.stdout().slice(f.stdout().indexOf("{\n  \"$schema"))).type).toBe("object");
    expect(await run(["bogus"], f.ctx)).toBe(64);
    expect(await run(["set", "a"], f.ctx)).toBe(64);
    expect(await run(["show", "--file", "x"], f.ctx)).toBe(64);
    expect(await run([], f.ctx)).toBe(64);
    expect(await run(["--help"], f.ctx)).toBe(0);
  });
});
