// src/ui/TranscriptRow.tsx
import { Box, Text } from "ink";
import { renderMarkdown } from "./markdown";
import { sanitizeForTerminal } from "./terminal-safe";
import { useTheme } from "./theme-context";
import { ToolRow } from "./ToolRow";
import type { TranscriptItem } from "./transcript";

const THINKING_LINES = 6;

export function TranscriptRow({ item, live = false, width = 80 }: { item: TranscriptItem; live?: boolean; width?: number }) {
  const theme = useTheme();
  switch (item.kind) {
    case "user":
      return (
        <Box marginTop={1}>
          <Text color={theme.accent}>{"› "}</Text>
          <Text>{sanitizeForTerminal(item.text)}</Text>
        </Box>
      );
    case "assistant":
      return (
        <Box marginTop={1} paddingLeft={2}>
          <Text>{live ? sanitizeForTerminal(item.text) : renderMarkdown(item.text, Math.max(20, width - 4))}</Text>
        </Box>
      );
    case "thinking": {
      const lines = sanitizeForTerminal(item.text).trim().split("\n");
      const shown = lines.slice(-THINKING_LINES).join("\n");
      return (
        <Box paddingLeft={2}>
          <Text color={theme.muted} italic>
            ∴ {shown}
          </Text>
        </Box>
      );
    }
    case "tool":
      return (
        <Box paddingLeft={2} marginTop={1}>
          <ToolRow item={item} />
        </Box>
      );
    case "notice": {
      const color = item.level === "error" ? theme.danger : item.level === "warn" ? theme.warning : theme.muted;
      return (
        <Box paddingLeft={2} marginTop={1}>
          <Text color={color}>{sanitizeForTerminal(item.text)}</Text>
        </Box>
      );
    }
  }
}
