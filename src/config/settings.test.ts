// src/config/settings.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import {
  DEFAULT_SETTINGS,
  SettingsError,
  addLocalAllowRule,
  loadSettings,
  settingsPaths,
  type SettingsPaths,
} from "./settings";

let dir: string;
let paths: SettingsPaths;

async function put(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
}

beforeEach(async () => {
  dir = await makeTmpDir();
  paths = settingsPaths(join(dir, "project"), join(dir, "home"));
});
afterEach(() => removeDir(dir));

describe("settingsPaths", () => {
  test("user, project and local locations", () => {
    expect(paths).toEqual({
      user: join(dir, "home", "settings.json"),
      project: join(dir, "project", ".tropos", "settings.json"),
      local: join(dir, "project", ".tropos", "settings.local.json"),
    });
  });
});

describe("loadSettings", () => {
  test("returns defaults when no files exist", async () => {
    expect(await loadSettings(paths)).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.model).toBe("claude-opus-5-5");
    expect(DEFAULT_SETTINGS.effort).toBe("high");
    expect(DEFAULT_SETTINGS.refusalFallback).toBe(true);
  });

  test("later layers win for scalars; overrides win last", async () => {
    await put(paths.user, { model: "user-model", effort: "low", theme: "dark" });
    await put(paths.project, { model: "project-model" });
    await put(paths.local, { effort: "max" });
    const s = await loadSettings(paths, { theme: "light" });
    expect(s.model).toBe("project-model");
    expect(s.effort).toBe("max");
    expect(s.theme).toBe("light");
  });

  test("permission lists and directories accumulate without duplicates", async () => {
    await put(paths.user, { permissions: { allow: ["Read"], deny: ["Read(.env)"] }, additionalDirectories: ["/a"] });
    await put(paths.project, { permissions: { allow: ["Read", "Bash(bun test:*)"] }, additionalDirectories: ["/b"] });
    const s = await loadSettings(paths, { permissions: { allow: ["Glob"] } });
    expect(s.permissions).toEqual({ allow: ["Read", "Bash(bun test:*)", "Glob"], ask: [], deny: ["Read(.env)"] });
    expect(s.additionalDirectories).toEqual(["/a", "/b"]);
  });

  test("env maps merge", async () => {
    await put(paths.user, { env: { A: "1", B: "1" } });
    await put(paths.project, { env: { B: "2" } });
    expect((await loadSettings(paths)).env).toEqual({ A: "1", B: "2" });
  });

  test("invalid JSON names the file", async () => {
    await put(paths.project, "{ not json");
    const err = await loadSettings(paths).catch((e) => e);
    expect(err).toBeInstanceOf(SettingsError);
    expect(err.path).toBe(paths.project);
    expect(err.message).toContain(paths.project);
  });

  test("wrong types are rejected", async () => {
    await put(paths.user, { effort: "enormous" });
    await expect(loadSettings(paths)).rejects.toBeInstanceOf(SettingsError);
  });

  test("unknown keys are ignored", async () => {
    await put(paths.user, { somethingElse: true });
    expect(await loadSettings(paths)).toEqual(DEFAULT_SETTINGS);
  });
});

describe("addLocalAllowRule", () => {
  test("creates the file and directory", async () => {
    await addLocalAllowRule(paths.local, "Bash(bun test:*)");
    expect(JSON.parse(await readFile(paths.local, "utf8"))).toEqual({ permissions: { allow: ["Bash(bun test:*)"] } });
  });

  test("keeps other keys and does not duplicate", async () => {
    await put(paths.local, { theme: "dark", custom: 1, permissions: { allow: ["Read"], deny: ["X"] } });
    await addLocalAllowRule(paths.local, "Read");
    await addLocalAllowRule(paths.local, "Glob");
    expect(JSON.parse(await readFile(paths.local, "utf8"))).toEqual({
      theme: "dark",
      custom: 1,
      permissions: { allow: ["Read", "Glob"], deny: ["X"] },
    });
  });
});
