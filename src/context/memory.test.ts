import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { gitRoot, loadMemory, MAX_FILE_CHARS, truncateMemoryText } from "./memory";

let dir: string;
let home: string;
let repo: string;
beforeEach(async () => {
  dir = await makeTmpDir();
  home = join(dir, "home");
  repo = join(dir, "repo");
  await mkdir(join(repo, ".git"), { recursive: true });
  await mkdir(join(repo, "pkg", "app"), { recursive: true });
  await mkdir(home, { recursive: true });
});
afterEach(() => removeDir(dir));

describe("gitRoot", () => {
  test("finds the nearest .git upwards", () => {
    expect(gitRoot(join(repo, "pkg", "app"))).toBe(repo);
  });
  test("null outside a repo", () => {
    expect(gitRoot(home)).toBeNull();
  });
});

describe("loadMemory", () => {
  test("user file, then repo root down to cwd, then local", async () => {
    await writeFile(join(home, "TROPOS.md"), "user rules");
    await writeFile(join(repo, "TROPOS.md"), "root rules");
    await writeFile(join(repo, "pkg", "AGENTS.md"), "pkg agents");
    await writeFile(join(repo, "pkg", "app", "TROPOS.md"), "app rules");
    await writeFile(join(repo, "pkg", "app", "TROPOS.local.md"), "my local notes");
    const files = await loadMemory(join(repo, "pkg", "app"), home);
    expect(files.map((f) => f.content)).toEqual(["user rules", "root rules", "pkg agents", "app rules", "my local notes"]);
    expect(files[0]!.path).toBe(join(home, "TROPOS.md"));
  });

  test("the home file is source user, everything in the repo is source project", async () => {
    await writeFile(join(home, "TROPOS.md"), "user rules");
    await writeFile(join(repo, "TROPOS.md"), "root rules");
    await writeFile(join(repo, "pkg", "app", "TROPOS.local.md"), "my local notes");
    const files = await loadMemory(join(repo, "pkg", "app"), home);
    expect(files.map((f) => f.source)).toEqual(["user", "project", "project"]);
  });

  test("TROPOS.md wins over AGENTS.md in the same directory", async () => {
    await writeFile(join(repo, "TROPOS.md"), "tropos");
    await writeFile(join(repo, "AGENTS.md"), "agents");
    expect((await loadMemory(repo, home)).map((f) => f.content)).toEqual(["tropos"]);
  });

  test("CLAUDE.md is read when a directory has neither TROPOS.md nor AGENTS.md", async () => {
    await writeFile(join(repo, "CLAUDE.md"), "claude root");
    await writeFile(join(repo, "pkg", "TROPOS.md"), "pkg tropos");
    await writeFile(join(repo, "pkg", "CLAUDE.md"), "pkg claude");
    const files = await loadMemory(join(repo, "pkg"), home);
    expect(files.map((f) => f.content)).toEqual(["claude root", "pkg tropos"]);
    expect(files[0]!.source).toBe("project");
  });

  test("AGENTS.md wins over CLAUDE.md in the same directory", async () => {
    await writeFile(join(repo, "AGENTS.md"), "agents");
    await writeFile(join(repo, "CLAUDE.md"), "claude");
    expect((await loadMemory(repo, home)).map((f) => f.content)).toEqual(["agents"]);
  });

  test("empty files are skipped", async () => {
    await writeFile(join(repo, "TROPOS.md"), "   \n");
    expect(await loadMemory(repo, home)).toEqual([]);
  });

  test("does not walk above the repo root", async () => {
    await writeFile(join(dir, "TROPOS.md"), "outside");
    expect(await loadMemory(repo, home)).toEqual([]);
  });
});

describe("size caps", () => {
  test("a file over 40,000 characters keeps its head and tail with a marker naming it", async () => {
    await writeFile(join(repo, "TROPOS.md"), "a".repeat(30_000) + "b".repeat(20_000));
    const [file] = await loadMemory(repo, home);
    const marker = `[… truncated: ${join(repo, "TROPOS.md")} is 50,000 chars; read it for the full text …]`;
    expect(file!.content).toBe(`${"a".repeat(18_000)}\n${marker}\n${"b".repeat(6_000)}`);
    expect(file!.content.length).toBeLessThan(MAX_FILE_CHARS);
  });

  test("policy lines from the middle survive, in order and deduplicated", async () => {
    const filler = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `${tag} filler line ${i} `.padEnd(80, "x")).join("\n");
    const middle = [
      "You MUST run the linter.",
      "plain prose",
      "Never commit secrets.",
      "You MUST run the linter.",
      "Use a token bucket.",
      "testing is not a match",
      "do not push to main",
    ].join("\n");
    await writeFile(join(repo, "TROPOS.md"), `${filler("head", 300)}\n${middle}\n${filler("mid", 300)}\n${filler("tail", 100)}`);
    const [file] = await loadMemory(repo, home);
    const text = file!.content;
    expect(text).toContain("[policy lines from the omitted middle:]\nYou MUST run the linter.\nNever commit secrets.\nUse a token bucket.\ndo not push to main\n[… end of policy lines");
    expect(text).not.toContain("plain prose");
    expect(text).not.toContain("testing is not a match");
    expect(text).toStartWith("head filler line 0");
    expect(text).toEndWith(`tail filler line 99 `.padEnd(80, "x"));
    // Head and tail are cut at line breaks.
    expect(text.split("\n").filter((l) => l.includes("filler")).every((l) => l.length === 80)).toBe(true);
  });

  test("the digest stops at its share of the budget", () => {
    const rules = Array.from({ length: 2_000 }, (_, i) => `rule ${i}: always do thing ${i}`).join("\n");
    const out = truncateMemoryText("/r/T.md", `${"h".repeat(20_000)}\n${rules}\n${"t".repeat(7_000)}`, null, "n chars");
    const digest = out.slice(out.indexOf("[policy lines"), out.indexOf("[… end of policy"));
    expect(digest.length).toBeLessThanOrEqual(14_000 + 60);
    expect(digest).toContain("rule 0: always do thing 0");
    expect(out.length).toBeLessThan(MAX_FILE_CHARS + 300);
  });

  test("a file over 1 MB is read only as far as the cap, start and end", async () => {
    await writeFile(join(repo, "TROPOS.md"), `${"b".repeat(1_000_000)}\nnever skip tests here\n${"é".repeat(500_000)}\nend rule`);
    const [file] = await loadMemory(repo, home);
    const text = file!.content;
    expect(text).toStartWith("b".repeat(18_000));
    expect(text).toContain(`is ${(1_000_000 + 23 + 1_000_000 + 9).toLocaleString("en-US")} bytes; read it`);
    expect(text).not.toContain("never skip tests here"); // beyond what is read
    expect(text).toEndWith("é\nend rule");
    expect(text).not.toContain("\uFFFD");
  });
});

describe("file safety", () => {
  test("a symlink to a file outside the repo is skipped", async () => {
    const outside = join(dir, "outside.md");
    await writeFile(outside, "secret rules");
    await symlink(outside, join(repo, "TROPOS.md"));
    expect(await loadMemory(repo, home)).toEqual([]);
  });

  test("a symlink to a file inside the repo is loaded", async () => {
    await writeFile(join(repo, "notes.md"), "linked rules");
    await symlink(join(repo, "notes.md"), join(repo, "TROPOS.md"));
    expect((await loadMemory(repo, home)).map((f) => f.content)).toEqual(["linked rules"]);
  });

  test("a user file symlink must point inside the Tropos home", async () => {
    const outside = join(dir, "elsewhere.md");
    await writeFile(outside, "not yours");
    await symlink(outside, join(home, "TROPOS.md"));
    expect(await loadMemory(repo, home)).toEqual([]);
  });

  test("outside git, a symlink to a file in a sibling directory is skipped", async () => {
    const plain = join(dir, "plain");
    await mkdir(plain);
    await mkdir(join(dir, "sibling"));
    await writeFile(join(dir, "sibling", "secret.md"), "not for the model");
    await symlink(join(dir, "sibling", "secret.md"), join(plain, "TROPOS.md"));
    expect(await loadMemory(plain, home)).toEqual([]);
  });

  test("outside git, a regular TROPOS.md still loads", async () => {
    const plain = join(dir, "plain");
    await mkdir(plain);
    await writeFile(join(plain, "TROPOS.md"), "plain rules");
    expect((await loadMemory(plain, home)).map((f) => f.content)).toEqual(["plain rules"]);
  });

  test("outside git, a CLAUDE.md in a parent folder is not loaded (it belongs to something else)", async () => {
    const plain = join(dir, "desktop", "project");
    await mkdir(plain, { recursive: true });
    await writeFile(join(dir, "desktop", "CLAUDE.md"), "This file provides guidance to Claude Code");
    expect(await loadMemory(plain, home)).toEqual([]);
    await writeFile(join(plain, "AGENTS.md"), "project rules");
    expect((await loadMemory(plain, home)).map((f) => f.content)).toEqual(["project rules"]);
  });

  test("a directory named TROPOS.md does not block the AGENTS.md fallback", async () => {
    await mkdir(join(repo, "TROPOS.md"));
    await writeFile(join(repo, "AGENTS.md"), "agents");
    expect((await loadMemory(repo, home)).map((f) => f.content)).toEqual(["agents"]);
  });

  test("a FIFO named TROPOS.md is skipped without hanging", async () => {
    await Bun.$`mkfifo ${join(repo, "TROPOS.md")}`.quiet();
    expect(await loadMemory(repo, home)).toEqual([]);
  });
});
