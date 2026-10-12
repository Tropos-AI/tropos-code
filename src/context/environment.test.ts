import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { environmentBlock, gitSummary } from "./environment";

const SHA = "0123456789abcdef0123456789abcdef01234567";

let dir: string;
beforeAll(async () => {
  dir = await makeTmpDir();
});
afterAll(() => removeDir(dir));

test("not a git repository", async () => {
  expect(await gitSummary(dir)).toBe("not a git repository");
});

test("branch name comes from HEAD", async () => {
  await Bun.$`git init -q -b trunk ${dir} && touch ${dir}/a ${dir}/b`.quiet();
  expect(await gitSummary(dir)).toBe("branch trunk");
  await mkdir(join(dir, "sub"));
  expect(await gitSummary(join(dir, "sub"))).toBe("branch trunk");
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

test("a repo-configured clean filter is never run", async () => {
  const repo = join(dir, "filtered");
  const marker = join(dir, "clean-ran");
  const script = join(dir, "clean.sh");
  await mkdir(repo);
  await writeFile(script, `#!/bin/sh\ntouch ${marker}\ncat\n`);
  await chmod(script, 0o755);
  await writeFile(join(repo, ".gitattributes"), "*.dat filter=evil\n");
  await writeFile(join(repo, "data.dat"), "one");
  await Bun.$`git init -q -b trunk ${repo} && git -C ${repo} add . && git -C ${repo} -c user.name=t -c user.email=t@t commit -q -m init`.quiet();
  await Bun.$`git -C ${repo} config filter.evil.clean ${script}`.quiet();
  // Same size, new mtime: git must hash the content, which is when a clean filter would run.
  await writeFile(join(repo, "data.dat"), "two");
  expect(await gitSummary(repo)).toBe("branch trunk");
  expect(existsSync(marker)).toBe(false);
});

test("a repo-configured fsmonitor hook is never run", async () => {
  const repo = join(dir, "hooked");
  const marker = join(dir, "fsmonitor-ran");
  const script = join(dir, "fsmonitor.sh");
  await mkdir(repo);
  await writeFile(join(repo, "file.txt"), "x");
  await writeFile(script, `#!/bin/sh\ntouch ${marker}\n`);
  await chmod(script, 0o755);
  await Bun.$`git init -q -b trunk ${repo} && git -C ${repo} add file.txt && git -C ${repo} -c user.name=t -c user.email=t@t commit -q -m init`.quiet();
  await Bun.$`git -C ${repo} config core.fsmonitor ${script}`.quiet();
  expect(await gitSummary(repo)).toBe("branch trunk");
  expect(existsSync(marker)).toBe(false);
});

test("a worktree .git file points at its git directory", async () => {
  await mkdir(join(dir, "main-repo", ".git"), { recursive: true });
  await writeFile(join(dir, "main-repo", ".git", "HEAD"), "ref: refs/heads/feature\n");
  await mkdir(join(dir, "wt"));
  await writeFile(join(dir, "wt", ".git"), "gitdir: ../main-repo/.git\n");
  expect(await gitSummary(join(dir, "wt"))).toBe("branch feature");
});

test("a detached HEAD is reported as such", async () => {
  await mkdir(join(dir, "detached", ".git"), { recursive: true });
  await writeFile(join(dir, "detached", ".git", "HEAD"), `${SHA}\n`);
  expect(await gitSummary(join(dir, "detached"))).toBe("detached HEAD");
});

test("a .git file pointing nowhere is not a repository", async () => {
  await mkdir(join(dir, "broken"));
  await writeFile(join(dir, "broken", ".git"), "gitdir: ../nowhere\n");
  expect(await gitSummary(join(dir, "broken"))).toBe("not a git repository");
});
