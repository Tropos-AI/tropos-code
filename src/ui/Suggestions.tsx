// src/ui/Suggestions.tsx
import { Box, Text } from "ink";
import { windowStart } from "./design/SelectList";
import type { SuggestCommand } from "./suggest";
import { sanitizeForTerminal } from "./terminal-safe";
import type { Theme } from "./theme";
import { useTheme } from "./theme-context";

/** A dropdown row: a slash command, or a file path from `@` completion (stored with its `@`). */
export type Suggestion = { type: "command"; command: SuggestCommand } | { type: "file"; path: string };

/** Rows shown at once; the window follows the selection so long lists stay short on screen. */
export const MAX_SUGGESTIONS = 6;

/** Cuts `text` to `width` columns, ending with `…` when something was dropped. */
export function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  const chars = [...text];
  if (chars.length <= width) return text;
  return width === 1 ? "…" : `${chars.slice(0, width - 1).join("")}…`;
}

function kindColor(theme: Theme, command: SuggestCommand): string {
  return { builtin: theme.command, custom: theme.customCommand, skill: theme.skill }[command.kind];
}

function tagOf(command: SuggestCommand): string | undefined {
  return command.tag ?? (command.kind === "skill" ? "skill" : undefined);
}

/**
 * The live dropdown under the prompt. Pure rendering: PromptInput owns the list and the selection.
 * Names are padded to the longest visible name plus three so descriptions line up in one column.
 */
export function Suggestions({ items, selected, width }: { items: Suggestion[]; selected: number; width?: number }) {
  const theme = useTheme();
  if (items.length === 0) return null;
  // paddingX 2 on each side, so the text itself gets four columns less.
  const columns = Math.max(10, (width ?? process.stdout.columns ?? 80) - 4);
  const first = windowStart(selected, items.length, MAX_SUGGESTIONS);
  const shown = items.slice(first, first + MAX_SUGGESTIONS);
  const nameWidth = Math.max(...shown.map((s) => (s.type === "command" ? s.command.name.length + 1 : 0)));
  return (
    <Box flexDirection="column" paddingX={2}>
      {shown.map((item, i) => {
        const active = first + i === selected;
        if (item.type === "file") {
          const path = sanitizeForTerminal(item.path.replace(/^@/, ""));
          return (
            <Text key={`f:${item.path}`} color={active ? theme.accent : undefined} bold={active}>
              {truncate(`+ ${path}`, columns)}
            </Text>
          );
        }
        const { command } = item;
        const name = sanitizeForTerminal(`/${command.name}`);
        const tag = tagOf(command);
        const tagText = tag ? ` [${sanitizeForTerminal(tag)}]` : "";
        const padded = truncate(name.padEnd(nameWidth + 3), columns);
        const room = columns - padded.length - tagText.length;
        const description = truncate(sanitizeForTerminal(command.description).replace(/\s+/g, " "), room);
        return (
          <Text key={`c:${command.kind}:${command.name}`} wrap="truncate">
            <Text color={active ? theme.accent : kindColor(theme, command)} bold={active}>
              {padded}
            </Text>
            <Text color={active ? theme.accent : undefined} bold={active} dimColor={!active}>
              {description}
            </Text>
            {tagText && room > 0 ? <Text dimColor>{tagText}</Text> : null}
          </Text>
        );
      })}
    </Box>
  );
}
