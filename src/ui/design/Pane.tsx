// src/ui/design/Pane.tsx
import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { sanitizeForTerminal } from "../terminal-safe";
import { useTheme } from "../theme-context";

export interface PaneProps {
  title: string;
  subtitle?: string;
  /** Rule and title color; the accent by default. */
  color?: string;
  /** Dim key hints under the body, e.g. "↑↓ to move · enter to select · esc to close". */
  footer?: string;
  /** Right side of the title row, e.g. a count. */
  aside?: string;
  children: ReactNode;
}

/**
 * The frame every panel uses: a full-width rule in the panel's color, a bold title, the body indented
 * two columns, and dim key hints. Panels replace transcript messages for commands like /help and /mcp.
 */
export function Pane({ title, subtitle, color, footer, aside, children }: PaneProps) {
  const theme = useTheme();
  const tone = color ?? theme.accent;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box borderStyle="single" borderColor={tone} borderLeft={false} borderRight={false} borderBottom={false} />
      <Box flexDirection="column" paddingX={2}>
        <Box justifyContent="space-between">
          <Text bold color={tone}>
            {sanitizeForTerminal(title)}
          </Text>
          {aside ? <Text color={theme.muted}>{sanitizeForTerminal(aside)}</Text> : null}
        </Box>
        {subtitle ? <Text color={theme.muted}>{sanitizeForTerminal(subtitle)}</Text> : null}
        <Box flexDirection="column" marginTop={1}>
          {children}
        </Box>
        {footer ? (
          <Box marginTop={1}>
            <Text color={theme.muted} italic>
              {footer}
            </Text>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}
