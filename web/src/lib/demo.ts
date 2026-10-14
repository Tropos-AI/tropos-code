// web/src/lib/demo.ts — `?demo=1`: a fake tcode server behind a fake socket, so the UI can be built and screenshotted
// without tcode running. It speaks the real protocol (src/web/protocol.ts): hello, state, a scripted turn with every
// kind of event (thinking, Markdown, Bash/Read/TodoWrite/Edit/Agent tools, a permission ask, usage), and answers to
// every RPC with plausible data.
import type { AgentEvent, PermissionAnswer, PermissionPrompt, TurnEndReason } from "@core/agent/events";
import type { Effort, Mode } from "@core/config/constants";
import type { MessageParam, SessionSummary } from "@core/session/store";
import type { ListTopic } from "@core/ui/commands";
import type { ClientMessage, HelloInfo, RpcMap, RpcMethod, ServerMessage, SessionState } from "@core/web/protocol";

import type { SocketLike } from "@/lib/client";
import { createDemoProviders, DEMO_PANELS } from "@/lib/demo-panels";

const CWD = "/Users/demo/code/tropos-code";
const SESSION_ID = "6f1c2d9a-4b7e-4e21-9c3a-1d2e3f4a5b6c";

const FIRST_PROMPT = "The session list in the sidebar shows raw ISO dates. Make them relative (\"2h ago\") and add a test.";

const PATCH = `--- web/src/lib/time.ts
+++ web/src/lib/time.ts
@@ -1,9 +1,21 @@
 // web/src/lib/time.ts
-export function formatDate(iso: string): string {
-  return new Date(iso).toISOString();
+const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
+  ["year", 31_536_000],
+  ["month", 2_592_000],
+  ["day", 86_400],
+  ["hour", 3_600],
+  ["minute", 60],
+];
+
+/** "2h ago", "3d ago"; anything under a minute is "just now". */
+export function relativeTime(iso: string, now = Date.now()): string {
+  const seconds = Math.round((now - Date.parse(iso)) / 1000);
+  for (const [unit, size] of UNITS) {
+    if (seconds >= size) return format.format(-Math.floor(seconds / size), unit);
+  }
+  return "just now";
 }

-export const EPOCH = 0;
+const format = new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "narrow" });
`;

const READ_BODY = [
  "     1\t// web/src/app/layout/session-list.tsx",
  "     2\timport type { SessionSummary } from \"@core/session/store\";",
  "     3\timport { formatDate } from \"@/lib/time\";",
  "     4\t",
  "     5\texport function SessionRow({ session }: { session: SessionSummary }) {",
  "     6\t  return (",
  "     7\t    <li>",
  "     8\t      <span>{session.title}</span>",
  "     9\t      <time>{formatDate(String(session.updatedAt))}</time>",
].join("\n");

const FINAL_MARKDOWN = `Done. Session ages are now relative, and the formatter has its own test.

## What changed

- **\`web/src/lib/time.ts\`** — \`formatDate\` became \`relativeTime(iso, now)\`, built on \`Intl.RelativeTimeFormat\` so it is localised for free.
- **\`session-list.tsx\`** — rows render \`<time dateTime={iso}>2h ago</time>\`; the full timestamp moved to the \`title\`.
- **\`time.test.ts\`** — six cases, including the *just now* edge and future dates.

\`\`\`ts
import { relativeTime } from "@/lib/time";

const now = Date.parse("2026-10-14T12:00:00Z");
relativeTime("2026-10-14T10:00:00Z", now); // "2 hr. ago"
relativeTime("2026-10-14T11:59:30Z", now); // "just now"
\`\`\`

| Check | Result |
| --- | --- |
| \`bun test web/src/lib\` | 6 pass, 0 fail |
| \`tsc --noEmit\` | clean |

> The list still sorts by \`updatedAt\`, so nothing moves around — only the labels changed.

See the [Intl.RelativeTimeFormat docs](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Intl/RelativeTimeFormat) for the \`numeric\` option.`;

const TEST_FILE = [
  'import { describe, expect, test } from "bun:test";',
  'import { relativeTime } from "@/lib/time";',
  "",
  'const now = Date.parse("2026-10-14T12:00:00Z");',
  "",
  'describe("relativeTime", () => {',
  '  test("just now", () => expect(relativeTime("2026-10-14T11:59:30Z", now)).toBe("just now"));',
  '  test("minutes", () => expect(relativeTime("2026-10-14T11:55:00Z", now)).toBe("5 min. ago"));',
  '  test("hours", () => expect(relativeTime("2026-10-14T10:00:00Z", now)).toBe("2 hr. ago"));',
  '  test("days", () => expect(relativeTime("2026-10-11T12:00:00Z", now)).toBe("3 days ago"));',
  '  test("months", () => expect(relativeTime("2026-07-14T12:00:00Z", now)).toBe("3 mo. ago"));',
  '  test("future dates", () => expect(relativeTime("2026-10-15T12:00:00Z", now)).toBe("just now"));',
  "});",
];

const TEST_PATCH = `--- web/src/lib/time.test.ts\n+++ web/src/lib/time.test.ts\n@@ -0,0 +1,${TEST_FILE.length} @@\n${TEST_FILE.map((l) => `+${l}`).join("\n")}\n`;

/** In demo mode a follow-up waits in the composer's queue and runs when the first turn ends. */
export const DEMO_QUEUED = "Also show the full timestamp on hover";

const DEMO_HISTORY: MessageParam[] = [{ role: "user", content: FIRST_PROMPT }];

const PAST_SESSIONS: Array<SessionSummary & { history: MessageParam[] }> = [
  {
    id: SESSION_ID,
    title: "Relative dates in the session list",
    updatedAt: new Date(Date.now() - 60_000),
    messageCount: 14,
    history: DEMO_HISTORY,
  },
  {
    id: "1a2b3c4d-0000-4000-8000-000000000002",
    title: "Fix flaky blink test on the macOS runner",
    updatedAt: new Date(Date.now() - 3 * 3_600_000),
    messageCount: 38,
    history: [
      { role: "user", content: "The blink test flakes on the macOS runner. Find out why." },
      { role: "assistant", content: "It waits a fixed 120 ms for the blink phase. I replaced the sleep with a wait for the state change." },
    ],
  },
  {
    id: "1a2b3c4d-0000-4000-8000-000000000003",
    title: "Rename the command to tcode, keep tropos as an alias",
    updatedAt: new Date(Date.now() - 26 * 3_600_000),
    messageCount: 22,
    history: [
      { role: "user", content: "Rename the CLI to tcode and keep tropos working as an alias." },
      { role: "assistant", content: "Renamed the bin entry and added the alias in the installer; the README now says `tcode`." },
    ],
  },
  {
    id: "1a2b3c4d-0000-4000-8000-000000000004",
    title: "/review src/agent/agent.ts",
    updatedAt: new Date(Date.now() - 4 * 86_400_000),
    messageCount: 9,
    history: [{ role: "user", content: "/review src/agent/agent.ts" }],
  },
  {
    id: "1a2b3c4d-0000-4000-8000-000000000005",
    title: "Prompt caching for subagents",
    updatedAt: new Date(Date.now() - 12 * 86_400_000),
    messageCount: 51,
    history: [{ role: "user", content: "Can subagents share the parent's prompt cache?" }],
  },
];

const MODELS: Record<string, string[]> = {
  anthropic: ["claude-opus-5-5", "claude-sonnet-5", "claude-haiku-4-5"],
  openrouter: ["openrouter/deepseek/deepseek-v4", "openrouter/qwen/qwen3-coder"],
  openai: ["gpt-5.2", "gpt-5.2-mini"],
  ollama: ["ollama/qwen3:32b"],
};

const FILES = [
  "web/src/app/App.tsx",
  "web/src/app/layout/Sidebar.tsx",
  "web/src/app/layout/TopBar.tsx",
  "web/src/lib/client.ts",
  "web/src/lib/store.ts",
  "web/src/lib/time.ts",
  "src/agent/agent.ts",
  "src/ui/transcript.ts",
  "src/web/protocol.ts",
  "package.json",
  "README.md",
];

const OPEN = 1;
const CLOSED = 3;

type Sleep = (ms: number) => Promise<void>;

class Interrupted extends Error {}

/** The fake server. One per socket: a new "connection" gets a fresh hello, like the real server. */
class DemoServer {
  private state: SessionState = {
    model: "claude-opus-5-5",
    effort: "high",
    mode: "default",
    busy: false,
    contextTokens: 18_420,
    contextWindow: 200_000,
    totalCostUsd: 0.4182,
    turns: 6,
  };
  private history: MessageParam[] = DEMO_HISTORY;
  private sessionId = SESSION_ID;
  private askSeq = 0;
  private waiting = new Map<number, (answer: PermissionAnswer) => void>();
  private running: { interrupted: boolean } | null = null;
  private favorites = new Set(["claude-opus-5-5"]);
  private recent = ["claude-opus-5-5", "claude-sonnet-5"];
  private canRedo = false;
  private providers = createDemoProviders();

  constructor(
    private readonly send: (message: ServerMessage) => void,
    private readonly sleep: Sleep,
  ) {}

  start(): void {
    this.send({ t: "hello", server: this.hello() });
    this.pushState();
    void this.turn(this.firstTurn(), null);
  }

  stop(): void {
    if (this.running) this.running.interrupted = true;
    for (const resolve of this.waiting.values()) resolve({ kind: "deny" });
    this.waiting.clear();
  }

  receive(message: ClientMessage): void {
    if (message.t === "permission") {
      const resolve = this.waiting.get(message.id);
      if (!resolve) return;
      this.waiting.delete(message.id);
      resolve(message.answer);
      return;
    }
    void this.rpc(message.id, message.method, message.params);
  }

  private hello(): HelloInfo {
    return {
      version: "0.3.0-demo",
      cwd: CWD,
      sessionId: this.sessionId,
      modes: ["default", "acceptEdits", "plan"],
      commands: [
        { name: "review", description: "Review the current diff for bugs", argumentHint: "[path]" },
        { name: "ship", description: "Run checks, commit and open a PR" },
        { name: "frontend-design", description: "Skill: distinctive, intentional UI" },
      ],
      history: this.history,
      identity: { name: "Nova", emoji: "🦊" },
    };
  }

  private pushState(patch: Partial<SessionState> = {}): void {
    this.state = { ...this.state, ...patch };
    this.send({ t: "state", state: this.state });
  }

  private event(event: AgentEvent): void {
    this.send({ t: "event", event });
  }

  private ok(id: number, result: unknown): void {
    this.send({ t: "rpc_result", id, ok: true, result });
  }

  private fail(id: number, error: string): void {
    this.send({ t: "rpc_result", id, ok: false, error });
  }

  private async rpc(id: number, method: RpcMethod, params: unknown): Promise<void> {
    await this.sleep(40 + Math.random() * 120);
    const result = this.answer(method, params);
    if (result === BUSY) {
      this.fail(id, "busy");
      return;
    }
    if (method === "prompt") {
      const p = params as RpcMap["prompt"]["params"];
      // A custom command arrives as { command }: the demo "expands" it the way the server would.
      const text = p.command ? `Expanded /${p.command.name} ${p.command.args}` : String(p.text);
      void this.turn(this.replyTurn(text), id);
      return;
    }
    this.ok(id, result);
  }

  private answer(method: RpcMethod, params: unknown): unknown {
    switch (method) {
      case "prompt":
        return this.running ? BUSY : null;
      case "expand": {
        const { name, args } = params as RpcMap["expand"]["params"];
        return { ok: true, prompt: `<command name="${name}" args="${args}">Expanded /${name} ${args}</command>` };
      }
      case "interrupt":
        if (this.running) this.running.interrupted = true;
        for (const [askId, resolve] of this.waiting) {
          resolve({ kind: "deny" });
          this.send({ t: "ask_closed", id: askId });
        }
        this.waiting.clear();
        return null;
      case "setMode":
        this.pushState({ mode: params as Mode });
        return null;
      case "setModel":
        this.pushState({ model: String(params) });
        return null;
      case "setEffort":
        this.pushState({ effort: params as Effort });
        return null;
      case "panel":
        return DEMO_PANELS[params as ListTopic];
      case "sessions":
        return PAST_SESSIONS.map(({ history: _history, ...summary }) => summary);
      case "resume": {
        const found = PAST_SESSIONS.find((s) => s.id === params);
        if (!found) return null;
        this.sessionId = found.id;
        this.history = found.history;
        const hello = this.hello();
        this.send({ t: "hello", server: hello });
        this.pushState({ contextTokens: 9_800, turns: found.messageCount / 2 });
        return hello;
      }
      case "clear": {
        this.sessionId = crypto.randomUUID();
        this.history = [];
        const hello = this.hello();
        this.send({ t: "hello", server: hello });
        this.pushState({ contextTokens: 0, turns: 0, totalCostUsd: 0 });
        return hello;
      }
      case "learned.undo":
        return { summary: "skill: SkillManage patch bun-testing (+3 −1)" };
      case "undo":
        this.canRedo = true;
        return { ok: true, files: ["web/src/lib/time.ts", "web/src/app/layout/session-list.tsx"] };
      case "redo":
        if (!this.canRedo) return { ok: false, reason: "Nothing to redo" };
        this.canRedo = false;
        return { ok: true, files: ["web/src/lib/time.ts", "web/src/app/layout/session-list.tsx"] };
      case "providers.status":
        return this.providers.status();
      case "providers.connect":
        this.providers.connect((params as RpcMap["providers.connect"]["params"]).id);
        return null;
      case "modelPrefs.recordUse":
        return null;
      case "providers.disconnect":
        return this.providers.disconnect(String(params));
      case "providers.models":
        return MODELS[String(params)] ?? [];
      case "modelPrefs.get":
        return { recent: this.recent, favorites: [...this.favorites] };
      case "modelPrefs.toggleFavorite": {
        const model = String(params);
        if (this.favorites.has(model)) this.favorites.delete(model);
        else this.favorites.add(model);
        return this.favorites.has(model);
      }
      case "completeFile": {
        const token = (params as RpcMap["completeFile"]["params"]).token.replace(/^@/, "").toLowerCase();
        return FILES.filter((f) => f.toLowerCase().includes(token)).slice(0, 8);
      }
    }
  }

  // ───────── turns ─────────

  private async turn(script: (run: { interrupted: boolean }) => Promise<void>, rpcId: number | null): Promise<void> {
    const run = { interrupted: false };
    this.running = run;
    this.pushState({ busy: true });
    let reason: TurnEndReason = "end_turn";
    try {
      await script(run);
    } catch (error) {
      if (!(error instanceof Interrupted)) throw error;
      this.event({ type: "notice", level: "info", text: "Interrupted · what should Tropos do instead?" });
      reason = "aborted";
    }
    this.event({ type: "turn_end", reason });
    this.running = null;
    this.pushState({ busy: false, turns: this.state.turns + 1 });
    if (rpcId !== null) this.ok(rpcId, reason);
  }

  private async pause(run: { interrupted: boolean }, ms: number): Promise<void> {
    await this.sleep(ms);
    if (run.interrupted) throw new Interrupted();
  }

  private async stream(run: { interrupted: boolean }, type: "text" | "thinking", text: string): Promise<void> {
    const pieces = text.match(/[\s\S]{1,14}/g) ?? [];
    for (const delta of pieces) {
      this.event({ type, delta });
      await this.pause(run, type === "thinking" ? 14 : 22);
    }
  }

  private usage(contextTokens: number, costUsd: number): void {
    const total = (this.state.totalCostUsd ?? 0) + costUsd;
    this.event({ type: "usage", inputTokens: contextTokens - this.state.contextTokens, outputTokens: 640, contextTokens, costUsd, totalCostUsd: total });
    this.state = { ...this.state, contextTokens, totalCostUsd: total };
  }

  private async ask(run: { interrupted: boolean }, prompt: PermissionPrompt): Promise<PermissionAnswer> {
    const id = ++this.askSeq;
    const answer = new Promise<PermissionAnswer>((resolve) => this.waiting.set(id, resolve));
    this.send({ t: "ask", id, prompt });
    const result = await answer;
    if (run.interrupted) throw new Interrupted();
    return result;
  }

  private firstTurn() {
    return async (run: { interrupted: boolean }): Promise<void> => {
      await this.pause(run, 900);
      await this.stream(run, "thinking", "The sidebar renders updatedAt straight from the summary. I should find the formatter, swap it for Intl.RelativeTimeFormat, and cover the edges (just now, future dates) in a test.");
      await this.stream(run, "text", "I'll find where the session list formats its dates first.");

      this.event({ type: "tool_start", id: "t1", name: "Bash", summary: 'rg -n "updatedAt" web/src', input: { command: 'rg -n "updatedAt" web/src --type ts', description: "Find date formatting" } });
      await this.pause(run, 700);
      this.event({
        type: "tool_end",
        id: "t1",
        name: "Bash",
        status: "done",
        output: {
          content: [
            "web/src/app/layout/session-list.tsx:9:      <time>{formatDate(String(session.updatedAt))}</time>",
            "web/src/app/layout/Sidebar.tsx:41:  const sorted = [...sessions].sort((a, b) => +b.updatedAt - +a.updatedAt);",
            "web/src/lib/time.ts:2:export function formatDate(iso: string): string {",
            "web/src/lib/time.test.ts:4:  expect(formatDate(\"2026-01-01T00:00:00Z\")).toBe(\"2026-01-01T00:00:00.000Z\");",
            "web/src/app/pages/Settings.tsx:88:        updated {formatDate(info.updatedAt)}",
          ].join("\n"),
          summary: "ok",
        },
      });

      this.event({ type: "tool_start", id: "t1b", name: "Bash", summary: "bun test web/src/lib/time.test.ts", input: { command: "bun test web/src/lib/time.test.ts", description: "Run the existing date test" } });
      await this.pause(run, 600);
      this.event({
        type: "tool_end",
        id: "t1b",
        name: "Bash",
        status: "error",
        output: {
          content: [
            "bun test v1.4.3",
            "",
            "web/src/lib/time.test.ts:",
            "4 |   expect(formatDate(\"2026-01-01T00:00:00Z\")).toBe(\"2026-01-01T00:00:00.000Z\");",
            "                                                    ^",
            "error: expect(received).toBe(expected)",
            "Expected: \"2026-01-01T00:00:00.000Z\"",
            "Received: \"2026-01-01T00:00:00Z\"",
            "",
            " 0 pass",
            " 1 fail",
          ].join("\n"),
        },
      });

      this.event({ type: "tool_start", id: "t2", name: "Read", summary: `${CWD}/web/src/app/layout/session-list.tsx`, input: { file_path: `${CWD}/web/src/app/layout/session-list.tsx` } });
      await this.pause(run, 380);
      this.event({ type: "tool_end", id: "t2", name: "Read", status: "done", output: { content: READ_BODY, summary: "84 lines" } });
      this.usage(24_960, 0.0412);

      const todos = [
        { content: "Replace formatDate with a relative formatter", status: "in_progress" as const, activeForm: "Replacing formatDate" },
        { content: "Render <time dateTime> in the session rows", status: "pending" as const },
        { content: "Add tests for the formatter", status: "pending" as const },
      ];
      this.event({ type: "tool_start", id: "t3", name: "TodoWrite", summary: "3 todos", input: { todos } });
      await this.pause(run, 200);
      this.event({ type: "tool_end", id: "t3", name: "TodoWrite", status: "done", output: { content: "Todos updated", display: { kind: "todos", todos } } });

      await this.stream(run, "text", "`formatDate` is only used in two places, so I'll replace it outright.");
      const editInput = {
        file_path: `${CWD}/web/src/lib/time.ts`,
        old_string: "export function formatDate(iso: string): string {\n  return new Date(iso).toISOString();",
        new_string: "export function relativeTime(iso: string, now = Date.now()): string {",
      };
      this.event({ type: "tool_start", id: "t4", name: "Edit", summary: `${CWD}/web/src/lib/time.ts`, input: editInput });
      await this.pause(run, 300);
      const answer = await this.ask(run, {
        toolName: "Edit",
        kind: "edit",
        summary: "web/src/lib/time.ts",
        input: editInput,
        reason: "Edits need approval in the default mode.",
        suggestion: "Edit(web/src/**)",
      });
      if (answer.kind === "deny") {
        this.event({ type: "tool_end", id: "t4", name: "Edit", status: "denied", output: { content: answer.feedback ? `The user declined this action and said: ${answer.feedback}` : "The user declined this action." } });
        await this.stream(run, "text", "Understood — I left `time.ts` as it was. Tell me how you'd like the dates shown and I'll take it from there.");
        this.usage(26_410, 0.0198);
        return;
      }
      await this.pause(run, 240);
      this.event({
        type: "tool_end",
        id: "t4",
        name: "Edit",
        status: "done",
        output: { content: "Updated web/src/lib/time.ts", display: { kind: "diff", path: "web/src/lib/time.ts", patch: PATCH, added: 15, removed: 3 } },
      });
      this.event({
        type: "tool_end",
        id: "t3",
        name: "TodoWrite",
        status: "done",
        output: { content: "Todos updated", display: { kind: "todos", todos: todos.map((t, i) => ({ ...t, status: i === 0 ? ("completed" as const) : i === 1 ? ("in_progress" as const) : t.status })) } },
      });
      this.usage(31_880, 0.0735);

      this.event({ type: "tool_start", id: "t4b", name: "Write", summary: `${CWD}/web/src/lib/time.test.ts`, input: { file_path: `${CWD}/web/src/lib/time.test.ts`, content: TEST_FILE.join("\n") } });
      await this.pause(run, 260);
      this.event({
        type: "tool_end",
        id: "t4b",
        name: "Write",
        status: "done",
        output: { content: "Created web/src/lib/time.test.ts", summary: "created", display: { kind: "diff", path: "web/src/lib/time.test.ts", patch: TEST_PATCH, added: TEST_FILE.length, removed: 0 } },
      });

      this.event({ type: "tool_start", id: "t5", name: "Agent", summary: "test-runner: Run the web unit tests", input: { description: "Run the web unit tests", subagent_type: "test-runner", prompt: "Run bun test web/src and report failures." } });
      for (const step of ["Bash(bun test web/src/lib)", "Read(web/src/lib/time.test.ts)", "Bash(bun test web/src/lib/time.test.ts)"]) {
        await this.pause(run, 650);
        this.event({ type: "tool_progress", id: "t5", text: step });
      }
      await this.pause(run, 500);
      this.event({ type: "tool_end", id: "t5", name: "Agent", status: "done", output: { content: "All 6 tests pass.", summary: "3" } });

      const check = "bunx tsc --noEmit -p web/tsconfig.json && bun test web/src/lib";
      this.event({ type: "tool_start", id: "t6", name: "Bash", summary: check, input: { command: check, description: "Typecheck and test" } });
      await this.pause(run, 300);
      const allowed = await this.ask(run, { toolName: "Bash", kind: "exec", summary: check, input: { command: check, description: "Typecheck and test" }, suggestion: "Bash(bunx tsc:*)" });
      if (allowed.kind === "deny") {
        this.event({ type: "tool_end", id: "t6", name: "Bash", status: "denied", output: { content: allowed.feedback ? `The user declined this action and said: ${allowed.feedback}` : "The user declined this action." } });
        await this.stream(run, "text", "Skipped the checks. The edit and the new test are in place; run `bun test web/src/lib` when you're ready.");
        return;
      }
      await this.pause(run, 900);
      this.event({
        type: "tool_end",
        id: "t6",
        name: "Bash",
        status: "done",
        output: {
          content: ["bun test v1.4.3", "", "web/src/lib/time.test.ts:", "✓ relativeTime > just now", "✓ relativeTime > minutes", "✓ relativeTime > hours", "✓ relativeTime > days", "✓ relativeTime > months", "✓ relativeTime > future dates", "", " 6 pass", " 0 fail", "Ran 6 tests across 1 file. [41.00ms]"].join("\n"),
          summary: "ok",
        },
      });
      this.event({ type: "notice", level: "info", text: "2 files changed · /undo restores them" });
      await this.stream(run, "text", FINAL_MARKDOWN);
      this.usage(36_204, 0.0911);
    };
  }

  private replyTurn(text: string) {
    return async (run: { interrupted: boolean }): Promise<void> => {
      await this.pause(run, 500);
      await this.stream(run, "thinking", "Demo mode: no model is attached, so I'll answer with a canned reply.");
      const quoted = text.split("\n").map((line) => `> ${line}`).join("\n");
      await this.stream(
        run,
        "text",
        `This is **demo mode** — nothing reached a model. You wrote:\n\n${quoted}\n\nRun \`tcode web\` in a project to talk to the real agent:\n\n\`\`\`sh\ncd ~/code/my-project\ntcode web --port 4317\n\`\`\``,
      );
      this.usage(this.state.contextTokens + 1_200, 0.0063);
    };
  }
}

const BUSY = Symbol("busy");

/** A WebSocket stand-in that connects to an in-page DemoServer. Pass it to TcodeClient as `socket`. */
export class DemoSocket implements SocketLike {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly server: DemoServer;

  constructor(_url: string) {
    this.server = new DemoServer(
      (message) => {
        if (this.readyState !== OPEN) return;
        this.onmessage?.({ data: JSON.stringify(message) });
      },
      (ms) => new Promise<void>((resolve) => this.later(resolve, ms)),
    );
    this.later(() => {
      this.readyState = OPEN;
      this.onopen?.({});
      this.server.start();
    }, 180);
  }

  send(data: string): void {
    if (this.readyState !== OPEN) throw new Error("demo socket is not open");
    this.server.receive(JSON.parse(data) as ClientMessage);
  }

  close(): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.server.stop();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.onclose?.({});
  }

  private later(fn: () => void, ms: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
  }
}

export function createDemoSocket(url: string): SocketLike {
  return new DemoSocket(url);
}

/** True when the page was opened with `?demo=1`. */
export function isDemoMode(search: string = typeof window === "undefined" ? "" : window.location.search): boolean {
  const value = new URLSearchParams(search).get("demo");
  return value !== null && value !== "0" && value !== "false";
}
