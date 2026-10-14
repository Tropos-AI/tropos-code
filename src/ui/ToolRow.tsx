// src/ui/ToolRow.tsx
import { Box, Text } from "ink";
import { BlinkingDot } from "./BlinkingDot";
import { DiffView } from "./DiffView";
import { agentColor, type Theme } from "./theme";
import { useTheme } from "./theme-context";
import { TodoList } from "./TodoList";
import { dotGlyph, toolView, type Line, type ResultView } from "./tool-view";
import type { TranscriptItem } from "./transcript";

type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

/** The result gutter; result text lines up under the first column after it. */
const GUTTER = "  ⎿  ";
const GUTTER_WIDTH = GUTTER.length;

function LineText({ line, theme }: { line: Line; theme: Theme }) {
  return (
    <Text>
      {line.map((seg, i) => (
        <Text key={i} color={seg.color ? theme[seg.color] : undefined} bold={seg.bold}>
          {seg.text}
        </Text>
      ))}
    </Text>
  );
}

function ResultBody({ result, width, theme }: { result: ResultView; width: number; theme: Theme }) {
  switch (result.kind) {
    case "none":
      return null;
    case "lines":
      return (
        <Box flexDirection="column">
          {result.lines.map((line, i) => (
            <LineText key={i} line={line} theme={theme} />
          ))}
        </Box>
      );
    case "diff":
      return (
        <Box flexDirection="column">
          <LineText line={result.summary} theme={theme} />
          <DiffView patch={result.patch} width={width} verbose={result.verbose} />
        </Box>
      );
    case "todos":
      return <TodoList todos={result.todos} />;
    case "write-preview": {
      const numWidth = String(Math.max(1, result.lines.length)).length;
      return (
        <Box flexDirection="column">
          <LineText line={result.summary} theme={theme} />
          {result.lines.map((l, i) => (
            <Text key={i}>
              <Text color={theme.muted}>{String(i + 1).padStart(numWidth)} </Text>
              {l}
            </Text>
          ))}
          {result.more > 0 ? <Text color={theme.muted}>… +{result.more} {result.more === 1 ? "line" : "lines"}</Text> : null}
        </Box>
      );
    }
    case "agent-progress":
      return (
        <Box flexDirection="column">
          <Text color={theme.muted}>{result.progress ? `↳ ${result.progress}` : "Starting…"}</Text>
          <Text color={theme.muted}>
            {result.toolUses} tool {result.toolUses === 1 ? "use" : "uses"}
          </Text>
        </Box>
      );
  }
}

export interface ToolRowProps {
  item: ToolItem;
  /** Terminal columns available to the row. */
  width?: number;
  /** ctrl+o: full output and full diffs instead of previews. */
  verbose?: boolean;
  /** Paths inside it are shown relative. */
  cwd?: string;
}

/** `⏺ Name(args)`, then the result under a `⎿` gutter. */
export function ToolRow({ item, width = 80, verbose = false, cwd }: ToolRowProps) {
  const theme = useTheme();
  const view = toolView(item, cwd, { verbose });
  const glyph = dotGlyph();
  const dotColor = { done: theme.success, error: theme.danger, denied: theme.warning, running: theme.muted }[item.status];
  return (
    <Box flexDirection="column">
      <Box>
        <Box flexShrink={0}>
          {item.status === "running" ? <BlinkingDot glyph={glyph} color={theme.muted} /> : <Text color={dotColor}>{glyph}</Text>}
          <Text> </Text>
        </Box>
        <Text>
          {view.badge ? (
            <Text backgroundColor={agentColor(theme, view.badge.agent)} color="#FFFFFF" bold>
              {` ${view.badge.text} `}
            </Text>
          ) : null}
          {view.badge ? " " : ""}
          <Text bold>{view.title}</Text>
          {view.args ? `(${view.args})` : ""}
        </Text>
      </Box>
      {view.result.kind === "none" ? null : (
        <Box>
          <Box flexShrink={0} width={GUTTER_WIDTH}>
            <Text color={theme.muted}>{GUTTER}</Text>
          </Box>
          <Box flexDirection="column" flexGrow={1}>
            <ResultBody result={view.result} width={Math.max(20, width - GUTTER_WIDTH)} theme={theme} />
          </Box>
        </Box>
      )}
    </Box>
  );
}
