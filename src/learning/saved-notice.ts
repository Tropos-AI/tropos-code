// src/learning/saved-notice.ts
import { STORE_TOOLS } from "./stores";

const MAX = 160;

const clip = (text: string): string => (text.length > MAX ? `${text.slice(0, MAX - 1)}…` : text);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** The one-line notice for a store tool's finished save, or undefined for a tool or action that saves nothing to announce. */
export function savedNotice(tool: string, input: unknown): string | undefined {
  if (!(STORE_TOOLS as readonly string[]).includes(tool)) return undefined;
  const i = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  switch (tool) {
    case "Memory": {
      if (Array.isArray(i.operations)) return clip(`💡 Updated memory (${i.operations.length} changes)`);
      return clip(i.action === "remove" ? `💡 Forgot: ${str(i.old_text)}` : `💡 Remembered: ${str(i.content)}`);
    }
    case "DailyNote":
      return "📓 Added to today's journal";
    case "SkillManage": {
      const verb = i.action === "create" ? "saved" : i.action === "delete" ? "deleted" : "updated";
      return clip(`🛠 Skill ${verb}: ${str(i.name)}`);
    }
    case "AgentManage": {
      const verb = i.action === "create" ? "created" : i.action === "delete" ? "deleted" : "updated";
      return clip(`🧩 Agent ${verb}: ${str(i.name)}`);
    }
    case "Identity":
      return i.action === "set" ? "🪪 Identity updated" : i.action === "soul" ? "🪪 SOUL.md updated" : undefined;
    default:
      return undefined;
  }
}
