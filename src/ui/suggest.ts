// src/ui/suggest.ts
import { COMMANDS, type ExtraCommand } from "./commands";
import { tokenAtCursor } from "./input-state";

/** One entry in the `/` dropdown. `kind` picks its color; `tag` is a dim `[project]`-style label. */
export interface SuggestCommand {
  name: string;
  description: string;
  kind: "builtin" | "custom" | "skill";
  argumentHint?: string;
  /** Where it came from, e.g. "project" or "plugin". Skills show `[skill]` when untagged. */
  tag?: string;
  /** True when the command needs an argument, so enter inserts `/name ` instead of submitting. */
  takesArgs?: boolean;
}

/** What the dropdown should show for the current input, if anything. */
export type SuggestionState =
  | { kind: "none" }
  /** `query` is the typed name without the leading `/`. */
  | { kind: "command"; query: string }
  /** `token` is the `@…` word ending at the cursor, with its range in the value. */
  | { kind: "file"; token: { start: number; end: number; text: string } };

/** Whether accepting the command should leave room for an argument rather than run it at once. */
export function needsArgs(command: SuggestCommand): boolean {
  return command.takesArgs === true || Boolean(command.argumentHint);
}

/**
 * Decides when the dropdown is open. Slash mode needs the whole input to be a single `/word` (no space yet),
 * so a path typed mid-sentence never pops it; file mode follows the token at the cursor, wherever it is.
 */
export function suggestionState(value: string, cursor: number): SuggestionState {
  if (/^\/[^\s/]*$/.test(value)) return { kind: "command", query: value.slice(1) };
  const token = tokenAtCursor({ value, cursor, historyIndex: null, draft: "" });
  if (token.text.startsWith("@")) return { kind: "file", token };
  return { kind: "none" };
}

/** 0 exact, 1 prefix, 2 substring of the name, 3 description match; -1 means no match. */
function score(query: string, command: SuggestCommand): number {
  const name = command.name.toLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  if (command.description.toLowerCase().includes(query)) return 3;
  return -1;
}

/**
 * Ranks commands for the `/` dropdown: exact name, then prefix, then name substring, then description
 * match; shorter names first among ties so `/he` puts `/help` above `/hooks-helper`. An empty query keeps
 * the given order, which lets the caller decide how the full list reads (built-ins first).
 */
export function rankCommands(query: string, commands: SuggestCommand[]): SuggestCommand[] {
  const q = query.replace(/^\//, "").toLowerCase();
  if (q === "") return [...commands];
  return commands
    .map((command) => ({ command, rank: score(q, command) }))
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.command.name.length - b.command.name.length || a.command.name.localeCompare(b.command.name))
    .map((entry) => entry.command);
}

/** The known command the input starts with (`/name` then whitespace or the end), for highlighting. */
export function leadingCommand(value: string, commands: SuggestCommand[]): SuggestCommand | undefined {
  const match = /^\/(\S+)(?:\s|$)/.exec(value);
  if (!match) return undefined;
  const name = match[1]!.toLowerCase();
  return commands.find((c) => c.name.toLowerCase() === name);
}

/** Built-in commands as suggestions. None of them require an argument, so enter runs them directly. */
export function builtinSuggestions(): SuggestCommand[] {
  return COMMANDS.map((c) => ({ name: c.name, description: c.description, kind: "builtin" as const }));
}

/**
 * Custom commands and skills as suggestions. Skills arrive from the runtime with a `(skill) ` description
 * prefix; that becomes the kind instead, so the dropdown shows a colored name and a `[skill]` tag.
 */
export function extraSuggestions(extra: ExtraCommand[]): SuggestCommand[] {
  return extra.map((c) =>
    c.description.startsWith("(skill) ")
      ? { name: c.name, description: c.description.slice("(skill) ".length), kind: "skill" as const }
      : { name: c.name, description: c.description, kind: "custom" as const, ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}) },
  );
}
