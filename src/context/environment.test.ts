import { afterAll, beforeAll, expect, test } from "bun:test";
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
