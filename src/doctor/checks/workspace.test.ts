import { afterEach, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fakeRunner, makeFixture, runOne, type Fixture } from "../testing";
import { workspaceCheck } from "./workspace";

let fx: Fixture;
afterEach(() => fx?.close());

const projects = (list: Array<{ id: string; path: string }>) => fakeRunner({ listProjects: async () => list.map((p) => ({ ...p, name: p.id })) });

test("no projects is informational", async () => {
  fx = await makeFixture();
  expect((await runOne(fx, workspaceCheck)).findings[0]!.level).toBe("info");
});

test("each project is judged on its own: ok, no .git, missing, and the home directory", async () => {
  fx = await makeFixture();
  const good = join(fx.root, "good");
  const nogit = join(fx.root, "nogit");
  await mkdir(join(good, ".git"), { recursive: true });
  await mkdir(nogit);
  const r = await runOne(fx, workspaceCheck, {
    runner: projects([
      { id: "good", path: good },
      { id: "nogit", path: nogit },
      { id: "gone", path: join(fx.root, "gone") },
      { id: "home", path: fx.userHome },
    ]),
  });
  const level = (id: string) => r.findings.find((f) => f.id === `workspace.projects.${id}`)!.level;
  expect(level("good")).toBe("ok");
  expect(level("nogit")).toBe("warn");
  expect(level("gone")).toBe("error");
  expect(level("home")).toBe("error");
  expect(r.findings.find((f) => f.id.endsWith(".home"))!.message).toContain("home directory");
});

test("a project inside the data directory is refused", async () => {
  fx = await makeFixture();
  const inside = join(fx.home, "workspace");
  await mkdir(join(inside, ".git"), { recursive: true });
  const r = await runOne(fx, workspaceCheck, { runner: projects([{ id: "default", path: inside }]) });
  expect(r.findings[0]!.level).toBe("error");
});

test("the built-in default project may not exist yet", async () => {
  fx = await makeFixture();
  const path = join(fx.home, "workspace");
  const runner = fakeRunner({ listProjects: async () => [{ id: "default", name: "default", path, builtin: true }] });
  expect((await runOne(fx, workspaceCheck, { runner })).findings[0]!.level).toBe("ok");
});

test("the built-in managed workspace lives in the data directory by design and is not an error", async () => {
  fx = await makeFixture();
  const path = join(fx.home, "workspace");
  await mkdir(join(path, ".git"), { recursive: true });
  const runner = fakeRunner({ listProjects: async () => [{ id: "default", name: "default", path, builtin: true }] });
  expect((await runOne(fx, workspaceCheck, { runner })).findings[0]!.level).toBe("ok");
});
