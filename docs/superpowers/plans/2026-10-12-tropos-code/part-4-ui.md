# Part 4 — Terminal UI (Tasks 15–17)

Plan index: [../2026-10-12-tropos-code.md](../2026-10-12-tropos-code.md). Read its Global Constraints first.

UI rules for every component: colors come only from the `Theme` (never hard-coded hex in components); finished transcript items render inside Ink `<Static>`; only the live turn re-renders. For `ink-testing-library` tests, key codes are: Enter `"\r"`, Esc `"\x1b"`, Up `"\x1b[A"`, Down `"\x1b[B"`, Shift+Tab `"\x1b[Z"`, Backspace `"\x7f"`, Tab `"\t"`. Wait ~30 ms between writes (`const tick = () => Bun.sleep(30)`), and assert on `frames.join("\n")` when the text may sit in `<Static>` output.

---

### Task 15: UI foundations — theme, markdown, transcript, input state, commands

**Files:**
- Create: `src/ui/theme.ts`, `src/ui/theme-context.tsx`, `src/ui/markdown.ts`, `src/types/marked-terminal.d.ts`
- Create: `src/ui/transcript.ts`, `src/ui/input-state.ts`, `src/ui/complete.ts`, `src/ui/commands.ts`
- Test: `src/ui/theme.test.ts`, `src/ui/markdown.test.ts`, `src/ui/transcript.test.ts`, `src/ui/input-state.test.ts`, `src/ui/complete.test.ts`, `src/ui/commands.test.ts`

**Interfaces:**
- Consumes: `AgentEvent`, `ToolStatus` (Task 13); `ToolOutput` (Task 5); `MessageParam` (Task 11); `ThemeSetting` (Task 2); `EFFORTS`, `Effort` (Task 1).
- Produces:
  - `Theme { name; accent; muted; text; success; danger; warning; diffAdd; diffRemove }`, `DARK`, `LIGHT`, `resolveTheme(setting: ThemeSetting, env?: NodeJS.ProcessEnv): Theme`
  - `ThemeProvider({ theme, children })`, `useTheme(): Theme`
  - `renderMarkdown(markdown: string, width?: number): string`
  - `TranscriptItem` (kinds `user`, `assistant`, `thinking`, `tool`, `notice`; every item has `id: string`), `Transcript { done; live; seq }`, `emptyTranscript`, `reduce(t, event)`, `addUser(t, text)`, `addNotice(t, level, text)`, `flush(t)`, `historyToTranscript(messages)`
  - `InputState`, `emptyInput`, `InputAction`, `inputReducer(state, action)`, `tokenAtCursor(state): { start: number; end: number; text: string }`
  - `completeFile(token: string, cwd: string): Promise<string[]>`, `completeCommand(token: string): string[]`, `commonPrefix(items: string[]): string`
  - `COMMANDS`, `INIT_PROMPT`, `CommandResult`, `parseCommand(input: string): CommandResult`, `helpText(): string`

- [ ] **Step 1: Write the failing tests**

```ts
// src/ui/theme.test.ts
import { expect, test } from "bun:test";
import { DARK, LIGHT, resolveTheme } from "./theme";

test("explicit settings win", () => {
  expect(resolveTheme("dark", { COLORFGBG: "0;15" })).toBe(DARK);
  expect(resolveTheme("light", {})).toBe(LIGHT);
});
test("auto reads COLORFGBG", () => {
  expect(resolveTheme("auto", { COLORFGBG: "0;15" })).toBe(LIGHT);
  expect(resolveTheme("auto", { COLORFGBG: "15;0" })).toBe(DARK);
});
test("auto defaults to dark", () => {
  expect(resolveTheme("auto", {})).toBe(DARK);
});
test("brand accents", () => {
  expect(LIGHT.accent).toBe("#4568FF");
  expect(DARK.accent).toBe("#93B0FF");
  expect(LIGHT.muted).toBe("#78716C");
  expect(DARK.muted).toBe("#A8A29E");
});
```

```ts
// src/ui/markdown.test.ts
import { expect, test } from "bun:test";
import { renderMarkdown } from "./markdown";

test("renders markdown for the terminal", () => {
  const out = renderMarkdown("# Title\n\nSome **bold** text and `code`.\n\n- one\n- two", 60);
  const plain = Bun.stripANSI(out);
  expect(plain).toContain("Title");
  expect(plain).toContain("bold");
  expect(plain).not.toContain("**");
  expect(plain).toContain("one");
});
```

```ts
// src/ui/transcript.test.ts
import { describe, expect, test } from "bun:test";
import { addNotice, addUser, emptyTranscript, flush, historyToTranscript, reduce, type Transcript } from "./transcript";

const apply = (t: Transcript, ...events: Parameters<typeof reduce>[1][]) => events.reduce(reduce, t);

describe("transcript reducer", () => {
  test("text deltas merge into one live assistant item", () => {
    const t = apply(emptyTranscript, { type: "text", delta: "Hel" }, { type: "text", delta: "lo" });
    expect(t.live).toHaveLength(1);
    expect(t.live[0]).toMatchObject({ kind: "assistant", text: "Hello" });
  });

  test("a tool start settles the text before it", () => {
    const t = apply(emptyTranscript, { type: "text", delta: "Looking" }, { type: "tool_start", id: "a", name: "Read", summary: "x.ts", input: {} });
    expect(t.done.map((i) => i.kind)).toEqual(["assistant"]);
    expect(t.live.map((i) => i.kind)).toEqual(["tool"]);
  });

  test("tool end updates the running item and settles it", () => {
    const t = apply(
      emptyTranscript,
      { type: "tool_start", id: "a", name: "Read", summary: "x.ts", input: {} },
      { type: "tool_end", id: "a", name: "Read", output: { content: "ok", summary: "3 lines" }, status: "done" },
    );
    expect(t.done[0]).toMatchObject({ kind: "tool", status: "done" });
    expect(t.live).toHaveLength(0);
  });

  test("running tools are never moved to done", () => {
    const t = apply(
      emptyTranscript,
      { type: "tool_start", id: "a", name: "Bash", summary: "sleep", input: {} },
      { type: "tool_start", id: "b", name: "Read", summary: "y", input: {} },
      { type: "tool_end", id: "b", name: "Read", output: { content: "ok" }, status: "done" },
    );
    expect(t.live.map((i) => (i.kind === "tool" ? i.toolUseId : "")) ).toEqual(["a", "b"]);
  });

  test("turn end flushes everything", () => {
    const t = apply(emptyTranscript, { type: "text", delta: "x" }, { type: "turn_end", reason: "end_turn" });
    expect(t.live).toHaveLength(0);
    expect(t.done).toHaveLength(1);
  });

  test("users and notices; ids are unique", () => {
    let t = addUser(emptyTranscript, "hi");
    t = reduce(t, { type: "text", delta: "a" });
    t = addUser(t, "again");
    t = flush(addNotice(t, "info", "note"));
    const ids = t.done.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(t.done.map((i) => i.kind)).toEqual(["user", "assistant", "user", "notice"]);
  });

  test("history replay skips context and mode blocks", () => {
    const t = historyToTranscript([
      { role: "user", content: [{ type: "text", text: "<context>x</context>" }, { type: "text", text: "fix it" }] },
      { role: "assistant", content: [{ type: "text", text: "On it" }, { type: "tool_use", id: "t", name: "Read", input: { file_path: "a.ts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "..." }] },
    ]);
    expect(t.done.map((i) => i.kind)).toEqual(["user", "assistant", "tool"]);
    expect(t.done[2]).toMatchObject({ name: "Read", summary: "a.ts" });
  });
});
```

```ts
// src/ui/input-state.test.ts
import { describe, expect, test } from "bun:test";
import { emptyInput, inputReducer, tokenAtCursor, type InputAction, type InputState } from "./input-state";

const run = (...actions: InputAction[]) => actions.reduce(inputReducer, emptyInput);

describe("inputReducer", () => {
  test("insert and backspace at the cursor", () => {
    let s = run({ type: "insert", text: "helo" }, { type: "left" }, { type: "insert", text: "l" });
    expect(s).toMatchObject({ value: "hello", cursor: 4 });
    s = inputReducer(s, { type: "backspace" });
    expect(s).toMatchObject({ value: "helo", cursor: 3 });
  });

  test("home and end work per line", () => {
    const s = run({ type: "insert", text: "ab\ncd" }, { type: "home" });
    expect(s.cursor).toBe(3);
    expect(inputReducer(s, { type: "end" }).cursor).toBe(5);
  });

  test("history navigation keeps the draft", () => {
    const history = ["first", "second"];
    let s: InputState = run({ type: "insert", text: "draft" });
    s = inputReducer(s, { type: "historyPrev", history });
    expect(s.value).toBe("second");
    s = inputReducer(s, { type: "historyPrev", history });
    expect(s.value).toBe("first");
    s = inputReducer(s, { type: "historyNext", history });
    s = inputReducer(s, { type: "historyNext", history });
    expect(s.value).toBe("draft");
  });

  test("delete word back and clear", () => {
    expect(run({ type: "insert", text: "run the tests" }, { type: "deleteWordBack" }).value).toBe("run the ");
    expect(run({ type: "insert", text: "x" }, { type: "clear" })).toEqual(emptyInput);
  });

  test("tokenAtCursor", () => {
    const s = run({ type: "insert", text: "look at @src/ma" });
    expect(tokenAtCursor(s)).toEqual({ start: 8, end: 15, text: "@src/ma" });
  });
});
```

```ts
// src/ui/complete.test.ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { commonPrefix, completeCommand, completeFile } from "./complete";

let dir: string;
beforeAll(async () => {
  dir = await makeTmpDir();
  await mkdir(join(dir, "src", "components"), { recursive: true });
  await mkdir(join(dir, "src", "config"));
  await writeFile(join(dir, "src", "main.ts"), "");
  await mkdir(join(dir, "node_modules"));
});
afterAll(() => removeDir(dir));

test("file completion lists matches with / on directories", async () => {
  expect(await completeFile("@src/c", dir)).toEqual(["@src/components/", "@src/config/"]);
  expect(await completeFile("@src/m", dir)).toEqual(["@src/main.ts"]);
  expect(await completeFile("@n", dir)).toEqual([]);
});

test("command completion", () => {
  expect(completeCommand("/he")).toEqual(["/help"]);
  expect(completeCommand("/e")).toEqual(["/effort", "/exit"]);
});

test("common prefix", () => {
  expect(commonPrefix(["@src/components/", "@src/config/"])).toBe("@src/co");
  expect(commonPrefix([])).toBe("");
});
```

```ts
// src/ui/commands.test.ts
import { expect, test } from "bun:test";
import { INIT_PROMPT, helpText, parseCommand } from "./commands";

test("plain text and paths are not commands", () => {
  expect(parseCommand("hello")).toEqual({ kind: "none" });
  expect(parseCommand("/usr/bin/env is missing")).toEqual({ kind: "none" });
});

test("simple commands", () => {
  expect(parseCommand("/clear")).toEqual({ kind: "clear" });
  expect(parseCommand("/exit")).toEqual({ kind: "exit" });
  expect(parseCommand("/quit")).toEqual({ kind: "exit" });
  expect(parseCommand("/resume")).toEqual({ kind: "resume" });
  expect(parseCommand("/cost")).toEqual({ kind: "cost" });
});

test("model and effort", () => {
  expect(parseCommand("/model")).toEqual({ kind: "model" });
  expect(parseCommand("/model claude-sonnet-5-5")).toEqual({ kind: "model", model: "claude-sonnet-5-5" });
  expect(parseCommand("/effort max")).toEqual({ kind: "effort", effort: "max" });
  expect(parseCommand("/effort huge")).toMatchObject({ kind: "effort", error: expect.stringContaining("low, medium") });
});

test("init sends a prompt; unknown commands are reported", () => {
  expect(parseCommand("/init")).toEqual({ kind: "prompt", text: INIT_PROMPT });
  expect(parseCommand("/frobnicate")).toEqual({ kind: "unknown", name: "frobnicate" });
});

test("help lists every command and the shortcuts", () => {
  const text = helpText();
  for (const name of ["/help", "/clear", "/resume", "/model", "/effort", "/cost", "/init", "/exit", "shift+tab"]) {
    expect(text).toContain(name);
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test src/ui`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

```ts
// src/ui/theme.ts
import type { ThemeSetting } from "../config/settings";

export interface Theme {
  name: "dark" | "light";
  accent: string;
  muted: string;
  text: string;
  success: string;
  danger: string;
  warning: string;
  diffAdd: string;
  diffRemove: string;
}

/** Tropos brand: periwinkle accent, warm stone neutrals. */
export const DARK: Theme = {
  name: "dark",
  accent: "#93B0FF",
  muted: "#A8A29E",
  text: "#F5F5F4",
  success: "#4ADE80",
  danger: "#F87171",
  warning: "#FBBF24",
  diffAdd: "#4ADE80",
  diffRemove: "#F87171",
};

export const LIGHT: Theme = {
  name: "light",
  accent: "#4568FF",
  muted: "#78716C",
  text: "#1C1917",
  success: "#15803D",
  danger: "#B91C1C",
  warning: "#B45309",
  diffAdd: "#15803D",
  diffRemove: "#B91C1C",
};

/** COLORFGBG is "fg;bg" (sometimes "fg;x;bg"); background 7 or 15 means a light terminal. */
function lightBackground(env: NodeJS.ProcessEnv): boolean | undefined {
  const value = env.COLORFGBG;
  if (!value) return undefined;
  const bg = Number(value.split(";").at(-1));
  if (Number.isNaN(bg)) return undefined;
  return bg === 7 || bg === 15;
}

export function resolveTheme(setting: ThemeSetting, env: NodeJS.ProcessEnv = process.env): Theme {
  if (setting === "dark") return DARK;
  if (setting === "light") return LIGHT;
  return lightBackground(env) ? LIGHT : DARK;
}
```

```tsx
// src/ui/theme-context.tsx
import { createContext, useContext, type ReactNode } from "react";
import { DARK, type Theme } from "./theme";

const ThemeContext = createContext<Theme>(DARK);

export function ThemeProvider({ theme, children }: { theme: Theme; children: ReactNode }) {
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
```

```ts
// src/types/marked-terminal.d.ts
declare module "marked-terminal" {
  import type { MarkedExtension } from "marked";
  export function markedTerminal(options?: Record<string, unknown>, highlightOptions?: Record<string, unknown>): MarkedExtension;
}
```

```ts
// src/ui/markdown.ts
import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";

const renderers = new Map<number, Marked>();

export function renderMarkdown(markdown: string, width = 80): string {
  let renderer = renderers.get(width);
  if (!renderer) {
    renderer = new Marked(markedTerminal({ width, reflowText: true, tab: 2 }));
    renderers.set(width, renderer);
  }
  return (renderer.parse(markdown) as string).trimEnd();
}
```

```ts
// src/ui/transcript.ts
import type { AgentEvent, ToolStatus } from "../agent/events";
import type { MessageParam } from "../session/store";
import type { ToolOutput } from "../tools/types";

export type TranscriptItem =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant"; text: string }
  | { id: string; kind: "thinking"; text: string }
  | { id: string; kind: "tool"; toolUseId: string; name: string; summary: string; status: "running" | ToolStatus; output?: ToolOutput }
  | { id: string; kind: "notice"; level: "info" | "warn" | "error"; text: string };

type NewItem = TranscriptItem extends infer T ? (T extends TranscriptItem ? Omit<T, "id"> : never) : never;

export interface Transcript {
  done: TranscriptItem[];
  live: TranscriptItem[];
  seq: number;
}

export const emptyTranscript: Transcript = { done: [], live: [], seq: 0 };

function make(t: Transcript, item: NewItem): { t: Transcript; item: TranscriptItem } {
  return { t: { ...t, seq: t.seq + 1 }, item: { ...item, id: `i${t.seq}` } as TranscriptItem };
}

export function flush(t: Transcript): Transcript {
  return t.live.length === 0 ? t : { ...t, done: [...t.done, ...t.live], live: [] };
}

/** Moves finished items at the front of `live` into `done`. A trailing text item may still be streaming. */
function settle(t: Transcript): Transcript {
  let n = 0;
  while (n < t.live.length) {
    const item = t.live[n]!;
    if (item.kind === "tool" && item.status === "running") break;
    const isLast = n === t.live.length - 1;
    if (isLast && (item.kind === "assistant" || item.kind === "thinking")) break;
    n++;
  }
  return n === 0 ? t : { ...t, done: [...t.done, ...t.live.slice(0, n)], live: t.live.slice(n) };
}

function pushLive(t: Transcript, item: NewItem): Transcript {
  const made = make(t, item);
  return { ...made.t, live: [...made.t.live, made.item] };
}

function pushDone(t: Transcript, item: NewItem): Transcript {
  const made = make(t, item);
  return { ...made.t, done: [...made.t.done, made.item] };
}

export function addUser(t: Transcript, text: string): Transcript {
  return pushDone(flush(t), { kind: "user", text });
}

export function addNotice(t: Transcript, level: "info" | "warn" | "error", text: string): Transcript {
  return pushLive(t, { kind: "notice", level, text });
}

export function reduce(t: Transcript, event: AgentEvent): Transcript {
  switch (event.type) {
    case "text":
    case "thinking": {
      const kind = event.type === "text" ? "assistant" : "thinking";
      const last = t.live.at(-1);
      if (last && (last.kind === "assistant" || last.kind === "thinking") && last.kind === kind) {
        return { ...t, live: [...t.live.slice(0, -1), { ...last, text: last.text + event.delta }] };
      }
      return settle(pushLive(t, { kind, text: event.delta }));
    }
    case "tool_start":
      return settle(pushLive(t, { kind: "tool", toolUseId: event.id, name: event.name, summary: event.summary, status: "running" }));
    case "tool_end":
      return settle({
        ...t,
        live: t.live.map((i) => (i.kind === "tool" && i.toolUseId === event.id ? { ...i, status: event.status, output: event.output } : i)),
      });
    case "notice":
      return addNotice(t, event.level, event.text);
    case "turn_end":
      return flush(t);
    default:
      return t;
  }
}

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  for (const key of ["file_path", "command", "pattern"]) {
    if (typeof record[key] === "string") return record[key] as string;
  }
  return "";
}

/** Rebuilds a read-only transcript from a saved session. */
export function historyToTranscript(messages: MessageParam[]): Transcript {
  let t = emptyTranscript;
  for (const m of messages) {
    if (typeof m.content === "string") {
      t = m.role === "user" ? addUser(t, m.content) : pushDone(t, { kind: "assistant", text: m.content });
      continue;
    }
    for (const block of m.content) {
      if (m.role === "user" && block.type === "text" && !block.text.startsWith("<context>") && !block.text.startsWith("<mode>")) {
        t = addUser(t, block.text);
      } else if (m.role === "assistant" && block.type === "text") {
        t = pushDone(t, { kind: "assistant", text: block.text });
      } else if (m.role === "assistant" && block.type === "tool_use") {
        t = pushDone(t, { kind: "tool", toolUseId: block.id, name: block.name, summary: summarizeInput(block.input), status: "done" });
      }
    }
  }
  return t;
}
```

```ts
// src/ui/input-state.ts
export interface InputState {
  value: string;
  cursor: number;
  historyIndex: number | null;
  draft: string;
}

export const emptyInput: InputState = { value: "", cursor: 0, historyIndex: null, draft: "" };

export type InputAction =
  | { type: "insert"; text: string }
  | { type: "backspace" }
  | { type: "left" }
  | { type: "right" }
  | { type: "home" }
  | { type: "end" }
  | { type: "clear" }
  | { type: "deleteWordBack" }
  | { type: "historyPrev"; history: string[] }
  | { type: "historyNext"; history: string[] }
  | { type: "replaceRange"; start: number; end: number; text: string };

export function inputReducer(s: InputState, a: InputAction): InputState {
  switch (a.type) {
    case "insert":
      return { ...s, value: s.value.slice(0, s.cursor) + a.text + s.value.slice(s.cursor), cursor: s.cursor + a.text.length, historyIndex: null };
    case "backspace":
      if (s.cursor === 0) return s;
      return { ...s, value: s.value.slice(0, s.cursor - 1) + s.value.slice(s.cursor), cursor: s.cursor - 1 };
    case "left":
      return { ...s, cursor: Math.max(0, s.cursor - 1) };
    case "right":
      return { ...s, cursor: Math.min(s.value.length, s.cursor + 1) };
    case "home":
      return { ...s, cursor: s.value.lastIndexOf("\n", s.cursor - 1) + 1 };
    case "end": {
      const newline = s.value.indexOf("\n", s.cursor);
      return { ...s, cursor: newline === -1 ? s.value.length : newline };
    }
    case "clear":
      return emptyInput;
    case "deleteWordBack": {
      const before = s.value.slice(0, s.cursor).replace(/\S+\s*$/, "");
      return { ...s, value: before + s.value.slice(s.cursor), cursor: before.length };
    }
    case "historyPrev": {
      if (a.history.length === 0) return s;
      const index = s.historyIndex === null ? a.history.length - 1 : Math.max(0, s.historyIndex - 1);
      const value = a.history[index]!;
      return { value, cursor: value.length, historyIndex: index, draft: s.historyIndex === null ? s.value : s.draft };
    }
    case "historyNext": {
      if (s.historyIndex === null) return s;
      const index = s.historyIndex + 1;
      if (index >= a.history.length) return { value: s.draft, cursor: s.draft.length, historyIndex: null, draft: "" };
      const value = a.history[index]!;
      return { ...s, value, cursor: value.length, historyIndex: index };
    }
    case "replaceRange": {
      const value = s.value.slice(0, a.start) + a.text + s.value.slice(a.end);
      return { ...s, value, cursor: a.start + a.text.length };
    }
  }
}

/** The whitespace-delimited word that ends at the cursor. */
export function tokenAtCursor(s: InputState): { start: number; end: number; text: string } {
  let start = s.cursor;
  while (start > 0 && !/\s/.test(s.value[start - 1]!)) start--;
  return { start, end: s.cursor, text: s.value.slice(start, s.cursor) };
}
```

```ts
// src/ui/complete.ts
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { COMMANDS } from "./commands";

const MAX_SUGGESTIONS = 50;

/** "@src/co" → ["@src/components/", "@src/config/"]. Hidden entries only when the prefix starts with ".". */
export async function completeFile(token: string, cwd: string): Promise<string[]> {
  const partial = token.slice(1);
  const slash = partial.lastIndexOf("/");
  const dir = slash === -1 ? "" : partial.slice(0, slash + 1);
  const base = partial.slice(dir.length);
  const entries = await readdir(join(cwd, dir), { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.name.startsWith(base) && e.name !== "node_modules" && (base.startsWith(".") || !e.name.startsWith(".")))
    .map((e) => `@${dir}${e.name}${e.isDirectory() ? "/" : ""}`)
    .sort()
    .slice(0, MAX_SUGGESTIONS);
}

export function completeCommand(token: string): string[] {
  return COMMANDS.map((c) => `/${c.name}`)
    .filter((name) => name.startsWith(token))
    .sort();
}

export function commonPrefix(items: string[]): string {
  if (items.length === 0) return "";
  let prefix = items[0]!;
  for (const item of items.slice(1)) {
    while (!item.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  return prefix;
}
```

```ts
// src/ui/commands.ts
import { EFFORTS, type Effort } from "../config/constants";

export const COMMANDS = [
  { name: "help", description: "Show commands and shortcuts" },
  { name: "clear", description: "Start a new session" },
  { name: "resume", description: "Resume an earlier session in this directory" },
  { name: "model", description: "Show or set the model, e.g. /model claude-sonnet-5-5" },
  { name: "effort", description: "Show or set effort: low, medium, high, xhigh, max" },
  { name: "cost", description: "Show this session's cost and context size" },
  { name: "init", description: "Create or improve TROPOS.md for this project" },
  { name: "exit", description: "Quit Tropos Code" },
] as const;

export const INIT_PROMPT =
  "Look through this repository and write a TROPOS.md file at its root for future Tropos Code sessions. " +
  "Cover how to build, test, lint and run it (exact commands, including how to run a single test), " +
  "the architecture at the level that takes reading several files to learn, and conventions that aren't obvious from the code. " +
  "Keep it under 150 lines, skip generic advice, and include nothing you can't verify in the repo. " +
  "If TROPOS.md already exists, improve it instead of replacing it.";

export type CommandResult =
  | { kind: "none" }
  | { kind: "help"; text: string }
  | { kind: "clear" }
  | { kind: "exit" }
  | { kind: "resume" }
  | { kind: "model"; model?: string }
  | { kind: "effort"; effort?: Effort; error?: string }
  | { kind: "cost" }
  | { kind: "prompt"; text: string }
  | { kind: "unknown"; name: string };

const SHORTCUTS = [
  ["shift+tab", "cycle permission mode"],
  ["esc", "interrupt Tropos"],
  ["\\ then enter", "new line"],
  ["@", "complete a file path (tab)"],
  ["↑ / ↓", "input history"],
  ["ctrl+c", "interrupt, or quit when idle"],
] as const;

export function helpText(): string {
  const commands = COMMANDS.map((c) => `  /${c.name.padEnd(8)} ${c.description}`);
  const shortcuts = SHORTCUTS.map(([key, what]) => `  ${key.padEnd(12)} ${what}`);
  return ["Commands", ...commands, "", "Shortcuts", ...shortcuts].join("\n");
}

export function parseCommand(input: string): CommandResult {
  const text = input.trim();
  if (!text.startsWith("/")) return { kind: "none" };
  const [head = "", ...rest] = text.slice(1).split(/\s+/);
  if (head.includes("/") || head === "") return { kind: "none" }; // a path such as /usr/bin/env
  const arg = rest.join(" ").trim();
  switch (head.toLowerCase()) {
    case "help":
      return { kind: "help", text: helpText() };
    case "clear":
      return { kind: "clear" };
    case "exit":
    case "quit":
      return { kind: "exit" };
    case "resume":
      return { kind: "resume" };
    case "cost":
      return { kind: "cost" };
    case "init":
      return { kind: "prompt", text: INIT_PROMPT };
    case "model":
      return arg ? { kind: "model", model: arg } : { kind: "model" };
    case "effort":
      if (!arg) return { kind: "effort" };
      return (EFFORTS as readonly string[]).includes(arg)
        ? { kind: "effort", effort: arg as Effort }
        : { kind: "effort", error: `Effort must be one of: ${EFFORTS.join(", ")}.` };
    default:
      return { kind: "unknown", name: head };
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test src/ui && bun run typecheck`
Expected: PASS; typecheck exits 0. If `Bun.stripANSI` is unavailable in this Bun build, replace it in the markdown test with `out.replace(/\x1b\[[0-9;]*m/g, "")`.

- [ ] **Step 5: Commit**

```bash
git add src/ui src/types
git commit -m "feat: UI foundations - theme, markdown, transcript reducer, input editing, slash commands

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: UI components

**Files:**
- Create: `src/ui/BrandHeader.tsx`, `src/ui/Spinner.tsx`, `src/ui/StatusBar.tsx`, `src/ui/DiffView.tsx`, `src/ui/TodoList.tsx`, `src/ui/ToolRow.tsx`, `src/ui/TranscriptRow.tsx`, `src/ui/PermissionDialog.tsx`, `src/ui/PromptInput.tsx`, `src/ui/SessionPicker.tsx`
- Test: `src/ui/components.test.tsx`

**Interfaces:**
- Consumes: Task 15 modules; `PermissionPrompt`, `PermissionAnswer` (Task 13); `makeDiff`, `Todo` (Task 5); `SessionSummary` (Task 11); `Mode` (Task 1).
- Produces (all are React function components):
  - `BrandHeader({ version, model, effort, cwd })`
  - `Spinner({ verb? })`, `SPINNER_VERBS`
  - `StatusBar({ mode, contextPct, costUsd })`, `MODE_LABELS: Record<Mode, string>`
  - `DiffView({ patch, maxLines? })`
  - `TodoList({ todos })`
  - `ToolRow({ item })` — `item` is the `tool` variant of `TranscriptItem`
  - `TranscriptRow({ item, live, width })`
  - `PermissionDialog({ prompt, onAnswer })`
  - `PromptInput({ onSubmit, history, cwd })`
  - `SessionPicker({ sessions, onPick, onCancel })`

- [ ] **Step 1: Write the failing component tests**

```tsx
// src/ui/components.test.tsx
import { describe, expect, mock, test } from "bun:test";
import { render } from "ink-testing-library";
import type { PermissionPrompt } from "../agent/events";
import { makeDiff } from "../tools/diff";
import { BrandHeader } from "./BrandHeader";
import { PermissionDialog } from "./PermissionDialog";
import { PromptInput } from "./PromptInput";
import { SessionPicker } from "./SessionPicker";
import { StatusBar } from "./StatusBar";
import { ToolRow } from "./ToolRow";

const tick = () => Bun.sleep(30);

describe("BrandHeader", () => {
  test("shows product, version, model and cwd", () => {
    const frame = render(<BrandHeader version="0.1.0" model="claude-opus-5-5" effort="high" cwd="/work/app" />).lastFrame()!;
    expect(frame).toContain("Tropos Code");
    expect(frame).toContain("v0.1.0");
    expect(frame).toContain("claude-opus-5-5 · effort high");
    expect(frame).toContain("/work/app");
  });
});

describe("StatusBar", () => {
  test("mode labels, context and cost", () => {
    const frame = render(<StatusBar mode="plan" contextPct={12} costUsd={0.0412} />).lastFrame()!;
    expect(frame).toContain("plan mode");
    expect(frame).toContain("ctx 12%");
    expect(frame).toContain("$0.04");
    expect(frame).toContain("shift+tab");
    expect(render(<StatusBar mode="bypass" contextPct={0} costUsd={0} />).lastFrame()).toContain("bypass permissions");
  });
});

describe("ToolRow", () => {
  test("done edit shows a diff", () => {
    const display = makeDiff("/w/a.ts", "const a = 1;\n", "const a = 2;\n");
    const frame = render(
      <ToolRow item={{ id: "i1", kind: "tool", toolUseId: "t", name: "Edit", summary: "a.ts", status: "done", output: { content: "ok", display, summary: "+1 −1" } }} />,
    ).lastFrame()!;
    expect(frame).toContain("Edit");
    expect(frame).toContain("+1 −1");
    expect(frame).toContain("+const a = 2;");
    expect(frame).toContain("-const a = 1;");
  });

  test("denied tool says so", () => {
    const frame = render(<ToolRow item={{ id: "i2", kind: "tool", toolUseId: "t", name: "Bash", summary: "rm -rf x", status: "denied", output: { content: "no", isError: true } }} />).lastFrame()!;
    expect(frame).toContain("declined");
  });
});

describe("PermissionDialog", () => {
  const prompt: PermissionPrompt = { toolName: "Bash", kind: "exec", summary: "bun test", input: { command: "bun test" }, suggestion: "Bash(bun test:*)" };

  test("shows the command and options", () => {
    const frame = render(<PermissionDialog prompt={prompt} onAnswer={() => {}} />).lastFrame()!;
    expect(frame).toContain("Run this command?");
    expect(frame).toContain("bun test");
    expect(frame).toContain("1. Yes");
    expect(frame).toContain("2. Yes, and don't ask again for Bash(bun test:*)");
    expect(frame).toContain("3. No, tell Tropos what to do instead");
  });

  test("number keys and arrows choose", async () => {
    const onAnswer = mock();
    const r = render(<PermissionDialog prompt={prompt} onAnswer={onAnswer} />);
    await tick();
    r.stdin.write("\x1b[B");
    await tick();
    r.stdin.write("\r");
    await tick();
    expect(onAnswer).toHaveBeenCalledWith({ kind: "allow_always", rule: "Bash(bun test:*)" });
  });

  test("option 3 collects feedback", async () => {
    const onAnswer = mock();
    const r = render(<PermissionDialog prompt={prompt} onAnswer={onAnswer} />);
    await tick();
    r.stdin.write("3");
    await tick();
    r.stdin.write("use npm");
    await tick();
    r.stdin.write("\r");
    await tick();
    expect(onAnswer).toHaveBeenCalledWith({ kind: "deny", feedback: "use npm" });
  });

  test("esc declines", async () => {
    const onAnswer = mock();
    const r = render(<PermissionDialog prompt={prompt} onAnswer={onAnswer} />);
    await tick();
    r.stdin.write("\x1b");
    await tick();
    expect(onAnswer).toHaveBeenCalledWith({ kind: "deny" });
  });

  test("edit prompts preview the change", () => {
    const frame = render(
      <PermissionDialog
        prompt={{ toolName: "Edit", kind: "edit", summary: "a.ts", input: { file_path: "a.ts", old_string: "one", new_string: "two" } }}
        onAnswer={() => {}}
      />,
    ).lastFrame()!;
    expect(frame).toContain("Make this edit?");
    expect(frame).toContain("-one");
    expect(frame).toContain("+two");
  });
});

describe("PromptInput", () => {
  test("typing and enter submits", async () => {
    const onSubmit = mock();
    const r = render(<PromptInput onSubmit={onSubmit} history={[]} cwd="/" />);
    await tick();
    r.stdin.write("hello");
    await tick();
    r.stdin.write("\r");
    await tick();
    expect(onSubmit).toHaveBeenCalledWith("hello");
  });

  test("backslash then enter inserts a newline", async () => {
    const onSubmit = mock();
    const r = render(<PromptInput onSubmit={onSubmit} history={[]} cwd="/" />);
    await tick();
    r.stdin.write("a\\");
    await tick();
    r.stdin.write("\r");
    await tick();
    r.stdin.write("b");
    await tick();
    r.stdin.write("\r");
    await tick();
    expect(onSubmit).toHaveBeenCalledWith("a\nb");
  });

  test("up recalls history", async () => {
    const r = render(<PromptInput onSubmit={() => {}} history={["earlier prompt"]} cwd="/" />);
    await tick();
    r.stdin.write("\x1b[A");
    await tick();
    expect(r.lastFrame()).toContain("earlier prompt");
  });

  test("empty input does not submit", async () => {
    const onSubmit = mock();
    const r = render(<PromptInput onSubmit={onSubmit} history={[]} cwd="/" />);
    await tick();
    r.stdin.write("\r");
    await tick();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("SessionPicker", () => {
  test("pick with enter, cancel with esc", async () => {
    const onPick = mock();
    const onCancel = mock();
    const sessions = [
      { id: "a", title: "first", updatedAt: new Date(), messageCount: 4 },
      { id: "b", title: "second", updatedAt: new Date(Date.now() - 7_200_000), messageCount: 9 },
    ];
    const r = render(<SessionPicker sessions={sessions} onPick={onPick} onCancel={onCancel} />);
    expect(r.lastFrame()).toContain("first");
    expect(r.lastFrame()).toContain("2h ago");
    await tick();
    r.stdin.write("\x1b[B");
    await tick();
    r.stdin.write("\r");
    await tick();
    expect(onPick).toHaveBeenCalledWith("b");
    r.stdin.write("\x1b");
    await tick();
    expect(onCancel).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test src/ui/components.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the presentational components**

```tsx
// src/ui/BrandHeader.tsx
import { Box, Text } from "ink";
import { homedir } from "node:os";
import { useTheme } from "./theme-context";

/** The Tropos angular T: two slanted bars and a slanted stem. Tune glyphs visually if needed. */
const MARK = ["▟█████▛ ▟█████▛", "     ▟██▛", "     ███", "     ██▘"];

function shortenHome(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export function BrandHeader({ version, model, effort, cwd }: { version: string; model: string; effort: string; cwd: string }) {
  const theme = useTheme();
  return (
    <Box flexDirection="row" gap={3} paddingX={1} marginBottom={1}>
      <Box flexDirection="column">
        {MARK.map((line, i) => (
          <Text key={i} color={theme.accent}>
            {line}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" justifyContent="center">
        <Text bold>
          Tropos Code <Text color={theme.muted}>v{version}</Text>
        </Text>
        <Text color={theme.muted}>
          {model} · effort {effort}
        </Text>
        <Text color={theme.muted}>{shortenHome(cwd)}</Text>
      </Box>
    </Box>
  );
}
```

```tsx
// src/ui/Spinner.tsx
import { Text } from "ink";
import { useEffect, useState } from "react";
import { useTheme } from "./theme-context";

const FRAMES = ["◐", "◓", "◑", "◒"];
/** Tropos is Greek for "turn". */
export const SPINNER_VERBS = ["Turning", "Pivoting", "Orbiting", "Revolving"];

export function Spinner({ verb }: { verb?: string }) {
  const theme = useTheme();
  const [frame, setFrame] = useState(0);
  const [startedAt] = useState(() => Date.now());
  const [word] = useState(() => verb ?? SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)]!);
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => f + 1), 120);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  return (
    <Text>
      <Text color={theme.accent}>
        {FRAMES[frame % FRAMES.length]} {word}…
      </Text>
      <Text color={theme.muted}> ({seconds}s · esc to interrupt)</Text>
    </Text>
  );
}
```

```tsx
// src/ui/StatusBar.tsx
import { Box, Text } from "ink";
import type { Mode } from "../config/constants";
import { useTheme } from "./theme-context";

export const MODE_LABELS: Record<Mode, string> = {
  default: "default mode",
  acceptEdits: "accept edits",
  plan: "plan mode",
  bypass: "bypass permissions",
};

export function StatusBar({ mode, contextPct, costUsd }: { mode: Mode; contextPct: number; costUsd: number }) {
  const theme = useTheme();
  const color = { default: theme.muted, acceptEdits: theme.accent, plan: theme.warning, bypass: theme.danger }[mode];
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text>
        <Text color={color} bold={mode !== "default"}>
          {MODE_LABELS[mode]}
        </Text>
        <Text color={theme.muted}>
          {" "}
          · ctx {contextPct}% · ${costUsd.toFixed(2)}
        </Text>
      </Text>
      <Text color={theme.muted}>shift+tab mode</Text>
    </Box>
  );
}
```

```tsx
// src/ui/DiffView.tsx
import { Box, Text } from "ink";
import { useTheme } from "./theme-context";

const HEADER = /^(Index:|===|---|\+\+\+|\\ No newline)/;

export function DiffView({ patch, maxLines = 40 }: { patch: string; maxLines?: number }) {
  const theme = useTheme();
  const lines = patch.split("\n").filter((l) => l.length > 0 && !HEADER.test(l));
  const shown = lines.slice(0, maxLines);
  return (
    <Box flexDirection="column" paddingLeft={4}>
      {shown.map((line, i) => (
        <Text key={i} color={line.startsWith("+") ? theme.diffAdd : line.startsWith("-") ? theme.diffRemove : theme.muted}>
          {line}
        </Text>
      ))}
      {lines.length > maxLines && <Text color={theme.muted}>… {lines.length - maxLines} more lines</Text>}
    </Box>
  );
}
```

```tsx
// src/ui/TodoList.tsx
import { Box, Text } from "ink";
import type { Todo } from "../tools/types";
import { useTheme } from "./theme-context";

const ICON = { pending: "☐", in_progress: "◐", completed: "☑" } as const;

export function TodoList({ todos }: { todos: Todo[] }) {
  const theme = useTheme();
  return (
    <Box flexDirection="column">
      {todos.map((todo, i) => (
        <Text key={i} color={todo.status === "completed" ? theme.muted : todo.status === "in_progress" ? theme.accent : undefined} strikethrough={todo.status === "completed"} bold={todo.status === "in_progress"}>
          {ICON[todo.status]} {todo.status === "in_progress" ? (todo.activeForm ?? todo.content) : todo.content}
        </Text>
      ))}
    </Box>
  );
}
```

```tsx
// src/ui/ToolRow.tsx
import { Box, Text } from "ink";
import { DiffView } from "./DiffView";
import { useTheme } from "./theme-context";
import { TodoList } from "./TodoList";
import type { TranscriptItem } from "./transcript";

type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const firstLine = (content: unknown) => (typeof content === "string" ? truncate(content.split("\n")[0] ?? "", 120) : "");

export function ToolRow({ item }: { item: ToolItem }) {
  const theme = useTheme();
  const color = { running: theme.accent, done: theme.success, error: theme.danger, denied: theme.warning }[item.status];
  const display = item.output?.display;
  const result =
    item.status === "running"
      ? null
      : item.status === "denied"
        ? "declined"
        : item.status === "error"
          ? firstLine(item.output?.content)
          : item.output?.summary;
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={color}>● </Text>
        <Text bold>{item.name}</Text>
        <Text color={theme.muted}> {truncate(item.summary.replace(/\s+/g, " "), 100)}</Text>
      </Text>
      {result ? (
        <Text color={item.status === "error" ? theme.danger : theme.muted}>
          {"  ⎿ "}
          {result}
        </Text>
      ) : null}
      {display?.kind === "diff" && item.status === "done" ? <DiffView patch={display.patch} /> : null}
      {display?.kind === "todos" ? (
        <Box paddingLeft={4}>
          <TodoList todos={display.todos} />
        </Box>
      ) : null}
    </Box>
  );
}
```

```tsx
// src/ui/TranscriptRow.tsx
import { Box, Text } from "ink";
import { renderMarkdown } from "./markdown";
import { useTheme } from "./theme-context";
import { ToolRow } from "./ToolRow";
import type { TranscriptItem } from "./transcript";

const THINKING_LINES = 6;

export function TranscriptRow({ item, live = false, width = 80 }: { item: TranscriptItem; live?: boolean; width?: number }) {
  const theme = useTheme();
  switch (item.kind) {
    case "user":
      return (
        <Box marginTop={1}>
          <Text color={theme.accent}>{"› "}</Text>
          <Text>{item.text}</Text>
        </Box>
      );
    case "assistant":
      return (
        <Box marginTop={1} paddingLeft={2}>
          <Text>{live ? item.text : renderMarkdown(item.text, Math.max(20, width - 4))}</Text>
        </Box>
      );
    case "thinking": {
      const lines = item.text.trim().split("\n");
      const shown = lines.slice(-THINKING_LINES).join("\n");
      return (
        <Box paddingLeft={2}>
          <Text color={theme.muted} italic>
            ∴ {shown}
          </Text>
        </Box>
      );
    }
    case "tool":
      return (
        <Box paddingLeft={2} marginTop={1}>
          <ToolRow item={item} />
        </Box>
      );
    case "notice": {
      const color = item.level === "error" ? theme.danger : item.level === "warn" ? theme.warning : theme.muted;
      return (
        <Box paddingLeft={2} marginTop={1}>
          <Text color={color}>{item.text}</Text>
        </Box>
      );
    }
  }
}
```

- [ ] **Step 4: Implement the interactive components**

```tsx
// src/ui/PermissionDialog.tsx
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { PermissionAnswer, PermissionPrompt } from "../agent/events";
import { makeDiff } from "../tools/diff";
import { DiffView } from "./DiffView";
import { useTheme } from "./theme-context";

function title(prompt: PermissionPrompt): string {
  if (prompt.kind === "exec") return "Run this command?";
  if (prompt.toolName === "Edit") return "Make this edit?";
  if (prompt.kind === "edit") return "Write this file?";
  if (prompt.kind === "read") return "Read outside the project?";
  return `Allow ${prompt.toolName}?`;
}

function Preview({ prompt }: { prompt: PermissionPrompt }) {
  const theme = useTheme();
  const input = (prompt.input ?? {}) as Record<string, unknown>;
  if (prompt.toolName === "Edit" && typeof input.old_string === "string" && typeof input.new_string === "string") {
    return (
      <Box flexDirection="column">
        <Text color={theme.muted}>{prompt.summary}</Text>
        <DiffView patch={makeDiff(prompt.summary, input.old_string, input.new_string).patch} maxLines={20} />
      </Box>
    );
  }
  if (prompt.toolName === "Write" && typeof input.content === "string") {
    const lines = input.content.split("\n");
    return (
      <Box flexDirection="column">
        <Text color={theme.muted}>{prompt.summary}</Text>
        <Box paddingLeft={4} flexDirection="column">
          <Text>{lines.slice(0, 10).join("\n")}</Text>
          {lines.length > 10 && <Text color={theme.muted}>… {lines.length - 10} more lines</Text>}
        </Box>
      </Box>
    );
  }
  return <Text>{prompt.summary}</Text>;
}

export function PermissionDialog({ prompt, onAnswer }: { prompt: PermissionPrompt; onAnswer(answer: PermissionAnswer): void }) {
  const theme = useTheme();
  const options: Array<{ label: string; answer: PermissionAnswer | null }> = [
    { label: "Yes", answer: { kind: "allow" } },
    ...(prompt.suggestion
      ? [{ label: `Yes, and don't ask again for ${prompt.suggestion}`, answer: { kind: "allow_always", rule: prompt.suggestion } as PermissionAnswer }]
      : []),
    { label: "No, tell Tropos what to do instead", answer: null },
  ];
  const [selected, setSelected] = useState(0);
  const [feedback, setFeedback] = useState<string | null>(null);

  const choose = (index: number) => {
    const option = options[index];
    if (!option) return;
    if (option.answer) onAnswer(option.answer);
    else setFeedback("");
  };

  useInput((input, key) => {
    if (feedback !== null) {
      if (key.escape) return onAnswer({ kind: "deny" });
      if (key.return) return onAnswer(feedback.trim() ? { kind: "deny", feedback: feedback.trim() } : { kind: "deny" });
      if (key.backspace || key.delete) return setFeedback(feedback.slice(0, -1));
      if (input && !key.ctrl && !key.meta) setFeedback(feedback + input);
      return;
    }
    if (key.escape) return onAnswer({ kind: "deny" });
    if (key.upArrow) return setSelected((s) => (s - 1 + options.length) % options.length);
    if (key.downArrow || key.tab) return setSelected((s) => (s + 1) % options.length);
    if (key.return) return choose(selected);
    const n = Number(input);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) choose(n - 1);
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} marginTop={1}>
      <Text bold color={theme.accent}>
        {title(prompt)}
      </Text>
      <Box marginY={1} paddingLeft={2} flexDirection="column">
        <Preview prompt={prompt} />
      </Box>
      {prompt.reason ? <Text color={theme.muted}>Why: {prompt.reason}</Text> : null}
      {options.map((option, i) => (
        <Text key={option.label} color={i === selected ? theme.accent : undefined}>
          {i === selected ? "› " : "  "}
          {i + 1}. {option.label}
        </Text>
      ))}
      {feedback !== null ? (
        <Text>
          <Text color={theme.muted}>{"  Tell Tropos: "}</Text>
          {feedback}
          <Text inverse> </Text>
        </Text>
      ) : null}
      <Text color={theme.muted}>esc to decline</Text>
    </Box>
  );
}
```

```tsx
// src/ui/PromptInput.tsx
import { Box, Text, useInput } from "ink";
import { useReducer, useState } from "react";
import { commonPrefix, completeCommand, completeFile } from "./complete";
import { emptyInput, inputReducer, tokenAtCursor } from "./input-state";
import { useTheme } from "./theme-context";

const PLACEHOLDER = "Ask Tropos… (/ for commands, @ for files)";

export function PromptInput({ onSubmit, history, cwd }: { onSubmit(text: string): void; history: string[]; cwd: string }) {
  const theme = useTheme();
  const [state, dispatch] = useReducer(inputReducer, emptyInput);
  const [suggestions, setSuggestions] = useState<string[]>([]);

  const complete = async () => {
    const token = tokenAtCursor(state);
    let items: string[] = [];
    if (token.text.startsWith("@")) items = await completeFile(token.text, cwd);
    else if (token.start === 0 && token.text.startsWith("/")) items = completeCommand(token.text);
    if (items.length === 0) return;
    const replacement = items.length === 1 ? `${items[0]}${items[0]!.endsWith("/") ? "" : " "}` : commonPrefix(items);
    if (replacement.length > token.text.length) dispatch({ type: "replaceRange", start: token.start, end: token.end, text: replacement });
    setSuggestions(items.length > 1 ? items.slice(0, 8) : []);
  };

  useInput((input, key) => {
    if (key.return) {
      if (state.value[state.cursor - 1] === "\\") {
        dispatch({ type: "replaceRange", start: state.cursor - 1, end: state.cursor, text: "\n" });
        return;
      }
      if (state.value.trim()) {
        onSubmit(state.value);
        dispatch({ type: "clear" });
        setSuggestions([]);
      }
      return;
    }
    if (key.tab && !key.shift) return void complete();
    if (key.upArrow) return dispatch({ type: "historyPrev", history });
    if (key.downArrow) return dispatch({ type: "historyNext", history });
    if (key.leftArrow) return dispatch({ type: "left" });
    if (key.rightArrow) return dispatch({ type: "right" });
    if (key.backspace || key.delete) return dispatch({ type: "backspace" });
    if (key.ctrl && input === "a") return dispatch({ type: "home" });
    if (key.ctrl && input === "e") return dispatch({ type: "end" });
    if (key.ctrl && input === "u") return dispatch({ type: "clear" });
    if (key.ctrl && input === "w") return dispatch({ type: "deleteWordBack" });
    if (key.ctrl || key.meta || key.escape || key.tab) return;
    if (input) {
      dispatch({ type: "insert", text: input.replace(/\r\n?/g, "\n") });
      setSuggestions([]);
    }
  });

  const lines = state.value.split("\n");
  let offset = 0;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box borderStyle="round" borderColor={theme.muted} paddingX={1} flexDirection="column">
        {state.value === "" ? (
          <Text>
            <Text color={theme.accent}>{"› "}</Text>
            <Text inverse> </Text>
            <Text color={theme.muted}>{PLACEHOLDER}</Text>
          </Text>
        ) : (
          lines.map((line, i) => {
            const start = offset;
            offset += line.length + 1;
            const col = state.cursor - start;
            const hasCursor = col >= 0 && col <= line.length;
            return (
              <Text key={i}>
                <Text color={theme.accent}>{i === 0 ? "› " : "  "}</Text>
                {hasCursor ? (
                  <>
                    {line.slice(0, col)}
                    <Text inverse>{line[col] ?? " "}</Text>
                    {line.slice(col + 1)}
                  </>
                ) : (
                  line
                )}
              </Text>
            );
          })
        )}
      </Box>
      {suggestions.length > 0 ? (
        <Box flexDirection="column" paddingX={3}>
          {suggestions.map((s) => (
            <Text key={s} color={theme.muted}>
              {s}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
```

```tsx
// src/ui/SessionPicker.tsx
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { SessionSummary } from "../session/store";
import { useTheme } from "./theme-context";

const VISIBLE = 10;

export function age(date: Date, now = Date.now()): string {
  const seconds = Math.max(0, (now - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function SessionPicker({ sessions, onPick, onCancel }: { sessions: SessionSummary[]; onPick(id: string): void; onCancel(): void }) {
  const theme = useTheme();
  const [selected, setSelected] = useState(0);
  useInput((_input, key) => {
    if (key.escape) return onCancel();
    if (key.upArrow) return setSelected((s) => Math.max(0, s - 1));
    if (key.downArrow) return setSelected((s) => Math.min(sessions.length - 1, s + 1));
    if (key.return && sessions[selected]) onPick(sessions[selected]!.id);
  });
  const first = Math.max(0, Math.min(selected - Math.floor(VISIBLE / 2), sessions.length - VISIBLE));
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} marginTop={1}>
      <Text bold color={theme.accent}>
        Resume a session
      </Text>
      {sessions.slice(first, first + VISIBLE).map((s, i) => {
        const index = first + i;
        return (
          <Text key={s.id} color={index === selected ? theme.accent : undefined}>
            {index === selected ? "› " : "  "}
            {s.title}
            <Text color={theme.muted}>
              {"  "}
              {age(s.updatedAt)} · {s.messageCount} messages
            </Text>
          </Text>
        );
      })}
      <Text color={theme.muted}>enter to resume · esc to cancel</Text>
    </Box>
  );
}
```

- [ ] **Step 5: Run to verify pass**

Run: `bun test src/ui && bun run typecheck`
Expected: PASS; typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/ui
git commit -m "feat: Ink components - header, tool rows, diffs, permission dialog, prompt input, session picker

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 17: App and interactive wiring

**Files:**
- Create: `src/ui/runtime.ts`, `src/ui/App.tsx`
- Create: `test/helpers/fake-runtime.ts`
- Test: `src/ui/App.test.tsx`

**Interfaces:**
- Consumes: everything in Tasks 13, 15, 16; `contextWindow` (Task 12).
- Produces:
  - `AgentUi { emit(event: AgentEvent): void; askPermission(prompt: PermissionPrompt, signal: AbortSignal): Promise<PermissionAnswer> }`
  - `Runtime` (see code) — implemented for real in Task 18 (`src/cli/runtime.ts`), faked in tests
  - `App({ runtime }: { runtime: Runtime })`
  - `fakeRuntime(steps: Step[], over?: { mode?: Mode }): Runtime & { model: FakeModel; inputs: string[] }`

- [ ] **Step 1: Write the Runtime contract**

```ts
// src/ui/runtime.ts
import type { Agent } from "../agent/agent";
import type { AgentEvent, PermissionAnswer, PermissionPrompt } from "../agent/events";
import type { Effort, Mode } from "../config/constants";
import type { MessageParam, SessionSummary } from "../session/store";
import type { Theme } from "./theme";

export interface AgentUi {
  emit(event: AgentEvent): void;
  askPermission(prompt: PermissionPrompt, signal: AbortSignal): Promise<PermissionAnswer>;
}

/** Everything the interactive UI needs from the outside world. */
export interface Runtime {
  readonly version: string;
  readonly cwd: string;
  readonly theme: Theme;
  /** Shift+Tab cycle order; includes "bypass" only when started with --dangerously-skip-permissions. */
  readonly modes: Mode[];
  readonly initialPrompt?: string;
  /** Open the session picker on start (`tropos -r` without an id). */
  readonly startWithPicker?: boolean;
  state(): { model: string; effort: Effort; mode: Mode };
  setMode(mode: Mode): void;
  setModel(model: string): void;
  setEffort(effort: Effort): void;
  /** An agent for the current session, seeded with its history. */
  newAgent(ui: AgentUi): Agent;
  /** The current session's saved history. */
  history(): MessageParam[];
  /** Starts a new, empty session. */
  clear(): Promise<void>;
  sessions(): Promise<SessionSummary[]>;
  /** Makes a saved session current. */
  resume(id: string): Promise<void>;
  inputHistory(): string[];
  recordInput(text: string): void;
}
```

- [ ] **Step 2: Write the fake runtime and the failing App tests**

```ts
// test/helpers/fake-runtime.ts
import { z } from "zod";
import { Agent } from "../../src/agent/agent";
import type { Effort, Mode } from "../../src/config/constants";
import { compileRules } from "../../src/permissions/engine";
import type { MessageParam } from "../../src/session/store";
import { defineTool, type AnyTool } from "../../src/tools/types";
import { DARK } from "../../src/ui/theme";
import type { Runtime } from "../../src/ui/runtime";
import { FakeModel, type Step } from "./fake-model";
import { makeToolContext } from "./tool-context";

export const shellTool = defineTool({
  name: "Shell",
  kind: "exec",
  description: "run",
  schema: z.object({ command: z.string() }),
  summarize: (i) => i.command,
  subject: (i) => ({ command: i.command, paths: [] }),
  run: async (i) => ({ content: `ran ${i.command}`, summary: "ok" }),
});

export function fakeRuntime(steps: Step[], over: { mode?: Mode } = {}): Runtime & { model: FakeModel; inputs: string[] } {
  const model = new FakeModel(steps);
  let state = { model: "claude-opus-5-5", effort: "high" as Effort, mode: over.mode ?? ("default" as Mode) };
  let history: MessageParam[] = [];
  const inputs: string[] = [];
  const toolContext = makeToolContext({ root: "/w" });
  return {
    version: "0.1.0-test",
    cwd: "/w",
    theme: DARK,
    modes: ["default", "acceptEdits", "plan"],
    model,
    inputs,
    state: () => state,
    setMode: (mode) => (state = { ...state, mode }),
    setModel: (m) => (state = { ...state, model: m }),
    setEffort: (effort) => (state = { ...state, effort }),
    newAgent: (ui) =>
      new Agent(
        {
          model,
          tools: [shellTool] as AnyTool[],
          system: "s",
          config: () => ({ model: state.model, effort: state.effort, refusalFallback: true }),
          permissions: () => ({ mode: state.mode, rules: compileRules({ allow: [], ask: [], deny: [] }).rules, cwd: "/w", home: "/h", allowedDirs: ["/w"] }),
          askPermission: ui.askPermission,
          contextText: async () => "<context></context>",
          persist: async (m) => {
            history.push(m);
          },
          toolContext,
          emit: ui.emit,
        },
        history,
      ),
    history: () => history,
    clear: async () => {
      history = [];
    },
    sessions: async () => [],
    resume: async () => {},
    inputHistory: () => inputs,
    recordInput: (t) => {
      inputs.push(t);
    },
  };
}
```

```tsx
// src/ui/App.test.tsx
import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { reply, textBlock, toolUseBlock } from "../../test/helpers/fake-model";
import { fakeRuntime } from "../../test/helpers/fake-runtime";
import { App } from "./App";

const tick = (ms = 40) => Bun.sleep(ms);
const all = (r: ReturnType<typeof render>) => r.frames.join("\n");

describe("App", () => {
  test("header and status bar", async () => {
    const r = render(<App runtime={fakeRuntime([])} />);
    await tick();
    expect(all(r)).toContain("Tropos Code");
    expect(r.lastFrame()).toContain("default mode");
  });

  test("a prompt gets a streamed answer", async () => {
    const runtime = fakeRuntime([() => reply([textBlock("Hello from Tropos")])]);
    const r = render(<App runtime={runtime} />);
    await tick();
    r.stdin.write("hi");
    await tick();
    r.stdin.write("\r");
    await tick(150);
    expect(all(r)).toContain("Hello from Tropos");
    expect(runtime.inputs).toEqual(["hi"]);
  });

  test("shift+tab cycles the permission mode", async () => {
    const runtime = fakeRuntime([]);
    const r = render(<App runtime={runtime} />);
    await tick();
    r.stdin.write("\x1b[Z");
    await tick();
    expect(r.lastFrame()).toContain("accept edits");
    expect(runtime.state().mode).toBe("acceptEdits");
  });

  test("a command needing permission shows the dialog, then runs", async () => {
    const runtime = fakeRuntime([() => reply([toolUseBlock("t1", "Shell", { command: "make" })], "tool_use"), () => reply([textBlock("Built it.")])]);
    const r = render(<App runtime={runtime} />);
    await tick();
    r.stdin.write("build");
    await tick();
    r.stdin.write("\r");
    await tick(150);
    expect(r.lastFrame()).toContain("Run this command?");
    r.stdin.write("1");
    await tick(150);
    expect(all(r)).toContain("Built it.");
    expect(all(r)).toContain("Shell");
  });

  test("/help and bad /effort", async () => {
    const r = render(<App runtime={fakeRuntime([])} />);
    await tick();
    r.stdin.write("/help");
    await tick();
    r.stdin.write("\r");
    await tick();
    expect(all(r)).toContain("/clear");
    r.stdin.write("/effort huge");
    await tick();
    r.stdin.write("\r");
    await tick();
    expect(all(r)).toContain("Effort must be one of");
  });

  test("/model sets the model", async () => {
    const runtime = fakeRuntime([]);
    const r = render(<App runtime={runtime} />);
    await tick();
    r.stdin.write("/model claude-sonnet-5-5");
    await tick();
    r.stdin.write("\r");
    await tick();
    expect(runtime.state().model).toBe("claude-sonnet-5-5");
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `bun test src/ui/App.test.tsx`
Expected: FAIL — `Cannot find module './App'`.

- [ ] **Step 4: Implement `src/ui/App.tsx`**

```tsx
// src/ui/App.tsx
import { Box, Static, useApp, useInput, useStdout } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Agent } from "../agent/agent";
import type { PermissionAnswer, PermissionPrompt } from "../agent/events";
import { contextWindow } from "../api/pricing";
import type { SessionSummary } from "../session/store";
import { BrandHeader } from "./BrandHeader";
import { parseCommand } from "./commands";
import { PermissionDialog } from "./PermissionDialog";
import { PromptInput } from "./PromptInput";
import type { AgentUi, Runtime } from "./runtime";
import { SessionPicker } from "./SessionPicker";
import { Spinner } from "./Spinner";
import { StatusBar } from "./StatusBar";
import { ThemeProvider } from "./theme-context";
import { addNotice, addUser, emptyTranscript, flush, historyToTranscript, reduce, type Transcript, type TranscriptItem } from "./transcript";
import { TranscriptRow } from "./TranscriptRow";

const CLEAR_SCREEN = "\x1b[2J\x1b[3J\x1b[H";
type StaticItem = TranscriptItem | { id: "header"; kind: "header" };

export function App({ runtime }: { runtime: Runtime }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [transcript, setTranscript] = useState<Transcript>(() => historyToTranscript(runtime.history()));
  const [busy, setBusy] = useState(false);
  const [permission, setPermission] = useState<{ prompt: PermissionPrompt; answer(a: PermissionAnswer): void } | null>(null);
  const [picker, setPicker] = useState<SessionSummary[] | null>(null);
  const [usage, setUsage] = useState({ contextTokens: 0, totalCostUsd: 0 });
  const [settings, setSettings] = useState(runtime.state());
  const [staticKey, setStaticKey] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const ui = useMemo<AgentUi>(
    () => ({
      emit: (event) => {
        if (event.type === "usage") setUsage({ contextTokens: event.contextTokens, totalCostUsd: event.totalCostUsd });
        setTranscript((t) => reduce(t, event));
      },
      askPermission: (prompt, signal) =>
        new Promise<PermissionAnswer>((resolve) => {
          let settled = false;
          const answer = (a: PermissionAnswer) => {
            if (settled) return;
            settled = true;
            setPermission(null);
            resolve(a);
          };
          signal.addEventListener("abort", () => answer({ kind: "deny" }), { once: true });
          setPermission({ prompt, answer });
        }),
    }),
    [],
  );

  const agentRef = useRef<Agent | null>(null);
  if (!agentRef.current) agentRef.current = runtime.newAgent(ui);

  const notice = useCallback((level: "info" | "warn" | "error", text: string) => {
    setTranscript((t) => flush(addNotice(t, level, text)));
  }, []);

  const resetScreen = useCallback(
    (next: Transcript) => {
      stdout.write(CLEAR_SCREEN);
      setTranscript(next);
      setStaticKey((k) => k + 1);
    },
    [stdout],
  );

  const runTurn = useCallback(
    async (prompt: string, display = prompt) => {
      setTranscript((t) => addUser(t, display));
      setBusy(true);
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        await agentRef.current!.run(prompt, controller.signal);
      } catch (err) {
        notice("error", (err as Error).message);
      } finally {
        abortRef.current = null;
        setBusy(false);
      }
    },
    [notice],
  );

  const submit = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      runtime.recordInput(trimmed);
      const command = parseCommand(trimmed);
      switch (command.kind) {
        case "none":
          return runTurn(trimmed);
        case "prompt":
          return runTurn(command.text, trimmed);
        case "help":
          return notice("info", command.text);
        case "exit":
          return exit();
        case "clear":
          await runtime.clear();
          agentRef.current = runtime.newAgent(ui);
          setUsage({ contextTokens: 0, totalCostUsd: 0 });
          return resetScreen(emptyTranscript);
        case "resume": {
          const list = await runtime.sessions();
          if (list.length === 0) return notice("info", "No saved sessions for this directory.");
          return setPicker(list);
        }
        case "model":
          if (!command.model) return notice("info", `Model: ${runtime.state().model}`);
          runtime.setModel(command.model);
          setSettings(runtime.state());
          return notice("info", `Model set to ${command.model}.`);
        case "effort":
          if (command.error) return notice("error", command.error);
          if (!command.effort) return notice("info", `Effort: ${runtime.state().effort}`);
          runtime.setEffort(command.effort);
          setSettings(runtime.state());
          return notice("info", `Effort set to ${command.effort}.`);
        case "cost":
          return notice("info", `Session cost $${agentRef.current!.totalCostUsd.toFixed(4)} · context ${usage.contextTokens.toLocaleString()} tokens`);
        case "unknown":
          return notice("error", `Unknown command /${command.name}. Type /help for the list.`);
      }
    },
    [runtime, runTurn, notice, exit, ui, resetScreen, usage.contextTokens],
  );

  const pickSession = useCallback(
    async (id: string) => {
      setPicker(null);
      await runtime.resume(id);
      agentRef.current = runtime.newAgent(ui);
      resetScreen(historyToTranscript(runtime.history()));
    },
    [runtime, ui, resetScreen],
  );

  useEffect(() => {
    if (runtime.initialPrompt) void runTurn(runtime.initialPrompt);
    else if (runtime.startWithPicker) {
      void runtime.sessions().then((list) => (list.length > 0 ? setPicker(list) : notice("info", "No saved sessions for this directory.")));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useInput(
    (input, key) => {
      if (key.tab && key.shift) {
        const modes = runtime.modes;
        const next = modes[(modes.indexOf(settings.mode) + 1) % modes.length]!;
        runtime.setMode(next);
        setSettings(runtime.state());
        return;
      }
      if (key.escape && busy) {
        abortRef.current?.abort();
        return;
      }
      if (key.ctrl && input === "c") {
        if (busy) abortRef.current?.abort();
        else exit();
      }
    },
    { isActive: !permission && !picker },
  );

  const width = stdout.columns ?? 80;
  const staticItems: StaticItem[] = [{ id: "header", kind: "header" }, ...transcript.done];
  const contextPct = Math.round((usage.contextTokens / contextWindow(settings.model)) * 100);

  return (
    <ThemeProvider theme={runtime.theme}>
      <Static key={staticKey} items={staticItems}>
        {(item) =>
          item.kind === "header" ? (
            <BrandHeader key="header" version={runtime.version} model={settings.model} effort={settings.effort} cwd={runtime.cwd} />
          ) : (
            <TranscriptRow key={item.id} item={item} width={width} />
          )
        }
      </Static>
      <Box flexDirection="column">
        {transcript.live.map((item) => (
          <TranscriptRow key={item.id} item={item} live width={width} />
        ))}
        {permission ? <PermissionDialog prompt={permission.prompt} onAnswer={permission.answer} /> : null}
        {picker ? <SessionPicker sessions={picker} onPick={(id) => void pickSession(id)} onCancel={() => setPicker(null)} /> : null}
        {busy && !permission ? (
          <Box marginTop={1}>
            <Spinner />
          </Box>
        ) : null}
        {!busy && !picker ? <PromptInput onSubmit={(t) => void submit(t)} history={runtime.inputHistory()} cwd={runtime.cwd} /> : null}
        <StatusBar mode={settings.mode} contextPct={contextPct} costUsd={usage.totalCostUsd} />
      </Box>
    </ThemeProvider>
  );
}
```

Note: the header is the first `<Static>` item, so it prints once at the top; `/clear` and `/resume` clear the screen and bump `staticKey`, which remounts `<Static>` so the header and the new transcript print fresh.

- [ ] **Step 5: Run to verify pass**

Run: `bun test src/ui && bun run typecheck`
Expected: PASS; typecheck exits 0. If a test is timing-sensitive on a slow machine, raise its `tick` duration rather than changing component logic.

- [ ] **Step 6: Commit**

```bash
git add src/ui/runtime.ts src/ui/App.tsx src/ui/App.test.tsx test/helpers/fake-runtime.ts
git commit -m "feat: interactive App with streaming transcript, permission flow, modes and slash commands

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
