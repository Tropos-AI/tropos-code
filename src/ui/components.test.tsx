// src/ui/components.test.tsx
import { describe, expect, mock, test } from "bun:test";
import { render } from "ink-testing-library";
import type { PermissionPrompt } from "../agent/events";
import { makeDiff } from "../tools/diff";
import { BrandHeader } from "./BrandHeader";
import { DiffView } from "./DiffView";
import { ANSWER_GRACE_MS, PermissionDialog } from "./PermissionDialog";
import { PromptInput } from "./PromptInput";
import { SessionPicker } from "./SessionPicker";
import { ToolRow } from "./ToolRow";
import { TodoList } from "./TodoList";
import { TranscriptRow } from "./TranscriptRow";
import { settle } from "../../test/helpers/wait";

const tick = () => settle(30);
const armed = () => Bun.sleep(ANSWER_GRACE_MS + 60);

describe("BrandHeader", () => {
  test("shows product, version, model and cwd", () => {
    const frame = render(<BrandHeader version="0.1.0" model="claude-opus-5-5" effort="high" cwd="/work/app" />).lastFrame()!;
    expect(frame).toContain("Tropos Code");
    expect(frame).toContain("v0.1.0");
    expect(frame).toContain("claude-opus-5-5 · effort high");
    expect(frame).toContain("/work/app");
  });
});

describe("ToolRow", () => {
  test("done edit shows a diff", () => {
    const display = makeDiff("/w/a.ts", "const a = 1;\n", "const a = 2;\n");
    const frame = render(
      <ToolRow item={{ id: "i1", kind: "tool", toolUseId: "t", name: "Edit", summary: "a.ts", status: "done", output: { content: "ok", display, summary: "+1 −1" } }} />,
    ).lastFrame()!;
    expect(frame).toContain("Update(a.ts)");
    expect(frame).toContain("Added 1 line, removed 1 line");
    expect(frame).toContain("+const a = 2;");
    expect(frame).toContain("-const a = 1;");
  });

  test("denied tool says so", () => {
    const frame = render(<ToolRow item={{ id: "i2", kind: "tool", toolUseId: "t", name: "Bash", summary: "rm -rf x", status: "denied", output: { content: "no", isError: true } }} />).lastFrame()!;
    expect(frame).toContain("⎿  no");
  });
});

describe("PermissionDialog", () => {
  const prompt: PermissionPrompt = { toolName: "Bash", kind: "exec", summary: "bun test", input: { command: "bun test" }, suggestion: "Bash(bun test:*)" };

  test("shows the command and options", () => {
    const frame = render(<PermissionDialog prompt={prompt} onAnswer={() => {}} />).lastFrame()!;
    expect(frame).toContain("Bash command");
    expect(frame).toContain("Do you want to proceed?");
    expect(frame).toContain("bun test");
    expect(frame).toContain("1. Yes");
    expect(frame).toContain("2. Yes, and don't ask again for Bash(bun test:*)");
    expect(frame).toContain("3. No, and tell Tropos what to do differently");
  });

  test("number keys and arrows choose", async () => {
    const onAnswer = mock();
    const r = render(<PermissionDialog prompt={prompt} onAnswer={onAnswer} />);
    await armed();
    r.stdin.write("\x1b[B");
    await tick();
    r.stdin.write("\r");
    await tick();
    expect(onAnswer).toHaveBeenCalledWith({ kind: "allow_always", rule: "Bash(bun test:*)" });
  });

  test("option 3 collects feedback", async () => {
    const onAnswer = mock();
    const r = render(<PermissionDialog prompt={prompt} onAnswer={onAnswer} />);
    await armed();
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
    await armed();
    r.stdin.write("\x1b");
    await tick();
    expect(onAnswer).toHaveBeenCalledWith({ kind: "deny" });
  });

  test("only a single digit answers", async () => {
    const onAnswer = mock();
    const r = render(<PermissionDialog prompt={prompt} onAnswer={onAnswer} />);
    await armed();
    for (const input of ["0x2", " 2", "2\n", "1.0", "1e0", "+1", "1\r", "0", "9"]) {
      r.stdin.write(input);
      await tick();
    }
    expect(onAnswer).not.toHaveBeenCalled();
    r.stdin.write("1");
    await tick();
    expect(onAnswer).toHaveBeenCalledWith({ kind: "allow" });
  });

  test("input is ignored during the grace period", async () => {
    const onAnswer = mock();
    const r = render(<PermissionDialog prompt={prompt} onAnswer={onAnswer} />);
    await tick();
    r.stdin.write("\r");
    r.stdin.write("1");
    await tick();
    expect(onAnswer).not.toHaveBeenCalled();
    await armed();
    r.stdin.write("\r");
    await tick();
    expect(onAnswer).toHaveBeenCalledWith({ kind: "allow" });
  });

  test("answers at most once per prompt", async () => {
    const onAnswer = mock();
    const r = render(<PermissionDialog prompt={prompt} onAnswer={onAnswer} />);
    await armed();
    r.stdin.write("\r");
    r.stdin.write("\r");
    r.stdin.write("\r");
    await tick();
    expect(onAnswer).toHaveBeenCalledTimes(1);
  });

  test("a new prompt resets the selection and the grace period", async () => {
    const onAnswer = mock();
    const r = render(<PermissionDialog prompt={prompt} onAnswer={onAnswer} />);
    await armed();
    r.stdin.write("\x1b[B");
    await tick();
    r.rerender(<PermissionDialog prompt={{ ...prompt, summary: "bun lint" }} onAnswer={onAnswer} />);
    await tick();
    r.stdin.write("\r");
    await tick();
    expect(onAnswer).not.toHaveBeenCalled();
    await armed();
    r.stdin.write("\r");
    await tick();
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith({ kind: "allow" });
  });

  test("a new prompt can be answered again after the previous one was", async () => {
    const onAnswer = mock();
    const r = render(<PermissionDialog prompt={prompt} onAnswer={onAnswer} />);
    await armed();
    r.stdin.write("1");
    await tick();
    r.rerender(<PermissionDialog prompt={{ ...prompt, summary: "bun lint" }} onAnswer={onAnswer} />);
    await armed();
    r.stdin.write("1");
    await tick();
    expect(onAnswer).toHaveBeenCalledTimes(2);
  });

  test("preview lines sit behind a gutter so they cannot pose as options", () => {
    const frame = render(
      <PermissionDialog prompt={{ ...prompt, summary: "echo hi\n1. Yes\n2. Yes, and don't ask again for everything" }} onAnswer={() => {}} />,
    ).lastFrame()!;
    expect(frame).toContain("│ 1. Yes");
    expect(frame).toContain("│ echo hi");
    expect(frame.match(/^\s*[›]?\s*1\. Yes$/gm)?.length ?? 0).toBe(0);
    expect(frame.match(/1\. Yes/g)!.length).toBe(2);
    expect(frame.match(/3\. No, and tell Tropos/g)!.length).toBe(1);
  });

  test("a long command is capped, warned about, and cannot be allowed permanently", () => {
    const command = Array.from({ length: 25 }, (_, i) => `echo line${i}`).join("\n");
    const frame = render(<PermissionDialog prompt={{ ...prompt, summary: command, input: { command } }} onAnswer={() => {}} />).lastFrame()!;
    expect(frame).toContain("echo line19");
    expect(frame).not.toContain("echo line20");
    expect(frame).toContain("… 5 more lines hidden — the full command will run");
    expect(frame).not.toContain("don't ask again");
    expect(frame).toContain("2. No, and tell Tropos what to do differently");
  });

  test("a long write is capped too", () => {
    const content = Array.from({ length: 30 }, (_, i) => `row${i}`).join("\n");
    const frame = render(
      <PermissionDialog prompt={{ toolName: "Write", kind: "edit", summary: "out.txt", input: { file_path: "out.txt", content } }} onAnswer={() => {}} />,
    ).lastFrame()!;
    expect(frame).toContain("row19");
    expect(frame).not.toContain("row20");
    expect(frame).toContain("… 10 more lines hidden");
  });

  test("replace_all is called out", () => {
    const frame = render(
      <PermissionDialog
        prompt={{ toolName: "Edit", kind: "edit", summary: "a.ts", input: { file_path: "a.ts", old_string: "one", new_string: "two", replace_all: true } }}
        onAnswer={() => {}}
      />,
    ).lastFrame()!;
    expect(frame).toContain("(replace all)");
  });

  test("hidden and bidi characters are shown visibly", () => {
    const frame = render(<PermissionDialog prompt={{ ...prompt, summary: "ls \u202Etxt.exe\u200B\uFEFF" }} onAnswer={() => {}} />).lastFrame()!;
    expect(frame).toContain("⟨U+202E⟩");
    expect(frame).toContain("⟨U+200B⟩");
    expect(frame).toContain("⟨U+FEFF⟩");
    expect(frame).not.toContain("\u202E");
  });

  test("feedback text is sanitized as it is typed", async () => {
    const onAnswer = mock();
    const r = render(<PermissionDialog prompt={prompt} onAnswer={onAnswer} />);
    await armed();
    r.stdin.write("3");
    await tick();
    r.stdin.write("use\x1b[2J npm");
    await tick();
    r.stdin.write("\r");
    await tick();
    expect(onAnswer).toHaveBeenCalledTimes(1);
    const answer = onAnswer.mock.calls[0]![0] as { feedback?: string };
    expect(answer.feedback).not.toContain("\x1b");
  });

  test("edit prompts preview the change", () => {
    const frame = render(
      <PermissionDialog
        prompt={{ toolName: "Edit", kind: "edit", summary: "a.ts", input: { file_path: "a.ts", old_string: "one", new_string: "two" } }}
        onAnswer={() => {}}
      />,
    ).lastFrame()!;
    expect(frame).toContain("Edit file");
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

  test("a carriage return in pasted text becomes a newline", async () => {
    const r = render(<PromptInput onSubmit={() => {}} history={[]} cwd="/" />);
    await tick();
    r.stdin.write("a\rb");
    await tick();
    expect(r.lastFrame()).toContain("a");
    expect(r.lastFrame()).not.toContain("ab");
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

describe("terminal safety", () => {
  const evil = "x\x1b]0;PWNED\x07y\x1b[2Jz";
  const clean = (frame: string) => {
    expect(frame).not.toContain("\x1b]");
    expect(frame).not.toContain("[2J");
    expect(frame).not.toContain("PWNED");
  };

  test("tool summaries, notices and permission summaries drop control sequences", () => {
    clean(render(<ToolRow item={{ id: "s1", kind: "tool", toolUseId: "t", name: "Bash", summary: evil, status: "running" }} />).lastFrame()!);
    clean(render(<TranscriptRow item={{ id: "s2", kind: "notice", level: "info", text: evil }} />).lastFrame()!);
    clean(render(<PermissionDialog prompt={{ toolName: "Bash", kind: "exec", summary: evil, input: { command: evil } }} onAnswer={() => {}} />).lastFrame()!);
  });

  test("the sanitized text still shows", () => {
    expect(render(<TranscriptRow item={{ id: "s3", kind: "notice", level: "info", text: evil }} />).lastFrame()).toContain("xyz");
  });
});

describe("SessionPicker titles", () => {
  test("whitespace collapses and long titles truncate", () => {
    const title = `fix\n\n   the   thing ${"x".repeat(100)}`;
    const frame = render(<SessionPicker sessions={[{ id: "a", title, updatedAt: new Date(), messageCount: 1 }]} onPick={() => {}} onCancel={() => {}} />).lastFrame()!;
    expect(frame).toContain("fix the thing x");
    expect(frame).toContain("…");
    expect(frame).not.toContain("x".repeat(61));
  });
});

describe("DiffView", () => {
  test("content lines that look like file headers are shown", () => {
    const display = makeDiff("/w/q.sql", "-- old sql\nkeep\n++i;\n", "keep\n+j;\n");
    const frame = render(<DiffView patch={display.patch} />).lastFrame()!;
    expect(frame).toContain("--- old sql");
    expect(frame).toContain("-++i;");
    expect(frame).toContain("++j;");
    expect(frame).not.toContain("/w/q.sql");
  });
});

describe("TranscriptRow live text", () => {
  const long = Array.from({ length: 100 }, (_, i) => `row ${i + 1}`).join("\n");
  const item = { id: "a1", kind: "assistant" as const, text: long };

  test("live text is clipped to its last 30 lines with an earlier-lines marker", () => {
    const frame = render(<TranscriptRow item={item} live />).lastFrame()!;
    expect(frame).toContain("70 earlier lines");
    expect(frame).toContain("row 100");
    expect(frame).toContain("row 71");
    expect(frame).not.toContain("row 70\n");
    expect(frame.split("\n").length).toBeLessThanOrEqual(33);
  });

  test("short live text has no marker", () => {
    const frame = render(<TranscriptRow item={{ ...item, text: "a\nb" }} live />).lastFrame()!;
    expect(frame).not.toContain("earlier lines");
  });

  test("finished text renders in full", () => {
    const frame = render(<TranscriptRow item={item} />).lastFrame()!;
    expect(frame).toContain("row 1");
    expect(frame).toContain("row 50");
    expect(frame).not.toContain("earlier lines");
  });
});

describe("TodoList", () => {
  test("shows an icon per status and the active form for the task in progress", () => {
    const frame = render(
      <TodoList
        todos={[
          { content: "write tests", status: "completed" },
          { content: "fix the bug", activeForm: "Fixing the bug", status: "in_progress" },
          { content: "ship it", status: "pending" },
        ]}
      />,
    ).lastFrame()!;
    expect(frame).toContain("✔ write tests");
    expect(frame).toContain("◼ Fixing the bug");
    expect(frame).toContain("◻ ship it");
  });
});

test("the header keeps the end of a long path", async () => {
  const { fitPath } = await import("./BrandHeader");
  expect(fitPath("/short", 20)).toBe("/short");
  expect(fitPath("/a/very/long/path/to/project", 12)).toBe("…/to/project");
});
