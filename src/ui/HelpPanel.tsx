// src/ui/HelpPanel.tsx — /help: a tabbed panel instead of a wall of text in the transcript.
import { Box, Text, useInput } from "ink";
import { useState, type ReactNode } from "react";
import { COMMANDS, type ExtraCommand } from "./commands";
import { Pane } from "./design/Pane";
import { Tabs } from "./design/Tabs";
import { sanitizeForTerminal } from "./terminal-safe";
import type { Theme } from "./theme";
import { useTheme } from "./theme-context";

/** A custom command or skill for the Custom tab; `kind` wins over the "(skill)" description prefix. */
export interface HelpCommand extends ExtraCommand {
  kind?: "custom" | "skill";
}

export const HELP_TABS = ["General", "Commands", "Custom", "Shortcuts"] as const;

/** The same keys the prompt's shortcut grid lists, so /help and `?` never disagree. */
export const HELP_SHORTCUTS: ReadonlyArray<readonly [string, string]> = [
  ["shift+tab", "cycle permission mode (default, accept edits, plan)"],
  ["esc", "interrupt Tropos; again on an empty input clears the queue"],
  ["ctrl+o", "toggle verbose output (full tool results and thinking)"],
  ["\\ then ⏎", "insert a new line"],
  ["↑ / ↓", "input history; ↑ on an empty input edits queued messages"],
  ["@", "mention a file (tab to complete)"],
  ["/", "commands and skills, with suggestions as you type"],
  ["?", "show shortcuts under the prompt"],
  ["ctrl+c", "interrupt, or quit when idle"],
];

const GENERAL = [
  "Tropos Code is a coding agent in your terminal: it reads, edits and runs code in this project.",
  "",
  "Type what you want in plain words and press enter. You can keep typing while it works;",
  "messages sent mid-turn are queued and run next.",
  "Mention files with @path to put them in front of Tropos, and type / for commands and skills.",
  "shift+tab cycles modes: default asks before edits and commands, accept edits applies edits",
  "without asking, and plan mode looks around and proposes a plan before changing anything.",
  "Permission prompts let you allow once, allow a rule for good, or say no and tell Tropos why.",
];

const SKILL_PREFIX = /^\(skill\)\s*/;

/** Skill or custom command: the explicit kind, else the "(skill)" prefix extraCommands() puts on skills. */
export function commandKind(command: HelpCommand): "custom" | "skill" {
  return command.kind ?? (SKILL_PREFIX.test(command.description) ? "skill" : "custom");
}

/** One-line text: no control sequences, no line breaks that would break the columns. */
const oneLine = (text: string) => sanitizeForTerminal(text).replace(/\s+/g, " ").trim();

/**
 * /help as a Pane with four tabs. ←/→, tab and shift+tab switch tabs; ↑/↓ scroll a tab that is taller
 * than `height` rows; esc closes. Nothing here goes into the transcript.
 */
export function HelpPanel({ version, commands, onClose, height = 14 }: { version: string; commands: HelpCommand[]; onClose(): void; height?: number }) {
  const theme = useTheme();
  const [tab, setTab] = useState(0);
  const [offset, setOffset] = useState(0);

  const rows = tabRows(tab, commands, theme);
  const maxOffset = Math.max(0, rows.length - height);
  const first = Math.min(offset, maxOffset);

  const switchTo = (next: number) => {
    setTab((next + HELP_TABS.length) % HELP_TABS.length);
    setOffset(0);
  };

  useInput((_input, key) => {
    if (key.escape) return onClose();
    if (key.rightArrow || (key.tab && !key.shift)) return switchTo(tab + 1);
    if (key.leftArrow || (key.tab && key.shift)) return switchTo(tab - 1);
    const scroll = (by: number) => setOffset((o) => Math.max(0, Math.min(maxOffset, Math.min(o, maxOffset) + by)));
    if (key.upArrow) return scroll(-1);
    if (key.downArrow) return scroll(1);
    if (key.pageUp) return scroll(-height);
    if (key.pageDown) return scroll(height);
  });

  const shown = rows.slice(first, first + height);
  return (
    <Pane title={`Tropos Code v${version}`} footer="←/→ or tab to switch · ↑↓ to scroll · esc to close">
      <Tabs tabs={[...HELP_TABS]} active={tab} />
      <Box flexDirection="column" marginTop={1}>
        {first > 0 ? <Text color={theme.muted}>{`↑ ${first} more`}</Text> : null}
        {shown.map((row, i) => (
          <Box key={first + i}>{row}</Box>
        ))}
        {first + height < rows.length ? <Text color={theme.muted}>{`↓ ${rows.length - first - height} more`}</Text> : null}
      </Box>
    </Pane>
  );
}

/** Each tab as a list of one-line rows, so long tabs scroll by row. */
function tabRows(tab: number, commands: HelpCommand[], theme: Theme): ReactNode[] {
  if (tab === 0) return GENERAL.map((line) => <Text>{line || " "}</Text>);
  if (tab === 1) {
    const width = Math.max(...COMMANDS.map((c) => c.name.length)) + 4;
    return COMMANDS.map((c) => (
      <Text>
        <Text color={theme.command}>{`/${c.name}`.padEnd(width)}</Text>
        <Text color={theme.muted}>{c.description}</Text>
      </Text>
    ));
  }
  if (tab === 2) {
    if (commands.length === 0) {
      return [
        <Text color={theme.muted}>No custom commands or skills yet.</Text>,
        <Text color={theme.muted}>Add commands as .tropos/commands/name.md and skills as .tropos/skills/name/SKILL.md.</Text>,
      ];
    }
    const names = commands.map((c) => oneLine(`/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ""}`));
    const width = Math.max(...names.map((n) => n.length)) + 3;
    return commands.map((c, i) => {
      const kind = commandKind(c);
      return (
        <Text>
          <Text color={kind === "skill" ? theme.skill : theme.customCommand}>{names[i]!.padEnd(width)}</Text>
          <Text color={theme.muted}>{oneLine(c.description.replace(SKILL_PREFIX, ""))}</Text>
          {kind === "skill" ? <Text color={theme.subtle}>{"  [skill]"}</Text> : null}
        </Text>
      );
    });
  }
  const width = Math.max(...HELP_SHORTCUTS.map(([k]) => k.length)) + 3;
  return HELP_SHORTCUTS.map(([keys, what]) => (
    <Text>
      <Text color={theme.accent}>{keys.padEnd(width)}</Text>
      <Text color={theme.muted}>{what}</Text>
    </Text>
  ));
}
