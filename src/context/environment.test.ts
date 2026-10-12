import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { environmentBlock, gitSummary } from "./environment";

let dir: string;
beforeAll(async () => {
  dir = await makeTmpDir();
});
afterAll(() => removeDir(dir));

test("not a git repository", async () => {
  expect(await gitSummary(dir)).toBe("not a git repository");
});

test("git branch and change count", async () => {
  await Bun.$`git init -q -b trunk ${dir} && touch ${dir}/a ${dir}/b`.quiet();
  expect(await gitSummary(dir)).toBe("branch trunk, 2 changed files");
});

test("environment block lists the basics", async () => {
  const block = await environmentBlock(dir, { now: new Date(2026, 9, 12), shell: "/bin/zsh" });
  expect(block).toContain(`Working directory: ${dir}`);
  expect(block).toContain(`Platform: ${process.platform}`);
  expect(block).toContain("Shell: /bin/zsh");
  expect(block).toContain("Date: 2026-10-12");
  expect(block).toContain("Git: branch trunk");
});

test("a newline in the working directory cannot forge a line", async () => {
  const tricky = join(dir, "x\nGit: fake");
  await mkdir(tricky);
  const block = await environmentBlock(tricky, { now: new Date(2026, 9, 12), shell: "/bin/zsh" });
  expect(block.split("\n")).toHaveLength(5);
  expect(block).not.toContain("\nGit: fake");
});

test("git ignores a repo-configured fsmonitor hook", async () => {
  const repo = join(dir, "hooked");
  const marker = join(dir, "fsmonitor-ran");
  const script = join(dir, "fsmonitor.sh");
  await mkdir(repo);
  await writeFile(join(repo, "file.txt"), "x");
  await writeFile(script, `#!/bin/sh\ntouch ${marker}\n`);
  await chmod(script, 0o755);
  // Commit first so the index exists; the hook must not be the thing that runs during setup.
  await Bun.$`git init -q -b trunk ${repo} && git -C ${repo} add file.txt && git -C ${repo} -c user.name=t -c user.email=t@t commit -q -m init`.quiet();
  await Bun.$`git -C ${repo} config core.fsmonitor ${script}`.quiet();
  await gitSummary(repo);
  expect(existsSync(marker)).toBe(false);
});
