import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { FakeModel, reply, textBlock, toolUseBlock } from "../../test/helpers/fake-model";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { makeToolContext } from "../../test/helpers/tool-context";
import { HUB_ONLY_TOOLS } from "../agent/subagent";
import { Ledger } from "../learning/ledger";
import { compileRules, decide, type PermissionContext } from "../permissions/engine";
import { agentsDir, journalDir, workspaceFile } from "../paths";
import { defineTool, type AnyTool } from "../tools/types";
import type { ExecBackend } from "../exec/backend";
import { capAutonomy, execAsks, specialistPermissions, runSpecialist, SPECIALIST_BLOCKED_TOOLS, specialistDenyRules, specialistKit, specialistModel, SpecialistSlots, type SpecialistDeps } from "./delegate";
import { readRuns } from "./runs";
import type { Specialist } from "./specialists";

const tool = (name: string): AnyTool =>
  defineTool({
    name,
    kind: "read",
    description: name,
    schema: z.object({ path: z.string().optional() }).passthrough(),
    summarize: () => "",
    subject: (input: { path?: string }) => ({ paths: input.path ? [input.path] : [] }),
    run: async () => ({ content: `${name} (the chief's)` }),
  }) as AnyTool;

const CHIEF_TOOLS = ["Read", "Grep", "Bash", "Skill", "Memory", "DailyNote", "SkillManage", "Agent", "AgentManage", "Cron", "Identity", "SessionSearch"];

let home: string;
let spec: Specialist;
let deps: SpecialistDeps;
const ctx = () => makeToolContext({ root: "/repo" });

function makeDeps(model: FakeModel): SpecialistDeps {
  return {
    model,
    tools: CHIEF_TOOLS.map(tool),
    system: "BASE",
    config: () => ({ model: "claude-opus-5-5", effort: "high", refusalFallback: true }),
    permissions: () => ({ mode: "default", rules: compileRules({ allow: [], ask: [], deny: [] }).rules, cwd: "/repo", home, allowedDirs: ["/repo"] }),
    askPermission: async () => ({ kind: "deny" }),
    contextText: async () => "<context>CHIEF</context>",
    home,
    role: "owner",
    ledger: new Ledger(home),
    skills: [],
    specialistContext: async (extras) => extras.join("\n"),
    learn: false,
    notice: () => {},
    background: () => {},
  };
}

beforeEach(async () => {
  home = await makeTmpDir();
  const dir = join(agentsDir(home), "reviewer");
  await mkdir(join(dir, "skills", "lint-pr"), { recursive: true });
  await writeFile(join(dir, "MEMORY.md"), "own note\n");
  await writeFile(join(dir, "skills", "lint-pr", "SKILL.md"), "---\nname: lint-pr\ndescription: Lint a PR\n---\nRun the linter.\n");
  spec = { id: "reviewer", name: "reviewer", description: "Reviews PRs", prompt: "Review pull requests.", dir, createdBy: "user", createdAt: 0, revision: 1 };
  deps = makeDeps(new FakeModel([() => reply([textBlock("LGTM")])]));
});
afterEach(async () => {
  await removeDir(home);
});

test("the kit: a subset of the chief's tools, never the blocked ones, own Memory/DailyNote/SkillManage", async () => {
  const kit = await specialistKit({ ...spec, tools: undefined }, deps, "/repo");
  const names = kit.tools.map((t) => t.name);
  expect(names.filter((n) => (SPECIALIST_BLOCKED_TOOLS as readonly string[]).includes(n))).toEqual([]);
  expect(names).toEqual(expect.arrayContaining(["Read", "Memory", "DailyNote", "SkillManage", "Skill"]));
  await kit.tools.find((t) => t.name === "Memory")!.run({ action: "add", target: "memory", content: "PRs need a changelog line" }, ctx());
  expect(await readFile(join(spec.dir, "MEMORY.md"), "utf8")).toContain("changelog");
  expect(await kit.tools.find((t) => t.name === "Memory")!.run({ action: "add", target: "user", content: "x" }, ctx())).toMatchObject({ isError: true });
  await kit.tools.find((t) => t.name === "DailyNote")!.run({ text: "reviewed PR 12" }, ctx());
  expect(await readFile(join(spec.dir, "memory", `${new Date().toLocaleDateString("sv")}.md`), "utf8")).toContain("reviewed PR 12");
  expect((await specialistKit({ ...spec, tools: ["Read"] }, deps, "/repo")).tools.map((t) => t.name)).toEqual(["Read"]);
});

test("the blocked set is the hub-only tools plus Identity and SessionSearch", () => {
  expect([...SPECIALIST_BLOCKED_TOOLS].sort()).toEqual([...HUB_ONLY_TOOLS, "Identity", "SessionSearch"].sort());
});

test("a Skill tool is added when the chief had none and the specialist has skills", async () => {
  const bare = { ...deps, tools: deps.tools.filter((t) => t.name !== "Skill") };
  expect((await specialistKit(spec, bare, "/repo")).tools.map((t) => t.name)).toContain("Skill");
  expect((await specialistKit({ ...spec, tools: ["Read"] }, bare, "/repo")).tools.map((t) => t.name)).toEqual(["Read"]);
});

test("context holds its own notes, journal and skills, never the chief's", async () => {
  await mkdir(join(home, "workspace"), { recursive: true });
  await writeFile(workspaceFile(home, "MEMORY.md"), "owner secret\n");
  const own = await specialistKit(spec, deps, "/repo");
  await own.tools.find((t) => t.name === "DailyNote")!.run({ text: "own journal line" }, ctx());
  const text = await own.contextText();
  expect(text).toContain("own note");
  expect(text).toContain("lint-pr");
  expect(text).toContain("own journal line");
  expect(text).not.toContain("owner secret");
});

const withRules = (deny: ReturnType<typeof specialistDenyRules>): PermissionContext => ({
  mode: "default",
  rules: { allow: [], ask: [], deny },
  cwd: "/repo",
  home,
  allowedDirs: ["/repo", spec.dir],
});

test("deny rules: private files and other specialists, not its own folder", () => {
  const pc = withRules(specialistDenyRules(home, spec, [join(home, "agents/other")]));
  const verdict = (toolName: string, kind: "read" | "edit", path: string) => decide({ toolName, kind, paths: [path] }, pc).behavior;
  expect(verdict("Read", "read", workspaceFile(home, "USER.md"))).toBe("deny");
  expect(verdict("Read", "read", workspaceFile(home, "IDENTITY.md"))).toBe("deny");
  expect(verdict("Read", "read", workspaceFile(home, "AGENTS.md"))).toBe("deny");
  expect(verdict("Grep", "read", join(journalDir(home), "2026-10-16.md"))).toBe("deny");
  expect(verdict("Read", "read", join(home, "workspace", "skills-learned", "x", "SKILL.md"))).toBe("deny");
  expect(verdict("Write", "edit", join(home, "agents/other/MEMORY.md"))).toBe("deny");
  expect(verdict("Read", "read", join(home, "agents/.archive/old/AGENT.md"))).toBe("deny");
  expect(verdict("Read", "read", join(home, "learning/ledger.jsonl"))).toBe("deny");
  expect(verdict("Read", "read", join(home, "projects/abc/session.jsonl"))).toBe("deny");
  expect(verdict("Read", "read", join(home, "memories/USER.md"))).toBe("deny");
  expect(verdict("Read", "read", join(spec.dir, "MEMORY.md"))).not.toBe("deny");
  // Bash is not covered by path rules, but is never silently allowed under default rules.
  expect(decide({ toolName: "Bash", kind: "exec", command: `cat ${workspaceFile(home, "USER.md")}`, paths: [] }, pc).behavior).not.toBe("allow");
});

test("capAutonomy keeps the stricter level of P2's policy and its pinned tests", () => {
  const base = withRules([]);
  const at = (level: "ask" | "balanced" | "autonomous"): PermissionContext => ({ ...base, autonomy: { level, testCommands: ["bun test"] } });
  expect(capAutonomy(at("autonomous"), "balanced").autonomy).toEqual({ level: "balanced", testCommands: ["bun test"] });
  expect(capAutonomy(at("ask"), "autonomous").autonomy?.level).toBe("ask");
  expect(capAutonomy(at("balanced"), undefined).autonomy?.level).toBe("balanced");
  expect(capAutonomy(base, "autonomous").autonomy).toBeUndefined();
});

test("specialistModel: its own model on the chief's provider, otherwise the chief's", () => {
  expect(specialistModel({ model: "haiku" }, "claude-opus-5-5")).toBe("claude-haiku-5-5");
  expect(specialistModel({ model: "haiku" }, "deepseek/deepseek-chat")).toBe("deepseek/deepseek-chat");
  expect(specialistModel({ model: "deepseek/other" }, "deepseek/deepseek-chat")).toBe("deepseek/other");
  expect(specialistModel({}, "deepseek/deepseek-chat")).toBe("deepseek/deepseek-chat");
});

test("at most 4 run at once: the 5th waits for a free slot; an abort while waiting gives up", async () => {
  const slots = new SpecialistSlots();
  const releases = await Promise.all([0, 1, 2, 3].map(() => slots.acquire(new AbortController().signal)));
  expect(slots.running).toBe(4);
  let fifth = false;
  const waiting = slots.acquire(new AbortController().signal).then((r) => ((fifth = true), r));
  await Bun.sleep(0);
  expect(fifth).toBe(false);
  releases[0]!();
  const got = await waiting;
  expect(got).toBeFunction();
  expect(slots.running).toBe(4);
  const aborted = new AbortController();
  const gaveUp = slots.acquire(aborted.signal);
  aborted.abort();
  expect(await gaveUp).toBeNull();
  releases[1]!();
  releases[1]!(); // releasing twice frees one slot only
  expect(slots.running).toBe(3);
  expect(await slots.acquire(AbortSignal.abort())).toBeNull();
});

test("runSpecialist returns the report, records the run, and a guest gets nothing", async () => {
  const slots = new SpecialistSlots();
  const out = await runSpecialist(spec, "review PR 12", "review PR 12", deps, ctx(), slots);
  expect(out.content).toStartWith("LGTM");
  expect(slots.running).toBe(0);
  expect((await readRuns(home, { agent: "reviewer" }))[0]).toMatchObject({ specialist: true, task: "review PR 12", ok: true, result: "LGTM", cwd: "/repo" });
  const guest = await runSpecialist(spec, "x", "x", { ...deps, role: "guest" }, ctx(), new SpecialistSlots());
  expect(guest).toEqual({ content: "Specialists aren't available in this chat.", isError: true });
  expect((await runSpecialist(spec, "x", "x", { ...deps, role: "scheduled", model: new FakeModel([() => reply([textBlock("ok")])]) }, ctx(), new SpecialistSlots())).isError).toBeUndefined();
});

test("the run uses the specialist's model, context and tools, and its deny rules stop reads of the chief's files", async () => {
  const model = new FakeModel([
    () => reply([toolUseBlock("t1", "Read", { path: workspaceFile(home, "USER.md") })], "tool_use"),
    () => reply([textBlock("done")]),
  ]);
  await runSpecialist({ ...spec, model: "haiku" }, "go", "go", makeDeps(model), ctx(), new SpecialistSlots());
  const req = model.requests[0]!;
  expect(req.model).toBe("claude-haiku-5-5");
  expect(req.tools.map((t) => t.name)).not.toContain("Cron");
  const first = JSON.stringify(req.messages[0]);
  expect(first).toContain("own note");
  expect(first).not.toContain("CHIEF");
  expect(String(req.system)).toContain("You are a specialist working for the chief agent");
  expect(String(req.system)).toContain("Review pull requests.");
  expect(JSON.stringify(model.requests[1]!.messages)).toContain("Blocked by the deny rule");
});

test("a failing run is recorded as not ok and still frees the slot", async () => {
  const slots = new SpecialistSlots();
  const d = makeDeps(new FakeModel([() => reply([textBlock("x")], "refusal")]));
  const out = await runSpecialist(spec, "bad", "bad", d, ctx(), slots);
  expect(out.isError).toBe(true);
  expect(slots.running).toBe(0);
  expect((await readRuns(home))[0]).toMatchObject({ ok: false });
});

test("execAsks: an unconfined shell always asks for a specialist, a confined or docker one follows the capped level", () => {
  const pc = (ask: ReturnType<typeof execAsks>): PermissionContext => ({
    ...withRules([]),
    rules: { allow: [], ask, deny: [] },
    autonomy: { level: "autonomous", testCommands: [] },
  });
  const cat = { toolName: "Bash", kind: "exec" as const, command: `cat ${workspaceFile(home, "USER.md")}`, paths: [] };
  const tools = [tool("Bash")];
  for (const exec of [undefined, { kind: "local" } as ExecBackend]) {
    expect(decide(cat, pc(execAsks(exec, tools))).behavior).toBe("ask");
  }
  for (const kind of ["confined", "docker"] as const) {
    const asks = execAsks({ kind } as ExecBackend, tools);
    expect(asks).toEqual([]);
    expect(decide(cat, pc(asks)).behavior).toBe("allow");
  }
  const mcp = { ...tool("mcp__x__run"), kind: "exec" as const } as AnyTool;
  expect(decide({ toolName: "mcp__x__run", kind: "exec", paths: [] }, pc(execAsks(undefined, [mcp]))).behavior).toBe("ask");
});

test("a specialist's saves inside its own folder run unasked; elsewhere they ask or are denied", async () => {
  const kit = await specialistKit(spec, deps, "/repo");
  const base: PermissionContext = { ...withRules([]), mode: "default" };
  const pc = specialistPermissions(base, spec, specialistDenyRules(home, spec, []), []);
  const req = (name: string, input: Record<string, unknown>) => {
    const t = kit.tools.find((x) => x.name === name)!;
    return { toolName: name, kind: t.kind ?? "edit", paths: t.subject(input as never, "/repo").paths };
  };
  expect(decide(req("Memory", { action: "add", target: "memory", content: "x" }), pc).behavior).toBe("allow");
  expect(decide(req("SkillManage", { action: "create", name: "lint", content: "x" }), pc).behavior).toBe("allow");
  expect(decide(req("DailyNote", { text: "x" }), pc).behavior).toBe("allow");
  // The chief's file and another specialist's folder never save unasked.
  expect(decide({ toolName: "Memory", kind: "edit", paths: [workspaceFile(home, "MEMORY.md")] }, pc).behavior).toBe("deny");
  expect(decide({ toolName: "Memory", kind: "edit", paths: [join(home, "agents/other/MEMORY.md")] }, pc).behavior).not.toBe("allow");
  // A save with one target outside the folder asks.
  expect(decide({ toolName: "SkillManage", kind: "edit", paths: [join(spec.dir, "MEMORY.md"), join(home, "workspace", "skills-learned", "x")] }, pc).behavior).not.toBe("allow");
});

test("a specialist's save is announced with its label", async () => {
  const notices: string[] = [];
  const kit = await specialistKit({ ...spec, emoji: "🔍" }, { ...deps, notice: (t) => notices.push(t) }, "/repo");
  await kit.tools.find((t) => t.name === "Memory")!.run({ action: "add", target: "memory", content: "PRs need a changelog line" }, ctx());
  expect(notices).toEqual(["💡 Remembered: PRs need a changelog line (🔍 reviewer)"]);
  await kit.tools.find((t) => t.name === "Memory")!.run({ action: "add", target: "user", content: "x" }, ctx());
  expect(notices).toHaveLength(1);
});

describe("a specialist learns from its own run", () => {
  const readStep = () => reply([toolUseBlock("t1", "Read", { path: "/repo/a.ts" })], "tool_use");
  const learnSteps = (): Array<() => ReturnType<typeof reply>> => [
    readStep,
    () => reply([textBlock("report")]),
    () => reply([toolUseBlock("m1", "Memory", { action: "add", target: "memory", content: "Changelog line needed on every PR" })], "tool_use"),
    () => reply([textBlock("NOTHING")]),
  ];
  async function run(over: Partial<SpecialistDeps>, steps = learnSteps()) {
    const jobs: Promise<void>[] = [];
    const notices: string[] = [];
    const model = new FakeModel(steps);
    await mkdir(join(home, "workspace"), { recursive: true });
    await writeFile(workspaceFile(home, "MEMORY.md"), "chief note\n");
    const out = await runSpecialist({ ...spec, emoji: "🔍" }, "go", "go", { ...makeDeps(model), learn: true, notice: (t) => notices.push(t), background: (w) => void jobs.push(w), ...over }, ctx(), new SpecialistSlots());
    await Promise.all(jobs);
    return { out, model, notices, jobs };
  }

  test("after a run that used tools, the review writes only its own memory and says so once", async () => {
    const { model, notices } = await run({});
    expect(await readFile(join(spec.dir, "MEMORY.md"), "utf8")).toContain("Changelog line");
    expect(await readFile(workspaceFile(home, "MEMORY.md"), "utf8")).toBe("chief note\n");
    expect(notices).toEqual(["💡 🔍 reviewer learned: Memory add memory: Changelog line needed on every PR"]);
    // Its history is the child's messages and its system prompt is the specialist's.
    const review = model.requests[2]!;
    expect(JSON.stringify(review.messages)).toContain("a.ts");
    expect(String(review.system)).toContain("Review pull requests.");
    expect(JSON.stringify(review.messages.at(-1))).toContain("your role");
  });

  test("no review when learning is off, no tool was used, or the run failed", async () => {
    expect((await run({ learn: false }, [readStep, () => reply([textBlock("r")])])).model.requests).toHaveLength(2);
    expect((await run({}, [() => reply([textBlock("r")])])).model.requests).toHaveLength(1);
    expect((await run({}, [readStep, () => reply([textBlock("x")], "refusal")])).model.requests).toHaveLength(2);
  });

  test("a review that can't use the model fails quietly", async () => {
    const { out, notices } = await run({}, [readStep, () => reply([textBlock("report")]), () => { throw new Error("boom"); }]);
    expect(out.isError).toBeUndefined();
    expect(notices).toEqual([]);
  });
});
