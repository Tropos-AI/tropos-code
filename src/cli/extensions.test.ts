// src/cli/extensions.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeToolContext } from "../../test/helpers/tool-context";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { DEFAULT_SETTINGS, type Settings } from "../config/settings";
import { BOOTSTRAP_TEXT } from "../context/identity";
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
    await put(join(home, "workspace", "skills", "deploy", "SKILL.md"), "---\ndescription: Deploy the app\n---\nSteps");
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

describe("reload", () => {
  test("picks up a skill, a command and an agent written after loading, in the same arrays", async () => {
    const ext = await load();
    const { skills, commands, agents } = ext;
    await put(join(home, "workspace", "skills", "deploy", "SKILL.md"), "---\ndescription: Deploy\n---\nSteps");
    await put(join(home, "commands", "ship.md"), "Ship it");
    await put(join(home, "agents", "reviewer.md"), "---\nname: reviewer\ndescription: Reviews\n---\nReview.");
    await ext.reload();
    expect(ext.skills).toBe(skills);
    expect(ext.commands).toBe(commands);
    expect(ext.agents).toBe(agents);
    expect(skills.map((s) => s.name)).toContain("deploy");
    expect(commands.map((c) => c.name)).toContain("ship");
    expect(agents.map((a) => a.name)).toContain("reviewer");
  });

  test("a skill named like a command still can't be typed after a reload", async () => {
    const ext = await load();
    await put(join(home, "commands", "ship.md"), "Ship it");
    await put(join(home, "workspace", "skills", "ship", "SKILL.md"), "---\ndescription: Ship\n---\nx");
    await ext.reload();
    expect(ext.skills.find((s) => s.name === "ship")!.userInvocable).toBe(false);
  });

  test("the Skill tool of a session made before the skill existed loads it", async () => {
    const ext = await load();
    const base = createTools({ rgPath: null });
    const tools = sessionTools(base, ext, { home, cwd, holder: {}, sessionId: () => "s" });
    const skill = tools.find((t) => t.name === "Skill")!;
    await put(join(home, "workspace", "skills", "deploy", "SKILL.md"), "---\ndescription: Deploy\n---\nSteps");
    await ext.reload();
    const out = await skill.run({ skill: "deploy" }, makeToolContext({ root: cwd }));
    expect(out.isError).toBeUndefined();
  });
});

describe("sessionTools", () => {
  test("fixed order; Skill always (skills may appear later); Memory and DailyNote only when on", async () => {
    const holder = {};
    const base = createTools({ rgPath: null });
    const names = (ext: Extensions) => sessionTools(base, ext, { home, cwd, holder, sessionId: () => "s" }).map((t) => t.name).slice(base.length);
    expect(names(await load())).toEqual(["WebFetch", "Skill", "Agent", "Memory", "DailyNote", "SessionSearch", "SkillManage", "AgentManage", "Identity"]);
    await put(join(home, "workspace", "skills", "deploy", "SKILL.md"), "---\ndescription: Deploy\n---\nSteps");
    expect(names(await load({ memory: false }))).toEqual(["WebFetch", "Skill", "Agent", "SessionSearch", "SkillManage", "AgentManage", "Identity"]);
  });

  test("Memory, SkillManage, DailyNote and Identity record their writes in the ledger with the actor", async () => {
    const ext = await load();
    const tools = sessionTools([], ext, { home, cwd, holder: {}, sessionId: () => "s" });
    const tool = (name: string) => tools.find((t) => t.name === name)!;
    const { makeToolContext } = await import("../../test/helpers/tool-context");
    const ctx = (actor?: "review") => makeToolContext({ root: cwd, ...(actor ? { actor } : {}) });
    expect((await tool("Memory").run({ target: "memory", action: "add", content: "Uses bun" }, ctx())).isError).toBeUndefined();
    const skill = "---\nname: ship\ndescription: Use when shipping\n---\nSteps";
    expect((await tool("SkillManage").run({ action: "create", name: "ship", content: skill }, ctx("review"))).isError).toBeUndefined();
    expect((await tool("DailyNote").run({ text: "Moved the parser" }, ctx())).isError).toBeUndefined();
    expect((await tool("Identity").run({ action: "set", name: "Nova" }, ctx())).isError).toBeUndefined();
    const entries = (await ext.ledger.list()).reverse();
    expect(entries.map((e) => [e.kind, e.actor])).toEqual([
      ["memory", "agent"],
      ["skill", "review"],
      ["daily", "agent"],
      ["identity", "agent"],
    ]);
    expect(entries[0]!.path).toBe(join(home, "workspace", "MEMORY.md"));
    expect(entries[2]).toMatchObject({ action: "append", summary: "daily note", before: null });
    expect(entries[3]).toMatchObject({ path: join(home, "workspace", "IDENTITY.md"), action: "write", summary: expect.stringContaining("Name: Nova") });
    // Undo goes through the same ledger: the identity file is gone again.
    expect(await ext.ledger.undo()).toMatchObject({ ok: true, entry: { kind: "identity" } });
    expect(await readFile(join(home, "workspace", "IDENTITY.md"), "utf8").catch(() => null)).toBeNull();
  });

  test("the Agent tool needs a running session", async () => {
    const tools = sessionTools([], await load(), { home, cwd, holder: {}, sessionId: () => "s" });
    const agent = tools.find((t) => t.name === "Agent")!;
    const { makeToolContext } = await import("../../test/helpers/tool-context");
    const out = await agent.run({ description: "d", prompt: "p" }, makeToolContext());
    expect(out.isError).toBe(true);
  });
});

test("context extras: identity, bootstrap, skills listing, notes and daily notes for the main session", async () => {
  await put(join(home, "workspace", "skills", "deploy", "SKILL.md"), "---\ndescription: Deploy\n---\nSteps");
  const ext = await load();
  await ext.notes!.add("user", "Prefers bun");
  await ext.notes!.add("memory", "Tests are colocated");
  await ext.daily!.append("Moved the parser to src/parse");
  // Without BOOTSTRAP.md (a finished or migrated home) no ritual starts.
  expect((await contextExtras(ext, () => "", { home, scope: "main", bootstrap: true }))[1]).toBe("");
  await put(join(home, "workspace", "BOOTSTRAP.md"), BOOTSTRAP_TEXT);
  const [identity, bootstrap, skills, notes, daily] = await contextExtras(ext, (s) => skillListing(s), { home, scope: "main", bootstrap: true });
  expect(identity).toBe("");
  expect(bootstrap).toContain("<bootstrap>");
  expect(bootstrap).toContain("ask what they'd like to call you");
  expect(skills).toContain("- deploy: Deploy");
  expect(notes).toContain("Prefers bun");
  expect(daily).toContain("Moved the parser");
  // Not interactive (print mode): no bootstrap note.
  expect((await contextExtras(ext, () => "", { home, scope: "main" }))[1]).toBe("");
  // Once the agent has a name, the ritual is over and the identity rides along.
  await put(join(home, "IDENTITY.md"), "- Name: Nova\n- Emoji: 🦊\n");
  const named = await contextExtras(ext, () => "", { home, scope: "main", bootstrap: true });
  expect(named[0]).toContain("Nova");
  expect(named[1]).toBe("");
  expect(await contextExtras(await load({ memory: false }), () => "", { home, scope: "main" })).toEqual([named[0], "", "", "", ""]);
});

test("context extras: a subagent gets the skills and the agent's own notes, not the user profile or daily notes", async () => {
  const ext = await load();
  await ext.notes!.add("user", "Prefers bun");
  await ext.notes!.add("memory", "Tests are colocated");
  await ext.daily!.append("Moved the parser to src/parse");
  await put(join(home, "IDENTITY.md"), "- Name: Nova\n");
  const extras = await contextExtras(ext, () => "<skills>x</skills>", { home, scope: "subagent", bootstrap: true });
  expect(extras).toHaveLength(2);
  expect(extras[1]).toContain("Tests are colocated");
  expect(extras.join("\n")).not.toContain("Prefers bun");
  expect(extras.join("\n")).not.toContain("Nova");
  expect(extras.join("\n")).not.toContain("parser");
  expect(await contextExtras(await load({ memory: false }), () => "", { home, scope: "subagent" })).toEqual(["", ""]);
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

test("reloadAgents picks up an agent file written after startup, in the same list the Agent tool reads", async () => {
  const ext = await load();
  const list = ext.agents;
  expect(list.some((a) => a.name === "george")).toBe(false);
  await put(join(home, "agents", "george.md"), "---\nname: george\ndescription: Researches\nemoji: \"🔬\"\n---\nYou research.");
  await ext.reloadAgents();
  expect(ext.agents).toBe(list);
  expect(list.find((a) => a.name === "george")).toMatchObject({ emoji: "🔬", source: "user" });
  // AgentManage, wired by sessionTools, reloads after it writes.
  const tools = sessionTools([], ext, { home, cwd, holder: {}, sessionId: () => "s" });
  const { makeToolContext } = await import("../../test/helpers/tool-context");
  await tools.find((t) => t.name === "AgentManage")!.run({ action: "create", name: "ana", description: "Analyses", prompt: "You analyse." }, makeToolContext());
  expect(list.some((a) => a.name === "ana")).toBe(true);
});

test("context extras: the setup reminder is appended last, only when there is one", async () => {
  const ext = await load();
  const extras = await contextExtras(ext, () => "", { home, scope: "main", reminder: "<setup-reminder>x</setup-reminder>" });
  expect(extras.at(-1)).toBe("<setup-reminder>x</setup-reminder>");
  expect(await contextExtras(ext, () => "", { home, scope: "main" })).toHaveLength(5);
  expect(await contextExtras(ext, () => "", { home, scope: "main", reminder: "" })).toHaveLength(5);
});
