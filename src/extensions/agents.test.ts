import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { BUILTIN_AGENTS, loadAgents } from "./agents";
import type { ExtensionDir } from "./sources";

let dir: string;
beforeEach(async () => {
  dir = await makeTmpDir();
});
afterEach(() => removeDir(dir));

async function put(rel: string, text: string): Promise<string> {
  const path = join(dir, rel);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
  return path;
}

test("built-ins come back unchanged when nothing is loaded", async () => {
  const { agents, warnings } = await loadAgents([{ dir: join(dir, "none"), source: "user" }]);
  expect(warnings).toEqual([]);
  expect(agents).toEqual(BUILTIN_AGENTS);
  expect(agents.map((a) => a.name)).toEqual(["general-purpose", "explore", "plan"]);
  expect(BUILTIN_AGENTS[0]!.tools).toBeUndefined();
  expect(BUILTIN_AGENTS[1]!.tools).toEqual(["Read", "Glob", "Grep", "Bash", "WebFetch"]);
  expect(BUILTIN_AGENTS[2]!.tools).toEqual(BUILTIN_AGENTS[1]!.tools);
});

test("loads frontmatter keys; user agents override built-ins, project ones can't", async () => {
  await put("p/reviewer.md", "---\nname: reviewer\ndescription: Reviews\n  code\ntools: Read, Grep\ndisallowedTools: [Bash]\nmodel: claude-opus-4-1\nmaxTurns: 12\n---\n\nBe strict.\n");
  await put("p/nested/explore.md", "---\nname: explore\ndescription: Project explorer\ntools: '*'\nmodel: inherit\n---\nLook around.");
  await put("p/README.md", "# Docs without a name are skipped silently");
  await put("u/explore.md", "---\nname: explore\ndescription: User explorer\n---\nignored");
  await put("plug/helper.md", "---\nname: helper\ndescription: Helps\nmodel: deepseek/chat\nmaxTurns: '7'\n---\nHelp.");
  const dirs: ExtensionDir[] = [
    { dir: join(dir, "u"), source: "user" },
    { dir: join(dir, "p"), source: "project" },
    { dir: join(dir, "plug"), source: "plugin", plugin: "kit" },
  ];
  const { agents, warnings } = await loadAgents(dirs);
  expect(warnings).toEqual([]);
  expect(agents.map((a) => `${a.name}:${a.source}`)).toEqual(["general-purpose:builtin", "explore:user", "plan:builtin", "reviewer:project", "kit:helper:plugin"]);
  expect(agents[1]).toMatchObject({ description: "User explorer", prompt: "ignored", path: join(dir, "u", "explore.md") });
  const projectOnly = await loadAgents([{ dir: join(dir, "p"), source: "project" }]);
  expect(projectOnly.agents.find((a) => a.name === "explore")!.source).toBe("builtin");
  expect(projectOnly.warnings[0]).toContain("a project agent can't replace a built-in one");
  expect(agents[3]).toEqual({
    name: "reviewer",
    description: "Reviews code",
    tools: ["Read", "Grep"],
    disallowedTools: ["Bash"],
    model: "claude-opus-4-1",
    maxTurns: 12,
    prompt: "Be strict.",
    source: "project",
    path: join(dir, "p", "reviewer.md"),
  });
  // A plugin agent may name another provider's model; only project files are restricted.
  expect(agents[4]).toMatchObject({ model: "deepseek/chat", maxTurns: 7 });
});

test("project agents lose non-Anthropic models; bad files become warnings", async () => {
  await put("p/a.md", "---\nname: a\ndescription: A\nmodel: ollama/llama3\nmaxTurns: -2\n---\n");
  await put("p/b.md", "---\nname: b\n---\nno description");
  await put("p/c.md", "---\nname: bad name\ndescription: C\n---\n");
  await put("p/d.md", "---\nname: a\ndescription: duplicate\n---\n");
  const locked = await put("p/e.md", "---\nname: e\ndescription: E\n---\n");
  await put("p/big.md", `---\nname: big\ndescription: Big\n---\n${"x".repeat(210 * 1024)}`);
  await chmod(locked, 0o000);
  const { agents, warnings } = await loadAgents([{ dir: join(dir, "p"), source: "project" }]);
  await chmod(locked, 0o644);
  const a = agents.find((x) => x.name === "a")!;
  expect(a.model).toBeUndefined();
  expect(a.maxTurns).toBeUndefined();
  expect(a.description).toBe("A");
  expect(agents.find((x) => x.name === "b")).toBeUndefined();
  expect(agents.find((x) => x.name === "big")).toBeDefined();
  const text = warnings.join("\n");
  expect(text).toContain('ignores model "ollama/llama3"');
  expect(text).toContain("ignores maxTurns");
  expect(text).toContain("Skipped agent b: no description");
  expect(text).toContain('Skipped agent "bad name"');
  expect(text).toContain("was cut to 200 KB");
  if (process.getuid?.() !== 0) expect(text).toContain("Cannot read agent");
});
