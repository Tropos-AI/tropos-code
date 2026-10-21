// src/harness/tree.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SYSTEM_PROMPT } from "../context/system-prompt";
import { ALWAYS_ON_CHARS, runsCode, surfaceKind } from "./surface";
import { assembleSystem, diffTrees, globalHarnessDir, harnessWarnings, loadHarness, projectHarnessDir, readLayer, renderTreeDiff } from "./tree";

let home: string;
const cwd = "/work/app";

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "tcode-harness-"));
});
afterEach(() => rm(home, { recursive: true, force: true }));

async function put(dir: string, path: string, text: string): Promise<void> {
  await mkdir(dirname(join(dir, path)), { recursive: true });
  await writeFile(join(dir, path), text);
}

describe("surfaceKind", () => {
  test("always-on files, skills, scripts, agents and hooks; nothing else", () => {
    expect(surfaceKind("system.md")).toBe("always-on");
    expect(surfaceKind("guardrails.md")).toBe("always-on");
    expect(surfaceKind("tool-guidance.md")).toBe("always-on");
    expect(surfaceKind("skills/bun-tests/SKILL.md")).toBe("skill");
    expect(surfaceKind("scripts/check-diff.py")).toBe("script");
    expect(surfaceKind("agents/reviewer.md")).toBe("agent");
    expect(surfaceKind("hooks.json")).toBe("hooks");
    for (const off of ["settings.json", "MEMORY.md", "skills/x/notes.md", "skills/Big/SKILL.md", "scripts/a/b.py", "../system.md", "agents/.md", "sub/system.md"]) {
      expect(surfaceKind(off)).toBeNull();
    }
  });

  test("scripts and hooks run code", () => {
    expect(runsCode("script")).toBe(true);
    expect(runsCode("hooks")).toBe(true);
    expect(runsCode("always-on")).toBe(false);
    expect(runsCode("skill")).toBe(false);
  });
});

describe("loadHarness", () => {
  test("with no overlays the prompt is the built-in one, byte for byte", async () => {
    const harness = await loadHarness({ home, cwd });
    expect(harness.system).toBe(SYSTEM_PROMPT);
    expect(harness.layers.map((l) => [l.name, l.applied, l.problems.length])).toEqual([
      ["base", true, 0],
      ["global", true, 0],
      ["project", true, 0],
    ]);
    expect(harnessWarnings(harness)).toEqual([]);
  });

  test("overlays replace files one by one and the always-on files join in order", async () => {
    const base = new Map([["system.md", "You are T.\n"]]);
    await put(globalHarnessDir(home), "guardrails.md", "Run the tests.\n\n");
    await put(globalHarnessDir(home), "tool-guidance.md", "Read before Edit.");
    await put(projectHarnessDir(home, cwd), "guardrails.md", "Run bun test.");
    const harness = await loadHarness({ home, cwd, base });
    expect(harness.system).toBe("You are T.\n\nRun bun test.\n\nRead before Edit.");
    expect(harness.layers.find((l) => l.name === "global")!.files).toEqual(["guardrails.md", "tool-guidance.md"]);
  });

  test("another project's overlay doesn't apply", async () => {
    await put(projectHarnessDir(home, "/work/other"), "guardrails.md", "Elsewhere only.");
    expect((await loadHarness({ home, cwd })).system).toBe(SYSTEM_PROMPT);
    expect(projectHarnessDir(home, "/a/b-c")).not.toBe(projectHarnessDir(home, "/a-b/c"));
  });

  test("a layer over the always-on budget is skipped whole; the layers below still apply", async () => {
    const base = new Map([["system.md", "S"]]);
    await put(globalHarnessDir(home), "guardrails.md", "G");
    await put(projectHarnessDir(home, cwd), "guardrails.md", "P");
    await put(projectHarnessDir(home, cwd), "tool-guidance.md", "x".repeat(ALWAYS_ON_CHARS));
    const harness = await loadHarness({ home, cwd, base });
    expect(harness.system).toBe("S\n\nG");
    const project = harness.layers.find((l) => l.name === "project")!;
    expect(project.applied).toBe(false);
    expect(project.problems[0]).toContain("over the 24000 limit; layer skipped");
    expect(harnessWarnings(harness)[0]).toStartWith("harness (project): ");
  });

  test("an overlay that empties system.md is skipped", async () => {
    await put(globalHarnessDir(home), "system.md", "  \n");
    const harness = await loadHarness({ home, cwd });
    expect(harness.system).toBe(SYSTEM_PROMPT);
    expect(harness.layers[1]!.problems).toEqual(["system.md is empty; layer skipped"]);
  });
});

describe("readLayer", () => {
  test("a missing folder is an empty layer", async () => {
    expect(await readLayer(join(home, "none"))).toEqual({ tree: new Map(), problems: [] });
  });

  test("files off the surface and links are left out and named", async () => {
    const dir = globalHarnessDir(home);
    await put(dir, "guardrails.md", "ok");
    await put(dir, "skills/bun-tests/SKILL.md", "skill");
    await put(dir, "settings.json", "{}");
    await put(home, "secret.txt", "key");
    await symlink(join(home, "secret.txt"), join(dir, "tool-guidance.md"));
    const { tree, problems } = await readLayer(dir);
    expect([...tree.keys()]).toEqual(["guardrails.md", "skills/bun-tests/SKILL.md"]);
    expect(problems).toEqual(["settings.json: not a harness file; ignored", "tool-guidance.md: not a plain file; ignored"]);
  });
});

describe("diff", () => {
  test("names added, changed and removed files, and renders a patch per file", () => {
    const from = new Map([["system.md", "a\n"], ["guardrails.md", "g\n"]]);
    const to = new Map([["system.md", "b\n"], ["skills/x/SKILL.md", "s\n"]]);
    expect(diffTrees(from, to)).toEqual([
      { path: "guardrails.md", change: "removed" },
      { path: "skills/x/SKILL.md", change: "added" },
      { path: "system.md", change: "changed" },
    ]);
    const patch = renderTreeDiff(from, to);
    expect(patch).toContain("--- a/system.md");
    expect(patch).toContain("-a\n+b");
    expect(renderTreeDiff(from, from)).toBe("");
  });

  test("assembleSystem drops empty always-on files", () => {
    expect(assembleSystem(new Map([["system.md", "S\n"], ["guardrails.md", "\n"]]))).toBe("S");
  });
});
