// src/ui/TranscriptRow.tsx
import { Box, Text } from "ink";
import { renderMarkdown } from "./markdown";
import { sanitizeForTerminal } from "./terminal-safe";
import { useTheme } from "./theme-context";
import { dotGlyph, turnDoneText } from "./tool-view";
import { ToolRow } from "./ToolRow";
import type { TranscriptItem } from "./transcript";

/** Live thinking shows only its tail; the full text is one ctrl+o away. */
const LIVE_THINKING_LINES = 3;
/** The live area is redrawn on every delta, so streaming text is bounded to its tail until the turn is done. */
const LIVE_TEXT_LINES = 30;

function liveTail(text: string): { earlier: number; shown: string } {
  const lines = sanitizeForTerminal(text).split("\n");
  const earlier = Math.max(0, lines.length - LIVE_TEXT_LINES);
  return { earlier, shown: lines.slice(earlier).join("\n") };
}

export interface TranscriptRowProps {
  item: TranscriptItem;
  /** Still streaming: text is shown raw and bounded, thinking shows its tail. */
  live?: boolean;
  width?: number;
  /** ctrl+o: full thinking, full tool output, full diffs. */
  verbose?: boolean;
  /** Tool paths inside it are shown relative. */
  cwd?: string;
}

export function TranscriptRow({ item, live = false, width = 80, verbose = false, cwd }: TranscriptRowProps) {
  const theme = useTheme();
  const dot = dotGlyph();
  switch (item.kind) {
    case "user":
      return (
        <Box marginTop={1} backgroundColor={theme.userBg} paddingRight={1}>
          <Text color={theme.subtle}>{"❯ "}</Text>
          <Text color={theme.text}>{sanitizeForTerminal(item.text)}</Text>
        </Box>
      );
    case "assistant": {
      const bodyWidth = Math.max(20, width - 2);
      let body;
      if (!live) {
        body = <Text>{renderMarkdown(item.text, bodyWidth)}</Text>;
      } else {
        const { earlier, shown } = liveTail(item.text);
        body = (
          <>
            {earlier > 0 ? <Text color={theme.muted}>… {earlier} earlier lines</Text> : null}
            <Text>{shown}</Text>
          </>
        );
      }
      return (
        <Box marginTop={1}>
          <Box flexShrink={0} width={2}>
            <Text color={theme.text}>{dot}</Text>
          </Box>
          <Box flexDirection="column" flexGrow={1}>
            {body}
          </Box>
        </Box>
      );
    }
    case "thinking": {
      if (!live && !verbose) {
        return (
          <Box marginTop={1}>
            <Text color={theme.muted} italic>
              ∴ Thinking (ctrl+o to expand)
            </Text>
          </Box>
        );
      }
      const lines = sanitizeForTerminal(item.text).trim().split("\n");
      const shown = verbose ? lines : lines.slice(-LIVE_THINKING_LINES);
      return (
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.muted} italic>
            ∴ Thinking…
          </Text>
          <Box paddingLeft={2}>
            <Text color={theme.muted} italic>
              {shown.join("\n")}
            </Text>
          </Box>
        </Box>
      );
    }
    case "tool":
      return (
        <Box marginTop={1}>
          <ToolRow item={item} width={width} verbose={verbose} cwd={cwd} />
        </Box>
      );
    case "notice": {
      const color = item.level === "error" ? theme.danger : item.level === "warn" ? theme.warning : theme.muted;
      return (
        <Box marginTop={1}>
          <Box flexShrink={0} width={2}>
            <Text color={color}>{dot}</Text>
          </Box>
          <Text color={color}>{sanitizeForTerminal(item.text)}</Text>
        </Box>
      );
    }
    case "turn_done":
      return (
        <Box marginTop={1}>
          <Text color={theme.muted}>✻ {turnDoneText(item.seconds)}</Text>
        </Box>
      );
  }
}
