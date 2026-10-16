// src/gateway/projects.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { loadGatewayConfig, saveGatewayConfig } from "./config";
import {
  ProjectError,
  addProject,
  defaultProjectId,
  ensureDefaultProject,
  getProject,
  listProjects,
  projectForChat,
  removeProject,
  setDefaultProject,
  withTemporaryProject,
  fileProjectSource,
} from "./projects";
import { ChatRouter } from "./router";

let dir: string;
let home: string;
let userHome: string;
beforeEach(async () => {
  dir = await makeTmpDir("gateway-projects");
  home = join(dir, "tropos");
  userHome = join(dir, "user");
  await mkdir(home, { recursive: true });
  await mkdir(join(userHome, "code", "app"), { recursive: true });
  await mkdir(join(userHome, "code", "other"), { recursive: true });
});
afterEach(() => removeDir(dir));

const deps = () => ({ cwd: userHome, userHome });

describe("the built-in default project", () => {
  test("is always listed first, even before it exists on disk", async () => {
    const list = await listProjects(home);
    expect(list).toEqual([{ id: "default", name: "Default workspace", path: join(home, "workspace"), builtin: true }]);
    expect(existsSync(join(home, "workspace"))).toBe(false);
  });

  test("ensureDefaultProject creates the directory, runs git init and writes a README once", async () => {
    const inited: string[] = [];
    const project = await ensureDefaultProject(home, { git: async (d) => void inited.push(d) });
    expect(project.path).toBe(join(home, "workspace"));
    expect(inited).toEqual([project.path]);
    expect(await readFile(join(project.path, "README.md"), "utf8")).toContain("Tropos");

    await writeFile(join(project.path, "README.md"), "mine");
    await ensureDefaultProject(home, { git: async () => {} });
    expect(await readFile(join(project.path, "README.md"), "utf8")).toBe("mine");
  });

  test("an existing .git is left alone, and a failing git doesn't fail the project", async () => {
    await mkdir(join(home, "workspace", ".git"), { recursive: true });
    const calls: string[] = [];
    await ensureDefaultProject(home, { git: async (d) => void calls.push(d) });
    expect(calls).toEqual([]);

    await removeDir(join(home, "workspace"));
    const project = await ensureDefaultProject(home, {
      git: async () => {
        throw new Error("no git");
      },
    });
    expect(existsSync(project.path)).toBe(true);
  });

  test("with the real git it makes a repository", async () => {
    if (!Bun.which("git")) return;
    await ensureDefaultProject(home);
    expect(existsSync(join(home, "workspace", ".git"))).toBe(true);
  });
});

describe("addProject", () => {
  test("registers a directory under an id slugged from its name", async () => {
    const project = await addProject(home, { path: "code/app", name: "My App!" }, deps());
    expect(project).toEqual({ id: "my-app", name: "My App!", path: join(userHome, "code", "app") });
    expect((await listProjects(home)).map((p) => p.id)).toEqual(["default", "my-app"]);
    expect(await getProject(home, "my-app")).toEqual(project);
  });

  test("the name defaults to the directory's, and a taken id gets a number", async () => {
    await mkdir(join(userHome, "elsewhere", "app"), { recursive: true });
    const a = await addProject(home, { path: join(userHome, "code", "app") }, deps());
    const b = await addProject(home, { path: join(userHome, "elsewhere", "app") }, deps());
    expect([a.id, b.id]).toEqual(["app", "app-2"]);
  });

  test("a name that slugs to a reserved id doesn't take it", async () => {
    expect((await addProject(home, { path: join(userHome, "code", "app"), name: "default" }, deps())).id).toBe("default-2");
  });

  test("is canonical: a symlink is the same project as its target", async () => {
    await symlink(join(userHome, "code", "app"), join(userHome, "link"));
    const first = await addProject(home, { path: join(userHome, "link") }, deps());
    expect(first.path).toBe(join(userHome, "code", "app"));
    await expect(addProject(home, { path: join(userHome, "code", "app") }, deps())).rejects.toThrow(/already the project "app"/);
    expect((await addProject(home, { path: join(userHome, "code", "app") }, { ...deps(), reuse: true })).id).toBe("app");
  });

  test("refuses what doesn't exist, a file, and anything that holds credentials or Tropos's data", async () => {
    await expect(addProject(home, { path: join(userHome, "nope") }, deps())).rejects.toThrow(/doesn't exist/);
    await writeFile(join(userHome, "file.txt"), "x");
    await expect(addProject(home, { path: join(userHome, "file.txt") }, deps())).rejects.toThrow(/not a directory/);
    await expect(addProject(home, { path: userHome }, deps())).rejects.toThrow(/home directory/);
    await expect(addProject(home, { path: home }, deps())).rejects.toThrow(ProjectError);
    await ensureDefaultProject(home, { git: async () => {} });
    await expect(addProject(home, { path: join(home, "workspace") }, deps())).rejects.toThrow(ProjectError);
    expect((await listProjects(home)).map((p) => p.id)).toEqual(["default"]);
  });
});

describe("removeProject / setDefaultProject", () => {
  test("remove drops a project, never the built-in, and resets a default that pointed at it", async () => {
    await addProject(home, { path: join(userHome, "code", "app") }, deps());
    await setDefaultProject(home, "app");
    expect(await defaultProjectId(home)).toBe("app");
    await removeProject(home, "app");
    expect(await defaultProjectId(home)).toBe("default");
    expect((await loadGatewayConfig(home)).defaultProject).toBe("default");
    await expect(removeProject(home, "default")).rejects.toThrow(/built in/);
    await expect(removeProject(home, "app")).rejects.toThrow(/no project/);
  });

  test("the default must exist; a default that was deleted by hand falls back", async () => {
    await expect(setDefaultProject(home, "ghost")).rejects.toThrow(/no project/);
    await saveGatewayConfig(home, { ...(await loadGatewayConfig(home)), defaultProject: "ghost" });
    expect(await defaultProjectId(home)).toBe("default");
  });
});

describe("withTemporaryProject", () => {
  test("adds a one-run project that is the default for the run and isn't saved", async () => {
    const temp = { id: "cwd", name: "scratch", path: join(userHome, "code", "app") };
    const source = withTemporaryProject(fileProjectSource(home), temp);
    expect((await source.list()).map((p) => p.id)).toEqual(["default", "cwd"]);
    expect(await source.defaultId()).toBe("cwd");
    expect(await source.get("cwd")).toEqual(temp);
    expect((await listProjects(home)).map((p) => p.id)).toEqual(["default"]);
  });
});

describe("projectForChat", () => {
  test("is the chat's choice, else the default project", async () => {
    await addProject(home, { path: join(userHome, "code", "app") }, deps());
    expect((await projectForChat(home, "telegram:1")).id).toBe("default");
    await new ChatRouter({ home }).select("telegram:1", "app");
    expect((await projectForChat(home, "telegram:1")).id).toBe("app");
    expect((await projectForChat(home, "telegram:2")).id).toBe("default");
  });
});
