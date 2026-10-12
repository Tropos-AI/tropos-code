import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { gitRoot, loadMemory } from "./memory";

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
