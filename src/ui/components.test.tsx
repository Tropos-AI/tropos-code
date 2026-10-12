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
import { TranscriptRow } from "./TranscriptRow";

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
