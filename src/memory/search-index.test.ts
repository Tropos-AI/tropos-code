// src/memory/search-index.test.ts
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, stat, truncate, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { projectDir } from "../session/store";
import { ftsQuery, MAX_SESSION_BYTES, noteEntries, parseSession, SearchIndex } from "./search-index";

let home: string;
let index: SearchIndex;
const CWD = "/work/app";
const OTHER = "/work/other";
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const meta = (fields: Record<string, unknown>) => JSON.stringify({ type: "meta", ...fields });
const msg = (role: string, content: unknown) => JSON.stringify({ type: "message", message: { role, content }, ts: "2026-10-01T00:00:00Z" });

async function session(cwd: string, n: number, lines: string[], when = new Date(Date.UTC(2026, 9, 10))): Promise<string> {
  const dir = projectDir(home, cwd);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${ID(n)}.jsonl`);
  await writeFile(path, `${lines.join("\n")}\n`);
  await utimes(path, when, when);
  return path;
}

async function note(cwd: string, date: string, text: string): Promise<string> {
  const dir = join(projectDir(home, cwd), "notes");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${date}.md`);
  await writeFile(path, text);
  return path;
}

const here = () => [projectDir(home, CWD)];

beforeEach(async () => {
  home = await makeTmpDir();
  index = SearchIndex.open(home)!;
});
afterEach(async () => {
  index.close();
  await removeDir(home);
});

describe("helpers", () => {
  test("ftsQuery quotes every word as a prefix phrase and drops punctuation-only words", () => {
    expect(ftsQuery('flaky "test" AND NEAR(x) -- *')).toBe('"flaky"* """test"""* "AND"* "NEAR(x)"*');
    expect(ftsQuery("  -- ** ")).toBeNull();
    expect(ftsQuery("")).toBeNull();
  });

  test("parseSession numbers every message line, even unparseable ones, and drops scaffolding", () => {
    const parsed = parseSession(
      [
        meta({ title: "First", cwd: CWD }),
        msg("user", [{ type: "text", text: "<context>rules</context>" }, { type: "text", text: "hello" }]),
        '{"type":"message","message":{"role":"user"', // cut short by a crash
        msg("assistant", [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "hi" },
          { type: "tool_use", id: "t", name: "Bash", input: {} },
        ]),
        msg("system", "ignored"),
        JSON.stringify({ type: "event", name: "x", value: 1 }),
        "42",
        meta({ title: "Renamed" }),
        msg("user", "bye"),
        "",
      ].join("\n"),
    );
    expect(parsed.title).toBe("Renamed");
    expect(parsed.cwd).toBe(CWD);
    expect(parsed.messages).toEqual([
      { index: 0, role: "user", texts: ["hello"], tools: [] },
      { index: 2, role: "assistant", texts: ["hi"], tools: ["Bash"] },
      { index: 4, role: "user", texts: ["bye"], tools: [] },
    ]);
  });

  test("noteEntries keeps continuation lines with their entry", () => {
    expect(noteEntries("# heading\n- 09:00 one\n  more\n\n- 10:00 two\r\n")).toEqual(["# heading", "- 09:00 one\n  more", "- 10:00 two"]);
  });
});

describe("open", () => {
  test("creates an owner-only index.db", async () => {
    expect((await stat(join(home, "index.db"))).mode & 0o777).toBe(0o600);
  });

  test("null when the file can't be opened", async () => {
    const blocked = join(home, "blocked");
    await writeFile(blocked, "not a directory");
    expect(SearchIndex.open(blocked)).toBeNull();
    const corrupt = join(home, "corrupt");
    await mkdir(corrupt);
    await writeFile(join(corrupt, "index.db"), "this is not a database".repeat(100));
    expect(SearchIndex.open(corrupt)).toBeNull();
  });

  test("an index from another schema version is rebuilt", async () => {
    await session(CWD, 1, [msg("user", "rebuild me")]);
    await index.refresh({ home, cwd: CWD });
    index.close();
    const db = new Database(join(home, "index.db"));
    db.exec("PRAGMA user_version = 99");
    db.close();
    index = SearchIndex.open(home)!;
    expect(index.search("rebuild", { source: "all", projectDirs: here(), limit: 5 })).toEqual([]);
    await index.refresh({ home, cwd: CWD });
    expect(index.search("rebuild", { source: "all", projectDirs: here(), limit: 5 })).toHaveLength(1);
  });

  test("close is idempotent", () => {
    index.close();
    index.close();
  });
});

describe("search", () => {
  test("ranks by BM25 and groups hits per session with up to 3 snippets", async () => {
    await session(CWD, 1, [
      meta({ title: "Login work", cwd: CWD }),
      ...Array.from({ length: 5 }, (_, i) => msg("user", `the flaky login test failed again, run ${i}`)),
      msg("assistant", [{ type: "text", text: "The flaky test races the server." }]),
    ]);
    await session(CWD, 2, [msg("user", `${"padding words here ".repeat(40)} flaky`)]);
    await session(CWD, 3, [msg("user", "nothing relevant")]);
    await index.refresh({ home, cwd: CWD });

    const results = index.search("flaky", { source: "sessions", projectDirs: here(), limit: 10 });
    expect(results.map((r) => r.id)).toEqual([ID(1), ID(2)]);
    const [top] = results;
    expect(top).toMatchObject({ kind: "session", title: "Login work", cwd: CWD, project: projectDir(home, CWD), date: "2026-10-10" });
    expect(top!.snippets).toHaveLength(3);
    expect(top!.snippets[0]!.text).toContain("**flaky**");
    expect(top!.snippets.every((s) => s.role === "user" || s.role === "assistant")).toBe(true);
    expect(top!.snippets.every((s) => typeof s.index === "number")).toBe(true);
    expect(top!.score).toBeGreaterThan(results[1]!.score);
    expect(results[1]!.title).toBe("(untitled)");
    expect(results[1]!.cwd).toBeUndefined();

    // Every word must match; prefixes match longer words.
    expect(index.search("flak serv", { source: "all", projectDirs: here(), limit: 10 }).map((r) => r.id)).toEqual([ID(1)]);
    expect(index.search("flaky", { source: "all", projectDirs: here(), limit: 1 })).toHaveLength(1);
    expect(index.search("flaky", { source: "all", projectDirs: here(), limit: 10, excludeSessionId: ID(1) }).map((r) => r.id)).toEqual([ID(2)]);
    expect(index.search("flaky", { source: "all", projectDirs: [], limit: 10 })).toEqual([]);
    expect(index.search("flaky", { source: "all", projectDirs: here(), limit: 0 })).toEqual([]);
    expect(index.search("**", { source: "all", projectDirs: here(), limit: 10 })).toEqual([]);
  });

  test("FTS syntax in the query is matched as words, never parsed", async () => {
    await session(CWD, 1, [msg("user", 'use NEAR and "quotes" OR not')]);
    await index.refresh({ home, cwd: CWD });
    for (const q of ['NEAR(', '"quotes"', "OR", 'col:x "unbalanced', "a*b^c"]) {
      expect(() => index.search(q, { source: "all", projectDirs: here(), limit: 5 })).not.toThrow();
    }
    expect(index.search('"quotes" OR', { source: "all", projectDirs: here(), limit: 5 })).toHaveLength(1);
  });

  test("skips thinking, tool calls, tool results and harness scaffolding", async () => {
    await session(CWD, 1, [
      msg("user", [{ type: "text", text: "<context>zebra memory</context>" }]),
      msg("assistant", [
        { type: "thinking", thinking: "zebra thoughts" },
        { type: "tool_use", id: "t", name: "Bash", input: { command: "zebra" } },
      ]),
      msg("user", [{ type: "tool_result", tool_use_id: "t", content: "zebra output" }]),
    ]);
    await index.refresh({ home, cwd: CWD });
    expect(index.search("zebra", { source: "all", projectDirs: here(), limit: 5 })).toEqual([]);
  });

  test("daily notes are indexed per entry and filtered by source", async () => {
    await note(CWD, "2026-10-13", "- 09:00 Decided: keep the scan as a fallback\n  because sqlite may be missing\n- 10:00 unrelated\n");
    await session(CWD, 1, [msg("user", "fallback in a session")]);
    await index.refresh({ home, cwd: CWD });
    const notes = index.search("fallback", { source: "notes", projectDirs: here(), limit: 5 });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: "note", id: "2026-10-13", title: "Notes 2026-10-13", date: "2026-10-13" });
    expect(notes[0]!.snippets).toEqual([{ index: 0, text: expect.stringContaining("**fallback**") }]);
    expect(index.search("sqlite missing", { source: "notes", projectDirs: here(), limit: 5 })).toHaveLength(1);
    expect(index.search("fallback", { source: "sessions", projectDirs: here(), limit: 5 }).map((r) => r.kind)).toEqual(["session"]);
    expect(index.search("fallback", { source: "all", projectDirs: here(), limit: 5 })).toHaveLength(2);
  });

  test("projects are searched only when listed", async () => {
    await session(CWD, 1, [msg("user", "rotate keys")]);
    await session(OTHER, 2, [msg("user", "rotate keys")]);
    await index.refresh({ home, cwd: CWD });
    expect(index.search("rotate", { source: "all", projectDirs: [projectDir(home, OTHER)], limit: 5 })).toEqual([]);
    await index.refresh({ home, allProjects: true });
    const both = index.search("rotate", { source: "all", projectDirs: [projectDir(home, CWD), projectDir(home, OTHER)], limit: 5 });
    expect(both.map((r) => r.id).sort()).toEqual([ID(1), ID(2)]);
  });
});

describe("subagent transcripts", () => {
  test("the index picks up subagent transcripts", async () => {
    const dir = join(projectDir(home, CWD), "subagents", ID(1));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${ID(9)}.jsonl`), `${meta({ title: "Child" })}\n${msg("assistant", "the zucchini root cause")}\n`);
    await index.refresh({ home, cwd: CWD });
    const hits = index.search("zucchini", { source: "all", projectDirs: here(), limit: 5 });
    expect(hits.map((h) => h.id)).toEqual([ID(9)]);
    expect(hits[0]!.kind).toBe("session");
  });
});

describe("refresh", () => {
  test("re-indexes a file only when its mtime or size changed", async () => {
    const when = new Date(Date.UTC(2026, 9, 1));
    const path = await session(CWD, 1, [msg("user", "alpha")], when);
    await index.refresh({ home, cwd: CWD });
    // Same size and mtime: treated as unchanged, so the old text is still what's indexed.
    await writeFile(path, `${msg("user", "omega")}\n`);
    await utimes(path, when, when);
    await index.refresh({ home, cwd: CWD });
    expect(index.search("alpha", { source: "all", projectDirs: here(), limit: 5 })).toHaveLength(1);
    // Appended: re-read.
    await writeFile(path, `${msg("user", "omega")}\n${msg("assistant", "beta")}\n`);
    await index.refresh({ home, cwd: CWD });
    expect(index.search("alpha", { source: "all", projectDirs: here(), limit: 5 })).toEqual([]);
    const hit = index.search("beta", { source: "all", projectDirs: here(), limit: 5 });
    expect(hit[0]!.snippets[0]).toMatchObject({ role: "assistant", index: 1 });
  });

  test("forgets removed and oversized files, and projects whose folder is gone", async () => {
    const one = await session(CWD, 1, [msg("user", "gamma one")]);
    const two = await session(CWD, 2, [msg("user", "gamma two")]);
    const day = await note(CWD, "2026-10-12", "- 09:00 gamma note\n");
    await session(OTHER, 3, [msg("user", "gamma three")]);
    await index.refresh({ home, allProjects: true });
    const all = [projectDir(home, CWD), projectDir(home, OTHER)];
    expect(index.search("gamma", { source: "all", projectDirs: all, limit: 10 })).toHaveLength(4);

    await rm(one);
    await truncate(two, MAX_SESSION_BYTES + 1);
    await rm(day);
    await index.refresh({ home, cwd: CWD });
    expect(index.search("gamma", { source: "all", projectDirs: all, limit: 10 }).map((r) => r.id)).toEqual([ID(3)]);

    await rm(projectDir(home, OTHER), { recursive: true });
    await index.refresh({ home, allProjects: true });
    expect(index.search("gamma", { source: "all", projectDirs: all, limit: 10 })).toEqual([]);
  });

  test("leaves the excluded (current) session alone, and needs a cwd or allProjects", async () => {
    await session(CWD, 1, [msg("user", "delta")]);
    await index.refresh({ home });
    await index.refresh({ home, cwd: CWD, excludeSessionId: ID(1) });
    expect(index.search("delta", { source: "all", projectDirs: here(), limit: 5 })).toEqual([]);
    await index.refresh({ home, cwd: CWD });
    expect(index.search("delta", { source: "all", projectDirs: here(), limit: 5 })).toHaveLength(1);
  });

  test("concurrent refreshes are serialized", async () => {
    for (let i = 1; i <= 5; i++) await session(CWD, i, [msg("user", `epsilon ${i}`)]);
    await Promise.all([index.refresh({ home, cwd: CWD }), index.refresh({ home, cwd: CWD }), index.refresh({ home, allProjects: true })]);
    expect(index.search("epsilon", { source: "all", projectDirs: here(), limit: 10 })).toHaveLength(5);
  });

  test("a refresh after close rejects without breaking later calls' queue", async () => {
    await session(CWD, 1, [msg("user", "zeta")]);
    index.close();
    await expect(index.refresh({ home, cwd: CWD })).rejects.toThrow();
    index = SearchIndex.open(home)!;
  });
});
