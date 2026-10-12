// src/ui/DiffView.tsx
import { Box, Text } from "ink";
import { patchBody } from "../tools/diff";
import { sanitizeForTerminal } from "./terminal-safe";
import { useTheme } from "./theme-context";

export function DiffView({ patch, maxLines = 40 }: { patch: string; maxLines?: number }) {
  const theme = useTheme();
  const lines = patchBody(sanitizeForTerminal(patch));
  const shown = lines.slice(0, maxLines);
  return (
    <Box flexDirection="column" paddingLeft={4}>
      {shown.map((line, i) => (
        <Text key={i} color={line.startsWith("+") ? theme.diffAdd : line.startsWith("-") ? theme.diffRemove : theme.muted}>
          {line}
        </Text>
      ))}
      {lines.length > maxLines && <Text color={theme.muted}>… {lines.length - maxLines} more lines</Text>}
    </Box>
  );
}
