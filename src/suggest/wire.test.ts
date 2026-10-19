import { afterEach, beforeEach, expect, test } from "bun:test";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import type { AppContext } from "../cli/runtime";
import { updateOnboardingFlags } from "../onboard/flags";
import { withSuggestions } from "./wire";

let home: string;
beforeEach(async () => {
  home = await makeTmpDir("suggest-wire-");
});
afterEach(() => removeDir(home));

test("the suggestions block comes before blocks the context already has, and a watcher is attached", async () => {
  await updateOnboardingFlags(home, { skipped: ["phone"] });
  const base = { home, env: { HOME: home }, contextBlocks: async () => ["<worktree>w</worktree>"] } as unknown as AppContext;
  const ctx = withSuggestions(base, { userHome: home, projectId: "app", testCommands: ["bun test"] });
  const blocks = await ctx.contextBlocks!();
  expect(blocks).toHaveLength(2);
  expect(blocks[0]).toContain("[setup:phone]");
  expect(blocks[1]).toBe("<worktree>w</worktree>");
  expect(typeof ctx.testWatch?.observe).toBe("function");
});
