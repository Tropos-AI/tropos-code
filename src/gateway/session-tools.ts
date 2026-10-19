// src/gateway/session-tools.ts — the tools a chat's session gets on top of its project's: who may schedule, change
// Tropos's setup, record suggestions, or switch projects. Scheduled runs and the heartbeat get none of them.
import { createSwitchProjectTool } from "../tools/setup/switch-project-tool";
import type { AnyTool } from "../tools/types";
import type { ChatProjects, SessionRole } from "./types";

export function chatSessionTools(
  base: AnyTool[],
  o: { role: SessionRole; chatKey?: string; cron?: () => AnyTool; setup?: () => AnyTool; suggestion?: () => AnyTool; projects?: ChatProjects },
): AnyTool[] {
  const out = [...base];
  const key = o.chatKey;
  // A person's chat, not a scheduled run (project:<id>[:guest]) or the heartbeat.
  const realChat = key !== undefined && !key.startsWith("project:") && !key.startsWith("heartbeat:");
  if (!realChat) return out;
  if (o.cron) out.push(o.cron());
  if (o.role === "owner" && o.setup) out.push(o.setup());
  if (o.role === "owner" && o.suggestion) out.push(o.suggestion());
  if (key.startsWith("telegram:") && o.projects) out.push(createSwitchProjectTool({ chatKey: key, projects: o.projects }));
  return out;
}
