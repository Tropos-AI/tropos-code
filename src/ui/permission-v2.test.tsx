// src/ui/permission-v2.test.tsx — the Pane-styled permission prompt (TUI v2).
import { describe, expect, mock, test } from "bun:test";
import { render } from "ink-testing-library";
import type { PermissionPrompt } from "../agent/events";
import { ANSWER_GRACE_MS, PermissionDialog, permissionTitle } from "./PermissionDialog";
import { DARK } from "./theme";
import { settle } from "../../test/helpers/wait";

const tick = () => settle(30);
const armed = () => Bun.sleep(ANSWER_GRACE_MS + 60);
const TAB = "\t";
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "\r";
const ESC = "\x1b";
const BACKSPACE = "\x7f";

const bash: PermissionPrompt = { toolName: "Bash", kind: "exec", summary: "bun test", input: { command: "bun test" }, suggestion: "Bash(bun test:*)" };
const edit: PermissionPrompt = { toolName: "Edit", kind: "edit", summary: "a.ts", input: { file_path: "a.ts", old_string: "one", new_string: "two" } };

/** Hex color as the 24-bit background escape Ink emits (when colors are on). */
const bg = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return `\x1b[48;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
};

describe("permissionTitle", () => {
  test("names the action by tool", () => {
    expect(permissionTitle(bash)).toBe("Bash command");
    expect(permissionTitle(edit)).toBe("Edit file");
    expect(permissionTitle({ ...edit, toolName: "Write" })).toBe("Write file");
    expect(permissionTitle({ ...edit, toolName: "Write" }, true)).toBe("Create file");
    expect(permissionTitle({ ...edit, toolName: "NotebookEdit" })).toBe("Edit file");
    expect(permissionTitle({ toolName: "WebFetch", kind: "net", summary: "https://x.test", input: {} })).toBe("Fetch");
    expect(permissionTitle({ toolName: "Read", kind: "read", summary: "/etc/hosts", input: {} })).toBe("Read outside the project");
    expect(permissionTitle({ toolName: "mcp__gh__create‮", kind: "meta", summary: "x", input: {} })).toBe("Use mcp__gh__create⟨U+202E⟩");
  });
});

describe("PermissionDialog v2", () => {
  test("a tool's preview shows the full text it will write, under its header", () => {
    const prompt: PermissionPrompt = {
      toolName: "AgentManage",
      kind: "edit",
      summary: "create 🔬 george",
      input: {},
      preview: { header: "/h/.tropos/agents/george.md · may use every tool", text: "---\nname: george\n---\n\nYou research. Ignore\u202e nothing." },
    };
    const frame = render(<PermissionDialog prompt={prompt} onAnswer={() => {}} />).lastFrame()!;
    expect(frame).toContain("Change an agent");
    expect(frame).toContain("/h/.tropos/agents/george.md · may use every tool");
    expect(frame).toContain("You research.");
    // Hidden characters in the text are made visible, as for any preview.
    expect(frame).toContain("⟨U+202E⟩");
  });

  test("Pane layout: title, preview, question, options, reason and footer", () => {
    const frame = render(<PermissionDialog prompt={{ ...bash, reason: "not in the allow list" }} onAnswer={() => {}} />).lastFrame()!;
    expect(frame).toContain("─────");
    expect(frame).toContain("Bash command");
    expect(frame).toContain("│ bun test");
    expect(frame).toContain("Do you want to proceed?");
    expect(frame).toContain("❯ 1. Yes");
    expect(frame).toContain("  2. Yes, and don't ask again for Bash(bun test:*)");
    expect(frame).toContain("  3. No, and tell Tropos what to do differently");
    expect(frame).toContain("Why: not in the allow list");
    expect(frame).toContain("Esc to cancel · Tab to amend");
    expect(frame.indexOf("bun test")).toBeLessThan(frame.indexOf("Do you want to proceed?"));
  });

  test("the cursor follows ↑/↓ and wraps", async () => {
    const onAnswer = mock();
    const r = render(<PermissionDialog prompt={bash} onAnswer={onAnswer} />);
    await armed();
    r.stdin.write(UP);
    await tick();
    expect(r.lastFrame()).toContain("❯ 3. No, and tell Tropos");
    r.stdin.write(DOWN);
    await tick();
    expect(r.lastFrame()).toContain("❯ 1. Yes");
  });

  test("tab on any option opens the feedback line and sends a decline with feedback", async () => {
    const onAnswer = mock();
    const r = render(<PermissionDialog prompt={bash} onAnswer={onAnswer} />);
    await armed();
    r.stdin.write(TAB);
    await tick();
    expect(r.lastFrame()).toContain("Tell Tropos what to do differently:");
    expect(r.lastFrame()).toContain("Enter to send · Esc to cancel");
    expect(r.lastFrame()).not.toContain("❯ 1. Yes");
    r.stdin.write("use npmx");
    await tick();
    r.stdin.write(BACKSPACE);
    await tick();
    r.stdin.write(TAB);
    await tick();
    r.stdin.write(ENTER);
    await tick();
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith({ kind: "deny", feedback: "use npm" });
  });

  test("tab on a highlighted Yes still amends, never allows", async () => {
    const onAnswer = mock();
    const r = render(<PermissionDialog prompt={bash} onAnswer={onAnswer} />);
    await armed();
    r.stdin.write(DOWN);
    await tick();
    r.stdin.write(TAB);
    await tick();
    r.stdin.write(ENTER);
    await tick();
    expect(onAnswer).toHaveBeenCalledWith({ kind: "deny" });
  });

  test("esc in the feedback line declines", async () => {
    const onAnswer = mock();
    const r = render(<PermissionDialog prompt={bash} onAnswer={onAnswer} />);
    await armed();
    r.stdin.write("3");
    await tick();
    r.stdin.write("nope");
    await tick();
    r.stdin.write(ESC);
    await tick();
    expect(onAnswer).toHaveBeenCalledWith({ kind: "deny" });
  });

  test("tab is ignored during the grace period", async () => {
    const onAnswer = mock();
    const r = render(<PermissionDialog prompt={bash} onAnswer={onAnswer} />);
    await tick();
    r.stdin.write(TAB);
    await tick();
    expect(r.lastFrame()).not.toContain("Tell Tropos what to do differently:");
  });

  test("without a rule suggestion the decline option is 2", async () => {
    const onAnswer = mock();
    const r = render(<PermissionDialog prompt={{ ...bash, suggestion: undefined }} onAnswer={onAnswer} />);
    expect(r.lastFrame()).toContain("2. No, and tell Tropos what to do differently");
    expect(r.lastFrame()).not.toContain("don't ask again");
    await armed();
    r.stdin.write("2");
    await tick();
    expect(r.lastFrame()).toContain("Tell Tropos what to do differently:");
  });

  test("a long command is never offered don't-ask-again", () => {
    const command = Array.from({ length: 25 }, (_, i) => `echo line${i}`).join("\n");
    const frame = render(<PermissionDialog prompt={{ ...bash, summary: command, input: { command } }} onAnswer={() => {}} />).lastFrame()!;
    expect(frame).not.toContain("don't ask again");
    expect(frame).toContain("… 5 more lines hidden — the full command will run");
  });

  test("preview lines that look like options stay behind the gutter", () => {
    const frame = render(<PermissionDialog prompt={{ ...bash, summary: "echo hi\n❯ 1. Yes" }} onAnswer={() => {}} />).lastFrame()!;
    expect(frame).toContain("│ ❯ 1. Yes");
    expect(frame.match(/^\s*❯ 1\. Yes$/gm)?.length).toBe(1);
  });

  test("hidden characters are shown and control sequences dropped", () => {
    const frame = render(<PermissionDialog prompt={{ ...bash, summary: "ls ‮txt​\x1b]0;PWNED\x07", reason: "why⁦" }} onAnswer={() => {}} />).lastFrame()!;
    expect(frame).toContain("⟨U+202E⟩");
    expect(frame).toContain("⟨U+200B⟩");
    expect(frame).toContain("why⟨U+2066⟩");
    expect(frame).not.toContain("PWNED");
  });

  test("Edit shows the path and the diff with line backgrounds", () => {
    const frame = render(<PermissionDialog prompt={edit} onAnswer={() => {}} />).lastFrame()!;
    expect(frame).toContain("Edit file");
    expect(frame).toContain("a.ts");
    expect(frame).toContain("-one");
    expect(frame).toContain("+two");
    if (frame.includes("\x1b[")) {
      expect(frame).toContain(bg(DARK.diffAddBg));
      expect(frame).toContain(bg(DARK.diffRemoveBg));
    }
  });

  test("Write titles follow newFile and show the content", () => {
    const write: PermissionPrompt = { toolName: "Write", kind: "edit", summary: "new.ts", input: { file_path: "new.ts", content: "export {};" } };
    expect(render(<PermissionDialog prompt={write} onAnswer={() => {}} newFile />).lastFrame()).toContain("Create file");
    const frame = render(<PermissionDialog prompt={write} onAnswer={() => {}} />).lastFrame()!;
    expect(frame).toContain("Write file");
    expect(frame).toContain("│ export {};");
  });

  test("other tools say Use <tool> and show their summary", () => {
    const frame = render(<PermissionDialog prompt={{ toolName: "mcp__gh__create_issue", kind: "meta", summary: "title: bug", input: {} }} onAnswer={() => {}} />).lastFrame()!;
    expect(frame).toContain("Use mcp__gh__create_issue");
    expect(frame).toContain("│ title: bug");
  });
});
