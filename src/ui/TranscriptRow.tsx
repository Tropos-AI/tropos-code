// src/ui/TranscriptRow.tsx
import { Box, Text } from "ink";
import { renderMarkdown } from "./markdown";
import { sanitizeForTerminal } from "./terminal-safe";
import { useTheme } from "./theme-context";
import { ToolRow } from "./ToolRow";
import type { TranscriptItem } from "./transcript";

const THINKING_LINES = 6;
/** The live area is redrawn on every delta, so streaming text is bounded to its tail until the turn is done. */
const LIVE_TEXT_LINES = 30;

function liveTail(text: string): { earlier: number; shown: string } {
  const lines = sanitizeForTerminal(text).split("\n");
  const earlier = Math.max(0, lines.length - LIVE_TEXT_LINES);
  return { earlier, shown: lines.slice(earlier).join("\n") };
}

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
    case "assistant": {
      if (!live) {
        return (
          <Box marginTop={1} paddingLeft={2}>
            <Text>{renderMarkdown(item.text, Math.max(20, width - 4))}</Text>
          </Box>
        );
      }
      const { earlier, shown } = liveTail(item.text);
      return (
        <Box marginTop={1} paddingLeft={2} flexDirection="column">
          {earlier > 0 ? (
            <Text color={theme.muted} dimColor>
              … {earlier} earlier lines
            </Text>
          ) : null}
          <Text>{shown}</Text>
        </Box>
      );
    }
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
