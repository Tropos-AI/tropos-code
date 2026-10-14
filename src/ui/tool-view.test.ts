// src/ui/tool-view.test.ts
import { describe, expect, test } from "bun:test";
import { makeDiff } from "../tools/diff";
import type { ToolOutput } from "../tools/types";
import {
  contentText,
  displayPath,
  dotGlyph,
  formatDuration,
  parseMcpName,
  toolView,
  turnDoneText,
  type Line,
  type ResultView,
  type ToolViewInput,
} from "./tool-view";

const CWD = "/work/app";

function item(name: string, input: unknown, output?: ToolOutput, status: ToolViewInput["status"] = "done", extra: Partial<ToolViewInput> = {}): ToolViewInput {
  return { name, input, status, summary: "", ...(output ? { output } : {}), ...extra };
}

const text = (line: Line) => line.map((s) => s.text).join("");
function lines(view: ResultView): string[] {
  if (view.kind !== "lines") throw new Error(`expected lines, got ${view.kind}`);
  return view.lines.map(text);
}

describe("helpers", () => {
  test("dot glyph depends on the platform", () => {
    expect(dotGlyph("darwin")).toBe("⏺");
    expect(dotGlyph("linux")).toBe("●");
    expect(dotGlyph("win32")).toBe("●");
    expect(["⏺", "●"]).toContain(dotGlyph());
  });

  test("paths inside the cwd become relative", () => {
    expect(displayPath("/work/app/src/a.ts", CWD)).toBe("src/a.ts");
    expect(displayPath("/work/app", CWD)).toBe(".");
    expect(displayPath("/work/other/a.ts", CWD)).toBe("/work/other/a.ts");
    expect(displayPath("/work/application/a.ts", CWD)).toBe("/work/application/a.ts");
    expect(displayPath("rel/a.ts", CWD)).toBe("rel/a.ts");
    expect(displayPath("/x/a.ts")).toBe("/x/a.ts");
  });

  test("content text joins text blocks", () => {
    expect(contentText(undefined)).toBe("");
    expect(contentText("hi")).toBe("hi");
    expect(
      contentText([
        { type: "text", text: "a" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "" } },
      ]),
    ).toBe("a\n[image]");
  });

  test("mcp names split at the first separator", () => {
    expect(parseMcpName("mcp__github__create_issue")).toEqual({ server: "github", tool: "create_issue" });
    expect(parseMcpName("mcp__srv__a__b")).toEqual({ server: "srv", tool: "a__b" });
    expect(parseMcpName("mcp__srv")).toBeUndefined();
    expect(parseMcpName("mcp____x")).toBeUndefined();
    expect(parseMcpName("mcp__srv__")).toBeUndefined();
    expect(parseMcpName("Read")).toBeUndefined();
  });

  test("durations and the deterministic turn verb", () => {
    expect(formatDuration(12)).toBe("12s");
    expect(formatDuration(65)).toBe("1m 5s");
    expect(formatDuration(3725)).toBe("1h 2m");
    expect(formatDuration(-3)).toBe("0s");
    expect(turnDoneText(10)).toBe("Worked for 10s");
    expect(turnDoneText(11)).toBe("Turned for 11s");
    expect(turnDoneText(12)).toBe("Pivoted for 12s");
    expect(turnDoneText(13)).toBe("Orbited for 13s");
    expect(turnDoneText(14)).toBe("Revolved for 14s");
    expect(turnDoneText(14.4)).toBe("Revolved for 14s");
  });
});

describe("headers", () => {
  const h = (name: string, input: unknown, summary = "") => {
    const v = toolView({ ...item(name, input), summary }, CWD);
    return { title: v.title, args: v.args, badge: v.badge };
  };

  test("file tools show relative paths; Edit is Update", () => {
    expect(h("Read", { file_path: "/work/app/src/a.ts" })).toEqual({ title: "Read", args: "src/a.ts", badge: undefined });
    expect(h("Edit", { file_path: "/work/app/b.ts" }).title).toBe("Update");
    expect(h("Edit", { file_path: "/work/app/b.ts" }).args).toBe("b.ts");
    expect(h("Write", { file_path: "/elsewhere/c.ts" }).args).toBe("/elsewhere/c.ts");
    // No input (an old item): the summary stands in.
    expect(h("Read", undefined, "/work/app/x.ts").args).toBe("x.ts");
  });

  test("Bash keeps at most two lines and 160 chars", () => {
    expect(h("Bash", { command: "ls -la" }).args).toBe("ls -la");
    expect(h("Bash", { command: "a\nb\nc" }).args).toBe("a\nb…");
    const long = h("Bash", { command: "x".repeat(300) }).args;
    expect(long.length).toBe(160);
    expect(long.endsWith("…")).toBe(true);
    expect(h("Bash", { command: "echo \x1b]0;pwn\x07hi" }).args).toBe("echo hi");
  });

  test("Glob and Grep are Search with pattern and path", () => {
    expect(h("Glob", { pattern: "**/*.ts" })).toMatchObject({ title: "Search", args: 'pattern: "**/*.ts"' });
    expect(h("Grep", { pattern: "foo", path: "/work/app/src" }).args).toBe('pattern: "foo", path: "src"');
    expect(h("Grep", undefined, "foo in src").args).toBe("foo in src");
  });

  test("Fetch, Skill, Todos, Memory, sessions, SkillManage, jobs", () => {
    expect(h("WebFetch", { url: "https://x.dev/a" })).toMatchObject({ title: "Fetch", args: "https://x.dev/a" });
    expect(h("Skill", { skill: "deploy" })).toMatchObject({ title: "Skill", args: "deploy" });
    expect(h("TodoWrite", { todos: [] })).toMatchObject({ title: "Update Todos", args: "" });
    expect(h("Memory", { action: "add", target: "user", content: "x" })).toMatchObject({ title: "Memory", args: "add user" });
    expect(h("Memory", {}, "add user: x").args).toBe("add user: x");
    expect(h("SessionSearch", { query: "auth bug" })).toMatchObject({ title: "Search sessions", args: '"auth bug"' });
    expect(h("SessionSearch", {}, '"q"').args).toBe('"q"');
    expect(h("SkillManage", { action: "create", name: "lint" })).toMatchObject({ title: "SkillManage", args: "create lint" });
    expect(h("SkillManage", {}, "delete x").args).toBe("delete x");
    expect(h("BashOutput", { job_id: "bash-1" })).toMatchObject({ title: "BashOutput", args: "bash-1" });
    expect(h("KillShell", { job_id: "bash-2" })).toMatchObject({ title: "KillShell", args: "bash-2" });
  });

  test("Agent shows the description with a type badge", () => {
    expect(h("Agent", { description: "Find callers", subagent_type: "explore", prompt: "p" })).toEqual({
      title: "Agent",
      args: "Find callers",
      badge: { text: "explore", agent: "explore" },
    });
    expect(h("Agent", { description: "x", prompt: "p" }).badge).toEqual({ text: "general-purpose", agent: "general-purpose" });
    expect(h("Agent", undefined, "explore: Find it").args).toBe("Find it");
  });

  test("MCP tools: server - tool (MCP) with cut values", () => {
    const v = h("mcp__github__create_issue", { title: "Bug", labels: ["a"], body: "y".repeat(100) });
    expect(v.title).toBe("github - create_issue (MCP)");
    expect(v.args.startsWith('title: "Bug", labels: ["a"], body: "yyyy')).toBe(true);
    expect(v.args).toContain("…");
    expect(v.args.length).toBeLessThan(80);
    expect(h("mcp__srv__ping", {}).args).toBe("");
  });

  test("unknown tools use their name and summary", () => {
    expect(h("Custom", { a: 1 }, "some  summary\nhere")).toMatchObject({ title: "Custom", args: "some summary here" });
  });
});

describe("results", () => {
  test("Bash: first three lines, then a more marker; verbose shows all", () => {
    const out = { content: "1\n2\n3\n4\n5", summary: "ok" };
    expect(lines(toolView(item("Bash", { command: "x" }, out), CWD).result)).toEqual(["1", "2", "3", "… +2 lines (ctrl+o to expand)"]);
    expect(lines(toolView(item("Bash", { command: "x" }, out), CWD, { verbose: true }).result)).toEqual(["1", "2", "3", "4", "5"]);
    expect(lines(toolView(item("Bash", { command: "x" }, { content: "1\n2\n3\n4" }), CWD).result).at(-1)).toBe("… +1 line (ctrl+o to expand)");
  });

  test("Bash: empty output and background jobs", () => {
    expect(lines(toolView(item("Bash", { command: "x" }, { content: "(no output)", summary: "ok" }), CWD).result)).toEqual(["(No output)"]);
    expect(lines(toolView(item("Bash", { command: "x" }, { content: "", summary: "ok" }), CWD).result)).toEqual(["(No output)"]);
    const bg = item("Bash", { command: "dev", run_in_background: true }, { content: "Started background job bash-1.", summary: "bash-1" });
    expect(lines(toolView(bg, CWD).result)).toEqual(["Running in background (bash-1)"]);
  });

  test("errors show in danger; interrupts are dim", () => {
    const err = toolView(item("Bash", { command: "x" }, { content: "boom\n[exit code 1]", isError: true, summary: "exit 1" }, "error"), CWD).result;
    expect(err).toEqual({ kind: "lines", lines: [[{ text: "boom", color: "danger" }], [{ text: "[exit code 1]", color: "danger" }]] });
    const interrupted = toolView(item("Bash", { command: "x" }, { content: "partial\n[interrupted by user]", isError: true }, "error"), CWD).result;
    expect(interrupted).toEqual({ kind: "lines", lines: [[{ text: "Interrupted", color: "muted" }]] });
    expect(lines(toolView(item("Read", {}, { content: "", isError: true }, "error"), CWD).result)).toEqual(["Error"]);
    expect(lines(toolView(item("Read", {}, undefined, "error"), CWD).result)).toEqual(["Error"]);
  });

  test("denied: Declined, the user's feedback, or the rule's reason", () => {
    const plain = toolView(item("Bash", {}, { content: "The user declined this action. Ask what they would like to do instead.", isError: true }, "denied"), CWD);
    expect(plain.result).toEqual({ kind: "lines", lines: [[{ text: "Declined", color: "warning" }]] });
    const fb = toolView(item("Bash", {}, { content: "The user declined this action and said: use pnpm", isError: true }, "denied"), CWD);
    expect(lines(fb.result)).toEqual(["use pnpm"]);
    const rule = toolView(item("Bash", {}, { content: "Denied by rule Bash(rm:*)\nmore", isError: true }, "denied"), CWD);
    expect(rule.result).toEqual({ kind: "lines", lines: [[{ text: "Denied by rule Bash(rm:*)", color: "warning" }]] });
    expect(lines(toolView(item("Bash", {}, undefined, "denied"), CWD).result)).toEqual(["Declined"]);
  });

  test("Read: Read N lines with the number bold", () => {
    const v = toolView(item("Read", { file_path: "/work/app/a.ts" }, { content: "     1\tx", summary: "84 lines" }), CWD).result;
    expect(v).toEqual({ kind: "lines", lines: [[{ text: "Read " }, { text: "84", bold: true }, { text: " lines" }]] });
    expect(lines(toolView(item("Read", {}, { content: "x", summary: "1 lines" }), CWD).result)).toEqual(["Read 1 line"]);
    expect(lines(toolView(item("Read", {}, { content: "", summary: "empty" }), CWD).result)).toEqual(["Read 0 lines"]);
    expect(lines(toolView(item("Read", {}, { content: "img", summary: "image, 12 KB" }), CWD).result)).toEqual(["Image, 12 KB"]);
    expect(lines(toolView(item("Read", {}, { content: "     1\ta\n     2\tb", summary: "2 lines" }), CWD, { verbose: true }).result)).toEqual([
      "Read 2 lines",
      "     1\ta",
      "     2\tb",
    ]);
  });

  test("Glob and Grep: Found N files / lines", () => {
    expect(lines(toolView(item("Glob", { pattern: "*" }, { content: "a\nb", summary: "2 files" }), CWD).result)).toEqual(["Found 2 files"]);
    expect(lines(toolView(item("Glob", { pattern: "*" }, { content: "No files matched.", summary: "0 files" }), CWD).result)).toEqual(["Found 0 files"]);
    expect(lines(toolView(item("Grep", { pattern: "x" }, { content: "a", summary: "1 result" }), CWD).result)).toEqual(["Found 1 file"]);
    expect(lines(toolView(item("Grep", { pattern: "x", output_mode: "content" }, { content: "a:1:x", summary: "3 results" }), CWD).result)).toEqual([
      "Found 3 lines",
    ]);
    expect(lines(toolView(item("Grep", { pattern: "x" }, { content: "No matches found.", summary: "0 matches" }), CWD).result)).toEqual(["Found 0 files"]);
    expect(lines(toolView(item("Glob", {}, { content: "?", summary: "weird" }), CWD).result)).toEqual(["Weird"]);
  });

  test("WebFetch: Received size (status)", () => {
    expect(lines(toolView(item("WebFetch", {}, { content: "x", summary: "12.3 KB · 200" }), CWD).result)).toEqual(["Received 12.3 KB (200)"]);
    expect(lines(toolView(item("WebFetch", {}, { content: "x", summary: "redirect · 301" }), CWD).result)).toEqual(["Redirected (301)"]);
    expect(lines(toolView(item("WebFetch", {}, { content: "x", summary: "odd" }), CWD).result)).toEqual(["Odd"]);
  });

  test("Agent: progress while running, Done (N tool uses) after", () => {
    const running = toolView(item("Agent", { description: "d" }, undefined, "running", { progress: "Read  src/x.ts", progressCount: 3 }), CWD).result;
    expect(running).toEqual({ kind: "agent-progress", progress: "Read src/x.ts", toolUses: 3 });
    expect(toolView(item("Agent", {}, undefined, "running"), CWD).result).toEqual({ kind: "agent-progress", toolUses: 0 });
    expect(lines(toolView(item("Agent", {}, { content: "report", summary: "4 tool uses" }), CWD).result)).toEqual(["Done (4 tool uses)"]);
    expect(lines(toolView(item("Agent", {}, { content: "report", summary: "1 tool use" }), CWD).result)).toEqual(["Done (1 tool use)"]);
    expect(lines(toolView(item("Agent", {}, { content: "report\nmore", summary: "1 tool use" }), CWD, { verbose: true }).result)).toEqual([
      "Done (1 tool use)",
      "report",
      "more",
    ]);
  });

  test("other running tools: progress, Running… for Bash, else nothing", () => {
    expect(lines(toolView(item("Custom", {}, undefined, "running", { progress: "50%" }), CWD).result)).toEqual(["50%"]);
    expect(lines(toolView(item("Bash", { command: "x" }, undefined, "running"), CWD).result)).toEqual(["Running…"]);
    expect(toolView(item("Read", {}, undefined, "running"), CWD).result).toEqual({ kind: "none" });
  });

  test("Edit: Added N lines, removed M lines, then the diff", () => {
    const diff = makeDiff("/work/app/a.ts", "a\nb\n", "a\nc\nd\n");
    const v = toolView(item("Edit", { file_path: "/work/app/a.ts" }, { content: "ok", display: diff, summary: "+2 −1" }), CWD).result;
    expect(v.kind).toBe("diff");
    if (v.kind !== "diff") return;
    expect(text(v.summary)).toBe("Added 2 lines, removed 1 line");
    expect(v.verbose).toBe(false);
    expect(v.patch).toContain("+c");
    const onlyRemoved = makeDiff("a", "a\nb\n", "a\n");
    const r = toolView(item("Edit", {}, { content: "ok", display: onlyRemoved, summary: "" }), CWD, { verbose: true }).result;
    expect(r.kind === "diff" && text(r.summary)).toBe("Removed 1 line");
    expect(r.kind === "diff" && r.verbose).toBe(true);
    const nothing = makeDiff("a", "a\n", "a\n");
    const n = toolView(item("Edit", {}, { content: "ok", display: nothing }), CWD).result;
    expect(n.kind === "diff" && text(n.summary)).toBe("Added 0 lines");
  });

  test("Write: a new file previews its first 10 lines; an overwrite is a diff", () => {
    const body = Array.from({ length: 13 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    const created = makeDiff("/work/app/new.ts", "", body);
    const v = toolView(item("Write", { file_path: "/work/app/new.ts" }, { content: "Created", display: created, summary: "created, 13 lines" }), CWD).result;
    expect(v.kind).toBe("write-preview");
    if (v.kind !== "write-preview") return;
    expect(text(v.summary)).toBe("Wrote 13 lines to new.ts");
    expect(v.lines).toHaveLength(10);
    expect(v.lines[0]).toBe("line 1");
    expect(v.more).toBe(3);
    const full = toolView(item("Write", {}, { content: "Created", display: created, summary: "created, 13 lines" }), CWD, { verbose: true }).result;
    expect(full.kind === "write-preview" && full.more).toBe(0);
    const over = makeDiff("/work/app/x.ts", "a\n", "b\n");
    expect(toolView(item("Write", {}, { content: "Overwrote", display: over, summary: "+1 −1" }), CWD).result.kind).toBe("diff");
  });

  test("TodoWrite: the list, from the display or the input", () => {
    const todos = [
      { content: "a", status: "completed" as const },
      { content: "b", status: "in_progress" as const, activeForm: "Doing b" },
    ];
    expect(toolView(item("TodoWrite", { todos }, { content: "ok", display: { kind: "todos", todos }, summary: "1/2 done" }), CWD).result).toEqual({
      kind: "todos",
      todos,
    });
    // A resumed session has the input but no output.
    expect(toolView(item("TodoWrite", { todos: [...todos, { bogus: true }] }), CWD).result).toEqual({ kind: "todos", todos });
    expect(toolView(item("TodoWrite", {}), CWD).result).toEqual({ kind: "none" });
  });

  test("summaries for the rest, capitalized; text displays when there is no summary", () => {
    expect(lines(toolView(item("Memory", {}, { content: "x", summary: "added to user profile" }), CWD).result)).toEqual(["Added to user profile"]);
    expect(lines(toolView(item("Skill", {}, { content: "x", summary: "loaded deploy" }), CWD).result)).toEqual(["Loaded deploy"]);
    expect(lines(toolView(item("SessionSearch", {}, { content: "x", summary: "3 sessions" }), CWD).result)).toEqual(["Found 3 sessions"]);
    expect(lines(toolView(item("SessionSearch", {}, { content: "x", summary: "no matches" }), CWD).result)).toEqual(["No matches"]);
    expect(lines(toolView(item("BashOutput", {}, { content: "x", summary: "running" }), CWD).result)).toEqual(["Running"]);
    expect(lines(toolView(item("Custom", {}, { content: "x", display: { kind: "text", text: "Deleted it" } }), CWD).result)).toEqual(["Deleted it"]);
  });

  test("MCP results without a summary preview the output; with none there is nothing", () => {
    expect(lines(toolView(item("mcp__s__t", {}, { content: "a\nb\nc\nd" }), CWD).result)).toEqual(["a", "b", "c", "… +1 line (ctrl+o to expand)"]);
    expect(lines(toolView(item("mcp__s__t", {}, { content: [{ type: "text", text: "hi" }] }), CWD).result)).toEqual(["hi"]);
    expect(toolView(item("mcp__s__t", {}, { content: "" }), CWD).result).toEqual({ kind: "none" });
    expect(toolView(item("Read", {}), CWD).result).toEqual({ kind: "none" });
  });

  test("tool output is sanitized", () => {
    const v = toolView(item("Bash", { command: "x" }, { content: "\x1b[31mred\x1b[0m\x1b]52;c;Zm9v\x07" }), CWD).result;
    expect(lines(v)).toEqual(["red"]);
  });
});
