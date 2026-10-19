// src/suggest/wire.ts — what an owner's session gets for suggestions: the <suggestions> context block, the watcher for
// its project's pinned test commands, and (outside chats, which add it through chatSessionTools) the Suggestion tool.
import type { AppContext } from "../cli/runtime";
import type { AnyTool } from "../tools/types";
import { serviceInstalledProbe, suggestionContext } from "./signals";
import { SuggestionStore } from "./store";
import { createSuggestionTool } from "./tool";
import { createTestWatcher } from "./test-watch";

// One probe per computer, so every session of this process shares its ten-minute cache.
const probes = new Map<string, ReturnType<typeof serviceInstalledProbe>>();
const probeFor = (userHome: string) => {
  let probe = probes.get(userHome);
  if (!probe) probes.set(userHome, (probe = serviceInstalledProbe(userHome)));
  return probe;
};

/** The Suggestion tool over the owner's store. */
export const suggestionTool = (home: string): AnyTool => createSuggestionTool(new SuggestionStore(home));

/**
 * The context for an owner's session with suggestions switched on. Its block comes before blocks the context already
 * has (a worktree's); guests, scheduled runs and the heartbeat never go through this.
 */
export function withSuggestions(ctx: AppContext, o: { userHome: string; projectId: string; testCommands: string[] }): AppContext {
  const own = suggestionContext({ home: ctx.home, env: ctx.env, serviceInstalled: probeFor(o.userHome) });
  return {
    ...ctx,
    contextBlocks: async () => [...(await own()), ...((await ctx.contextBlocks?.()) ?? [])],
    testWatch: createTestWatcher(new SuggestionStore(ctx.home), o.projectId, o.testCommands),
  };
}
