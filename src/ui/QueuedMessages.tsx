// src/ui/QueuedMessages.tsx
import { Box, Text } from "ink";
import { sanitizeForTerminal } from "./terminal-safe";
import { useTheme } from "./theme-context";

/** A queued message never takes more than this many rows, so a pasted file can't push the prompt off screen. */
export const QUEUED_MAX_LINES = 3;

/** The rows to draw for one queued message: sanitized, at most QUEUED_MAX_LINES, the last ending in `…` if cut. */
export function queuedLines(text: string): string[] {
  const lines = sanitizeForTerminal(text).split("\n");
  if (lines.length <= QUEUED_MAX_LINES) return lines;
  const kept = lines.slice(0, QUEUED_MAX_LINES);
  kept[QUEUED_MAX_LINES - 1] = `${kept[QUEUED_MAX_LINES - 1]} …`;
  return kept;
}

/** Messages typed while a turn runs, shown dim above the prompt until their own turn starts. */
export function QueuedMessages({ items }: { items: string[] }) {
  const theme = useTheme();
  if (items.length === 0) return null;
  return (
    <Box flexDirection="column">
      {items.map((item, i) => (
        <Box key={i} flexDirection="column">
          {queuedLines(item).map((line, j) => (
            <Text key={j} backgroundColor={theme.userBg} dimColor>
              {`${j === 0 ? "❯" : " "} ${line} `}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  );
}
