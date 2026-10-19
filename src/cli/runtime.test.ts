import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { BOOTSTRAP_TEXT } from "../context/identity";
import { lstat, mkdir, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProviderRouter } from "../providers/router";
import { FakeModel, reply, textBlock, toolUseBlock, type Step } from "../../test/helpers/fake-model";
import { settle, waitFor } from "../../test/helpers/wait";
import type { AgentEvent, PermissionAnswer, PermissionPrompt } from "../agent/events";
import { Ledger, recordSetupChange } from "../learning/ledger";
import { onReloadSignal } from "../gateway/reload-signal";
import { NOTHING } from "../learning/review-prompts";
import type { LearningLoop } from "../learning/review";
import type { SearchIndex } from "../memory/search-index";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { DEFAULT_SETTINGS, type Settings } from "../config/settings";
import { compileRules } from "../permissions/engine";
import { projectDir, SessionStore } from "../session/store";
import { createTools } from "../tools/registry";
import { DARK } from "../ui/theme";
import { renderSpecialistFile } from "../agents/specialists";
import { ModelPrefs } from "../config/model-prefs";
import { loadExtensions, sessionTools } from "./extensions";
import { troposStorePaths } from "../learning/stores";
import { legacyNotesDir } from "../memory/daily";
import { journalDir } from "../paths";
import { workspaceOwnPaths } from "../home/layout";
import { channelContext } from "../gateway/policy";
import { createRuntime, createToolContext, makeAgent, permissionContext, type AppContext } from "./runtime";

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
    modelPrefs: new ModelPrefs(join(dir, ".home")),
    role: "owner",
  };
});
afterEach(async () => {
  // A test that fails while it fakes the clock must not leave later files on fake timers.
  jest.useRealTimers();
  await removeDir(dir);
});

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

test("each model reply's usage and cost is recorded as a session event, for the usage report", async () => {
  ctx = { ...ctx, model: new FakeModel([() => reply([textBlock("hello")]), () => reply([textBlock("again")])]) };
  const { session, runtime: rt } = await runtime();
  const agent = rt.newAgent({ emit: () => {}, askPermission: async () => ({ kind: "deny" }) });
  await agent.run("hi", new AbortController().signal);
  await agent.run("and again", new AbortController().signal);
  await Bun.sleep(20);
  const lines = (await readFile(session.path, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  const usage = lines.filter((l) => l.type === "event" && l.name === "usage");
  expect(usage).toHaveLength(2);
  expect(usage[0].value).toMatchObject({ model: "claude-opus-5-5", usage: { input_tokens: 100, output_tokens: 20 } });
  // The stored messages themselves carry no usage: extra fields there would be sent back to the API.
  expect(lines.filter((l) => l.type === "message").every((l) => l.message.usage === undefined)).toBe(true);
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

test("permissionContext carries the role, the origin's confinement and the stores, the project journal included", () => {
  const local = permissionContext(ctx, "plan");
  expect(local).toMatchObject({ mode: "plan", cwd: dir, allowedDirs: [dir], confine: false, role: "owner", stores: { askBeforeSaving: false } });
  expect(local.stores!.paths).toEqual([...troposStorePaths(ctx.home), legacyNotesDir(ctx.home, ctx.cwd)]);
  // The journal is under workspace/memory, which troposStorePaths already holds.
  expect(local.stores!.paths).toContain(journalDir(ctx.home));
  // The chief's own files are guarded from the generic file tools.
  for (const own of workspaceOwnPaths(ctx.home)) expect(local.ownFiles).toContain(own);
  const asking = { ...ctx, origin: "channel" as const, role: "guest" as const, settings: { ...DEFAULT_SETTINGS, learning: { ...DEFAULT_SETTINGS.learning, askBeforeSaving: true } } };
  expect(permissionContext(asking, "default")).toMatchObject({ mode: "default", confine: true, role: "guest", stores: { askBeforeSaving: true } });
});

test("permissionContext reads the chat's autonomy on every decision, so a change applies to the open session", () => {
  expect(permissionContext(ctx, "default").autonomy).toBeUndefined();
  let level: "ask" | "balanced" = "balanced";
  const live = { ...ctx, autonomy: () => ({ level, testCommands: ["bun test"] }) };
  expect(permissionContext(live, "default").autonomy).toEqual({ level: "balanced", testCommands: ["bun test"] });
  level = "ask";
  expect(permissionContext(live, "default").autonomy).toEqual({ level: "ask", testCommands: ["bun test"] });
});

test("permissionContext leaves out a journal reached through a link out of the home", async () => {
  const outside = join(dir, "outside");
  await mkdir(outside);
  await mkdir(ctx.home, { recursive: true });
  await symlink(outside, join(ctx.home, "projects"));
  expect(permissionContext(ctx, "default").stores!.paths).toEqual(troposStorePaths(ctx.home));
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
    await writeFileAt(join(ctx.home, "workspace", "skills", "deploy", "SKILL.md"), "---\ndescription: Deploy\n---\nDeploy from ${TROPOS_SKILL_DIR}");
    await withExt();
    ctx.rules = compileRules({ allow: ["Bash(echo:*)"], ask: [], deny: [] }).rules;
    const { runtime: rt } = await runtime();
    const asked: string[] = [];
    expect(await rt.expandCommand("date", "", ui("deny", asked), signal())).toMatchObject({ ok: true });
    expect(asked).toEqual([]);
    const skill = await rt.expandCommand("deploy", "prod", ui("allow"), signal());
    expect(skill.ok && skill.prompt).toContain(`Deploy from ${join(ctx.home, "workspace", "skills", "deploy")}`);
    expect(skill.ok && skill.prompt).toContain("Arguments: prod");
    expect(await rt.expandCommand("nope", "", ui("allow"), signal())).toEqual({ ok: false, reason: "Unknown command /nope." });
    expect(rt.extraCommands.map((c) => c.name)).toEqual(["date", "deploy"]);
  });

  test("panels", async () => {
    await writeFileAt(join(ctx.home, "workspace", "skills", "deploy", "SKILL.md"), "---\ndescription: Deploy\ndisable-model-invocation: true\n---\nx");
    await writeFileAt(join(ctx.home, "workspace", "skills-learned", "bun-release", "SKILL.md"), "---\ndescription: Release a bun CLI\n---\nx");
    await writeFileAt(join(ctx.home, "plugins", "kit", "plugin.json"), JSON.stringify({ name: "kit", version: "1.2.0", description: "Tools" }));
    await withExt({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.sh" }] }] }, disabledPlugins: [] });
    const { runtime: rt } = await runtime();
    const skills = await rt.panel("skills");
    expect(skills.sections[0]).toMatchObject({ title: "Yours (~/.tropos/workspace/skills)", items: [{ label: "deploy", hint: "Deploy", aside: "/deploy · you only" }] });
    expect(skills.sections[1]).toMatchObject({ title: "Learned on its own (~/.tropos/workspace/skills-learned)", items: [{ label: "bun-release", hint: "Release a bun CLI" }] });
    const agents = await rt.panel("agents");
    expect(agents.sections[0]!.title).toBe("Built-in");
    expect(agents.sections[0]!.items.map((i) => i.label)).toContain("🛠 general-purpose");
    expect(agents.sections[0]!.items.map((i) => i.key)).toContain("general-purpose");
    expect((await rt.panel("hooks")).sections[0]!.items[0]).toMatchObject({ label: "PreToolUse [Bash]", hint: "guard.sh" });
    expect(await rt.panel("mcp")).toMatchObject({ sections: [], empty: "No MCP servers. Ask me to add one, or add it in the dashboard (tcode dashboard → Extensions)." });
    expect((await rt.panel("plugins")).sections[0]!.items[0]).toMatchObject({ label: "kit", hint: "Tools", aside: "1.2.0", status: "ok" });
    await ctx.ext.notes!.add("memory", "Uses bun");
    const memory = await rt.panel("memory");
    expect(memory.sections[0]!.items[0]!.label).toBe("Uses bun");
    expect(memory.sections[1]!.items).toEqual([]);
    await rm(join(ctx.home, "workspace", "skills"), { recursive: true });
    await rm(join(ctx.home, "workspace", "skills-learned"), { recursive: true });
    await withExt({ memory: false });
    const { runtime: rt2 } = await runtime();
    expect((await rt2.panel("memory")).empty).toBe("Memory is off. Turn it on in the dashboard's settings (tcode dashboard).");
    const emptySkills = await rt2.panel("skills");
    expect(emptySkills.sections).toEqual([]);
    expect(emptySkills.empty).toBe("No skills yet. Add one at ~/.tropos/workspace/skills/<name>/SKILL.md or .tropos/skills/<name>/SKILL.md.");
    const emptyHooks = await rt2.panel("hooks");
    expect(emptyHooks.sections).toEqual([]);
    expect(emptyHooks.empty).toBe("No hooks. Add them in the dashboard (tcode dashboard → Extensions).");
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

  test("PreToolUse hooks rule slash-command shell lines: ask prompts despite an allow rule; rewrites are used", async () => {
    await writeFileAt(join(dir, ".tropos", "commands", "say.md"), "Say: !`echo RAN`");
    const hook = (json: object) => ({ PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command" as const, command: `echo '${JSON.stringify(json)}'` }] }] });
    await withExt({ hooks: hook({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" } }) });
    ctx.rules = compileRules({ allow: ["Bash(echo:*)"], ask: [], deny: [] }).rules;
    const { runtime: rt } = await runtime();
    const asked: string[] = [];
    expect(await rt.expandCommand("say", "", ui("deny", asked), signal())).toMatchObject({ ok: false });
    expect(asked).toEqual(["echo RAN"]);
    await withExt({ hooks: hook({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { command: "echo REWRITTEN" } } }) });
    const { runtime: rt2 } = await runtime();
    const out = await rt2.expandCommand("say", "", ui("deny"), signal());
    expect(out.ok && out.prompt).toContain("REWRITTEN");
    await withExt({ hooks: hook({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { nope: 1 } } }) });
    const { runtime: rt3 } = await runtime();
    expect(await rt3.expandCommand("say", "", ui("allow"), signal())).toMatchObject({ ok: false, reason: expect.stringContaining("into something invalid") });
  });
});

describe("learning and identity", () => {
  const LEARNING = { review: true, interval: 2, flushAt: 0.7, curator: false, askBeforeSaving: false };
  const text = (t: string): Step => () => reply([textBlock(t)]);
  const signal = () => new AbortController().signal;
  const allow = async (): Promise<PermissionAnswer> => ({ kind: "allow" });
  const notices = (events: AgentEvent[]) => events.flatMap((e) => (e.type === "notice" ? [e.text] : []));

  /** Real session tools (Memory, Identity, …) over the ledger, as main.tsx wires them. */
  async function setup(steps: Step[] = [], learning: Partial<Settings["learning"]> = {}) {
    ctx.settings = { ...DEFAULT_SETTINGS, learning: { ...LEARNING, ...learning } };
    ctx.ext = await loadExtensions({ cwd: dir, home: ctx.home, settings: ctx.settings, env: {}, connect: false });
    ctx.tools = sessionTools(createTools({ rgPath: null }), ctx.ext, { home: ctx.home, cwd: dir, holder: ctx.subagents, sessionId: () => "s" });
    const model = new FakeModel(steps);
    ctx.model = model;
    return model;
  }

  async function agentFor(opts: { interactive?: boolean; learn?: boolean; ask?: (p: PermissionPrompt) => Promise<PermissionAnswer>; ctx?: AppContext; onIdentityChange?(): void } = {}) {
    const appCtx = opts.ctx ?? ctx;
    const session = await SessionStore.create(ctx.home, { cwd: dir, model: "m", version: "v" });
    const events: AgentEvent[] = [];
    let loop: LearningLoop | undefined;
    const agent = makeAgent(appCtx, {
      session: () => session,
      history: [],
      state: () => ({ model: "claude-opus-5-5", effort: ctx.settings.effort, mode: "default" }),
      ui: { emit: (e) => events.push(e), askPermission: opts.ask ?? allow },
      toolContext: createToolContext(appCtx),
      interactive: opts.interactive,
      learn: opts.learn,
      onLearning: (l) => {
        loop = l;
      },
      onIdentityChange: opts.onIdentityChange,
    });
    return { agent, events, loop: () => loop };
  }

  test("after enough turns a background review saves to memory, says so, records it and adds its cost", async () => {
    const model = await setup([
      text("a"),
      text("b"),
      () => reply([toolUseBlock("r1", "Memory", { target: "memory", action: "add", content: "The user ships with bun" })], "tool_use"),
      text("done"),
    ]);
    const { agent, events, loop } = await agentFor({ interactive: true });
    expect(await agent.run("one", signal())).toBe("end_turn");
    const perReply = agent.totalCostUsd!;
    expect(perReply).toBeGreaterThan(0);
    expect(loop()!.running).toBe(false);
    expect(await agent.run("two", signal())).toBe("end_turn");
    expect(loop()!.running).toBe(true);
    await loop()!.whenIdle();
    expect(loop()!.last).toMatchObject({ kind: "memory", changes: 1 });
    expect(model.requests).toHaveLength(4);
    // The review continues a copy of the conversation and doesn't add to the main agent's.
    expect(model.requests[2]!.messages.length).toBe(5);
    expect(agent.messages).toHaveLength(4);
    expect(await readFile(join(ctx.home, "workspace", "MEMORY.md"), "utf8")).toContain("The user ships with bun");
    expect(notices(events).filter((t) => t.startsWith("💡 Learned: "))).toEqual([expect.stringContaining("Memory")]);
    const [entry] = await ctx.ext.ledger.list();
    expect(entry).toMatchObject({ actor: "review", kind: "memory", path: join(ctx.home, "workspace", "MEMORY.md") });
    // Two main replies plus two review replies, all priced the same.
    expect(agent.totalCostUsd!).toBeCloseTo(perReply * 4, 10);
  });

  test("skills the review writes land in ~/.tropos/skills-learned, never among the user's", async () => {
    const content = "---\ndescription: Use when releasing a bun CLI\n---\nSteps";
    const model = await setup([
      text("a"),
      text("b"),
      () => reply([toolUseBlock("r1", "SkillManage", { action: "create", name: "bun-release", content })], "tool_use"),
      text("done"),
    ]);
    const { agent, loop } = await agentFor({ interactive: true });
    await agent.run("one", signal());
    await agent.run("two", signal());
    await loop()!.whenIdle();
    expect(model.requests).toHaveLength(4);
    expect(await readFile(join(ctx.home, "workspace", "skills-learned", "bun-release", "SKILL.md"), "utf8")).toBe(content);
    expect(await lstat(join(ctx.home, "workspace", "skills", "bun-release")).catch(() => null)).toBeNull();
    const [entry] = await ctx.ext.ledger.list();
    expect(entry).toMatchObject({ actor: "review", kind: "skill", path: join(ctx.home, "workspace", "skills-learned", "bun-release", "SKILL.md") });
    // The review asks for no approval, and the main agent's SkillManage still writes to the user's folder.
    const main = ctx.tools.find((t) => t.name === "SkillManage")!;
    expect(main.subject({ action: "create", name: "x", content }, dir)).toEqual({ paths: [join(ctx.home, "workspace", "skills", "x", "SKILL.md")] });
  });

  test("undo of a learned change waits while the review is saving", async () => {
    const model = await setup([
      text("a"),
      text("b"),
      (_req, _handlers, abort) =>
        new Promise((_, reject) => {
          abort.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
        }),
    ]);
    const { runtime: rt } = await runtime();
    const events: AgentEvent[] = [];
    const agent = rt.newAgent({ emit: (e) => events.push(e), askPermission: allow });
    await agent.run("one", signal());
    await agent.run("two", signal());
    await waitFor(() => expect(model.requests).toHaveLength(3));
    expect(await rt.undoLearned()).toEqual({ ok: false, reason: "The background review is saving; try again in a moment." });
    // The review hangs until aborted: shut down without the final review, which would wait for it.
    await rt.shutdown({ finalReview: false });
    expect(await rt.undoLearned()).toMatchObject({ ok: false, reason: expect.not.stringContaining("background review") });
  });

  test("a new turn cancels a review still running; it is tried again after that turn", async () => {
    const model = await setup([
      text("a"),
      text("b"),
      (_req, _handlers, abort) =>
        new Promise((_, reject) => {
          abort.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
        }),
      text("c"),
      text(NOTHING),
    ]);
    const { agent, events, loop } = await agentFor({ interactive: true });
    await agent.run("one", signal());
    await agent.run("two", signal());
    await waitFor(() => expect(model.requests).toHaveLength(3));
    expect(loop()!.running).toBe(true);
    const first = loop()!.last;
    expect(await agent.run("three", signal())).toBe("end_turn");
    await loop()!.whenIdle();
    expect(first).toMatchObject({ kind: "memory", aborted: true, changes: 0 });
    // The cancelled review saved nothing, so its turn counter came back and the review ran again after "three".
    expect(loop()!.last).not.toBe(first);
    expect(model.requests).toHaveLength(5);
    expect(notices(events).some((t) => t.startsWith("💡"))).toBe(false);
    expect(await ctx.ext.ledger.list()).toEqual([]);
  });

  const memoryAdd = (id: string): Step => () => reply([toolUseBlock(id, "Memory", { target: "user", action: "add", content: "prefers bun" })], "tool_use");
  const learnedNotices = (events: AgentEvent[]) => events.flatMap((e) => (e.type === "notice" && e.learned ? [e.text] : []));

  test("an owner's Memory save runs without a prompt and leaves one learned notice", async () => {
    await setup([memoryAdd("m1"), text("ok")]);
    const asked: PermissionPrompt[] = [];
    const { agent, events } = await agentFor({ ask: async (p) => (asked.push(p), { kind: "allow" }) });
    await agent.run("remember", signal());
    expect(asked).toEqual([]);
    expect(events).toContainEqual({ type: "notice", level: "info", text: "💡 Remembered: prefers bun", learned: true });
    expect(learnedNotices(events)).toHaveLength(1);
    const entries = await ctx.ext.ledger.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ actor: "agent", kind: "user" });
  });

  test("a subagent's Memory save in an owner session asks first: only the owner's own agent saves without a prompt", async () => {
    const agentCall: Step = () => reply([toolUseBlock("a1", "Agent", { description: "save a note", prompt: "remember it" })], "tool_use");
    await setup([agentCall, memoryAdd("m1"), text("saved"), text("ok")]);
    const asked: PermissionPrompt[] = [];
    const { agent } = await agentFor({ ask: async (p) => (asked.push(p), { kind: "allow" }) });
    await agent.run("delegate", signal());
    expect(asked.map((p) => p.toolName)).toEqual(["Memory"]);
  });

  test("with learning.askBeforeSaving the same save asks first", async () => {
    await setup([memoryAdd("m1"), text("ok")], { askBeforeSaving: true });
    const asked: PermissionPrompt[] = [];
    const { agent, events } = await agentFor({ ask: async (p) => (asked.push(p), { kind: "allow" }) });
    await agent.run("remember", signal());
    expect(asked.map((p) => p.toolName)).toEqual(["Memory"]);
    expect(learnedNotices(events)).toEqual(["💡 Remembered: prefers bun"]);
  });

  test("a denied save leaves no notice", async () => {
    await setup([memoryAdd("m1"), text("ok")], { askBeforeSaving: true });
    const { agent, events } = await agentFor({ ask: async () => ({ kind: "deny" }) });
    await agent.run("remember", signal());
    expect(learnedNotices(events)).toEqual([]);
  });

  test("learn: true runs the review in a non-interactive session without the first-run note", async () => {
    const model = await setup([text("a"), text("b"), text(NOTHING)]);
    const { agent, loop } = await agentFor({ interactive: false, learn: true });
    expect(loop()).toBeDefined();
    await agent.run("one", signal());
    await agent.run("two", signal());
    await loop()!.whenIdle();
    expect(model.requests).toHaveLength(3);
    expect(JSON.stringify(model.requests[0]!.messages[0])).not.toContain("<bootstrap>");
    // Without the option a non-interactive session never reviews.
    expect((await agentFor({ interactive: false })).loop()).toBeUndefined();
    expect((await agentFor({ interactive: true, learn: false })).loop()).toBeUndefined();
  });

  test("a guest session gets no store tools and no learned notices; an owner session in the same setup does", async () => {
    await setup([memoryAdd("m1"), text("ok"), memoryAdd("m2"), text("ok")]);
    const exec = {} as Parameters<typeof channelContext>[1];
    const owner = await agentFor({ ctx: channelContext(ctx, exec, { role: "owner" }) });
    await owner.agent.run("remember", signal());
    expect(learnedNotices(owner.events)).toEqual(["💡 Remembered: prefers bun"]);
    const guest = await agentFor({ ctx: channelContext(ctx, exec, { role: "guest" }) });
    await guest.agent.run("remember", signal());
    expect(learnedNotices(guest.events)).toEqual([]);
    expect(await ctx.ext.ledger.list()).toHaveLength(1);
  });

  test("print mode never reviews", async () => {
    const model = await setup([text("a"), text("b"), text("c")]);
    const { agent, loop } = await agentFor();
    for (const prompt of ["one", "two", "three"]) expect(await agent.run(prompt, signal())).toBe("end_turn");
    await settle();
    expect(loop()).toBeUndefined();
    expect(model.requests).toHaveLength(3);
  });

  test("the main context carries the identity, and the first-run note only when interactive and unnamed", async () => {
    const model = await setup([text("a"), text("b"), text("c")]);
    const firstMessage = (i: number) => JSON.stringify(model.requests[i]!.messages[0]);
    await mkdir(join(ctx.home, "workspace"), { recursive: true });
    await writeFile(join(ctx.home, "workspace", "BOOTSTRAP.md"), BOOTSTRAP_TEXT);
    await (await agentFor({ interactive: true })).agent.run("hi", signal());
    expect(firstMessage(0)).toContain("<bootstrap>");
    expect(firstMessage(0)).not.toContain("<identity");
    await (await agentFor()).agent.run("hi", signal());
    expect(firstMessage(1)).not.toContain("<bootstrap>");
    await writeFile(join(ctx.home, "IDENTITY.md"), "- Name: Nova\n- Emoji: 🦊\n");
    await (await agentFor({ interactive: true })).agent.run("hi", signal());
    expect(firstMessage(2)).toContain('<identity source=\\"user\\">');
    expect(firstMessage(2)).toContain("Name: Nova");
    expect(firstMessage(2)).not.toContain("<bootstrap>");
  });

  test("context blocks ride in the first message's context, before the nonce block, and not in a subagent's", async () => {
    const model = await setup([text("a")]);
    const { agent } = await agentFor({ ctx: { ...ctx, contextBlocks: async () => ["<worktree>x</worktree>"] } });
    await agent.run("hi", signal());
    const first = JSON.stringify(model.requests[0]!.messages[0]);
    expect(first).toContain("<worktree>x</worktree>");
    expect(first.indexOf("<worktree>")).toBeLessThan(first.indexOf("nonce"));
    expect(await ctx.subagents.deps!.contextText()).not.toContain("<worktree>");
  });

  test("subagents get the agent's own notes but not the user profile or the identity", async () => {
    const model = await setup([text("a")]);
    await ctx.ext.notes!.add("user", "Prefers bun");
    await ctx.ext.notes!.add("memory", "Tests are colocated");
    await writeFile(join(ctx.home, "IDENTITY.md"), "- Name: Nova\n");
    const { agent } = await agentFor({ interactive: true });
    const sub = await ctx.subagents.deps!.contextText();
    expect(sub).toContain("Tests are colocated");
    expect(sub).not.toContain("Prefers bun");
    expect(sub).not.toContain("Nova");
    expect(sub).not.toContain("<identity");
    await agent.run("hi", signal());
    const main = JSON.stringify(model.requests[0]!.messages[0]);
    expect(main).toContain("Prefers bun");
    expect(main).toContain("Nova");
  });

  test("the chief's first context lists the specialists, except for guests; the deps are for specialists", async () => {
    const model = await setup([text("a"), text("b")]);
    await mkdir(join(ctx.home, "agents", "reviewer"), { recursive: true });
    await writeFile(
      join(ctx.home, "agents", "reviewer", "AGENT.md"),
      renderSpecialistFile({ name: "reviewer", description: "reviews pull requests", prompt: "## Purpose\nx", emoji: "🔍", createdBy: "user", createdAt: 1, revision: 1 }),
    );
    await ctx.ext.reloadAgents();
    const exec = {} as Parameters<typeof channelContext>[1];
    await (await agentFor({ ctx: channelContext(ctx, exec, { role: "owner" }) })).agent.run("hi", signal());
    await (await agentFor({ ctx: channelContext(ctx, exec, { role: "guest" }) })).agent.run("hi", signal());
    expect(JSON.stringify(model.requests[0]!.messages[0])).toContain("<specialists>");
    expect(JSON.stringify(model.requests[1]!.messages[0])).not.toContain("<specialists>");
    expect(ctx.subagents.deps).toMatchObject({ home: ctx.home, role: "guest" });
  });

  test("directCall resolves @specialist for owners and is null for guests, unknown names and plain text", async () => {
    await setup();
    await mkdir(join(ctx.home, "agents", "reviewer"), { recursive: true });
    await writeFile(
      join(ctx.home, "agents", "reviewer", "AGENT.md"),
      renderSpecialistFile({ name: "reviewer", description: "reviews pull requests", prompt: "## Purpose\nx", emoji: "🔍", createdBy: "user", createdAt: 1, revision: 1 }),
    );
    await ctx.ext.reloadAgents();
    const owner = (await runtime()).runtime;
    expect(owner.directCall?.("@reviewer look at PR 12")?.call.input.subagent_type).toBe("reviewer");
    expect(owner.directCall?.("@nobody hi")).toBeNull();
    expect(owner.directCall?.("plain")).toBeNull();
    const exec = {} as Parameters<typeof channelContext>[1];
    const guestRt = await createRuntime(channelContext(ctx, exec, { role: "guest" }), {
      session: (await runtime()).session, history: [], mode: "default", modes: ["default"], theme: DARK,
    });
    expect(guestRt.directCall?.("@reviewer look at PR 12")).toBeNull();
  });

  test("the agents panel lists specialists in their own section", async () => {
    await mkdir(join(ctx.home, "agents", "reviewer"), { recursive: true });
    await writeFile(
      join(ctx.home, "agents", "reviewer", "AGENT.md"),
      renderSpecialistFile({ name: "reviewer", description: "reviews pull requests", prompt: "## Purpose\nx", emoji: "🔍", createdBy: "user", createdAt: 1, revision: 1 }),
    );
    await setup();
    const { runtime: rt } = await runtime();
    const sections = (await rt.panel("agents")).sections;
    expect(sections.map((x) => x.title)).toEqual(["Built-in", "Specialists (~/.tropos/agents)"]);
    expect(sections[1]!.items.map((i) => i.key)).toEqual(["reviewer"]);
  });

  test("guest chats and scheduled runs get none of the owner's notes or journal; the owner's chat does", async () => {
    const model = await setup([text("a"), text("b"), text("c")]);
    await ctx.ext.notes!.add("user", "Prefers bun");
    await ctx.ext.notes!.add("memory", "Tests are colocated");
    await ctx.ext.daily!.append("Shipped the gateway");
    const exec = {} as Parameters<typeof channelContext>[1];
    for (const role of ["owner", "guest", "scheduled"] as const) {
      await (await agentFor({ ctx: channelContext(ctx, exec, { role }) })).agent.run("hi", signal());
    }
    const first = (i: number) => JSON.stringify(model.requests[i]!.messages[0]);
    for (const note of ["Prefers bun", "Tests are colocated", "Shipped the gateway"]) {
      expect(first(0)).toContain(note);
      expect(first(1)).not.toContain(note);
      expect(first(2)).not.toContain(note);
    }
  });

  test("transcripts record the session's role: after /clear, and a subagent's", async () => {
    await setup([text("a")]);
    const exec = {} as Parameters<typeof channelContext>[1];
    ctx = channelContext(ctx, exec, { role: "guest" });
    const { runtime: rt } = await runtime();
    await rt.clear();
    const metaOf = async (path: string) => JSON.parse((await readFile(path, "utf8")).split("\n")[0]!);
    expect((await metaOf(join(projectDir(ctx.home, dir), `${rt.sessionId()}.jsonl`))).role).toBe("guest");
    rt.newAgent({ emit: () => {}, askPermission: allow });
    await ctx.subagents.deps!.openTranscript!("helper");
    const subDir = join(projectDir(ctx.home, dir), "subagents", rt.sessionId());
    const [file] = await readdir(subDir);
    expect((await metaOf(join(subDir, file!))).role).toBe("guest");
  });

  test("an Identity save tells the runtime to refresh the header identity", async () => {
    await mkdir(ctx.home, { recursive: true });
    await writeFile(join(ctx.home, "IDENTITY.md"), "- Name: Nova\n");
    await setup([() => reply([toolUseBlock("i1", "Identity", { action: "set", name: "Orion", emoji: "🌟" })], "tool_use"), text("ok")]);
    const { runtime: rt } = await runtime();
    expect(rt.identity()).toEqual({ name: "Nova" });
    await rt.newAgent({ emit: () => {}, askPermission: allow }).run("call yourself Orion", signal());
    await waitFor(() => expect(rt.identity()).toEqual({ name: "Orion", emoji: "🌟" }));
  });

  test("onIdentityChange fires only for a finished Identity call", async () => {
    await setup([
      () => reply([toolUseBlock("i1", "Identity", { action: "set", emoji: "not an emoji" })], "tool_use"),
      () => reply([toolUseBlock("i2", "Identity", { action: "skip" })], "tool_use"),
      text("ok"),
    ]);
    let changes = 0;
    const { agent } = await agentFor({ onIdentityChange: () => void changes++ });
    await agent.run("go", signal());
    expect(changes).toBe(1);
  });

  test("identity is empty without IDENTITY.md", async () => {
    await setup();
    const { runtime: rt } = await runtime();
    expect(rt.identity()).toEqual({});
  });

  test("undoLearned reverts the latest change; the learned panel shows both entries", async () => {
    await setup();
    const { runtime: rt } = await runtime();
    expect(await rt.undoLearned()).toEqual({ ok: false, reason: "Nothing to undo." });
    expect(await rt.panel("learned")).toMatchObject({ title: "Learned", sections: [], empty: expect.stringContaining("Nothing learned yet") });
    await ctx.ext.notes!.add("memory", "Uses bun");
    expect(await rt.undoLearned()).toEqual({ ok: true, summary: "memory: add: Uses bun" });
    expect(await ctx.ext.notes!.entries("memory")).toEqual([]);
    const panel = await rt.panel("learned");
    const [undo, original] = panel.sections[0]!.items;
    expect(undo).toMatchObject({ label: "memory: undo add: add: Uses bun", hint: "undo", status: "warn" });
    expect(original).toMatchObject({ label: "memory: add: Uses bun", hint: "saved while we talked", status: "off" });
    expect(original!.detail![0]).toBe("add by agent (undone)");
    expect(original!.aside).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(await rt.undoLearned(original!.key)).toEqual({ ok: false, reason: `${original!.key} was already undone.` });
  });

  test("undoing a setup change asks the gateway to reload; noUndo entries show as not undoable", async () => {
    await setup();
    const { runtime: rt } = await runtime();
    await mkdir(join(ctx.home, "gateway"), { recursive: true });
    await writeFile(join(ctx.home, "gateway", "state.json"), JSON.stringify({ pid: process.pid, startedAt: "t", telegram: false }));
    await writeFile(join(ctx.home, "gateway.json"), JSON.stringify({ proactive: { enabled: false } }));
    const e = await recordSetupChange(ctx.ext.ledger, { actor: "agent", path: join(ctx.home, "gateway.json"), configPath: "proactive.enabled", action: "proactive.set", summary: "proactive off", before: true, after: false });
    const locked = await recordSetupChange(ctx.ext.ledger, { actor: "agent", path: join(ctx.home, "gateway.json"), action: "autonomy.lower", summary: "autonomy ask", noUndo: "Raise autonomy in Settings → Autonomy." });
    let hits = 0;
    const off = onReloadSignal(() => hits++);
    try {
      const items = (await rt.panel("learned")).sections[0]!.items;
      expect(items.find((i) => i.key === locked.id)).toMatchObject({ undoable: false });
      expect(items.find((i) => i.key === locked.id)!.detail!.at(-1)).toBe("Raise autonomy in Settings → Autonomy.");
      expect(items.find((i) => i.key === e.id)!.undoable).not.toBe(false);
      expect(await rt.undoLearned(e.id)).toMatchObject({ ok: true });
      await waitFor(() => expect(hits).toBe(1));
      expect(await rt.undoLearned(locked.id)).toEqual({ ok: false, reason: "Raise autonomy in Settings → Autonomy." });
      await settle();
      expect(hits).toBe(1);
    } finally {
      off();
    }
  });

  test("clear and resume reset the skills seen this session", async () => {
    await setup();
    const { session, runtime: rt } = await runtime();
    ctx.ext.tracker.markViewed("deploy");
    await rt.clear();
    expect(ctx.ext.tracker.hasViewed("deploy")).toBe(false);
    ctx.ext.tracker.markViewed("deploy");
    await rt.resume(session.id);
    expect(ctx.ext.tracker.hasViewed("deploy")).toBe(false);
  });

  async function staleSkill() {
    const path = join(ctx.home, "workspace", "skills-learned", "old-trick", "SKILL.md");
    await mkdir(join(path, ".."), { recursive: true });
    const body = "---\nname: old-trick\ndescription: Use when x\n---\nSteps";
    await writeFile(path, body);
    const ago = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    await new Ledger(ctx.home, { now: () => ago }).record({ actor: "review", kind: "skill", path, action: "create", summary: "old-trick", before: null, after: body });
    return path;
  }

  test("start archives a stale learned skill and says so when the curator is on", async () => {
    await setup([], { curator: true });
    const path = await staleSkill();
    const { runtime: rt } = await runtime();
    const seen: string[] = [];
    await rt.start((_level, t) => seen.push(t));
    await waitFor(() => expect(seen).toEqual([expect.stringContaining("Archived 1 learned skill unused for 30 days: old-trick")]));
    expect(seen[0]).toContain(join(ctx.home, "workspace", "skills-learned", ".archive"));
    expect(await lstat(path).catch(() => null)).toBeNull();
  });

  test("start leaves skills alone when the curator is off", async () => {
    await setup([], { curator: false });
    const path = await staleSkill();
    const { runtime: rt } = await runtime();
    const seen: string[] = [];
    await rt.start((_level, t) => seen.push(t));
    await settle();
    expect(seen).toEqual([]);
    expect(await lstat(path).catch(() => null)).not.toBeNull();
  });

  /** A model step that hangs until aborted; `started` resolves when the request arrives. */
  function hanging() {
    let signal: AbortSignal | undefined;
    let release: (() => void) | undefined;
    let markStarted: () => void = () => {};
    const started = new Promise<void>((r) => (markStarted = r));
    const step: Step = (_req, _handlers, abort) =>
      new Promise((resolve, reject) => {
        signal = abort;
        release = () => resolve(reply([textBlock(NOTHING)]));
        abort.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
        markStarted();
      });
    return { step, started, signal: () => signal, release: () => release!() };
  }
  const countersFile = () => join(projectDir(ctx.home, dir), "learning.json");
  const readCounters = async () => JSON.parse(await readFile(countersFile(), "utf8"));
  const LONG = { interval: 10 };

  test("shutdown runs the final review and the journal gets an entry", async () => {
    const model = await setup(
      [text("a"), text("b"), () => reply([toolUseBlock("d1", "DailyNote", { text: "Shipped the build fix on main" })], "tool_use"), text("done")],
      LONG,
    );
    const { runtime: rt } = await runtime();
    const events: AgentEvent[] = [];
    const agent = rt.newAgent({ emit: (e) => events.push(e), askPermission: allow });
    await agent.run("one", signal());
    expect(rt.finalReviewDue()).toBe(false);
    await agent.run("two", signal());
    expect(rt.finalReviewDue()).toBe(true);
    await rt.shutdown();
    expect(model.requests).toHaveLength(4);
    expect(JSON.stringify(model.requests[2]!.messages.at(-1))).toContain("session is ending");
    const [note] = await readdir(journalDir(ctx.home));
    expect(await readFile(join(journalDir(ctx.home), note!), "utf8")).toContain("Shipped the build fix on main");
    expect(notices(events)).toContainEqual(expect.stringContaining("💡 Learned: DailyNote"));
    expect(await readCounters()).toEqual({ turnsSinceMemory: 0, toolsSinceSkill: 0 });
  });

  test("the final review's prompt ends with the delegations block; a memory review's does not", async () => {
    const model = await setup([text("a"), text("b"), text(NOTHING)], LONG);
    const { runtime: rt } = await runtime();
    const agent = rt.newAgent({ emit: () => {}, askPermission: allow });
    await agent.run("one", signal());
    await agent.run("two", signal());
    await rt.shutdown();
    const last = JSON.stringify(model.requests[2]!.messages.at(-1));
    expect(last).toContain("<delegations>");
    expect(last.lastIndexOf("<delegations>")).toBeGreaterThan(last.indexOf("session is ending"));
    const memory = await setup([text("a"), text("b"), text(NOTHING)]);
    const second = await runtime();
    const a2 = second.runtime.newAgent({ emit: () => {}, askPermission: allow });
    await a2.run("one", signal());
    await a2.run("two", signal());
    await waitFor(() => expect(memory.requests.length).toBeGreaterThanOrEqual(3));
    await second.runtime.shutdown({ finalReview: false });
    expect(JSON.stringify(memory.requests[2]!.messages.at(-1))).not.toContain("<delegations>");
  });

  test("the session-start curator archives an idle specialist and says so in one line", async () => {
    await setup([], { curator: true });
    const dirOf = join(ctx.home, "agents", "idle");
    await mkdir(dirOf, { recursive: true });
    await writeFile(join(dirOf, "AGENT.md"), renderSpecialistFile({ name: "idle", description: "d", prompt: "## Purpose\nx", emoji: "🔍", createdBy: "user", createdAt: 1, revision: 1 }));
    const old = new Date("2026-01-01T00:00:00Z");
    await utimes(join(dirOf, "AGENT.md"), old, old);
    const { runtime: rt } = await runtime();
    const told: string[] = [];
    await rt.start((_level, text) => told.push(text));
    await waitFor(() => expect(told).toHaveLength(1));
    expect(told).toEqual(["Archived specialist 🔍 idle (unused for 60 days); restore it on the Agents page."]);
  });

  test("shutdown({ finalReview: false }) skips it; the counters carry to the next runtime", async () => {
    const model = await setup([text("a"), text("b"), text("c")], LONG);
    const { runtime: rt } = await runtime();
    const agent = rt.newAgent({ emit: () => {}, askPermission: allow });
    await agent.run("one", signal());
    await agent.run("two", signal());
    expect(rt.finalReviewDue()).toBe(true);
    await rt.shutdown({ finalReview: false });
    expect(model.requests).toHaveLength(2);
    expect(await readCounters()).toEqual({ turnsSinceMemory: 2, toolsSinceSkill: 0 });
    // A fresh runtime in the same project picks the counters up: one more turn and the final review is due.
    const { runtime: next } = await runtime();
    const agent2 = next.newAgent({ emit: () => {}, askPermission: allow });
    expect(next.finalReviewDue()).toBe(false);
    await agent2.run("three", signal());
    expect(next.finalReviewDue()).toBe(true);
    await next.shutdown({ finalReview: false });
  });

  test("clear returns before the final review ends; the next session starts from the carried counters", async () => {
    const final = hanging();
    const model = await setup([text("a"), text("b"), final.step, text("c")], LONG);
    const { runtime: rt } = await runtime();
    const agent = rt.newAgent({ emit: () => {}, askPermission: allow });
    await agent.run("one", signal());
    await agent.run("two", signal());
    await rt.clear();
    // clear is back while the final review still waits for its model reply.
    await final.started;
    expect(model.requests).toHaveLength(3);
    expect(final.signal()!.aborted).toBe(false);
    const fresh = rt.newAgent({ emit: () => {}, askPermission: allow });
    // The new agent didn't cancel the detached review.
    expect(final.signal()!.aborted).toBe(false);
    final.release();
    await fresh.run("three", signal());
    // Carried: 2 turns from before /clear plus this one.
    expect(rt.finalReviewDue()).toBe(true);
    await rt.shutdown({ finalReview: false });
    // The file follows the live session, whenever the detached review finished.
    expect(await readCounters()).toEqual({ turnsSinceMemory: 3, toolsSinceSkill: 0 });
  });

  test("resume returns before the final review ends", async () => {
    const final = hanging();
    await setup([text("a"), text("b"), final.step], LONG);
    const { session, runtime: rt } = await runtime();
    const agent = rt.newAgent({ emit: () => {}, askPermission: allow });
    await agent.run("one", signal());
    await agent.run("two", signal());
    await rt.resume(session.id);
    await final.started;
    expect(final.signal()!.aborted).toBe(false);
    // Shutting down without the final review also stops a detached one.
    await rt.shutdown({ finalReview: false });
    expect(final.signal()!.aborted).toBe(true);
  });

  test("a hanging final review is aborted after 30 s by shutdown()", async () => {
    const final = hanging();
    await setup([text("a"), text("b"), final.step], LONG);
    const { runtime: rt } = await runtime();
    const agent = rt.newAgent({ emit: () => {}, askPermission: allow });
    await agent.run("one", signal());
    await agent.run("two", signal());
    jest.useFakeTimers();
    try {
      let closed = false;
      const closing = rt.shutdown().then(() => void (closed = true));
      await final.started;
      jest.advanceTimersByTime(29_999);
      await Promise.resolve();
      expect(final.signal()!.aborted).toBe(false);
      expect(closed).toBe(false);
      jest.advanceTimersByTime(1);
      expect(final.signal()!.aborted).toBe(true);
      await closing;
    } finally {
      jest.useRealTimers();
    }
    // Aborted before it finished: the work stays counted for the next session.
    expect(await readCounters()).toEqual({ turnsSinceMemory: 2, toolsSinceSkill: 0 });
  });

  test("shutdown({ finalReview: false }) waits at most 30 s for a review that ignores the abort", async () => {
    let markStarted: () => void = () => {};
    const started = new Promise<void>((r) => (markStarted = r));
    let aborted = false;
    // A review whose model call never ends, abort or not.
    const stuck: Step = (_req, _handlers, abort) => {
      abort.addEventListener("abort", () => void (aborted = true));
      markStarted();
      return new Promise(() => {});
    };
    await setup([text("a"), text("b"), stuck]);
    let closed = 0;
    ctx.ext.searchIndex = { close: () => void closed++ } as unknown as SearchIndex;
    const { runtime: rt } = await runtime();
    const agent = rt.newAgent({ emit: () => {}, askPermission: allow });
    await agent.run("one", signal());
    await agent.run("two", signal());
    await started;
    const flush = async () => {
      for (let i = 0; i < 50; i++) await Promise.resolve();
    };
    jest.useFakeTimers();
    try {
      let done = false;
      const closing = rt.shutdown({ finalReview: false }).then(() => void (done = true));
      await flush();
      expect(aborted).toBe(true);
      jest.advanceTimersByTime(29_999);
      await flush();
      expect(done).toBe(false);
      jest.advanceTimersByTime(1);
      await closing;
    } finally {
      jest.useRealTimers();
    }
    expect(closed).toBe(1);
  });

  test("skipFinalReview during shutdown aborts the final review at once; the rest of shutdown still runs", async () => {
    const final = hanging();
    await setup([text("a"), text("b"), final.step], LONG);
    let closed = 0;
    ctx.ext.searchIndex = { close: () => void closed++ } as unknown as SearchIndex;
    const { runtime: rt } = await runtime();
    const agent = rt.newAgent({ emit: () => {}, askPermission: allow });
    await agent.run("one", signal());
    await agent.run("two", signal());
    const closing = rt.shutdown();
    await final.started;
    rt.skipFinalReview();
    await closing;
    expect(final.signal()!.aborted).toBe(true);
    expect(closed).toBe(1);
    expect(await readCounters()).toEqual({ turnsSinceMemory: 2, toolsSinceSkill: 0 });
  });

  test("shutdown closes the search index", async () => {
    await setup();
    let closed = 0;
    ctx.ext.searchIndex = { close: () => void closed++ } as unknown as SearchIndex;
    const { runtime: rt } = await runtime();
    await rt.shutdown();
    expect(closed).toBe(1);
  });
});

test("start shows the start notices as info", async () => {
  const session = await SessionStore.create(ctx.home, { cwd: dir, model: "m", version: "v" });
  const rt = await createRuntime(ctx, { session, history: [], mode: "default", modes: ["default"], theme: DARK, startNotices: ["Added this repo"] });
  const seen: string[] = [];
  await rt.start((level, text) => void seen.push(`${level}:${text}`));
  expect(seen).toContain("info:Added this repo");
});
