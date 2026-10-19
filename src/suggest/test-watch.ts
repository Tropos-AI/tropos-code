// src/suggest/test-watch.ts — notices when the agent runs one of a project's pinned test commands and keeps the result,
// so a suite that fails can be raised later. It sees the same events the transcript does and changes nothing.
import type { AgentEvent } from "../agent/events";
import type { SuggestionStore } from "./store";

export function createTestWatcher(store: SuggestionStore, projectId: string, commands: string[]): { observe(e: AgentEvent): void } {
  const pinned = new Set(commands);
  // A Bash call's command, by tool id, until it ends.
  const running = new Map<string, string>();
  return {
    observe(e) {
      if (pinned.size === 0) return;
      if (e.type === "tool_start" && e.name === "Bash") running.set(e.id, e.summary);
      else if (e.type === "tool_end" && e.name === "Bash") {
        const command = running.get(e.id);
        running.delete(e.id);
        if (command !== undefined && pinned.has(command)) void store.recordTest(projectId, command, e.status !== "error").catch(() => {});
      }
    },
  };
}
