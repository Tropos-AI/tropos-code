import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { gitRoot, loadMemory } from "./memory";

const TRUNCATED = "\n[truncated: file is larger than 40,000 characters]";

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
  test("a file over 40,000 characters is truncated with a note", async () => {
    await writeFile(join(repo, "TROPOS.md"), "a".repeat(50_000));
    const [file] = await loadMemory(repo, home);
    expect(file!.content).toBe("a".repeat(40_000) + TRUNCATED);
  });

  test("a file over 1 MB is read only as far as the cap", async () => {
    await writeFile(join(repo, "TROPOS.md"), "b".repeat(1_500_000));
    const [file] = await loadMemory(repo, home);
    expect(file!.content).toBe("b".repeat(40_000) + TRUNCATED);
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
