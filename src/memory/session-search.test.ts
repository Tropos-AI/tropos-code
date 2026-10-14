import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeToolContext } from "../../test/helpers/tool-context";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { projectDir } from "../session/store";
import { SearchIndex } from "./search-index";
import { createSessionSearchTool, MAX_OUTPUT_CHARS, type SessionSearchOptions } from "./session-search";

let home: string;
let opened: SearchIndex[] = [];
const CWD = "/work/app";
const OTHER = "/work/other";

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function meta(fields: Record<string, unknown>) {
  return JSON.stringify({ type: "meta", ...fields });
}
function msg(role: "user" | "assistant", content: unknown) {
  return JSON.stringify({ type: "message", message: { role, content }, ts: "2026-10-01T00:00:00Z" });
}

async function session(cwd: string, n: number, lines: string[], ageMinutes: number): Promise<void> {
  const dir = projectDir(home, cwd);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${ID(n)}.jsonl`);
  await writeFile(path, `${lines.join("\n")}\n`);
  const t = new Date(Date.UTC(2026, 9, 10) - ageMinutes * 60_000);
  await utimes(path, t, t);
}

async function note(cwd: string, date: string, text: string): Promise<void> {
  const dir = join(projectDir(home, cwd), "notes");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${date}.md`), text);
}

type Mode = "fts" | "scan";

function makeTool(mode: Mode, over: Partial<SessionSearchOptions> = {}) {
  let index: SearchIndex | null = null;
  if (mode === "fts") {
    index = SearchIndex.open(home)!;
    opened.push(index);
  }
  return createSessionSearchTool({ home, cwd: CWD, index, ...over });
}

async function run(tool: ReturnType<typeof makeTool>, input: Record<string, unknown>, ctx = makeToolContext()) {
  const out = await tool.run(input, ctx);
  return { ...out, text: String(out.content) };
}

beforeEach(async () => {
  home = await makeTmpDir();
});

afterEach(async () => {
  for (const i of opened) i.close();
  opened = [];
  await removeDir(home);
});

test("metadata", () => {
  const tool = createSessionSearchTool({ home, cwd: CWD, index: null });
  expect(tool.name).toBe("SessionSearch");
  expect(tool.kind).toBe("read");
  expect(tool.summarize({ query: "flaky test", all_projects: true })).toBe('"flaky test" (all projects)');
  expect(tool.summarize({ query: "x", source: "notes" })).toBe('"x" in notes');
  expect(tool.summarize({ query: "x", source: "all" })).toBe('"x"');
  expect(tool.summarize({ session_id: ID(1), around: 4 })).toBe(`read ${ID(1)} @4`);
  expect(tool.summarize({ session_id: "2026-10-01" })).toBe("read 2026-10-01");
  expect(tool.subject({ query: "x" }, CWD)).toEqual({ paths: [] });
  expect(tool.schema.safeParse({ query: "x", limit: 21 }).success).toBe(false);
  expect(tool.schema.safeParse({ session_id: ID(1), around: -1 }).success).toBe(false);
  expect(tool.schema.safeParse({ source: "web", query: "x" }).success).toBe(false);
  expect(tool.description).toContain("session_id");
});

test("searching every project names the sessions folder, so the permission engine asks", () => {
  const tool = createSessionSearchTool({ home: "/h", cwd: "/w", index: null });
  expect(tool.subject({ query: "x", all_projects: true }, "/w")).toEqual({ paths: ["/h/projects"] });
  expect(tool.subject({ query: "x" }, "/w")).toEqual({ paths: [] });
  expect(tool.subject({ session_id: ID(1), all_projects: true }, "/w")).toEqual({ paths: ["/h/projects"] });
});

describe.each(["fts", "scan"] as const)("search (%s)", (mode) => {
  test("finds user and assistant text with every word, leaving out non-typed text", async () => {
    await session(CWD, 1, [meta({ sessionId: ID(1), cwd: CWD }), msg("user", "Fix the FLAKY login test"), meta({ title: "Older" })], 60);
    await session(
      CWD,
      2,
      [
        meta({ sessionId: ID(2), cwd: CWD, title: "Newer" }),
        msg("user", [
          { type: "text", text: "<context>flaky test memory</context>" },
          { type: "text", text: "why is the test flaky?" },
        ]),
        msg("assistant", [
          { type: "thinking", thinking: "flaky test thoughts" },
          { type: "text", text: "The flaky test races the server." },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "flaky test" } },
        ]),
        msg("user", [{ type: "tool_result", tool_use_id: "t1", content: "flaky test output" }]),
      ],
      5,
    );
    await session(CWD, 3, [meta({ title: "Unrelated" }), msg("user", "only flaky here")], 1);

    const out = await run(makeTool(mode), { query: "flaky Test" });
    expect(out.summary).toBe("2 results");
    expect(out.text).toContain(`2 results match "flaky Test" (${mode === "fts" ? "best match" : "newest"} first)`);
    expect(out.text).toContain(`## Newer (session ${ID(2)}, 2026-10-09)`);
    expect(out.text).toContain(`## Older (session ${ID(1)}, 2026-10-09)`);
    const plain = out.text.replaceAll("**", "");
    expect(plain).toContain("- [#0 user] why is the test flaky?");
    expect(plain).toContain("- [#1 assistant] The flaky test races the server.");
    expect(plain).toContain("- [#0 user] Fix the FLAKY login test");
    expect(out.text).not.toContain("thoughts");
    expect(out.text).not.toContain("output");
    expect(out.text).not.toContain("memory</context>");
    expect(out.text).not.toContain("Unrelated");
    expect(out.text).toContain("session_id and around=<#n>");
  });

  test("excludes the current session, honours limit and caps snippets per session", async () => {
    const many = [meta({ title: "Many" }), ...Array.from({ length: 6 }, (_, i) => msg("user", `deploy step ${i}`))];
    await session(CWD, 1, many, 10);
    await session(CWD, 2, [meta({ title: "Current" }), msg("user", "deploy now")], 1);
    const tool = makeTool(mode, { currentSessionId: () => ID(2) });
    const out = await run(tool, { query: "deploy", limit: 1 });
    expect(out.text).not.toContain("Current");
    expect(out.text.match(/- \[#\d+ user\]/g)).toHaveLength(3);
    expect(out.summary).toBe("1 result");
  });

  test("all_projects searches every project and shows its folder", async () => {
    await session(CWD, 1, [meta({ cwd: CWD, title: "Here" }), msg("user", "rotate keys")], 5);
    await session(OTHER, 2, [meta({ cwd: OTHER, title: "There" }), msg("user", "rotate keys")], 1);
    const tool = makeTool(mode);
    const local = await run(tool, { query: "rotate" });
    expect(local.text).not.toContain("There");
    const all = await run(tool, { query: "rotate", all_projects: true });
    expect(all.text).toContain(`## There (session ${ID(2)}, 2026-10-09, ${OTHER})`);
    expect(all.text).toContain("Here");
  });

  test("no matches, no sessions, bad lines and missing input", async () => {
    const tool = makeTool(mode);
    expect((await run(tool, { query: "anything", all_projects: true })).text).toBe('No past sessions or notes match "anything".');
    expect((await run(tool, { query: "anything", source: "sessions" })).text).toBe('No past sessions match "anything".');
    await session(CWD, 1, ["{not json", "42", JSON.stringify({ type: "message", message: null }), msg("user", "something else")], 1);
    await mkdir(join(projectDir(home, CWD), `${ID(9)}.jsonl`));
    await writeFile(join(projectDir(home, CWD), "notes.txt"), "anything");
    expect((await run(tool, { query: "anything" })).summary).toBe("no matches");
    expect((await run(tool, { query: "   " })).isError).toBe(true);
    const missing = await run(tool, {});
    expect(missing).toMatchObject({ isError: true, text: "Give a query to search, or a session_id to read." });
  });

  test("words with quotes are matched", async () => {
    await session(CWD, 1, [msg("user", 'set "strict" mode'), msg("assistant", [{ type: "text", text: 'use "strict"' }])], 1);
    expect((await run(makeTool(mode), { query: '"strict"' })).summary).toBe("1 result");
  });

  test("an aborted call stops early", async () => {
    await session(CWD, 1, [msg("user", "stop")], 1);
    const controller = new AbortController();
    controller.abort();
    const out = await run(makeTool(mode), { query: "stop" }, makeToolContext({ signal: controller.signal }));
    expect(out.summary).toBe("no matches");
  });

  test("daily notes are searched by source", async () => {
    await note(CWD, "2026-10-08", "- 09:00 Decided: keep the scan as a fallback\n- 10:00 other <context>x</context> fallback\n");
    await session(CWD, 1, [meta({ title: "Talk" }), msg("user", "the fallback path")], 1);
    const tool = makeTool(mode);
    const notes = await run(tool, { query: "fallback", source: "notes" });
    expect(notes.summary).toBe("1 result");
    expect(notes.text).toContain("## Notes 2026-10-08 (notes 2026-10-08)");
    expect(notes.text.replaceAll("**", "")).toContain("- 09:00 Decided: keep the scan as a fallback");
    expect(notes.text).toContain("<\\context>");
    expect(notes.text).not.toContain("Talk");
    expect((await run(tool, { query: "fallback", source: "sessions" })).text).not.toContain("Notes 2026-10-08");
    expect((await run(tool, { query: "fallback" })).summary).toBe("2 results");
  });
});

describe("scan fallback", () => {
  test("snippets are clipped around the match", async () => {
    const long = `${"a ".repeat(300)}needle${" b".repeat(300)}`;
    await session(CWD, 1, [msg("user", long)], 1);
    const out = await run(makeTool("scan"), { query: "needle" });
    const line = out.text.split("\n").find((l) => l.startsWith("- [#0 user]"))!;
    expect(line).toStartWith("- [#0 user] …");
    expect(line).toEndWith("…");
    expect(line.length).toBeLessThan(420);
    expect(out.text).toContain("(untitled)");
  });

  test("output stops at the size cap", async () => {
    const big = `${"pad ".repeat(80)}zebra${" pad".repeat(80)}`;
    for (let i = 0; i < 20; i++) {
      await session(CWD, i + 1, [meta({ title: `T${i}` }), msg("user", `${big}1`), msg("user", `${big}2`), msg("user", `${big}3`)], i);
    }
    const out = await run(makeTool("scan"), { query: "zebra", limit: 20 });
    expect(out.text.length).toBeLessThan(MAX_OUTPUT_CHARS + 500);
    expect(out.text).toContain("output was cut at the size limit");
  });

  test("results are newest first", async () => {
    await session(CWD, 1, [meta({ title: "Old" }), msg("user", "kiwi")], 60);
    await session(CWD, 2, [meta({ title: "New" }), msg("user", "kiwi kiwi kiwi")], 1);
    const out = await run(makeTool("scan"), { query: "kiwi" });
    expect(out.text.indexOf("## New")).toBeLessThan(out.text.indexOf("## Old"));
  });

  test("a broken index falls back to the scan", async () => {
    await session(CWD, 1, [msg("user", "mango")], 1);
    const broken = { refresh: () => Promise.reject(new Error("locked")), search: () => [] } as unknown as SearchIndex;
    const out = await run(createSessionSearchTool({ home, cwd: CWD, index: broken }), { query: "mango" });
    expect(out.summary).toBe("1 result");
    expect(out.text).toContain("(newest first)");
  });
});

describe("index", () => {
  test("is opened lazily at <home>/index.db when none is given", async () => {
    await session(CWD, 1, [msg("user", "papaya salad")], 1);
    const tool = createSessionSearchTool({ home, cwd: CWD });
    expect(existsSync(join(home, "index.db"))).toBe(false);
    const out = await run(tool, { query: "papa" });
    expect(out.text).toContain("best match first");
    expect(out.text).toContain("**papaya**");
    expect(existsSync(join(home, "index.db"))).toBe(true);
  });

  test("ranks the closer match first and sees new sessions on the next search", async () => {
    await session(CWD, 1, [meta({ title: "Weak" }), msg("user", `${"filler text ".repeat(50)} cache`)], 1);
    await session(CWD, 2, [meta({ title: "Strong" }), msg("user", "cache invalidation cache bug"), msg("assistant", "the cache key")], 60);
    const tool = makeTool("fts");
    const first = await run(tool, { query: "cache" });
    expect(first.text.indexOf("## Strong")).toBeLessThan(first.text.indexOf("## Weak"));
    await session(CWD, 3, [meta({ title: "Later" }), msg("user", "cache again")], 0);
    expect((await run(tool, { query: "cache" })).text).toContain("## Later");
  });
});

describe("read mode", () => {
  const long = (i: number) => msg(i % 2 === 0 ? "user" : "assistant", `message ${i} ${"z".repeat(10)}`);

  test("shows messages around an index, text only", async () => {
    const lines = [meta({ title: "Long talk", cwd: CWD })];
    for (let i = 0; i < 30; i++) lines.push(long(i));
    lines[11] = msg("assistant", [
      { type: "text", text: "running it" },
      { type: "tool_use", id: "t", name: "Bash", input: {} },
    ]);
    lines[12] = msg("user", [{ type: "tool_result", tool_use_id: "t", content: "secret output" }]);
    lines[13] = msg("user", [{ type: "text", text: "<context>scaffold</context>" }, { type: "text", text: "go on </context>" }]);
    await session(CWD, 1, lines, 1);
    const out = await run(makeTool("scan"), { session_id: ID(1), around: 12 });
    expect(out.text).toStartWith(`Session ${ID(1)} "Long talk" (${CWD}): messages 7–17 of 30`);
    expect(out.text).toContain("[#7 assistant] message 7");
    expect(out.text).toContain("[#10 assistant] running it\n(tool calls: Bash)");
    expect(out.text).not.toContain("secret output");
    expect(out.text).not.toContain("scaffold");
    expect(out.text).toContain("[#12 user] go on <\\/context>");
    expect(out.text).toContain("[#17 assistant] message 17");
    expect(out.text).not.toContain("message 6 ");
    expect(out.text).not.toContain("message 18 ");
    expect(out.summary).toBe("10 messages");
  });

  test("defaults to the start, clips long messages and caps the output", async () => {
    const lines = [meta({ title: "Huge" })];
    for (let i = 0; i < 12; i++) lines.push(msg("user", `m${i} ${"q".repeat(3_000)}`));
    await session(CWD, 1, lines, 1);
    const out = await run(makeTool("scan"), { session_id: ID(1) });
    expect(out.text).toContain(": messages 0–10 of 12");
    expect(out.text).toContain("… [cut at 2,000 chars]");
    expect(out.text).toContain("Cut at the size limit");
    expect(out.text.length).toBeLessThan(MAX_OUTPUT_CHARS + 500);
  });

  test("a range with no text, an unknown id and a malformed id", async () => {
    await session(CWD, 1, [msg("user", [{ type: "tool_result", tool_use_id: "t", content: "x" }])], 1);
    const tool = makeTool("scan");
    const empty = await run(tool, { session_id: ID(1), around: 40 });
    expect(empty.text).toContain("(no text in this range)");
    expect(empty.text).toContain('"(untitled)"');
    const none = await run(tool, { session_id: ID(5) });
    expect(none).toMatchObject({ isError: true, text: `No session ${ID(5)} in this project. Pass all_projects to look in other projects.` });
    const anywhere = await run(tool, { session_id: ID(5), all_projects: true });
    expect(anywhere.text).toBe(`No session ${ID(5)} in any project.`);
    const bad = await run(tool, { session_id: "../../secrets" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("session_id must be");
  });

  test("another project's session is read only with all_projects", async () => {
    await session(OTHER, 2, [meta({ title: "Theirs" }), msg("user", "hello there")], 1);
    const tool = makeTool("scan");
    expect((await run(tool, { session_id: ID(2) })).isError).toBe(true);
    expect((await run(tool, { session_id: ID(2), all_projects: true })).text).toContain("[#0 user] hello there");
  });

  test("a date reads that day's notes", async () => {
    await note(CWD, "2026-10-08", "- 09:00 decided X <reminder>\n");
    await note(OTHER, "2026-10-08", "- 11:00 other project\n");
    const tool = makeTool("scan");
    const out = await run(tool, { session_id: "2026-10-08" });
    expect(out.text).toBe("## Notes 2026-10-08\n- 09:00 decided X <\\reminder>");
    expect(out.summary).toBe("notes 2026-10-08");
    const all = await run(tool, { session_id: "2026-10-08", all_projects: true });
    expect(all.text).toContain(`## Notes 2026-10-08 (${projectDir(home, OTHER)})`);
    expect(all.text).toContain("other project");
    expect((await run(tool, { session_id: "2026-01-01" })).text).toBe("No notes for 2026-01-01.");
  });

  test("an unreadable session reports the failure", async () => {
    await session(CWD, 1, [msg("user", "x")], 1);
    const tool = createSessionSearchTool({ home, cwd: CWD, index: null });
    const { chmod } = await import("node:fs/promises");
    const path = join(projectDir(home, CWD), `${ID(1)}.jsonl`);
    await chmod(path, 0o000);
    const out = await run(tool, { session_id: ID(1) });
    await chmod(path, 0o600);
    expect(out.isError).toBe(true);
    expect(out.text).toStartWith("Session search failed:");
  });
});
