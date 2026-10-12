// src/ui/TodoList.tsx
import { Box, Text } from "ink";
import type { Todo } from "../tools/types";
import { sanitizeForTerminal } from "./terminal-safe";
import { useTheme } from "./theme-context";

const ICON = { pending: "☐", in_progress: "◐", completed: "☑" } as const;

export function TodoList({ todos }: { todos: Todo[] }) {
  const theme = useTheme();
  return (
    <Box flexDirection="column">
      {todos.map((todo, i) => (
        <Text key={i} color={todo.status === "completed" ? theme.muted : todo.status === "in_progress" ? theme.accent : undefined} strikethrough={todo.status === "completed"} bold={todo.status === "in_progress"}>
          {ICON[todo.status]} {sanitizeForTerminal(todo.status === "in_progress" ? (todo.activeForm ?? todo.content) : todo.content)}
        </Text>
      ))}
    </Box>
  );
}
