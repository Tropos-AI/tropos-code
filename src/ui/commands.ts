import { EFFORTS, type Effort } from "../config/constants";

export const COMMANDS = [
  { name: "help", description: "Show commands and shortcuts" },
  { name: "clear", description: "Start a new session" },
  { name: "resume", description: "Resume an earlier session in this directory" },
  { name: "model", description: "Show or set the model, e.g. /model deepseek/deepseek-chat" },
  { name: "providers", description: "Connect a provider (OpenAI, xAI, DeepSeek…) and pick a model" },
  { name: "effort", description: "Show or set effort: low, medium, high, xhigh, max" },
  { name: "cost", description: "Show this session's cost and context size" },
  { name: "init", description: "Create or improve TROPOS.md for this project" },
  { name: "undo", description: "Revert the files Tropos changed in the last turn" },
  { name: "redo", description: "Re-apply the changes /undo reverted" },
  { name: "skills", description: "List skills (also usable as /skill-name)" },
  { name: "agents", description: "List subagents the Agent tool can start" },
  { name: "hooks", description: "List configured hooks" },
  { name: "mcp", description: "Show MCP servers and their tools" },
  { name: "plugins", description: "List plugins in ~/.tropos/plugins" },
  { name: "memory", description: "Show Tropos's notes about you and this work" },
  { name: "learn", description: "Save what worked in this session as a reusable skill" },
  { name: "exit", description: "Quit Tropos Code" },
] as const;

/** Names custom commands and skills may not take. */
export const RESERVED_COMMANDS = new Set<string>([...COMMANDS.map((c) => c.name), "quit", "provider"]);

export const LEARN_PROMPT =
  "Look back over this session and find the reusable procedure in it: the steps, commands, checks and pitfalls that would help next time. " +
  "Save it as a skill with the SkillManage tool (action create): a kebab-case name, a SKILL.md whose frontmatter has a description that starts with " +
  '"Use when …" and says when the skill applies, and a body with When to use, Steps, Pitfalls and Verification sections. ' +
  "Write lessons, not a log of what happened. If a skill for this already exists, patch it instead. Tell me what you saved.";

export type ListTopic = "skills" | "agents" | "hooks" | "mcp" | "plugins" | "memory";

/** Extra entries for /help and completion: custom commands and user-invocable skills. */
export interface ExtraCommand {
  name: string;
  description: string;
  argumentHint?: string;
}

export const INIT_PROMPT =
  "Look through this repository and write a TROPOS.md file at its root for future Tropos Code sessions. " +
  "Cover how to build, test, lint and run it (exact commands, including how to run a single test), " +
  "the architecture at the level that takes reading several files to learn, and conventions that aren't obvious from the code. " +
  "Keep it under 150 lines, skip generic advice, and include nothing you can't verify in the repo. " +
  "If TROPOS.md already exists, improve it instead of replacing it.";

export type CommandResult =
  | { kind: "none" }
  | { kind: "help"; text: string }
  | { kind: "clear" }
  | { kind: "exit" }
  | { kind: "resume" }
  | { kind: "model"; model?: string }
  | { kind: "providers" }
  | { kind: "effort"; effort?: Effort; error?: string }
  | { kind: "cost" }
  | { kind: "prompt"; text: string }
  | { kind: "list"; what: ListTopic }
  | { kind: "undo" }
  | { kind: "redo" }
  | { kind: "custom"; name: string; args: string }
  | { kind: "unknown"; name: string };

const SHORTCUTS = [
  ["shift+tab", "cycle permission mode"],
  ["esc", "interrupt Tropos"],
  ["\\ then enter", "new line"],
  ["@", "complete a file path (tab)"],
  ["↑ / ↓", "input history"],
  ["ctrl+c", "interrupt, or quit when idle"],
] as const;

export function helpText(extra: ExtraCommand[] = []): string {
  const commands = COMMANDS.map((c) => `  /${c.name.padEnd(10)} ${c.description}`);
  const custom = extra.map((c) => {
    const name = `/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ""}`;
    return `  ${name.padEnd(10)} ${c.description}`;
  });
  const shortcuts = SHORTCUTS.map(([key, what]) => `  ${key.padEnd(12)} ${what}`);
  return ["Commands", ...commands, ...(custom.length ? ["", "Custom commands and skills", ...custom] : []), "", "Shortcuts", ...shortcuts].join("\n");
}

/** `extra` holds custom command and skill names; built-ins always win. */
export function parseCommand(input: string, extra: ExtraCommand[] = []): CommandResult {
  const text = input.trim();
  if (!text.startsWith("/")) return { kind: "none" };
  const [head = "", ...rest] = text.slice(1).split(/\s+/);
  if (head.includes("/") || head === "") return { kind: "none" }; // a path such as /usr/bin/env
  const arg = rest.join(" ").trim();
  switch (head.toLowerCase()) {
    case "help":
      return { kind: "help", text: helpText(extra) };
    case "clear":
      return { kind: "clear" };
    case "exit":
    case "quit":
      return { kind: "exit" };
    case "resume":
      return { kind: "resume" };
    case "cost":
      return { kind: "cost" };
    case "init":
      return { kind: "prompt", text: INIT_PROMPT };
    case "learn":
      return { kind: "prompt", text: arg ? `${LEARN_PROMPT}\n\nFocus on: ${arg}` : LEARN_PROMPT };
    case "undo":
      return { kind: "undo" };
    case "redo":
      return { kind: "redo" };
    case "skills":
    case "agents":
    case "hooks":
    case "mcp":
    case "plugins":
    case "memory":
      return { kind: "list", what: head.toLowerCase() as ListTopic };
    case "model":
      return arg ? { kind: "model", model: arg } : { kind: "model" };
    case "providers":
    case "provider":
      return { kind: "providers" };
    case "effort":
      if (!arg) return { kind: "effort" };
      return (EFFORTS as readonly string[]).includes(arg)
        ? { kind: "effort", effort: arg as Effort }
        : { kind: "effort", error: `Effort must be one of: ${EFFORTS.join(", ")}.` };
    default:
      if (extra.some((c) => c.name === head)) return { kind: "custom", name: head, args: arg };
      return { kind: "unknown", name: head };
  }
}
