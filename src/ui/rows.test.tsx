// src/ui/rows.test.tsx
import { describe, expect, test } from "bun:test";
import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import type { ReactNode } from "react";
import { makeDiff } from "../tools/diff";
import { BLINK_MS, BlinkingDot } from "./BlinkingDot";
import { DiffView, diffRows } from "./DiffView";
import { DARK, LIGHT } from "./theme";
import { ThemeProvider } from "./theme-context";
import { TodoList } from "./TodoList";
import { dotGlyph } from "./tool-view";
import { ToolRow } from "./ToolRow";
import type { TranscriptItem } from "./transcript";
import { TranscriptRow } from "./TranscriptRow";

type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

const DOT = dotGlyph();
const frame = (node: ReactNode, theme = DARK) => render(<ThemeProvider theme={theme}>{node}</ThemeProvider>).lastFrame()!;
const tool = (over: Partial<ToolItem>): ToolItem => ({ id: "i1", kind: "tool", toolUseId: "t", name: "Bash", summary: "", status: "done", ...over });

describe("diffRows", () => {
  test("numbers removed lines by the old file and the rest by the new one", () => {
    const patch = "--- a\n+++ b\n@@ -10,3 +10,3 @@\n ctx\n-old\n+new\n\\ No newline at end of file\n@@ -40,1 +40,2 @@\n keep\n+added";
    expect(diffRows(patch)).toEqual([
      { kind: "context", num: 10, text: "ctx" },
      { kind: "remove", num: 11, text: "old" },
      { kind: "add", num: 11, text: "new" },
      { kind: "gap" },
      { kind: "context", num: 40, text: "keep" },
      { kind: "add", num: 41, text: "added" },
    ]);
  });

  test("lines before the first hunk are header, even if they look like changes", () => {
    expect(diffRows("--- x\n+++ y\n-- not a change")).toEqual([]);
    expect(diffRows("@@ -1 +1 @@\n--- sql comment")).toEqual([{ kind: "remove", num: 1, text: "-- sql comment" }]);
  });
});

describe("DiffView", () => {
  test("line numbers padded to the widest, a gap between hunks", () => {
    const out = frame(<DiffView patch={"@@ -9,2 +9,2 @@\n-a\n+b\n ctx\n@@ -100,1 +100,1 @@\n-x\n+y"} width={40} />);
    expect(out).toContain("  9 -a");
    expect(out).toContain("  9 +b");
    expect(out).toContain(" 10  ctx");
    expect(out).toContain("100 -x");
    expect(out).toContain("  ...");
  });

  test("caps rows unless verbose; tabs are expanded", () => {
    const patch = "@@ -1,0 +1,5 @@\n+1\n+2\n+3\n+4\n+\tt";
    const capped = frame(<DiffView patch={patch} maxLines={3} />);
    expect(capped).toContain("… +2 lines");
    expect(capped).not.toContain("4");
    expect(frame(<DiffView patch={patch} maxLines={4} />)).toContain("… +1 line");
    const full = frame(<DiffView patch={patch} maxLines={3} verbose />, LIGHT);
    expect(full).toContain("5 +  t");
    expect(full).not.toContain("more");
  });
});

describe("TodoList", () => {
  test("✔ done, ◼ in progress (active form), ◻ pending", () => {
    const out = frame(
      <TodoList
        todos={[
          { content: "Plan", status: "completed" },
          { content: "Build", status: "in_progress", activeForm: "Building" },
          { content: "Ship\x1b[2J", status: "pending" },
        ]}
      />,
    );
    expect(out).toContain("✔ Plan");
    expect(out).toContain("◼ Building");
    expect(out).toContain("◻ Ship");
    expect(out).not.toContain("\x1b[2J");
  });
});

describe("BlinkingDot", () => {
  test("blinks on a shared clock and keeps its width", async () => {
    const r = render(
      <Box>
        <BlinkingDot glyph="X" />
        <Text>|</Text>
      </Box>,
    );
    const r2 = render(<BlinkingDot glyph="Y" />);
    expect(r.lastFrame()).toBe("X|");
    // Wait for the hidden phase instead of sleeping a fixed time: a slow runner may tick twice in BLINK_MS + 100.
    const until = async (done: () => boolean) => {
      const deadline = Date.now() + BLINK_MS * 4;
      while (!done() && Date.now() < deadline) await Bun.sleep(10);
    };
    await until(() => r.lastFrame() === " |");
    expect(r.lastFrame()).toBe(" |");
    // Both dots run on the one shared clock, so the second is hidden in the same phase.
    await until(() => r2.lastFrame() === "" || r.lastFrame() !== " |");
    expect(r.lastFrame() === " |" ? r2.lastFrame() : "").toBe("");
    r.unmount();
    r2.unmount();
    // The clock restarts in the visible phase.
    expect(render(<BlinkingDot glyph="Z" />).lastFrame()).toBe("Z");
  });
});

describe("ToolRow", () => {
  test("header with display name, relative path and the result gutter", () => {
    const out = frame(
      <ToolRow cwd="/w" item={tool({ name: "Read", status: "done", input: { file_path: "/w/src/a.ts" }, output: { content: "x", summary: "84 lines" } })} />,
    );
    expect(out).toContain(`${DOT} Read(src/a.ts)`);
    expect(out).toContain("  ⎿  Read 84 lines");
  });

  test("an edit shows the counts and a numbered diff", () => {
    const display = makeDiff("/w/a.ts", "const a = 1;\n", "const a = 2;\n");
    const out = frame(<ToolRow cwd="/w" item={tool({ name: "Edit", input: { file_path: "/w/a.ts" }, output: { content: "ok", display, summary: "+1 −1" } })} />);
    expect(out).toContain(`${DOT} Update(a.ts)`);
    expect(out).toContain("Added 1 line, removed 1 line");
    expect(out).toContain("1 -const a = 1;");
    expect(out).toContain("1 +const a = 2;");
  });

  test("a new file previews its lines", () => {
    const display = makeDiff("/w/n.ts", "", "one\ntwo\n");
    const out = frame(<ToolRow cwd="/w" item={tool({ name: "Write", input: { file_path: "/w/n.ts" }, output: { content: "ok", display, summary: "created, 2 lines" } })} />);
    expect(out).toContain("Wrote 2 lines to n.ts");
    expect(out).toContain("1 one");
    expect(out).toContain("2 two");
    const many = makeDiff("/w/n.ts", "", Array.from({ length: 12 }, (_, i) => `l${i}`).join("\n") + "\n");
    expect(frame(<ToolRow item={tool({ name: "Write", output: { content: "ok", display: many, summary: "created, 12 lines" } })} />)).toContain("… +2 lines");
    const one = makeDiff("/w/n.ts", "", Array.from({ length: 11 }, (_, i) => `l${i}`).join("\n") + "\n");
    expect(frame(<ToolRow item={tool({ name: "Write", output: { content: "ok", display: one, summary: "created, 11 lines" } })} />)).toContain("… +1 line");
  });

  test("todos, multi-line results aligned under the gutter", () => {
    const todos = [{ content: "a", status: "pending" as const }];
    expect(frame(<ToolRow item={tool({ name: "TodoWrite", input: { todos }, output: { content: "ok", display: { kind: "todos", todos } } })} />)).toContain(
      "Update Todos",
    );
    const out = frame(<ToolRow item={tool({ name: "Bash", input: { command: "ls" }, output: { content: "a\nb" } })} />);
    expect(out).toContain(`${DOT} Bash(ls)`);
    expect(out).toContain("  ⎿  a\n     b");
  });

  test("a running agent: badge, progress and tool uses", () => {
    const one = frame(<ToolRow item={tool({ name: "Agent", status: "running", input: { description: "Find it", subagent_type: "explore" }, progress: "Read x", progressCount: 1 })} />);
    expect(one).toContain(" explore  Agent(Find it)");
    expect(one).toContain("↳ Read x");
    expect(one).toContain("1 tool use");
    const none = frame(<ToolRow item={tool({ name: "Agent", status: "running", input: { description: "d" } })} />);
    expect(none).toContain("Starting…");
    expect(none).toContain("0 tool uses");
  });

  test("denied and interrupted rows; nothing under a silent running tool", () => {
    expect(frame(<ToolRow item={tool({ status: "denied", output: { content: "The user declined this action.", isError: true } })} />)).toContain("⎿  Declined");
    expect(frame(<ToolRow item={tool({ status: "error", output: { content: "[interrupted by user]", isError: true } })} />)).toContain("⎿  Interrupted");
    expect(frame(<ToolRow item={tool({ name: "Read", status: "running", input: { file_path: "/a" } })} />)).not.toContain("⎿");
  });
});

describe("TranscriptRow", () => {
  test("user message with the prompt pointer", () => {
    expect(frame(<TranscriptRow item={{ id: "u", kind: "user", text: "/review main" }} />)).toContain("❯ /review main");
  });

  test("assistant text: dot, then markdown; live text keeps its tail", () => {
    const done = frame(<TranscriptRow item={{ id: "a", kind: "assistant", text: "Hello **there**" }} />);
    expect(done).toContain(`${DOT} Hello`);
    const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const live = frame(<TranscriptRow live item={{ id: "a", kind: "assistant", text: long }} />);
    expect(live).toContain("… 10 earlier lines");
    expect(live).toContain("line 39");
    expect(live).not.toContain("line 9\n");
    expect(frame(<TranscriptRow live item={{ id: "a", kind: "assistant", text: "short" }} />)).not.toContain("earlier");
  });

  test("thinking: collapsed when done, tail while live, everything when verbose", () => {
    const text = "one\ntwo\nthree\nfour";
    const collapsed = frame(<TranscriptRow item={{ id: "t", kind: "thinking", text }} />);
    expect(collapsed).toContain("∴ Thinking (ctrl+o to expand)");
    expect(collapsed).not.toContain("four");
    const live = frame(<TranscriptRow live item={{ id: "t", kind: "thinking", text }} />);
    expect(live).toContain("four");
    expect(live).not.toContain("one");
    const verbose = frame(<TranscriptRow verbose item={{ id: "t", kind: "thinking", text }} />);
    expect(verbose).toContain("one");
    expect(verbose).toContain("four");
  });

  test("notices by level, the turn footer and tool rows", () => {
    for (const level of ["info", "warn", "error"] as const) {
      expect(frame(<TranscriptRow item={{ id: "n", kind: "notice", level, text: `say ${level}` }} />)).toContain(`${DOT} say ${level}`);
    }
    expect(frame(<TranscriptRow item={{ id: "d", kind: "turn_done", seconds: 12 }} />)).toContain("✻ Pivoted for 12s");
    const out = frame(<TranscriptRow cwd="/w" verbose item={tool({ name: "Bash", input: { command: "ls" }, output: { content: "1\n2\n3\n4\n5" } })} />);
    expect(out).toContain("5");
    expect(out).not.toContain("ctrl+o");
  });
});
