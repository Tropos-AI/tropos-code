import { describe, expect, test } from "bun:test";
import { BOT_COMMANDS, callbackData, HELP_TEXT, learnedText, parseCallbackData, permissionKeyboard, permissionText, permissionView, renderToolBatch, redactSecrets, splitMessage, statusText, taskSummaryText } from "./render";

describe("splitMessage", () => {
  test("short text is one part", () => {
    expect(splitMessage("hello")).toEqual(["hello"]);
  });
  test("splits at line boundaries within the limit and loses nothing", () => {
    const text = Array.from({ length: 300 }, (_, i) => `line number ${i} with some padding text`).join("\n");
    const parts = splitMessage(text);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(4096);
    expect(parts.join("\n")).toBe(text);
  });
  test("splits a run without whitespace by hard cut", () => {
    const parts = splitMessage("x".repeat(10_000));
    expect(parts.map((p) => p.length)).toEqual([4096, 4096, 1808]);
  });
  test("prefers word boundaries", () => {
    const parts = splitMessage("word ".repeat(2000));
    for (const p of parts) expect(p.endsWith("word")).toBe(true);
  });
});

describe("render", () => {
  test("tool batch: one line per tool, marks failures", () => {
    const out = renderToolBatch([
      { id: "1", name: "Read", summary: "src/a.ts" },
      { id: "2", name: "Bash", summary: "ls\n-la", status: "error" },
    ]);
    expect(out.split("\n")).toEqual(["• Read: src/a.ts", "• Bash: ls -la (failed)"]);
  });
  test("keyboard has exactly Approve and Deny with compact callback data", () => {
    const rows = permissionKeyboard(123456).inline_keyboard;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.map((b) => b.text)).toEqual(["Approve", "Deny"]);
    for (const b of rows[0]!) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
    expect(parseCallbackData(callbackData(5, true))).toEqual({ id: 5, approve: true });
    expect(parseCallbackData("a:5:always")).toBeUndefined();
    expect(parseCallbackData("garbage")).toBeUndefined();
  });
  test("permission text names the tool and fits in a message", () => {
    const t = permissionText({ toolName: "Bash", kind: "exec", summary: "rm -rf x", input: {}, preview: { header: "h", text: "y".repeat(9000) } });
    expect(t).toContain("Bash");
    expect(t.length).toBeLessThanOrEqual(4096);
  });
  test("status", () => {
    expect(statusText({ model: "m", mode: "default", busy: false, turns: 1, totalCostUsd: 0.5 } as never)).toContain("$0.5000");
  });
});

describe("permissionView", () => {
  const bash = (summary: string, extra: object = {}) => ({ toolName: "Bash", kind: "exec" as const, summary, input: {}, ...extra });
  test("a short request is complete", () => {
    expect(permissionView(bash("ls -la"))).toEqual({ text: "Permission needed: Bash\nls -la", complete: true });
  });
  test("a command, reason, header or body that had to be cut is not complete", () => {
    expect(permissionView(bash("x".repeat(501))).complete).toBe(false);
    expect(permissionView(bash("ls", { reason: "y".repeat(301) })).complete).toBe(false);
    expect(permissionView(bash("ls", { preview: { header: "a.ts", text: "z".repeat(1501) } })).complete).toBe(false);
    expect(permissionView(bash("ls", { preview: { header: "h".repeat(201), text: "ok" } })).complete).toBe(false);
  });
  test("a body that fits is complete", () => {
    expect(permissionView(bash("Write", { preview: { header: "a.ts", text: "const a = 1;" } })).complete).toBe(true);
  });
});

describe("learnedText", () => {
  const item = (n: number) => ({ key: `k${n}`, label: `note: fact ${n}`, hint: "saved while we talked", aside: "2026-10-16 09:00" });

  test("shows up to 10 items and the undo hint, or the panel's empty text", () => {
    const panel = { title: "Learned", sections: [{ items: Array.from({ length: 12 }, (_, i) => item(i)) }], empty: "Nothing learned yet." };
    const lines = learnedText(panel).split("\n");
    expect(lines).toHaveLength(11);
    expect(lines[0]).toBe("• note: fact 0 (saved while we talked, 2026-10-16 09:00)");
    expect(lines[9]).toBe("• note: fact 9 (saved while we talked, 2026-10-16 09:00)");
    expect(lines[10]).toBe("Send /learned undo to take back the newest.");
    expect(learnedText(panel, 2).split("\n")).toHaveLength(3);
    expect(learnedText({ title: "Learned", sections: [], empty: "Nothing learned yet." })).toBe("Nothing learned yet.");
  });
});

describe("help", () => {
  test("lists /learned and the skill and command shortcut, and the menu has /learned", () => {
    expect(HELP_TEXT).toContain("/learned  what I saved; /learned undo takes back the newest");
    expect(HELP_TEXT).toContain("/login  a code to log a browser in to the dashboard (owner, private chat)");
    expect(HELP_TEXT).toContain("/<name>  run one of your skills or commands");
    expect(BOT_COMMANDS).toContainEqual({ command: "learned", description: "What I learned, with undo" });
    expect(HELP_TEXT).toContain("/autonomy  show the autonomy level, or lower it");
    expect(BOT_COMMANDS).toContainEqual({ command: "login", description: "log a browser in to the dashboard" });
    expect(BOT_COMMANDS).toContainEqual({ command: "autonomy", description: "Show or lower the autonomy level" });
  });
});

describe("taskSummaryText", () => {
  test("lists changed files and commands, capped", () => {
    expect(taskSummaryText({ files: [], commands: [] })).toBeUndefined();
    expect(taskSummaryText({ files: ["src/a.ts"], commands: ["bun test", "git status"] })).toBe("Changed: src/a.ts\nRan: bun test · git status");
    expect(taskSummaryText({ files: Array.from({ length: 12 }, (_, i) => `f${i}`), commands: [] })).toEndWith(" and 2 more");
    expect(taskSummaryText({ files: [], commands: Array.from({ length: 10 }, (_, i) => `c${i}`) })).toEndWith(" and 2 more");
    expect(taskSummaryText({ files: ["a.ts"], commands: ["x\n".repeat(60)] })!.split("\n")[1]!.length).toBeLessThanOrEqual(5 + 80);
  });
});

describe("redactSecrets", () => {
  const R = "‹redacted›";
  const cases: [string, string][] = [
    ["curl -H 'Authorization: Bearer abc.def' x", `curl -H 'Authorization: Bearer ${R}' x`],
    ["curl -H 'Authorization: Basic dXNlcjpwdw==' x", `curl -H 'Authorization: Basic ${R}' x`],
    ["API_KEY=sk123 bun run x", `API_KEY=${R} bun run x`],
    ["GITHUB_TOKEN='a b' make", `GITHUB_TOKEN=${R} make`],
    ["DB_PASSWORD=hunter2", `DB_PASSWORD=${R}`],
    ["git clone https://user:pw@github.com/a/b", `git clone https://${R}@github.com/a/b`],
    ["echo " + "a".repeat(32), `echo ${R}`],
    ["bun test src/foo.test.ts --bail", "bun test src/foo.test.ts --bail"],
    ["echo " + "a".repeat(31), "echo " + "a".repeat(31)],
  ];
  for (const [input, want] of cases) test(input.slice(0, 40), () => expect(redactSecrets(input)).toBe(want));

  test("is applied to tool lines and the summary", () => {
    expect(renderToolBatch([{ id: "1", name: "Bash", summary: "TOKEN=abc curl x" }])).toBe(`• Bash: TOKEN=${R} curl x`);
    expect(taskSummaryText({ files: [], commands: ["TOKEN=abc curl x"] })).toBe(`Ran: TOKEN=${R} curl x`);
  });
  test("summary bounds file paths, flattening newlines", () => {
    const out = taskSummaryText({ files: ["a/" + "b".repeat(300), "x\ny.ts"], commands: [] })!;
    expect(out).not.toContain("\n" + "y");
    expect(out.split(", ")[0]!.length).toBeLessThanOrEqual(9 + 100);
    expect(out).toContain("x y.ts");
  });
  test("extra counts add to 'and N more'", () => {
    expect(taskSummaryText({ files: ["a"], commands: [], moreFiles: 5 })).toBe("Changed: a and 5 more");
  });
});
