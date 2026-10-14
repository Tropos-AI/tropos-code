// src/ui/Footer.tsx
import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { Mode } from "../config/constants";
import { useTheme } from "./theme-context";

/** Right side: `ctx 12% · $0.42`, dropping whichever part is unknown (no window size or no price). */
export function usageText(contextPct: number | undefined, costUsd: number | undefined): string {
  const parts: string[] = [];
  if (contextPct !== undefined) parts.push(`ctx ${contextPct}%`);
  if (costUsd !== undefined) parts.push(`$${costUsd.toFixed(2)}`);
  return parts.join(" · ");
}

/**
 * The one row under the prompt. A non-default permission mode always wins the left side because it changes
 * what Tropos may do without asking; otherwise it hints at the key that matters right now.
 */
export function Footer({
  mode,
  busy,
  empty,
  contextPct,
  costUsd,
}: {
  mode: Mode;
  busy: boolean;
  empty: boolean;
  contextPct?: number;
  costUsd?: number;
}) {
  const theme = useTheme();
  const interrupt = busy ? <Text dimColor>{" · esc to interrupt"}</Text> : null;
  let left: ReactNode = null;
  if (mode === "acceptEdits") left = <Text color={theme.acceptEdits}>⏵⏵ accept edits on (shift+tab to cycle)</Text>;
  else if (mode === "plan") left = <Text color={theme.planMode}>⏸ plan mode on (shift+tab to cycle)</Text>;
  else if (mode === "bypass") left = <Text color={theme.danger}>⏵⏵ bypass permissions on</Text>;
  const usage = usageText(contextPct, costUsd);
  return (
    <Box justifyContent="space-between" paddingX={2}>
      {left ? (
        <Text>
          {left}
          {interrupt}
        </Text>
      ) : busy ? (
        <Text dimColor>esc to interrupt</Text>
      ) : empty ? (
        <Text dimColor>? for shortcuts</Text>
      ) : (
        <Text> </Text>
      )}
      {usage ? <Text dimColor>{usage}</Text> : null}
    </Box>
  );
}
