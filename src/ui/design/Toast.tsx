// src/ui/design/Toast.tsx
import { Text } from "ink";
import { sanitizeForTerminal } from "../terminal-safe";
import { useTheme } from "../theme-context";

export type ToastLevel = "info" | "success" | "warn" | "error";

/**
 * A one-line result shown just above the prompt for a few seconds, for command outcomes that don't
 * belong in the conversation ("Model set to …", "Reverted 3 files").
 */
export function Toast({ level, text }: { level: ToastLevel; text: string }) {
  const theme = useTheme();
  const color = { info: theme.accent, success: theme.success, warn: theme.warning, error: theme.danger }[level];
  const glyph = { info: "●", success: "✔", warn: "△", error: "✘" }[level];
  return (
    <Text>
      <Text color={color}>{`  ${glyph} `}</Text>
      <Text color={level === "info" ? undefined : color}>{sanitizeForTerminal(text)}</Text>
    </Text>
  );
}
