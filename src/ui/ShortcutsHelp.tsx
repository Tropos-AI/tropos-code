// src/ui/ShortcutsHelp.tsx
import { Box, Text } from "ink";

/** Grouped by column: how to enter things, how to steer a turn, how to get around. */
export const SHORTCUT_COLUMNS: string[][] = [
  ["/ for commands", "@ for files", "\\ ⏎ for newline"],
  ["shift+tab to cycle modes", "esc to interrupt", "ctrl+o verbose output"],
  ["↑ history / queued", "ctrl+c to quit", "? to close"],
];

/** Shown in place of the footer after `?` on an empty prompt; any key closes it again. */
export function ShortcutsHelp() {
  return (
    <Box paddingX={2} flexDirection="row" flexWrap="wrap">
      {SHORTCUT_COLUMNS.map((column, i) => (
        <Box key={i} flexDirection="column" marginRight={4}>
          {column.map((line) => (
            <Text key={line} dimColor>
              {line}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  );
}
