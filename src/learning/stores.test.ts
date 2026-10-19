// src/learning/stores.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { makeToolContext } from "../../test/helpers/tool-context";
import { loadExtensions, sessionTools } from "../cli/extensions";
import { DEFAULT_SETTINGS } from "../config/settings";
import { createTools } from "../tools/registry";
import type { AnyTool } from "../tools/types";
import type { z } from "zod";
import { workspaceOwnPaths } from "../home/layout";
import { agentsDir } from "../paths";
import { STORE_TOOLS, troposStorePaths } from "./stores";

let dir: string;
let outside: string;
beforeEach(async () => {
  dir = await makeTmpDir();
  outside = await makeTmpDir();
});
afterEach(async () => {
  await removeDir(dir);
  await removeDir(outside);
});

test("lists the five tools' stores as canonical paths under the home", async () => {
  const real = join(dir, "real-home");
  await mkdir(real);
  // The home is reached through a link, as /var is on macOS; what is listed is where the files really go.
  await symlink(real, join(dir, "home"));
  expect(STORE_TOOLS).toEqual(["Memory", "DailyNote", "SkillManage", "AgentManage", "Identity"]);
  expect(troposStorePaths(join(dir, "home"))).toEqual([
    ...["memories", "skills", "skills-learned", "IDENTITY.md", "SOUL.md", "identity.json"].map((name) => join(real, name)),
    ...workspaceOwnPaths(real),
    join(real, "agents"),
  ]);
  expect(troposStorePaths(join(dir, "home"))).toContain(agentsDir(real));
});

test("a store that is itself a link is left out, wherever it points", async () => {
  await symlink(outside, join(dir, "skills"));
  await mkdir(join(dir, "elsewhere"));
  await symlink(join(dir, "elsewhere"), join(dir, "agents"));
  await symlink("/etc/hosts", join(dir, "SOUL.md"));
  const paths = troposStorePaths(dir);
  expect(paths).toEqual([
    ...["memories", "skills-learned", "IDENTITY.md", "identity.json"].map((name) => join(dir, name)),
    ...workspaceOwnPaths(dir),
  ]);
});

/** The values of a tool's `action` enum (optional or not); none for a tool without one. */
function actionsOf(tool: AnyTool): string[] {
  let action = (tool.schema as unknown as z.ZodObject).shape?.action as z.ZodType | undefined;
  while (action && "unwrap" in action && typeof action.unwrap === "function") action = action.unwrap() as z.ZodType;
  return action && "options" in action ? (action.options as string[]) : [];
}

test("every delete-like action of every store tool is destructive (keeps asking) or fully undone by the ledger", async () => {
  const home = join(dir, "home");
  const ext = await loadExtensions({ cwd: dir, home, settings: DEFAULT_SETTINGS, env: {}, connect: false });
  const tools = sessionTools(createTools({ rgPath: null }), ext, { home, cwd: dir, holder: {}, sessionId: () => "s" });
  const tool = (name: string) => tools.find((t) => t.name === name)!;
  const ctx = makeToolContext({ root: dir });

  // Each one proves itself: destructive ones by their permission subject, undoable ones by a delete and an undo.
  const checks: Record<string, () => Promise<void>> = {
    "SkillManage.delete": async () => {
      expect(tool("SkillManage").subject({ action: "delete", name: "deploy" }, dir).destructive).toBe(true);
    },
    "Memory.remove": async () => {
      const memory = tool("Memory");
      expect(memory.subject({ target: "memory", action: "remove", old_text: "x" }, dir).destructive).toBeFalsy();
      await memory.run({ target: "memory", action: "add", content: "Tests are colocated" }, ctx);
      const path = memory.subject({ target: "memory", action: "add" }, dir).paths[0]!;
      const before = await readFile(path, "utf8");
      expect((await memory.run({ target: "memory", action: "remove", old_text: "colocated" }, ctx)).isError).toBeFalsy();
      expect(await readFile(path, "utf8")).not.toBe(before);
      expect((await ext.ledger.undo()).ok).toBe(true);
      expect(await readFile(path, "utf8")).toBe(before);
    },
    "AgentManage.delete": async () => {
      const agents = tool("AgentManage");
      // Delete is for single-file agents (specialists are archived, never deleted); create now makes specialists.
      const path = join(home, "agents", "helper.md");
      await mkdir(join(home, "agents"), { recursive: true });
      await writeFile(path, '---\nname: helper\ndescription: "Helps"\n---\n\nHelp out.\n');
      expect(agents.subject({ action: "delete", name: "helper" }, dir).destructive).toBeFalsy();
      const before = await readFile(path, "utf8");
      expect((await agents.run({ action: "delete", name: "helper" }, ctx)).isError).toBeFalsy();
      expect(await readFile(path, "utf8").catch(() => null)).toBeNull();
      expect((await ext.ledger.undo()).ok).toBe(true);
      expect(await readFile(path, "utf8")).toBe(before);
    },
  };
  const deleteLike = STORE_TOOLS.flatMap((name) => actionsOf(tool(name)).filter((a) => /delete|remove|clear|reset|drop|forget|purge/i.test(a)).map((a) => `${name}.${a}`));
  // A new delete-like action (or store tool) must be classified here before it ships.
  expect(deleteLike.sort()).toEqual(Object.keys(checks).sort());
  for (const key of deleteLike) await checks[key]!();
});

test("store paths cover the workspace layout and keep the legacy ones", () => {
  const paths = troposStorePaths(dir);
  for (const p of [...workspaceOwnPaths(dir), join(dir, "agents")]) expect(paths).toContain(p);
  expect(paths).not.toContain(join(dir, "workspace"));
  for (const name of ["memories", "skills", "skills-learned", "IDENTITY.md", "SOUL.md"]) expect(paths).toContain(join(dir, name));
});

test("a workspace that is a link contributes no store", async () => {
  await symlink(outside, join(dir, "workspace"));
  expect(troposStorePaths(dir).filter((p) => p.includes("/workspace"))).toEqual([]);
});
