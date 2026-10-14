import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProviderRouter } from "../providers/router";
import { FakeModel, reply, textBlock } from "../../test/helpers/fake-model";
import type { PermissionAnswer, PermissionPrompt } from "../agent/events";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { DEFAULT_SETTINGS, type Settings } from "../config/settings";
import { compileRules } from "../permissions/engine";
import { SessionStore } from "../session/store";
import { createTools } from "../tools/registry";
import { DARK } from "../ui/theme";
import { loadExtensions } from "./extensions";
import { createRuntime, type AppContext } from "./runtime";

let dir: string;
let ctx: AppContext;
beforeEach(async () => {
  dir = await makeTmpDir();
  // ctx.settings is replaced per test, never mutated.
  ctx = {
    cwd: dir,
    home: join(dir, ".home"),
    version: "0.1.0",
    settings: DEFAULT_SETTINGS,
    rules: compileRules({ allow: [], ask: [], deny: [] }).rules,
    allowedDirs: [dir],
    tools: createTools({ rgPath: null }),
    model: new FakeModel([]),
    providers: new ProviderRouter({ home: join(dir, ".home"), env: {}, settings: {} }),
    shell: "/bin/bash",
    localSettingsPath: join(dir, ".home", "projects", "p", "settings.json"),
    ext: await loadExtensions({ cwd: dir, home: join(dir, ".home"), settings: DEFAULT_SETTINGS, env: {}, connect: false }),
    subagents: {},
    env: {},
  };
});
afterEach(() => removeDir(dir));

async function runtime() {
  const session = await SessionStore.create(ctx.home, { cwd: dir, model: "m", version: "v" });
  return { session, runtime: await createRuntime(ctx, { session, history: [], mode: "default", modes: ["default", "acceptEdits", "plan"], theme: DARK }) };
}

test("mode, model and effort changes are recorded as session events", async () => {
  const { session, runtime: rt } = await runtime();
  rt.setMode("plan");
  rt.setEffort("max");
  await Bun.sleep(20);
  const lines = (await readFile(session.path, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  expect(lines.filter((l) => l.type === "event").map((l) => [l.name, l.value])).toEqual([
    ["mode", "plan"],
    ["effort", "max"],
  ]);
  expect(rt.state()).toMatchObject({ mode: "plan", effort: "max" });
});

test("clear starts a new session", async () => {
  const { runtime: rt } = await runtime();
  await rt.clear();
  expect(rt.history()).toEqual([]);
});

test("input history is saved per project and reloaded", async () => {
  const { runtime: first } = await runtime();
  first.recordInput("run the tests");
  await Bun.sleep(20);
  const { runtime: second } = await runtime();
  expect(second.inputHistory()).toEqual(["run the tests"]);
});

describe("extensions in the runtime", () => {
  const writeFileAt = async (path: string, text: string) => {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, text);
  };
  const ui = (answer: "allow" | "deny", asked: string[] = []) => ({
    askPermission: async (p: PermissionPrompt): Promise<PermissionAnswer> => {
      asked.push(p.summary);
      return { kind: answer };
    },
  });
  const signal = () => new AbortController().signal;

  async function withExt(settings: Partial<Settings> = {}) {
    ctx.settings = { ...DEFAULT_SETTINGS, ...settings };
    ctx.ext = await loadExtensions({ cwd: dir, home: ctx.home, settings: ctx.settings, env: {}, connect: false });
  }

  test("custom commands expand !`cmd` (asking first) and @file, and keep the typed args", async () => {
    await writeFileAt(join(dir, ".tropos", "commands", "review.md"), "---\nmodel: claude-haiku-5-5\nagent: explore\n---\nReview $1 with !`echo hi` and @notes.txt.");
    await writeFile(join(dir, "notes.txt"), "NOTES");
    await withExt();
    const { runtime: rt } = await runtime();
    const asked: string[] = [];
    const out = await rt.expandCommand("review", "main", ui("allow", asked), signal());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(asked).toEqual(["echo hi"]);
    expect(out.prompt).toStartWith('<command name="/review" args="main" source="project">');
    expect(out.prompt).toContain("Review main with hi");
    expect(out.prompt).toContain("NOTES");
    expect(out.prompt).toContain('subagent_type: "explore"');
    expect(out.model).toBe("claude-haiku-5-5");
    const declined = await rt.expandCommand("review", "", ui("deny"), signal());
    expect(declined).toEqual({ ok: false, reason: "you declined `echo hi`" });
  });

  test("repo commands can't pick another provider; deny rules and outside files are respected", async () => {
    await writeFileAt(join(dir, ".tropos", "commands", "x.md"), "---\nmodel: openai/gpt-x\n---\n!`rm -rf /tmp/nothing` @/etc/hosts @secret.env @missing.txt");
    await writeFile(join(dir, "secret.env"), "KEY=1");
    await withExt();
    ctx.rules = compileRules({ allow: [], ask: [], deny: ["Bash(rm:*)", "Read(secret.env)"] }).rules;
    const { runtime: rt } = await runtime();
    expect(await rt.expandCommand("x", "", ui("allow"), signal())).toMatchObject({ ok: false, reason: "Blocked by the deny rule Bash(rm:*)." });
    await writeFileAt(join(dir, ".tropos", "commands", "y.md"), "---\nmodel: openai/gpt-x\n---\nSee @/etc/hosts, @secret.env and @missing.txt.");
    await withExt();
    const { runtime: rt2 } = await runtime();
    const out = await rt2.expandCommand("y", "", ui("allow"), signal());
    expect(out).toEqual({ ok: true, prompt: '<command name="/y" source="project">\nSee @/etc/hosts, @secret.env and @missing.txt.\n</command>', model: undefined });
  });

  test("allowed commands run without asking; skills expand; unknown names fail", async () => {
    await writeFileAt(join(dir, ".tropos", "commands", "date.md"), "Today: !`echo 2026`");
    await writeFileAt(join(ctx.home, "skills", "deploy", "SKILL.md"), "---\ndescription: Deploy\n---\nDeploy from ${TROPOS_SKILL_DIR}");
    await withExt();
    ctx.rules = compileRules({ allow: ["Bash(echo:*)"], ask: [], deny: [] }).rules;
    const { runtime: rt } = await runtime();
    const asked: string[] = [];
    expect(await rt.expandCommand("date", "", ui("deny", asked), signal())).toMatchObject({ ok: true });
    expect(asked).toEqual([]);
    const skill = await rt.expandCommand("deploy", "prod", ui("allow"), signal());
    expect(skill.ok && skill.prompt).toContain(`Deploy from ${join(ctx.home, "skills", "deploy")}`);
    expect(skill.ok && skill.prompt).toContain("Arguments: prod");
    expect(await rt.expandCommand("nope", "", ui("allow"), signal())).toEqual({ ok: false, reason: "Unknown command /nope." });
    expect(rt.extraCommands.map((c) => c.name)).toEqual(["date", "deploy"]);
  });

  test("listings", async () => {
    await writeFileAt(join(ctx.home, "skills", "deploy", "SKILL.md"), "---\ndescription: Deploy\ndisable-model-invocation: true\n---\nx");
    await writeFileAt(join(ctx.home, "plugins", "kit", "plugin.json"), JSON.stringify({ name: "kit", version: "1.2.0", description: "Tools" }));
    await withExt({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.sh" }] }] }, disabledPlugins: [] });
    const { runtime: rt } = await runtime();
    expect(await rt.describe("skills")).toContain("deploy (user, user-only, /deploy): Deploy");
    expect(await rt.describe("agents")).toContain("general-purpose (builtin)");
    expect(await rt.describe("hooks")).toContain("PreToolUse[Bash] settings: guard.sh");
    expect(await rt.describe("mcp")).toContain("No MCP servers");
    expect(await rt.describe("plugins")).toContain("kit 1.2.0: Tools");
    await ctx.ext.notes!.add("memory", "Uses bun");
    const memory = await rt.describe("memory");
    expect(memory).toContain("Uses bun");
    expect(memory).toContain("(empty)");
    await rm(join(ctx.home, "skills"), { recursive: true });
    await rm(join(ctx.home, "plugins"), { recursive: true });
    await withExt({ memory: false });
    const { runtime: rt2 } = await runtime();
    expect(await rt2.describe("memory")).toContain("Memory is off");
    expect(await rt2.describe("skills")).toContain("No skills");
    expect(await rt2.describe("hooks")).toContain("No hooks");
    expect(await rt2.describe("plugins")).toContain("No plugins");
  });

  test("SessionStart context reaches the first prompt; SessionEnd fires on clear and shutdown", async () => {
    const log = join(dir, "hooks.log");
    await withExt({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: `echo "start $(jq -r .source 2>/dev/null || cat)" >> ${log}; echo 'branch: main'` }] }],
        SessionEnd: [{ hooks: [{ type: "command", command: `cat >> ${log}; echo >> ${log}` }] }],
      },
    });
    ctx.model = new FakeModel([() => reply([textBlock("ok")])]);
    const { runtime: rt } = await runtime();
    const notices: string[] = [];
    await rt.start((_l, t) => notices.push(t));
    const agent = rt.newAgent({ emit: () => {}, askPermission: async () => ({ kind: "deny" }) });
    await agent.run("hi", signal());
    const first = JSON.stringify((ctx.model as FakeModel).requests[0]!.messages[0]);
    expect(first).toContain("branch: main");
    // The hook block carries the session's nonce, and the context block says what it is.
    const nonce = /<harness-nonce>([0-9a-f]{12})<\/harness-nonce>/.exec(first)![1]!;
    expect(first).toContain(`<hook-context event=\\"SessionStart\\" nonce=\\"${nonce}\\">`);
    await rt.clear();
    await rt.shutdown();
    const text = await readFile(log, "utf8");
    expect(text).toContain('"reason":"clear"');
    expect(text).toContain('"reason":"exit"');
  });

  test("undo without a snapshot store explains why; turn models apply to one turn", async () => {
    const { runtime: rt } = await runtime();
    expect(await rt.undo()).toMatchObject({ ok: false });
    expect(await rt.redo()).toMatchObject({ ok: false });
    ctx.model = new FakeModel([() => reply([textBlock("a")]), () => reply([textBlock("b")])]);
    const { runtime: rt2 } = await runtime();
    const agent = rt2.newAgent({ emit: () => {}, askPermission: async () => ({ kind: "deny" }) });
    rt2.setTurnModel("claude-haiku-5-5");
    await agent.run("one", signal());
    rt2.setTurnModel(undefined);
    await agent.run("two", signal());
    expect((ctx.model as FakeModel).requests.map((r) => r.model)).toEqual(["claude-haiku-5-5", "claude-opus-5-5"]);
    expect(ctx.subagents.deps).toBeDefined();
  });

  test("an aborted expansion stops: no ask on a dead signal, no output after the abort", async () => {
    await writeFileAt(join(dir, ".tropos", "commands", "two.md"), "!`echo one` then !`echo two`");
    await withExt();
    const { runtime: rt } = await runtime();
    const controller = new AbortController();
    const asked: string[] = [];
    const out = await rt.expandCommand(
      "two",
      "",
      {
        askPermission: async (p) => {
          asked.push(p.summary);
          controller.abort();
          return { kind: "allow" };
        },
      },
      controller.signal,
    );
    expect(out).toEqual({ ok: false, reason: "interrupted" });
    expect(asked).toEqual(["echo one"]);
    const dead = new AbortController();
    dead.abort();
    expect(await rt.expandCommand("two", "", ui("allow", asked), dead.signal)).toEqual({ ok: false, reason: "interrupted" });
    expect(asked).toEqual(["echo one"]);
  });
});
