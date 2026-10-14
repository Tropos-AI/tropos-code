// web/src/components/chat/tool-meta.ts — which icon a tool card shows (spec §5 "Tool call card").
import { parseMcpName } from "@core/ui/tool-view";

import type { IconName } from "@/components/ui/icon";

const ICONS: Record<string, IconName> = {
  Bash: "terminal",
  BashOutput: "terminal",
  KillShell: "terminal",
  Read: "file-text",
  Edit: "pencil",
  Write: "file-code",
  Glob: "search",
  Grep: "search",
  SessionSearch: "search",
  WebFetch: "external-link",
  WebSearch: "globe",
  Agent: "bot",
  Skill: "layers",
  SkillManage: "layers",
  TodoWrite: "square-check",
  Memory: "brain",
};

export function toolIcon(name: string): IconName {
  if (parseMcpName(name)) return "network";
  return ICONS[name] ?? "code";
}
