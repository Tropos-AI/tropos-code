// src/ui/TodoList.tsx
import { Box, Text } from "ink";
import type { Todo } from "../tools/types";
import { sanitizeForTerminal } from "./terminal-safe";
import { useTheme } from "./theme-context";

const ICON = { completed: "✔", in_progress: "◼", pending: "◻" } as const;

/** The todo list: done items struck through and quiet, the current one bold in accent, the rest plain. */
export function TodoList({ todos }: { todos: Todo[] }) {
  const theme = useTheme();
  return (
    <Box flexDirection="column">
      {todos.map((todo, i) => {
        const text = sanitizeForTerminal(todo.status === "in_progress" ? (todo.activeForm ?? todo.content) : todo.content).replace(/\s+/g, " ");
        const icon = ICON[todo.status] ?? ICON.pending;
        if (todo.status === "completed") {
          return (
            <Text key={i} color={theme.subtle}>
              {icon} <Text strikethrough>{text}</Text>
            </Text>
          );
        }
        if (todo.status === "in_progress") {
          return (
            <Text key={i} color={theme.accent} bold>
              {icon} {text}
            </Text>
          );
        }
        return (
          <Text key={i}>
            {icon} {text}
          </Text>
        );
      })}
    </Box>
  );
}
