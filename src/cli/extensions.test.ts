// src/cli/extensions.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { DEFAULT_SETTINGS, type Settings } from "../config/settings";
import { skillListing } from "../extensions/skills";
import { ReadState } from "../tools/read-state";
import { createTools } from "../tools/registry";
import { contextExtras, createHookRunner, extraCommands, isCodeConfig, loadExtensions, postWrite, sessionTools, type Extensions } from "./extensions";

let dir: string;
let home: string;
let cwd: string;
beforeEach(async () => {
  dir = await makeTmpDir();
  home = join(dir, "home");
  cwd = join(dir, "proj");
  await mkdir(cwd, { recursive: true });
});
afterEach(() => removeDir(dir));

async function put(path: string, text: string) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
}

const load = (settings: Partial<Settings> = {}) => loadExtensions({ cwd, home, settings: { ...DEFAULT_SETTINGS, ...settings }, env: {}, connect: false });

describe("loadExtensions", () => {
  test("loads project and user commands, skills and agents, plus plugin ones", async () => {
    await put(join(cwd, ".tropos", "commands", "review.md"), "---\ndescription: Review it\n---\nReview $ARGUMENTS");
    await put(join(home, "skills", "deploy", "SKILL.md"), "---\ndescription: Deploy the app\n---\nSteps");
    await put(join(cwd, ".claude", "skills", "help", "SKILL.md"), "---\ndescription: Clashes with /help\n---\nx");
    await put(join(home, "agents", "tester.md"), "---\nname: tester\ndescription: Runs tests\ntools: Read, Bash\n---\nTest things.");
    await put(join(home, "plugins", "kit", "plugin.json"), JSON.stringify({ name: "kit", version: "1.0.0" }));
    await put(join(home, "plugins", "kit", "commands", "ship.md"), "Ship it");
    await put(join(home, "plugins", "kit", "hooks", "hooks.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "true" }] }] } }));
    await put(join(cwd, ".tropos", "commands", "bad name!.md"), "x");
    // A repo command can't replace the user's own, or link to a file outside the project.
    await put(join(home, "commands", "review.md"), "---\ndescription: Mine\n---\nMy review");
    await put(join(dir, "outside.txt"), "AWS_SECRET=x");
    await symlink(join(dir, "outside.txt"), join(cwd, ".tropos", "commands", "leak.md"));
    const ext = await load();
    expect(ext.commands.map((c) => c.name).sort()).toEqual(["kit:ship", "review"]);
    expect(ext.commands.find((c) => c.name === "review")!.source).toBe("user");
    expect(ext.warnings.some((w) => w.includes("leak.md: it links outside the project"))).toBe(true);
    expect(ext.skills.map((s) => [s.name, s.userInvocable])).toEqual([
      ["deploy", true],
      ["help", false],
    ]);
    expect(ext.agents.map((a) => a.name)).toContain("tester");
    expect(ext.agents.map((a) => a.name)).toContain("general-purpose");
    expect(ext.plugins.map((p) => p.name)).toEqual(["kit"]);
    expect(ext.hookConfig.plugins?.map((p) => p.name)).toEqual(["kit"]);
    expect(ext.warnings.some((w) => w.includes("bad name!"))).toBe(true);
    expect(ext.mcp).toBeNull();
    expect(ext.notes).not.toBeNull();
    expect(ext.formatters).toBeNull();
    expect(ext.lsp).toBeNull();
    expect(extraCommands(ext).map((c) => c.name)).toEqual(["deploy", "kit:ship", "review"]);
    expect(extraCommands(ext)[0]!.description).toBe("(skill) Deploy the app");
  });

  test("feature switches", async () => {
    const ext = await load({ memory: false, formatter: true, lsp: { x: { command: ["x"], extensions: [".x"] } } });
    expect(ext.notes).toBeNull();
    expect(ext.formatters).not.toBeNull();
    expect(ext.lsp).not.toBeNull();
  });

  test("MCP servers connect at load, and failures become warnings", async () => {
    const ext = await loadExtensions({
      cwd,
      home,
      settings: { ...DEFAULT_SETTINGS, snapshots: false, mcpServers: { broken: { command: join(dir, "missing-binary") } } },
      env: {},
    });
    try {
      expect(ext.mcp?.status()[0]!.state).toBe("failed");
      expect(ext.warnings.some((w) => w.startsWith("MCP server broken didn't start"))).toBe(true);
    } finally {
      await ext.mcp?.close();
    }
  });
});

describe("sessionTools", () => {
  test("fixed order; Skill only when a skill is model-invocable; Memory only when on", async () => {
    const holder = {};
    const base = createTools({ rgPath: null });
    const names = (ext: Extensions) => sessionTools(base, ext, { home, cwd, holder, sessionId: () => "s" }).map((t) => t.name).slice(base.length);
    expect(names(await load())).toEqual(["WebFetch", "Agent", "Memory", "SessionSearch", "SkillManage"]);
    await put(join(home, "skills", "deploy", "SKILL.md"), "---\ndescription: Deploy\n---\nSteps");
    expect(names(await load({ memory: false }))).toEqual(["WebFetch", "Skill", "Agent", "SessionSearch", "SkillManage"]);
  });

  test("the Agent tool needs a running session", async () => {
    const tools = sessionTools([], await load(), { home, cwd, holder: {}, sessionId: () => "s" });
    const agent = tools.find((t) => t.name === "Agent")!;
    const { makeToolContext } = await import("../../test/helpers/tool-context");
    const out = await agent.run({ description: "d", prompt: "p" }, makeToolContext());
    expect(out.isError).toBe(true);
  });
});

test("context extras: skills listing and notes", async () => {
  await put(join(home, "skills", "deploy", "SKILL.md"), "---\ndescription: Deploy\n---\nSteps");
  const ext = await load();
  await ext.notes!.add("user", "Prefers bun");
  const [skills, notes] = await contextExtras(ext, (s) => skillListing(s));
  expect(skills).toContain("- deploy: Deploy");
  expect(notes).toContain("Prefers bun");
  expect(await contextExtras(await load({ memory: false }), () => "")).toEqual(["", ""]);
});

describe("postWrite", () => {
  test("nothing configured, nothing appended", async () => {
    expect(await postWrite(await load(), new ReadState(), [join(cwd, "a.md")], new AbortController().signal)).toBeNull();
  });

  test("a formatter that changes the file refreshes read-state; a failing one is reported", async () => {
    const script = join(dir, "fmt.sh");
    await writeFile(script, '#!/bin/sh\necho formatted > "$1"\n', { mode: 0o755 });
    const failing = join(dir, "bad.sh");
    await writeFile(failing, "#!/bin/sh\necho nope >&2\nexit 3\n", { mode: 0o755 });
    const ext = await load({
      formatter: {
        fmt: { command: [script, "$FILE"], extensions: [".md"] },
        bad: { command: [failing, "$FILE"], extensions: [".txt"] },
      },
    });
    const file = join(cwd, "a.md");
    await writeFile(file, "x");
    await writeFile(join(cwd, "b.txt"), "y");
    const state = new ReadState();
    const out = await postWrite(ext, state, [file, join(cwd, "b.txt")], new AbortController().signal);
    expect(out).toContain("(formatted with fmt: the file on disk may differ from what you wrote)");
    expect(out).toContain("(formatter bad failed: nope)");
    expect(await readFile(file, "utf8")).toBe("formatted\n");
    const { mtimeMs } = await Bun.file(file).stat();
    expect(state.check(file, mtimeMs)).toBe("ok");
  });

  test("language-server errors are appended", async () => {
    const server = join(import.meta.dir, "..", "..", "test", "helpers", "fake-lsp-server.ts");
    const ext = await load({ lsp: { fake: { command: [process.execPath, server], extensions: [".txt"] } } });
    const file = join(cwd, "a.txt");
    await writeFile(file, "fine\nERROR: broken\n");
    try {
      const out = await postWrite(ext, new ReadState(), [file], new AbortController().signal);
      expect(out).toContain("<diagnostics");
    } finally {
      await ext.lsp?.close();
    }
  });
});

test("a hook runner exists only when some hook is configured", async () => {
  const base = { sessionId: () => "s", transcriptPath: () => "/t", cwd, mode: () => "default", env: {}, shell: "/bin/sh" };
  expect(createHookRunner(await load(), base)).toBeUndefined();
  const ext = await load({ hooks: { Stop: [{ hooks: [{ type: "command", command: "true" }] }] } });
  expect(createHookRunner(ext, base)?.has("Stop")).toBe(true);
});

describe("writing a file formatters or language servers load code from", () => {
  test("only plain source and doc files keep formatters on", () => {
    const risky = [
      "/p/prettier.config.js", "/p/.prettierrc", "/p/.prettierrc.cjs", "/p/package.json", "/p/package.yaml", "/p/tsconfig.build.json",
      "/p/base.json", "/p/node_modules/x/index.js", "/p/NODE_MODULES/x.js", "/p/.cargo/config.toml", "/p/go.mod", "/p/biome.json",
      "/p/.pnp.cjs", "/p/.yarnrc.yml", "/p/.yarn/releases/y.cjs", "/p/Cargo.toml", "/p/build.rs", "/p/deno.jsonc", "/p/.venv/bin/python",
      "/p/vite.config.ts", "/p/Makefile", "/p/.editorconfig",
    ];
    for (const p of risky) expect([p, isCodeConfig(p)]).toEqual([p, true]);
    for (const p of ["/p/src/a.ts", "/p/README.md", "/p/src/App.TSX", "/p/lib/x.py", "/p/main.go", "/p/src/lib.rs"]) expect([p, isCodeConfig(p)]).toEqual([p, false]);
  });

  test("a harmless-looking name that links to a config counts as the config", async () => {
    const real = join(cwd, "prettier.config.js");
    await writeFile(real, "x");
    await symlink(real, join(cwd, "notes.md"));
    expect(isCodeConfig(join(cwd, "notes.md"))).toBe(true);
  });

  test("switches formatting off for the rest of the session", async () => {
    const script = join(dir, "fmt.sh");
    await writeFile(script, '#!/bin/sh\necho formatted > "$1"\n', { mode: 0o755 });
    const ext = await load({ formatter: { fmt: { command: [script, "$FILE"], extensions: [".js", ".md"] } } });
    const config = join(cwd, "prettier.config.js");
    const doc = join(cwd, "a.md");
    await writeFile(config, "x");
    await writeFile(doc, "x");
    const signal = new AbortController().signal;
    expect(await postWrite(ext, new ReadState(), [config], signal)).toContain("off for the rest of this session");
    expect(await readFile(config, "utf8")).toBe("x");
    expect(await postWrite(ext, new ReadState(), [doc], signal)).toBeNull();
    expect(await readFile(doc, "utf8")).toBe("x");
  });
});
