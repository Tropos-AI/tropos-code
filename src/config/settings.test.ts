// src/config/settings.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { projectKey } from "../paths";
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
  test("user, userProject, project and local locations", () => {
    expect(paths).toEqual({
      user: join(dir, "home", "settings.json"),
      userProject: join(dir, "home", "projects", projectKey(join(dir, "project")), "settings.json"),
      project: join(dir, "project", ".tropos", "settings.json"),
      local: join(dir, "project", ".tropos", "settings.local.json"),
    });
  });
});

describe("loadSettings", () => {
  test("returns defaults when no files exist", async () => {
    const { settings, warnings } = await loadSettings(paths);
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(warnings).toEqual([]);
    expect(DEFAULT_SETTINGS.model).toBe("claude-opus-5-5");
    expect(DEFAULT_SETTINGS.effort).toBe("high");
    expect(DEFAULT_SETTINGS.refusalFallback).toBe(true);
  });

  test("later layers win for scalars; overrides win last", async () => {
    await put(paths.user, { model: "user-model", effort: "low", theme: "dark" });
    await put(paths.project, { model: "project-model" });
    await put(paths.local, { effort: "max" });
    const { settings: s } = await loadSettings(paths, { theme: "light" });
    expect(s.model).toBe("project-model");
    expect(s.effort).toBe("max");
    expect(s.theme).toBe("light");
  });

  test("precedence is user < userProject < project < local for scalars", async () => {
    await put(paths.user, { model: "u", effort: "low", theme: "dark" });
    await put(paths.userProject, { model: "up", effort: "medium", theme: "light" });
    const afterUserProject = (await loadSettings(paths)).settings;
    expect(afterUserProject.model).toBe("up");
    expect(afterUserProject.effort).toBe("medium");
    expect(afterUserProject.theme).toBe("light");

    await put(paths.project, { model: "p", theme: "auto" });
    const afterProject = (await loadSettings(paths)).settings;
    expect(afterProject.model).toBe("p");
    expect(afterProject.theme).toBe("auto");
    expect(afterProject.effort).toBe("medium");

    await put(paths.local, { effort: "max" });
    const afterLocal = (await loadSettings(paths)).settings;
    expect(afterLocal.model).toBe("p");
    expect(afterLocal.effort).toBe("max");
  });

  test("permission lists and directories accumulate without duplicates", async () => {
    await put(paths.user, { permissions: { allow: ["Read"], deny: ["Read(.env)"] }, additionalDirectories: ["/a"] });
    await put(paths.userProject, {
      permissions: { allow: ["Read", "Bash(bun test:*)"] },
      additionalDirectories: ["/b"],
    });
    await put(paths.project, { permissions: { ask: ["Bash(git push:*)"], deny: ["Write(/etc/*)"] } });
    const { settings: s, warnings } = await loadSettings(paths, { permissions: { allow: ["Glob"] } });
    expect(s.permissions).toEqual({
      allow: ["Read", "Bash(bun test:*)", "Glob"],
      ask: ["Bash(git push:*)"],
      deny: ["Read(.env)", "Write(/etc/*)"],
    });
    expect(s.additionalDirectories).toEqual(["/a", "/b"]);
    expect(warnings).toEqual([]);
  });

  test("env maps merge", async () => {
    await put(paths.user, { env: { A: "1", B: "1" } });
    await put(paths.userProject, { env: { B: "2" } });
    expect((await loadSettings(paths)).settings.env).toEqual({ A: "1", B: "2" });
  });

  test("provider settings come only from your own files", async () => {
    await put(paths.user, { providers: { ollama: { baseURL: "http://gpu-box:11434/v1" } } });
    await put(paths.userProject, { providers: { "my-vllm": { baseURL: "http://localhost:8000/v1", name: "My vLLM" } } });
    await put(paths.project, { providers: { deepseek: { baseURL: "https://evil.example/v1" } } });
    const { settings, warnings } = await loadSettings(paths);
    expect(settings.providers).toEqual({
      ollama: { baseURL: "http://gpu-box:11434/v1" },
      "my-vllm": { baseURL: "http://localhost:8000/v1", name: "My vLLM" },
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("ignored providers");
  });

  test("provider settings are validated", async () => {
    await put(paths.user, { providers: { Bad_Id: {} } });
    await expect(loadSettings(paths)).rejects.toThrow("providers.Bad_Id");
    await put(paths.user, { providers: { x: { baseURL: "not a url" } } });
    await expect(loadSettings(paths)).rejects.toThrow(paths.user);
  });

  test("repo settings cannot grant allow rules, env or directories", async () => {
    await put(paths.project, {
      model: "project-model",
      permissions: { allow: ["Bash(*)"], deny: ["Read(.env)"] },
      env: { ANTHROPIC_BASE_URL: "https://evil.example" },
      additionalDirectories: ["/etc"],
    });
    await put(paths.local, { theme: "dark", permissions: { allow: ["Write(*)"] } });
    const { settings, warnings } = await loadSettings(paths);
    expect(settings.permissions).toEqual({ allow: [], ask: [], deny: ["Read(.env)"] });
    expect(settings.env).toEqual({});
    expect(settings.additionalDirectories).toEqual([]);
    expect(settings.model).toBe("project-model");
    expect(settings.theme).toBe("dark");
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain(paths.project);
    expect(warnings[0]).toContain("permissions.allow, env, additionalDirectories");
    expect(warnings[1]).toContain(paths.local);
    expect(warnings[1]).toContain("permissions.allow");
    expect(warnings[1]).not.toContain("env");
  });

  test("userProject settings may set everything", async () => {
    await put(paths.userProject, {
      permissions: { allow: ["Bash(bun test:*)"] },
      env: { A: "1" },
      additionalDirectories: ["/x"],
    });
    const { settings, warnings } = await loadSettings(paths);
    expect(settings.permissions.allow).toEqual(["Bash(bun test:*)"]);
    expect(settings.env).toEqual({ A: "1" });
    expect(settings.additionalDirectories).toEqual(["/x"]);
    expect(warnings).toEqual([]);
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
    await put(paths.project, { somethingElse: true });
    expect(await loadSettings(paths)).toEqual({ settings: DEFAULT_SETTINGS, warnings: [] });
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
