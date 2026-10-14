// src/ui/SessionPicker.tsx
import { Text, useInput } from "ink";
import { useState } from "react";
import type { SessionSummary } from "../session/store";
import { Pane } from "./design/Pane";
import { windowStart } from "./design/SelectList";
import { sanitizeForTerminal } from "./terminal-safe";
import { useTheme } from "./theme-context";

const VISIBLE = 10;
const TITLE_MAX = 60;

const title = (raw: string) => {
  const text = sanitizeForTerminal(raw).replace(/\s+/g, " ").trim();
  return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1)}…` : text;
};

export function age(date: Date, now = Date.now()): string {
  const seconds = Math.max(0, (now - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/** /resume: saved sessions for this directory, newest first, as a Pane with a `❯` cursor. */
export function SessionPicker({ sessions, onPick, onCancel }: { sessions: SessionSummary[]; onPick(id: string): void; onCancel(): void }) {
  const theme = useTheme();
  const [selected, setSelected] = useState(0);
  useInput((_input, key) => {
    if (key.escape) return onCancel();
    if (key.upArrow) return setSelected((s) => Math.max(0, s - 1));
    if (key.downArrow) return setSelected((s) => Math.min(sessions.length - 1, s + 1));
    if (key.return && sessions[selected]) onPick(sessions[selected]!.id);
  });
  const first = windowStart(selected, sessions.length, VISIBLE);
  const count = sessions.length === 1 ? "1 session" : `${sessions.length} sessions`;
  return (
    <Pane title="Resume a session" aside={count} footer="↑↓ to move · enter to resume · esc to cancel">
      {sessions.length === 0 ? <Text color={theme.muted}>No saved sessions in this directory yet.</Text> : null}
      {first > 0 ? <Text color={theme.muted}>{`  ↑ ${first} more`}</Text> : null}
      {sessions.slice(first, first + VISIBLE).map((s, i) => {
        const index = first + i;
        const active = index === selected;
        return (
          <Text key={s.id}>
            <Text color={theme.accent}>{active ? "❯ " : "  "}</Text>
            <Text color={active ? theme.accent : undefined} bold={active}>
              {title(s.title)}
            </Text>
            <Text color={theme.muted}>
              {"  "}
              {age(s.updatedAt)} · {s.messageCount} messages
            </Text>
          </Text>
        );
      })}
      {first + VISIBLE < sessions.length ? <Text color={theme.muted}>{`  ↓ ${sessions.length - first - VISIBLE} more`}</Text> : null}
    </Pane>
  );
}
