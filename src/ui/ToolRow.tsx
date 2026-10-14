// src/ui/ToolRow.tsx
import { Box, Text } from "ink";
import { DiffView } from "./DiffView";
import { sanitizeForTerminal } from "./terminal-safe";
import { useTheme } from "./theme-context";
import { TodoList } from "./TodoList";
import type { TranscriptItem } from "./transcript";

type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const firstLine = (content: unknown) => (typeof content === "string" ? truncate(sanitizeForTerminal(content).split("\n")[0] ?? "", 120) : "");

export function ToolRow({ item }: { item: ToolItem }) {
  const theme = useTheme();
  const color = { running: theme.accent, done: theme.success, error: theme.danger, denied: theme.warning }[item.status];
  const display = item.output?.display;
  const result =
    item.status === "running"
      ? null
      : item.status === "denied"
        ? "declined"
        : item.status === "error"
          ? firstLine(item.output?.content)
          : item.output?.summary === undefined ? undefined : sanitizeForTerminal(item.output.summary);
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={color}>● </Text>
        <Text bold>{sanitizeForTerminal(item.name)}</Text>
        <Text color={theme.muted}> {truncate(sanitizeForTerminal(item.summary).replace(/\s+/g, " "), 100)}</Text>
      </Text>
      {item.status === "running" && item.progress ? (
        <Text color={theme.muted}>
          {"  ↳ "}
          {truncate(sanitizeForTerminal(item.progress).replace(/\s+/g, " "), 110)}
        </Text>
      ) : null}
      {result ? (
        <Text color={item.status === "error" ? theme.danger : theme.muted}>
          {"  ⎿ "}
          {result}
        </Text>
      ) : null}
      {display?.kind === "diff" && item.status === "done" ? <DiffView patch={display.patch} /> : null}
      {display?.kind === "todos" ? (
        <Box paddingLeft={4}>
          <TodoList todos={display.todos} />
        </Box>
      ) : null}
    </Box>
  );
}
