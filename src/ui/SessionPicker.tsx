// src/ui/SessionPicker.tsx
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { SessionSummary } from "../session/store";
import { sanitizeForTerminal } from "./terminal-safe";
import { useTheme } from "./theme-context";

const VISIBLE = 10;

export function age(date: Date, now = Date.now()): string {
  const seconds = Math.max(0, (now - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function SessionPicker({ sessions, onPick, onCancel }: { sessions: SessionSummary[]; onPick(id: string): void; onCancel(): void }) {
  const theme = useTheme();
  const [selected, setSelected] = useState(0);
  useInput((_input, key) => {
    if (key.escape) return onCancel();
    if (key.upArrow) return setSelected((s) => Math.max(0, s - 1));
    if (key.downArrow) return setSelected((s) => Math.min(sessions.length - 1, s + 1));
    if (key.return && sessions[selected]) onPick(sessions[selected]!.id);
  });
  const first = Math.max(0, Math.min(selected - Math.floor(VISIBLE / 2), sessions.length - VISIBLE));
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} marginTop={1}>
      <Text bold color={theme.accent}>
        Resume a session
      </Text>
      {sessions.slice(first, first + VISIBLE).map((s, i) => {
        const index = first + i;
        return (
          <Text key={s.id} color={index === selected ? theme.accent : undefined}>
            {index === selected ? "› " : "  "}
            {sanitizeForTerminal(s.title)}
            <Text color={theme.muted}>
              {"  "}
              {age(s.updatedAt)} · {s.messageCount} messages
            </Text>
          </Text>
        );
      })}
      <Text color={theme.muted}>enter to resume · esc to cancel</Text>
    </Box>
  );
}
