// src/ui/panels.test.tsx
import { describe, expect, mock, test } from "bun:test";
import { render } from "ink-testing-library";
import { COMMANDS } from "./commands";
import { CostPanel, formatContext, formatCost } from "./CostPanel";
import { commandKind, HELP_SHORTCUTS, HelpPanel } from "./HelpPanel";
import { DETAIL_LINES, ListPanel } from "./ListPanel";
import type { PanelData } from "./runtime";
import { SessionPicker } from "./SessionPicker";

const tick = () => Bun.sleep(30);
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";
const TAB = "\t";
const SHIFT_TAB = "\x1b[Z";
const PAGE_DOWN = "\x1b[6~";
const PAGE_UP = "\x1b[5~";
const ENTER = "\r";
const ESC = "\x1b";

describe("HelpPanel", () => {
  const custom = [
    { name: "review", description: "Review a branch", argumentHint: "<branch>" },
    { name: "deploy", description: "(skill) Use when deploying" },
    { name: "lint", description: "Run the linter", kind: "skill" as const },
  ];

  test("opens on General with the version in the title", () => {
    const frame = render(<HelpPanel version="0.2.0" commands={custom} onClose={() => {}} />).lastFrame()!;
    expect(frame).toContain("Tropos Code v0.2.0");
    for (const tab of ["General", "Commands", "Custom", "Shortcuts"]) expect(frame).toContain(tab);
    expect(frame).toContain("coding agent");
    expect(frame).toContain("@path");
    expect(frame).toContain("shift+tab");
  });

  test("→ and tab move through the tabs, ← and shift+tab move back, and they wrap", async () => {
    const r = render(<HelpPanel version="0.2.0" commands={custom} onClose={() => {}} height={40} />);
    await tick();
    r.stdin.write(RIGHT);
    await tick();
    expect(r.lastFrame()).toContain("/help");
    expect(r.lastFrame()).toContain("Show commands and shortcuts");
    r.stdin.write(TAB);
    await tick();
    expect(r.lastFrame()).toContain("/review <branch>");
    r.stdin.write(TAB);
    await tick();
    expect(r.lastFrame()).toContain("ctrl+o");
    r.stdin.write(RIGHT);
    await tick();
    expect(r.lastFrame()).toContain("coding agent");
    r.stdin.write(LEFT);
    await tick();
    expect(r.lastFrame()).toContain("ctrl+o");
    r.stdin.write(SHIFT_TAB);
    await tick();
    expect(r.lastFrame()).toContain("/review");
  });

  test("Commands lists every built-in with aligned descriptions", async () => {
    const r = render(<HelpPanel version="1" commands={[]} onClose={() => {}} height={40} />);
    await tick();
    r.stdin.write(RIGHT);
    await tick();
    const lines = r.lastFrame()!.split("\n");
    for (const c of COMMANDS) expect(r.lastFrame()).toContain(`/${c.name}`);
    const columns = COMMANDS.map((c) => {
      const line = lines.find((l) => l.includes(`/${c.name} `) && l.includes(c.description))!;
      return line.indexOf(c.description);
    });
    expect(new Set(columns).size).toBe(1);
  });

  test("Custom marks skills and strips the (skill) prefix; empty says how to add some", async () => {
    const r = render(<HelpPanel version="1" commands={custom} onClose={() => {}} height={40} />);
    await tick();
    r.stdin.write(RIGHT);
    await tick();
    r.stdin.write(RIGHT);
    await tick();
    const frame = r.lastFrame()!;
    expect(frame).toContain("Use when deploying  [skill]");
    expect(frame).not.toContain("(skill)");
    expect(frame).toContain("Run the linter  [skill]");
    expect(frame).not.toContain("Review a branch  [skill]");
    const empty = render(<HelpPanel version="1" commands={[]} onClose={() => {}} />);
    await tick();
    empty.stdin.write(LEFT);
    await tick();
    empty.stdin.write(LEFT);
    await tick();
    expect(empty.lastFrame()).toContain("No custom commands or skills yet.");
  });

  test("commandKind prefers the explicit kind", () => {
    expect(commandKind({ name: "a", description: "(skill) x" })).toBe("skill");
    expect(commandKind({ name: "a", description: "x" })).toBe("custom");
    expect(commandKind({ name: "a", description: "(skill) x", kind: "custom" })).toBe("custom");
  });

  test("long tabs scroll with ↑/↓ and page keys, with more-markers", async () => {
    const r = render(<HelpPanel version="1" commands={[]} onClose={() => {}} height={5} />);
    await tick();
    r.stdin.write(RIGHT);
    await tick();
    expect(r.lastFrame()).toContain("/help");
    expect(r.lastFrame()).toContain(`↓ ${COMMANDS.length - 5} more`);
    r.stdin.write(DOWN);
    await tick();
    expect(r.lastFrame()).toContain("↑ 1 more");
    expect(r.lastFrame()).not.toContain("/help ");
    r.stdin.write(PAGE_DOWN);
    await tick();
    for (let i = 0; i < 3; i++) {
      r.stdin.write(PAGE_DOWN);
      await tick();
    }
    expect(r.lastFrame()).toContain("/exit");
    expect(r.lastFrame()).not.toMatch(/↓ \d+ more/);
    r.stdin.write(PAGE_UP);
    await tick();
    for (let i = 0; i < 3; i++) {
      r.stdin.write(PAGE_UP);
      await tick();
    }
    r.stdin.write(UP);
    await tick();
    expect(r.lastFrame()).toContain("/help");
    // Switching tabs scrolls back to the top.
    r.stdin.write(DOWN);
    await tick();
    r.stdin.write(RIGHT);
    await tick();
    r.stdin.write(RIGHT);
    await tick();
    expect(r.lastFrame()).toContain(HELP_SHORTCUTS[0]![0]);
  });

  test("esc closes; custom text is sanitized", async () => {
    const onClose = mock();
    const r = render(<HelpPanel version="1" commands={[{ name: "x", description: "a\x1b[2Jb\nc" }]} onClose={onClose} />);
    await tick();
    r.stdin.write(LEFT);
    await tick();
    r.stdin.write(LEFT);
    await tick();
    expect(r.lastFrame()).toContain("ab c");
    expect(r.lastFrame()).not.toContain("\x1b[2J");
    r.stdin.write(ESC);
    await tick();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("ListPanel", () => {
  const data: PanelData = {
    title: "MCP servers",
    subtitle: "from .tropos/mcp.json",
    sections: [
      {
        title: "Project",
        items: [
          { key: "github", label: "github", hint: "12 tools", status: "ok", detail: ["create_issue", "list_prs"] },
          { key: "db", label: "db", hint: "failed to start", status: "error", aside: "stdio", detail: Array.from({ length: 9 }, (_, i) => `line ${i}`) },
        ],
      },
      {
        title: "User",
        items: [
          { key: "github", label: "slow", status: "warn" },
          { key: "off", label: "disabled-one", status: "off", detail: ["evil\x1b]0;PWNED\x07 text"] },
        ],
      },
    ],
  };

  test("shows sections, status marks, hints and the selected item's detail", () => {
    const frame = render(<ListPanel data={data} onClose={() => {}} />).lastFrame()!;
    expect(frame).toContain("MCP servers");
    expect(frame).toContain("from .tropos/mcp.json");
    expect(frame).toContain("4 items");
    expect(frame).toContain("Project");
    expect(frame).toContain("User");
    expect(frame).toContain("❯ ✔ github  12 tools");
    expect(frame).toContain("✘ db  failed to start  · stdio");
    expect(frame).toContain("△ slow");
    expect(frame).toContain("◯ disabled-one");
    expect(frame).toContain("create_issue");
    expect(frame).not.toContain("line 0");
  });

  test("↑/↓ and page keys move; detail is capped and sanitized; esc and enter close", async () => {
    const onClose = mock();
    const r = render(<ListPanel data={data} onClose={onClose} />);
    await tick();
    r.stdin.write(DOWN);
    await tick();
    expect(r.lastFrame()).toContain(`line ${DETAIL_LINES - 1}`);
    expect(r.lastFrame()).not.toContain(`line ${DETAIL_LINES}`);
    expect(r.lastFrame()).toContain(`… +${9 - DETAIL_LINES} lines`);
    r.stdin.write(PAGE_DOWN);
    await tick();
    expect(r.lastFrame()).toContain("❯ ◯ disabled-one");
    expect(r.lastFrame()).toContain("evil text");
    expect(r.lastFrame()).not.toContain("PWNED");
    r.stdin.write(DOWN);
    await tick();
    expect(r.lastFrame()).toContain("❯ ◯ disabled-one");
    r.stdin.write(PAGE_UP);
    await tick();
    r.stdin.write(UP);
    await tick();
    expect(r.lastFrame()).toContain("❯ ✔ github");
    r.stdin.write(ESC);
    await tick();
    r.stdin.write(ENTER);
    await tick();
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  test("shows the empty text when there are no items", () => {
    const frame = render(<ListPanel data={{ title: "Hooks", sections: [{ items: [] }], empty: "No hooks. Add them in settings.json." }} onClose={() => {}} />).lastFrame()!;
    expect(frame).toContain("Hooks");
    expect(frame).toContain("No hooks. Add them in settings.json.");
    expect(frame).not.toContain("items");
    expect(render(<ListPanel data={{ title: "X", sections: [] }} onClose={() => {}} />).lastFrame()).toContain("Nothing here.");
  });

  test("a single item says 1 item", () => {
    const frame = render(<ListPanel data={{ title: "Skills", sections: [{ items: [{ key: "a", label: "alpha" }] }] }} onClose={() => {}} />).lastFrame()!;
    expect(frame).toContain("1 item");
    expect(frame).toContain("❯ alpha");
  });
});

describe("CostPanel", () => {
  test("aligned rows with model, cost, context and turns; esc and enter close", async () => {
    const onClose = mock();
    const r = render(<CostPanel model="deepseek/deepseek-chat" costUsd={0.4213} contextTokens={12345} contextPct={12} turns={3} onClose={onClose} />);
    const frame = r.lastFrame()!;
    expect(frame).toContain("Session cost");
    expect(frame).toContain("deepseek/deepseek-chat");
    expect(frame).toContain("$0.42");
    expect(frame).toContain("12,345 tokens (12% of the window)");
    expect(frame).toContain("Turns");
    const lines = frame.split("\n");
    const cols = [
      ["Model", "deepseek/deepseek-chat"],
      ["Cost", "$0.42"],
      ["Context", "12,345"],
      ["Turns", "3"],
    ].map(([label, v]) => lines.find((l) => l.includes(`${label} `))!.indexOf(v!));
    expect(new Set(cols).size).toBe(1);
    await tick();
    r.stdin.write(ESC);
    await tick();
    r.stdin.write(ENTER);
    await tick();
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  test("unknown cost and missing optional fields", () => {
    const frame = render(<CostPanel model="m" costUsd={undefined} contextTokens={0} onClose={() => {}} />).lastFrame()!;
    expect(frame).toContain("unknown");
    expect(frame).not.toContain("Turns");
    expect(frame).toContain("0 tokens");
  });

  test("formatters", () => {
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(0.0042)).toBe("$0.0042");
    expect(formatCost(1.5)).toBe("$1.50");
    expect(formatContext(1000)).toBe("1,000 tokens");
    expect(formatContext(1000, 1)).toBe("1,000 tokens (1% of the window)");
  });
});

describe("SessionPicker (Pane)", () => {
  const sessions = Array.from({ length: 14 }, (_, i) => ({ id: `s${i}`, title: `session ${i}`, updatedAt: new Date(), messageCount: i }));

  test("❯ cursor, count, scroll markers", async () => {
    const r = render(<SessionPicker sessions={sessions} onPick={() => {}} onCancel={() => {}} />);
    expect(r.lastFrame()).toContain("Resume a session");
    expect(r.lastFrame()).toContain("14 sessions");
    expect(r.lastFrame()).toContain("❯ session 0");
    expect(r.lastFrame()).toContain("↓ 4 more");
    await tick();
    for (let i = 0; i < 13; i++) r.stdin.write(DOWN);
    await tick();
    expect(r.lastFrame()).toContain("❯ session 13");
    expect(r.lastFrame()).toContain("↑ 4 more");
  });

  test("an empty list says so", () => {
    expect(render(<SessionPicker sessions={[]} onPick={() => {}} onCancel={() => {}} />).lastFrame()).toContain("No saved sessions");
  });
});
