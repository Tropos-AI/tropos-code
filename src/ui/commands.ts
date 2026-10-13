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
  { name: "exit", description: "Quit Tropos Code" },
] as const;

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
  | { kind: "unknown"; name: string };

const SHORTCUTS = [
  ["shift+tab", "cycle permission mode"],
  ["esc", "interrupt Tropos"],
  ["\\ then enter", "new line"],
  ["@", "complete a file path (tab)"],
  ["↑ / ↓", "input history"],
  ["ctrl+c", "interrupt, or quit when idle"],
] as const;

export function helpText(): string {
  const commands = COMMANDS.map((c) => `  /${c.name.padEnd(10)} ${c.description}`);
  const shortcuts = SHORTCUTS.map(([key, what]) => `  ${key.padEnd(12)} ${what}`);
  return ["Commands", ...commands, "", "Shortcuts", ...shortcuts].join("\n");
}

export function parseCommand(input: string): CommandResult {
  const text = input.trim();
  if (!text.startsWith("/")) return { kind: "none" };
  const [head = "", ...rest] = text.slice(1).split(/\s+/);
  if (head.includes("/") || head === "") return { kind: "none" }; // a path such as /usr/bin/env
  const arg = rest.join(" ").trim();
  switch (head.toLowerCase()) {
    case "help":
      return { kind: "help", text: helpText() };
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
      return { kind: "unknown", name: head };
  }
}
