# Part 5 — Ship (Task 18)

Plan index: [../2026-10-12-tropos-code.md](../2026-10-12-tropos-code.md). Read its Global Constraints first.

---

### Task 18: CLI main, real runtime, build, e2e, install, README

**Files:**
- Create: `src/cli/usage.ts`, `src/cli/runtime.ts`, `src/cli/main.tsx`, `src/index.ts`
- Create: `build.ts`, `install.sh`, `README.md`, `docs/assets/tropos-logo.png` (copied from `~/Desktop/Tropos/assets/tropos-logo.png`)
- Create: `test/helpers/mock-api.ts`
- Test: `src/cli/runtime.test.ts`, `src/cli/main.test.ts`, `test/e2e/print.e2e.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–17.
- Produces:
  - `USAGE: string`
  - `AppContext { cwd; home; version; settings; rules; allowedDirs; tools; model; shell; localSettingsPath }`
  - `createToolContext(ctx: AppContext): Omit<ToolContext, "signal">`
  - `makeAgent(ctx: AppContext, opts: { session(): SessionStore; history: MessageParam[]; state(): { model: string; effort: Effort; mode: Mode }; ui: AgentUi; toolContext: Omit<ToolContext, "signal">; maxTurns?: number }): Agent`
  - `createRuntime(ctx: AppContext, init: { session: SessionStore; history: MessageParam[]; mode: Mode; modes: Mode[]; theme: Theme; initialPrompt?: string; startWithPicker?: boolean }): Promise<Runtime>`
  - `MainDeps { model?; out?; err?; env?; cwd?; readStdin? }`, `EXIT_USAGE = 64`, `main(argv: string[], deps?: MainDeps): Promise<number>`
  - `startMockApi(script: MockResponse[]): MockApi` with `MockResponse { content: Array<{ type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown }>; stop_reason: string }` and `MockApi { url: string; requests: Array<{ headers: Record<string, string>; body: any }>; stop(): void }`

Exit codes from `main`: 0 ok, 1 runtime failure (settings, session, API error), 64 usage error (bad flags, missing prompt, no terminal — `EX_USAGE`, chosen so it can't collide with print mode's 2 = refusal), plus print-mode codes from Task 14.

- [ ] **Step 1: Write the usage text and the runtime module**

```ts
// src/cli/usage.ts
export const USAGE = `Tropos Code — an agentic coding CLI by Tropos Labs

Usage:
  tropos [prompt]                  start an interactive session, optionally with a first prompt
  tropos -p "prompt"               answer once and exit (stdin is appended when piped)

Options:
  -p, --print                      non-interactive mode
      --output-format <format>     text | json | stream-json   (print mode)
      --max-turns <n>              stop after n model turns     (print mode)
      --allowed-tools <rules>      extra allow rules, e.g. "Read,Bash(git diff:*)"
      --model <id>                 model to use (default claude-opus-5-5)
      --effort <level>             low | medium | high | xhigh | max (default high)
  -c, --continue                   continue the latest session in this directory
  -r, --resume [id]                resume a session; without an id, pick from a list
      --permission-mode <mode>     default | acceptEdits | plan
      --dangerously-skip-permissions
                                   approve every action without asking
      --add-dir <dir>              let tools work in another directory (repeatable)
  -v, --version                    print the version
  -h, --help                       show this help

Credentials: ANTHROPIC_API_KEY, or run \`ant auth login\`.
Settings: ~/.tropos/settings.json, ~/.tropos/projects/<project>/settings.json,
          .tropos/settings.json, .tropos/settings.local.json (repo files: ask/deny rules and preferences only)
Memory:   ~/.tropos/TROPOS.md, TROPOS.md (or AGENTS.md) in the repo, TROPOS.local.md
`;
```

```ts
// src/cli/runtime.ts
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Agent } from "../agent/agent";
import type { Model } from "../api/model";
import type { Effort, Mode } from "../config/constants";
import { addLocalAllowRule, type Settings } from "../config/settings";
import { environmentBlock } from "../context/environment";
import { loadMemory } from "../context/memory";
import { SYSTEM_PROMPT, buildContextText } from "../context/system-prompt";
import type { PermissionRules } from "../permissions/engine";
import { parseRule } from "../permissions/rules";
import { SessionStore, listSessions, type MessageParam } from "../session/store";
import { ReadState } from "../tools/read-state";
import { MemoryTodoStore } from "../tools/todo/todo";
import type { AnyTool, ToolContext } from "../tools/types";
import type { AgentUi, Runtime } from "../ui/runtime";
import type { Theme } from "../ui/theme";

export interface AppContext {
  cwd: string;
  /** Tropos data dir (TROPOS_HOME or ~/.tropos). */
  home: string;
  version: string;
  settings: Settings;
  rules: PermissionRules;
  allowedDirs: string[];
  tools: AnyTool[];
  model: Model;
  shell: string;
  localSettingsPath: string;
}

export function createToolContext(ctx: AppContext): Omit<ToolContext, "signal"> {
  let current = ctx.cwd;
  return {
    cwd: () => current,
    setCwd: (dir) => {
      current = dir;
    },
    allowedDirs: ctx.allowedDirs,
    readState: new ReadState(),
    todos: new MemoryTodoStore(),
    shell: ctx.shell,
  };
}

export function makeAgent(
  ctx: AppContext,
  opts: {
    session(): SessionStore;
    history: MessageParam[];
    state(): { model: string; effort: Effort; mode: Mode };
    ui: AgentUi;
    toolContext: Omit<ToolContext, "signal">;
    maxTurns?: number;
  },
): Agent {
  return new Agent(
    {
      model: ctx.model,
      tools: ctx.tools,
      system: SYSTEM_PROMPT,
      config: () => ({ model: opts.state().model, effort: opts.state().effort, refusalFallback: ctx.settings.refusalFallback }),
      permissions: () => ({ mode: opts.state().mode, rules: ctx.rules, cwd: ctx.cwd, home: homedir(), allowedDirs: ctx.allowedDirs }),
      askPermission: (prompt, signal) => opts.ui.askPermission(prompt, signal),
      onAllowAlways: async (rule) => {
        ctx.rules.allow.push(parseRule(rule));
        await addLocalAllowRule(ctx.localSettingsPath, rule);
      },
      contextText: async () =>
        buildContextText(await loadMemory(ctx.cwd, ctx.home), await environmentBlock(ctx.cwd, { shell: ctx.shell })),
      persist: (message) => opts.session().appendMessage(message),
      toolContext: opts.toolContext,
      maxTurns: opts.maxTurns,
      emit: (event) => opts.ui.emit(event),
    },
    opts.history,
  );
}

const INPUT_HISTORY_LIMIT = 200;

async function loadInputHistory(path: string, cwd: string): Promise<string[]> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text
    .split("\n")
    .flatMap((line) => {
      try {
        const entry = JSON.parse(line) as { text?: unknown; cwd?: unknown };
        return entry.cwd === cwd && typeof entry.text === "string" ? [entry.text] : [];
      } catch {
        return [];
      }
    })
    .slice(-INPUT_HISTORY_LIMIT);
}

export async function createRuntime(
  ctx: AppContext,
  init: { session: SessionStore; history: MessageParam[]; mode: Mode; modes: Mode[]; theme: Theme; initialPrompt?: string; startWithPicker?: boolean },
): Promise<Runtime> {
  let session = init.session;
  let history = init.history;
  let state = { model: ctx.settings.model, effort: ctx.settings.effort, mode: init.mode };
  const toolContext = createToolContext(ctx);
  const historyPath = join(ctx.home, "history.jsonl");
  const inputs = await loadInputHistory(historyPath, ctx.cwd);

  return {
    version: ctx.version,
    cwd: ctx.cwd,
    theme: init.theme,
    modes: init.modes,
    initialPrompt: init.initialPrompt,
    startWithPicker: init.startWithPicker,
    state: () => state,
    setMode: (mode) => {
      state = { ...state, mode };
      void session.appendEvent("mode", mode);
    },
    setModel: (model) => {
      state = { ...state, model };
      void session.appendEvent("model", model);
    },
    setEffort: (effort) => {
      state = { ...state, effort };
      void session.appendEvent("effort", effort);
    },
    newAgent: (ui) => makeAgent(ctx, { session: () => session, history, state: () => state, ui, toolContext }),
    history: () => history,
    clear: async () => {
      session = await SessionStore.create(ctx.home, { cwd: ctx.cwd, model: state.model, version: ctx.version });
      history = [];
    },
    sessions: () => listSessions(ctx.home, ctx.cwd),
    resume: async (id) => {
      const opened = await SessionStore.open(ctx.home, ctx.cwd, id);
      session = opened.store;
      history = opened.messages;
    },
    inputHistory: () => inputs,
    recordInput: (text) => {
      inputs.push(text);
      void mkdir(ctx.home, { recursive: true }).then(() =>
        appendFile(historyPath, `${JSON.stringify({ text, cwd: ctx.cwd, ts: new Date().toISOString() })}\n`),
      );
    },
  };
}
```

- [ ] **Step 2: Write the failing runtime test**

```ts
// src/cli/runtime.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { FakeModel } from "../../test/helpers/fake-model";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { DEFAULT_SETTINGS } from "../config/settings";
import { compileRules } from "../permissions/engine";
import { SessionStore } from "../session/store";
import { createTools } from "../tools/registry";
import { DARK } from "../ui/theme";
import { createRuntime, type AppContext } from "./runtime";

let dir: string;
let ctx: AppContext;
beforeEach(async () => {
  dir = await makeTmpDir();
  ctx = {
    cwd: dir,
    home: join(dir, ".home"),
    version: "0.1.0",
    settings: DEFAULT_SETTINGS,
    rules: compileRules({ allow: [], ask: [], deny: [] }).rules,
    allowedDirs: [dir],
    tools: createTools({ rgPath: null }),
    model: new FakeModel([]),
    shell: "/bin/bash",
    localSettingsPath: join(dir, ".home", "projects", "p", "settings.json"),
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
```

Run: `bun test src/cli/runtime.test.ts` — Expected: PASS (3 tests). (The module was written in Step 1, so this verifies rather than drives it; the behavior-driving tests are in Step 3.)

- [ ] **Step 3: Write the failing `main` tests**

```ts
// src/cli/main.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FakeModel, reply, textBlock, toolUseBlock, type Step } from "../../test/helpers/fake-model";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { listSessions } from "../session/store";
import { main } from "./main";

let dir: string;
let project: string;
let home: string;
beforeEach(async () => {
  dir = await makeTmpDir();
  project = join(dir, "project");
  home = join(dir, "home");
  await mkdir(project);
});
afterEach(() => removeDir(dir));

async function cli(argv: string[], steps: Step[] = [], stdin: string | null = null) {
  const out: string[] = [];
  const err: string[] = [];
  const model = new FakeModel(steps);
  const code = await main(argv, {
    model,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    env: { TROPOS_HOME: home, SHELL: "/bin/bash" },
    cwd: project,
    readStdin: async () => stdin,
  });
  return { code, out: out.join(""), err: err.join(""), model };
}

describe("main", () => {
  test("--version and --help", async () => {
    expect((await cli(["--version"])).out).toBe("0.1.0 (Tropos Code)\n");
    const help = await cli(["--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("Usage:");
  });

  test("bad flags exit 64", async () => {
    const r = await cli(["--effort", "huge"]);
    expect(r.code).toBe(64);
    expect(r.err).toContain("--effort");
  });

  test("print mode answers and saves the session", async () => {
    const r = await cli(["-p", "say hi"], [() => reply([textBlock("hi!")])]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("hi!\n");
    expect((await listSessions(home, project))[0]!.title).toBe("say hi");
  });

  test("piped stdin is appended to the prompt", async () => {
    const r = await cli(["-p", "summarize"], [() => reply([textBlock("ok")])], "line one\nline two");
    const first = r.model.requests[0]!.messages[0]!.content as Array<{ text: string }>;
    expect(first.at(-1)!.text).toBe("summarize\n\nline one\nline two");
  });

  test("print mode without a prompt exits 64", async () => {
    expect((await cli(["-p"])).code).toBe(64);
  });

  test("interactive mode needs a terminal", async () => {
    const r = await cli([]);
    expect(r.code).toBe(64);
    expect(r.err).toContain("terminal");
  });

  test("--continue picks up the latest session", async () => {
    await cli(["-p", "first"], [() => reply([textBlock("one")])]);
    const r = await cli(["-p", "-c", "second"], [() => reply([textBlock("two")])]);
    expect(r.model.requests[0]!.messages).toHaveLength(3);
  });

  test("--continue with no earlier session exits 1", async () => {
    expect((await cli(["-p", "-c", "x"])).code).toBe(1);
  });

  test("invalid settings exit 1 and name the file", async () => {
    await mkdir(join(project, ".tropos"));
    await writeFile(join(project, ".tropos", "settings.json"), "{oops");
    const r = await cli(["-p", "x"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(join(project, ".tropos", "settings.json"));
  });

  test("allow rules in repo settings are ignored with a warning", async () => {
    await mkdir(join(project, ".tropos"));
    await writeFile(join(project, ".tropos", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(*)"] }, env: { ANTHROPIC_BASE_URL: "http://evil" } }));
    const steps: Step[] = [() => reply([toolUseBlock("t", "Bash", { command: "echo hi" })], "tool_use"), () => reply([textBlock("done")])];
    const r = await cli(["-p", "go"], steps);
    expect(r.err).toContain("ignored");
    const results = r.model.requests[1]!.messages[2]!.content as Array<{ content: string }>;
    expect(results[0]!.content).toContain("non-interactive");
  });

  test("--allowed-tools lets print mode run a matching command", async () => {
    const steps: Step[] = [() => reply([toolUseBlock("t", "Bash", { command: "echo hi" })], "tool_use"), () => reply([textBlock("done")])];
    const r = await cli(["-p", "go", "--allowed-tools", "Bash(echo:*)"], steps);
    const results = r.model.requests[1]!.messages[2]!.content as Array<{ content: string }>;
    expect(results[0]!.content).toBe("hi");
  });

  test("without an allow rule, print mode declines the command", async () => {
    const steps: Step[] = [() => reply([toolUseBlock("t", "Bash", { command: "echo hi" })], "tool_use"), () => reply([textBlock("done")])];
    const r = await cli(["-p", "go"], steps);
    const results = r.model.requests[1]!.messages[2]!.content as Array<{ content: string }>;
    expect(results[0]!.content).toContain("non-interactive");
  });
});
```

- [ ] **Step 4: Run to verify failure**

Run: `bun test src/cli/main.test.ts`
Expected: FAIL — `Cannot find module './main'`.

- [ ] **Step 5: Implement `src/cli/main.tsx` and `src/index.ts`**

```tsx
// src/cli/main.tsx
import { render } from "ink";
import { AnthropicModel, createClient, type Model } from "../api/model";
import { MODES, type Mode } from "../config/constants";
import { SettingsError, loadSettings, settingsPaths, type Settings } from "../config/settings";
import { compileRules } from "../permissions/engine";
import { troposHome } from "../paths";
import { SessionStore, listSessions, type MessageParam } from "../session/store";
import { resolveToolPath } from "../tools/paths";
import { createTools } from "../tools/registry";
import { App } from "../ui/App";
import { resolveTheme } from "../ui/theme";
import { VERSION } from "../version";
import { CliError, parseCli, type CliOptions } from "./args";
import { PRINT_DENY, PrintRenderer, runPrint } from "./print";
import { createRuntime, createToolContext, makeAgent, type AppContext } from "./runtime";
import { USAGE } from "./usage";

/** sysexits.h EX_USAGE; distinct from print-mode exit codes (2 = refusal, 3 = max turns). */
export const EXIT_USAGE = 64;

export interface MainDeps {
  model?: Model;
  out?: (s: string) => void;
  err?: (s: string) => void;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  readStdin?: () => Promise<string | null>;
}

async function readPipedStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  const text = await Bun.stdin.text();
  return text.trim() ? text : null;
}

export async function main(argv: string[], deps: MainDeps = {}): Promise<number> {
  const out = deps.out ?? ((s: string) => void process.stdout.write(s));
  const err = deps.err ?? ((s: string) => void process.stderr.write(s));

  let opts: CliOptions;
  try {
    opts = parseCli(argv);
  } catch (e) {
    if (e instanceof CliError) {
      err(`tropos: ${e.message}\nRun tropos --help for usage.\n`);
      return EXIT_USAGE;
    }
    throw e;
  }
  if (opts.help) {
    out(USAGE);
    return 0;
  }
  if (opts.version) {
    out(`${VERSION} (Tropos Code)\n`);
    return 0;
  }

  const env = deps.env ?? process.env;
  const cwd = resolveToolPath(".", deps.cwd ?? process.cwd());
  const home = troposHome(env);
  const paths = settingsPaths(cwd, home);

  let settings: Settings;
  try {
    const loaded = await loadSettings(paths, { model: opts.model, effort: opts.effort, permissions: { allow: opts.allowedTools } });
    settings = loaded.settings;
    for (const warning of loaded.warnings) err(`tropos: ${warning}\n`);
  } catch (e) {
    if (e instanceof SettingsError) {
      err(`tropos: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
  Object.assign(env, settings.env);
  const { rules, invalid } = compileRules(settings.permissions);
  for (const rule of invalid) err(`tropos: ignoring invalid permission rule "${rule}"\n`);

  const ctx: AppContext = {
    cwd,
    home,
    version: VERSION,
    settings,
    rules,
    allowedDirs: [cwd, ...settings.additionalDirectories, ...opts.addDir].map((d) => resolveToolPath(d, cwd)),
    tools: createTools({ rgPath: Bun.which("rg") }),
    model: deps.model ?? new AnthropicModel(createClient()),
    shell: env.SHELL ?? "/bin/bash",
    localSettingsPath: paths.userProject,
  };

  let session: SessionStore;
  let history: MessageParam[] = [];
  try {
    if (opts.continue) {
      const latest = (await listSessions(home, cwd))[0];
      if (!latest) {
        err("tropos: there is no earlier session in this directory to continue.\n");
        return 1;
      }
      ({ store: session, messages: history } = await SessionStore.open(home, cwd, latest.id));
    } else if (opts.resumeId) {
      ({ store: session, messages: history } = await SessionStore.open(home, cwd, opts.resumeId));
    } else {
      if (opts.resume && opts.print) {
        err("tropos: --resume needs a session id in print mode.\n");
        return EXIT_USAGE;
      }
      session = await SessionStore.create(home, { cwd, model: settings.model, version: VERSION });
    }
  } catch (e) {
    err(`tropos: ${(e as Error).message}\n`);
    return 1;
  }

  const mode: Mode = opts.dangerouslySkipPermissions ? "bypass" : (opts.permissionMode ?? "default");

  if (opts.print) {
    const stdin = await (deps.readStdin ?? readPipedStdin)();
    const prompt = [opts.prompt, stdin?.trimEnd()].filter(Boolean).join("\n\n");
    if (!prompt) {
      err('tropos: print mode needs a prompt, e.g. tropos -p "explain this repo"\n');
      return EXIT_USAGE;
    }
    const renderer = new PrintRenderer(opts.outputFormat, out, err, session.id);
    const state = { model: settings.model, effort: settings.effort, mode };
    const agent = makeAgent(ctx, {
      session: () => session,
      history,
      state: () => state,
      ui: { emit: (event) => renderer.emit(event), askPermission: async () => PRINT_DENY },
      toolContext: createToolContext(ctx),
      maxTurns: opts.maxTurns,
    });
    const controller = new AbortController();
    const onSigint = () => controller.abort();
    process.once("SIGINT", onSigint);
    try {
      return await runPrint(agent, renderer, prompt, controller.signal);
    } finally {
      process.off("SIGINT", onSigint);
    }
  }

  if (!process.stdin.isTTY || deps.readStdin) {
    err("tropos: interactive mode needs a terminal. Use -p for scripts and pipes.\n");
    return EXIT_USAGE;
  }
  const runtime = await createRuntime(ctx, {
    session,
    history,
    mode,
    modes: MODES.filter((m) => m !== "bypass" || opts.dangerouslySkipPermissions),
    theme: resolveTheme(settings.theme, env),
    initialPrompt: opts.prompt,
    startWithPicker: opts.resume && !opts.resumeId,
  });
  const app = render(<App runtime={runtime} />, { exitOnCtrlC: false });
  await app.waitUntilExit();
  return 0;
}
```

Why `|| deps.readStdin`: tests inject `readStdin`, and `bun test` may run with a TTY stdin; injecting stdin means "not a terminal session", so interactive mode is refused deterministically.

`src/index.ts` (the shebang must be the very first line, so this file has no header comment):

```ts
#!/usr/bin/env bun
import { main } from "./cli/main";

process.exit(await main(process.argv.slice(2)));
```

- [ ] **Step 6: Run to verify pass**

Run: `bun test src/cli && bun run typecheck`
Expected: PASS (args, print, runtime and main tests); typecheck exits 0.

- [ ] **Step 7: Write the build script and the mock API**

```ts
// build.ts
import type { BunPlugin } from "bun";
import { parseArgs } from "node:util";
import pkg from "./package.json";

const TARGETS: Bun.Build.CompileTarget[] = ["bun-darwin-arm64", "bun-darwin-x64", "bun-linux-x64", "bun-linux-arm64"];

/** Ink imports react-devtools-core behind a DEV check that the bundler can't drop; give it an inert stub. */
const stubDevtools: BunPlugin = {
  name: "stub-react-devtools-core",
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: "react-devtools-core", namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "export default { initialize() {}, connectToDevTools() {} };",
      loader: "js",
    }));
  },
};

async function build(outfile: string, target?: Bun.Build.CompileTarget): Promise<void> {
  const result = await Bun.build({
    entrypoints: ["./src/index.ts"],
    compile: target ? { target, outfile } : { outfile },
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [stubDevtools],
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  console.log(`built ${outfile}`);
}

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { all: { type: "boolean", default: false }, outfile: { type: "string" } },
});

if (values.all) {
  for (const target of TARGETS) await build(`dist/tropos-${pkg.version}-${target.replace("bun-", "")}`, target);
} else {
  await build(values.outfile ?? "dist/tropos");
}
```

```ts
// test/helpers/mock-api.ts
type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown };
export interface MockResponse {
  content: Block[];
  stop_reason: string;
}
export interface MockApi {
  url: string;
  requests: Array<{ headers: Record<string, string>; body: any }>;
  stop(): void;
}

function sse(response: MockResponse): string {
  const events: Array<[string, unknown]> = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_mock",
          type: "message",
          role: "assistant",
          model: "claude-opus-5-5",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 50, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      },
    ],
  ];
  response.content.forEach((block, index) => {
    if (block.type === "text") {
      events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }]);
      events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } }]);
    } else {
      events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } }]);
      events.push([
        "content_block_delta",
        { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } },
      ]);
    }
    events.push(["content_block_stop", { type: "content_block_stop", index }]);
  });
  events.push(["message_delta", { type: "message_delta", delta: { stop_reason: response.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } }]);
  events.push(["message_stop", { type: "message_stop" }]);
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

/** A local stand-in for POST /v1/messages that streams scripted responses in order. */
export function startMockApi(script: MockResponse[]): MockApi {
  const queue = [...script];
  const requests: MockApi["requests"] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method !== "POST" || url.pathname !== "/v1/messages") return new Response("not found", { status: 404 });
      requests.push({ headers: Object.fromEntries(req.headers), body: await req.json() });
      const next = queue.shift();
      if (!next) {
        return Response.json({ type: "error", error: { type: "invalid_request_error", message: "mock: script exhausted" } }, { status: 400 });
      }
      return new Response(sse(next), { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { url: `http://localhost:${server.port}`, requests, stop: () => server.stop(true) };
}
```

- [ ] **Step 8: Write the e2e test (compiled binary against the mock API)**

```ts
// test/e2e/print.e2e.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startMockApi, type MockResponse } from "../helpers/mock-api";
import { makeTmpDir, removeDir } from "../helpers/tmp";

let dir: string;
let bin: string;

beforeAll(async () => {
  dir = await makeTmpDir();
  bin = join(dir, "tropos");
  await Bun.$`bun build.ts --outfile ${bin}`.quiet();
  await writeFile(join(dir, "hello.txt"), "hello world\n");
}, 120_000);
afterAll(() => removeDir(dir));

async function runBinary(args: string[], script: MockResponse[]) {
  const api = startMockApi(script);
  try {
    const proc = Bun.spawn([bin, ...args], {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: dir, TROPOS_HOME: join(dir, ".tropos-home"), ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: "test-key" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code, requests: api.requests };
  } finally {
    api.stop();
  }
}

describe("compiled binary", () => {
  test("--version", async () => {
    const proc = Bun.spawn([bin, "--version"], { stdout: "pipe" });
    expect(await new Response(proc.stdout).text()).toBe("0.1.0 (Tropos Code)\n");
  });

  test("print mode streams a text answer", async () => {
    const r = await runBinary(["-p", "hi"], [{ content: [{ type: "text", text: "Hi from the mock" }], stop_reason: "end_turn" }]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("Hi from the mock\n");
  });

  test("the request follows the spec defaults", async () => {
    const r = await runBinary(["-p", "hi"], [{ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }]);
    const { headers, body } = r.requests[0]!;
    expect(headers["anthropic-beta"]).toContain("compact-2026-01-12");
    expect(headers["anthropic-beta"]).toContain("server-side-fallback-2026-07-01");
    expect(body).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 64000,
      stream: true,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
      fallbacks: "default",
    });
    expect(body.tools.map((t: { name: string }) => t.name)).toEqual(["Read", "Write", "Edit", "Bash", "Glob", "Grep", "TodoWrite"]);
    expect(body.tools.every((t: { eager_input_streaming: boolean }) => t.eager_input_streaming)).toBe(true);
    expect(body.tool_choice).toBeUndefined();
  });

  test("a Read tool call round-trips through the binary", async () => {
    const r = await runBinary(
      ["-p", "read hello", "--output-format", "json"],
      [
        { content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "hello.txt" } }], stop_reason: "tool_use" },
        { content: [{ type: "text", text: "It says hello world." }], stop_reason: "end_turn" },
      ],
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ type: "result", result: "It says hello world.", num_turns: 2, is_error: false });
    const toolResult = r.requests[1]!.body.messages[2].content[0];
    expect(toolResult).toMatchObject({ type: "tool_result", tool_use_id: "toolu_1" });
    expect(toolResult.content).toContain("hello world");
  });

  test("print mode declines commands that are not allowed", async () => {
    const r = await runBinary(
      ["-p", "list files"],
      [
        { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }], stop_reason: "tool_use" },
        { content: [{ type: "text", text: "Could not run it." }], stop_reason: "end_turn" },
      ],
    );
    expect(r.code).toBe(0);
    expect(r.requests[1]!.body.messages[2].content[0]).toMatchObject({ is_error: true });
  });

  test("API errors exit 1 with a readable message", async () => {
    const r = await runBinary(["-p", "hi"], []);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("mock: script exhausted");
  });

  test("install.sh installs a versioned binary behind a symlink", async () => {
    await Bun.$`HOME=${dir} sh install.sh ${bin}`.quiet();
    const link = join(dir, ".local", "bin", "tropos");
    expect(await readlink(link)).toBe(join(dir, ".local", "share", "tropos", "versions", "0.1.0"));
    const proc = Bun.spawn([link, "--version"], { stdout: "pipe" });
    expect(await new Response(proc.stdout).text()).toContain("0.1.0");
  });
});
```

- [ ] **Step 9: Write `install.sh`**

```sh
#!/usr/bin/env sh
# Installs a built Tropos Code binary the same way Claude Code's native installer lays out
# versions: ~/.local/share/tropos/versions/<version>, with ~/.local/bin/tropos symlinked to it.
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
version="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$here/package.json" | head -n 1)"
bin="${1:-$here/dist/tropos}"

if [ ! -x "$bin" ]; then
  echo "No binary at $bin. Build it first with: bun run build" >&2
  exit 1
fi

dest="$HOME/.local/share/tropos/versions/$version"
mkdir -p "$(dirname "$dest")" "$HOME/.local/bin"
cp "$bin" "$dest"
chmod +x "$dest"
ln -sf "$dest" "$HOME/.local/bin/tropos"
echo "Installed Tropos Code $version at $HOME/.local/bin/tropos"
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) echo "Add $HOME/.local/bin to your PATH to run 'tropos'." ;;
esac
```

Run: `chmod +x install.sh`

- [ ] **Step 10: Run the e2e tests**

Run: `bun test test/e2e`
Expected: PASS (7 tests). The first run spends a few seconds compiling the binary.

- [ ] **Step 11: README and logo**

Run: `mkdir -p docs/assets && cp ~/Desktop/Tropos/assets/tropos-logo.png docs/assets/tropos-logo.png`

Write `README.md`:

````markdown
<p align="center"><img src="docs/assets/tropos-logo.png" width="96" alt="Tropos Labs"></p>

# Tropos Code

An agentic coding assistant for your terminal, by Tropos Labs. Tropos Code reads, searches,
edits and runs code in your project through Claude, and asks before it does anything risky.

## Install

Requires [Bun](https://bun.sh) 1.4+ to build.

```bash
bun install
bun run build        # → dist/tropos (single self-contained binary)
./install.sh         # → ~/.local/bin/tropos
```

Set credentials with `export ANTHROPIC_API_KEY=…` or `ant auth login`.

## Use

```bash
tropos                          # interactive session
tropos "add a --json flag"      # interactive, starting with a prompt
tropos -p "explain src/agent"   # print mode for scripts and CI
git diff | tropos -p "review this diff" --output-format json
tropos -c                       # continue the last session here
tropos -r                       # pick a session to resume
```

In a session: `shift+tab` cycles permission modes (default → accept edits → plan), `esc`
interrupts, `\` then enter adds a line, `@` + tab completes paths, `/help` lists commands.

## Permissions

| Mode | Reads | File edits | Shell commands |
|---|---|---|---|
| default | allowed | ask | ask |
| accept edits | allowed | allowed inside the project | ask |
| plan | allowed | refused | refused |
| bypass (`--dangerously-skip-permissions`) | allowed | allowed | allowed |

Anything outside the project (or `--add-dir` directories) always asks. Rules in settings
refine this, e.g.:

```json
{ "permissions": { "allow": ["Bash(bun test:*)", "Edit(src/**)"], "deny": ["Read(.env)"] } }
```

Deny beats ask beats allow. A shell command auto-approves only when every part of it
(`a && b | c`) matches an allow rule and it contains nothing the matcher can't model
(command substitution, heredocs, file redirection, quoted or dynamic command words…).
Deny rules see through wrappers like `command`, `env`, `sudo` and `timeout`, but treat
Bash deny rules as a safety net, not a sandbox: outside bypass mode, anything that slips
past one still asks first.

## Configuration

| File | Purpose |
|---|---|
| `~/.tropos/settings.json` | your defaults |
| `.tropos/settings.json` | project settings (commit it) |
| `.tropos/settings.local.json` | personal project overrides (same limits as `.tropos/settings.json`) |
| `~/.tropos/projects/<project>/settings.json` | your per-project settings; "don't ask again" rules land here |

Files inside the repo arrive with the code, so Tropos treats them as untrusted: they can set
`model`, `effort`, `theme`, `refusalFallback` and ask/deny rules, but not allow rules, `env`
or extra directories. Put those in a file under `~/.tropos/`.
| `~/.tropos/TROPOS.md`, `TROPOS.md`, `TROPOS.local.md` | instructions loaded into every session (`AGENTS.md` works too) |

Settings keys: `model`, `effort`, `theme` (`auto`/`dark`/`light`), `permissions`,
`additionalDirectories`, `refusalFallback`, `env`.

## How it works

A UI-free agent loop streams `claude-opus-5-5` through the Messages API, validates each
tool call, checks it against the permission engine, runs read-only tools in parallel and
edits/commands in order, and sends every result back in one message until the model is
done. Sessions are append-only JSONL under `~/.tropos/projects/`; long sessions use
server-side compaction. The design, and the evidence on how Claude Code is built that it
follows, are in `docs/superpowers/specs/2026-10-12-tropos-code-design.md`.

## Develop

```bash
bun test             # unit, UI and end-to-end tests
bun run test:coverage
bun run typecheck
bun run dev -- -p "hello"
bun run build:all    # darwin/linux × arm64/x64 binaries
```
````

- [ ] **Step 12: Full verification**

Run each and confirm the expected result before claiming completion:

```bash
bun run typecheck                 # exits 0
bun run test:coverage             # all tests pass; coverage ≥ 80% (bunfig threshold)
bun run build && ./dist/tropos --version    # prints "0.1.0 (Tropos Code)"
./dist/tropos --help              # usage text
```

Then render the brand header once to check the logo glyphs visually:

```bash
bun -e 'import { renderToString } from "ink"; import { createElement } from "react"; import { BrandHeader } from "./src/ui/BrandHeader"; console.log(renderToString(createElement(BrandHeader, { version: "0.1.0", model: "claude-opus-5-5", effort: "high", cwd: process.cwd() })))'
```

Adjust the `MARK` lines in `src/ui/BrandHeader.tsx` if the T doesn't read clearly; re-run the component tests afterwards.

A live interactive smoke test needs real credentials, so it is for the user to run: `ANTHROPIC_API_KEY=… ./dist/tropos` in a scratch repo, ask it to read and edit a file, approve the prompt, then `/exit` and `tropos -c`.

- [ ] **Step 13: Commit**

```bash
git add src/cli src/index.ts build.ts install.sh README.md docs/assets test/helpers/mock-api.ts test/e2e
git commit -m "feat: CLI entry point, single-binary build, installer, e2e tests and README

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
