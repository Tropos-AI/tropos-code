// src/ui/StatusBar.tsx
import { Box, Text } from "ink";
import type { Mode } from "../config/constants";
import { useTheme } from "./theme-context";

export const MODE_LABELS: Record<Mode, string> = {
  default: "default mode",
  acceptEdits: "accept edits",
  plan: "plan mode",
  bypass: "bypass permissions",
};

export function StatusBar({ mode, contextPct, costUsd }: { mode: Mode; contextPct: number; costUsd: number }) {
  const theme = useTheme();
  const color = { default: theme.muted, acceptEdits: theme.accent, plan: theme.warning, bypass: theme.danger }[mode];
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text>
        <Text color={color} bold={mode !== "default"}>
          {MODE_LABELS[mode]}
        </Text>
        <Text color={theme.muted}>
          {" "}
          · ctx {contextPct}% · ${costUsd.toFixed(2)}
        </Text>
      </Text>
      <Text color={theme.muted}>shift+tab mode</Text>
    </Box>
  );
}
