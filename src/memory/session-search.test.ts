import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeToolContext } from "../../test/helpers/tool-context";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { projectDir } from "../session/store";
import { createSessionSearchTool, MAX_OUTPUT_CHARS } from "./session-search";

let home: string;
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

beforeEach(async () => {
  home = await makeTmpDir();
});

afterEach(async () => {
  await removeDir(home);
});

test("metadata", () => {
  const tool = createSessionSearchTool({ home, cwd: CWD });
  expect(tool.name).toBe("SessionSearch");
  expect(tool.kind).toBe("read");
  expect(tool.summarize({ query: "flaky test", all_projects: true })).toBe('"flaky test" (all projects)');
  expect(tool.subject({ query: "x" }, CWD)).toEqual({ paths: [] });
  expect(tool.schema.safeParse({ query: "x", limit: 21 }).success).toBe(false);
});

test("finds user and assistant text with every word, newest first", async () => {
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

  const out = await createSessionSearchTool({ home, cwd: CWD }).run({ query: "flaky Test" }, makeToolContext());
  const text = String(out.content);
  expect(out.summary).toBe("2 sessions");
  expect(text).toContain('2 sessions match "flaky Test"');
  expect(text.indexOf("Newer")).toBeLessThan(text.indexOf("Older"));
  expect(text).toContain(`## Newer (${ID(2)}, 2026-10-09)`);
  expect(text).toContain("- [user] why is the test flaky?");
  expect(text).toContain("- [assistant] The flaky test races the server.");
  expect(text).not.toContain("thoughts");
  expect(text).not.toContain("output");
  expect(text).not.toContain("memory</context>");
  expect(text).toContain("- [user] Fix the FLAKY login test");
  expect(text).not.toContain("Unrelated");
});

test("excludes the current session, honours limit and caps snippets per session", async () => {
  const many = [meta({ title: "Many" }), ...Array.from({ length: 6 }, (_, i) => msg("user", `deploy step ${i}`))];
  await session(CWD, 1, many, 10);
  await session(CWD, 2, [meta({ title: "Current" }), msg("user", "deploy now")], 1);
  await session(CWD, 3, [meta({ title: "Oldest" }), msg("user", "deploy later")], 100);
  const tool = createSessionSearchTool({ home, cwd: CWD, currentSessionId: () => ID(2) });
  const out = await tool.run({ query: "deploy", limit: 1 }, makeToolContext());
  const text = String(out.content);
  expect(text).not.toContain("Current");
  expect(text).not.toContain("Oldest");
  expect(text.match(/- \[user\]/g)).toHaveLength(3);
  expect(out.summary).toBe("1 session");
});

test("snippets are clipped around the match", async () => {
  const long = `${"a ".repeat(300)}needle${" b".repeat(300)}`;
  await session(CWD, 1, [msg("user", long)], 1);
  const out = await createSessionSearchTool({ home, cwd: CWD }).run({ query: "needle" }, makeToolContext());
  const line = String(out.content).split("\n").find((l) => l.startsWith("- [user]"))!;
  expect(line).toStartWith("- [user] …");
  expect(line).toEndWith("…");
  expect(line.length).toBeLessThan(420);
  expect(String(out.content)).toContain("(untitled)");
});

test("all_projects searches every project and shows its folder", async () => {
  await session(CWD, 1, [meta({ cwd: CWD, title: "Here" }), msg("user", "rotate keys")], 5);
  await session(OTHER, 2, [meta({ cwd: OTHER, title: "There" }), msg("user", "rotate keys")], 1);
  const tool = createSessionSearchTool({ home, cwd: CWD });
  const local = String((await tool.run({ query: "rotate" }, makeToolContext())).content);
  expect(local).not.toContain("There");
  const all = String((await tool.run({ query: "rotate", all_projects: true }, makeToolContext())).content);
  expect(all).toContain(`## There (${ID(2)}, 2026-10-09, ${OTHER})`);
  expect(all).toContain("Here");
});

test("no matches, no sessions, and bad lines", async () => {
  const tool = createSessionSearchTool({ home, cwd: CWD });
  expect((await tool.run({ query: "anything", all_projects: true }, makeToolContext())).content).toBe('No past sessions match "anything".');
  await session(CWD, 1, ["{not json", "42", JSON.stringify({ type: "message", message: null }), msg("user", "something else")], 1);
  await mkdir(join(projectDir(home, CWD), `${ID(9)}.jsonl`));
  await writeFile(join(projectDir(home, CWD), "notes.txt"), "anything");
  const out = await tool.run({ query: "anything" }, makeToolContext());
  expect(out.summary).toBe("no matches");
  expect((await tool.run({ query: "   " }, makeToolContext())).isError).toBe(true);
});

test("words with quotes are matched after parsing", async () => {
  await session(CWD, 1, [msg("user", 'set "strict" mode'), msg("assistant", [{ type: "text", text: 'use "strict"' }])], 1);
  const out = await createSessionSearchTool({ home, cwd: CWD }).run({ query: '"strict"' }, makeToolContext());
  expect(out.summary).toBe("1 session");
});

test("output stops at the size cap", async () => {
  const big = `${"pad ".repeat(80)}zebra${" pad".repeat(80)}`;
  for (let i = 0; i < 20; i++) {
    await session(CWD, i + 1, [meta({ title: `T${i}` }), msg("user", `${big}1`), msg("user", `${big}2`), msg("user", `${big}3`)], i);
  }
  const out = await createSessionSearchTool({ home, cwd: CWD }).run({ query: "zebra", limit: 20 }, makeToolContext());
  const text = String(out.content);
  expect(text.length).toBeLessThan(MAX_OUTPUT_CHARS + 500);
  expect(text).toContain("output was cut at the size limit");
});

test("an aborted call stops early", async () => {
  await session(CWD, 1, [msg("user", "stop")], 1);
  const controller = new AbortController();
  controller.abort();
  const out = await createSessionSearchTool({ home, cwd: CWD }).run({ query: "stop" }, makeToolContext({ signal: controller.signal }));
  expect(out.summary).toBe("no matches");
});

test("searching every project names the sessions folder, so the permission engine asks", () => {
  const tool = createSessionSearchTool({ home: "/h", cwd: "/w" });
  expect(tool.subject({ query: "x", all_projects: true }, "/w")).toEqual({ paths: ["/h/projects"] });
  expect(tool.subject({ query: "x" }, "/w")).toEqual({ paths: [] });
});
