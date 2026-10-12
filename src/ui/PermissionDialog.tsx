// src/ui/PermissionDialog.tsx
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { PermissionAnswer, PermissionPrompt } from "../agent/events";
import { makeDiff } from "../tools/diff";
import { DiffView } from "./DiffView";
import { sanitizeForTerminal } from "./terminal-safe";
import { useTheme } from "./theme-context";

function title(prompt: PermissionPrompt): string {
  if (prompt.kind === "exec") return "Run this command?";
  if (prompt.toolName === "Edit") return "Make this edit?";
  if (prompt.kind === "edit") return "Write this file?";
  if (prompt.kind === "read") return "Read outside the project?";
  return `Allow ${sanitizeForTerminal(prompt.toolName)}?`;
}

function Preview({ prompt }: { prompt: PermissionPrompt }) {
  const theme = useTheme();
  const input = (prompt.input ?? {}) as Record<string, unknown>;
  const summary = sanitizeForTerminal(prompt.summary);
  if (prompt.toolName === "Edit" && typeof input.old_string === "string" && typeof input.new_string === "string") {
    return (
      <Box flexDirection="column">
        <Text color={theme.muted}>{summary}</Text>
        <DiffView patch={makeDiff(prompt.summary, input.old_string, input.new_string).patch} maxLines={20} />
      </Box>
    );
  }
  if (prompt.toolName === "Write" && typeof input.content === "string") {
    const lines = input.content.split("\n");
    return (
      <Box flexDirection="column">
        <Text color={theme.muted}>{summary}</Text>
        <Box paddingLeft={4} flexDirection="column">
          <Text>{sanitizeForTerminal(lines.slice(0, 10).join("\n"))}</Text>
          {lines.length > 10 && <Text color={theme.muted}>… {lines.length - 10} more lines</Text>}
        </Box>
      </Box>
    );
  }
  return <Text>{summary}</Text>;
}

export function PermissionDialog({ prompt, onAnswer }: { prompt: PermissionPrompt; onAnswer(answer: PermissionAnswer): void }) {
  const theme = useTheme();
  const options: Array<{ label: string; answer: PermissionAnswer | null }> = [
    { label: "Yes", answer: { kind: "allow" } },
    ...(prompt.suggestion
      ? [{ label: `Yes, and don't ask again for ${prompt.suggestion}`, answer: { kind: "allow_always", rule: prompt.suggestion } as PermissionAnswer }]
      : []),
    { label: "No, tell Tropos what to do instead", answer: null },
  ];
  const [selected, setSelected] = useState(0);
  const [feedback, setFeedback] = useState<string | null>(null);

  const choose = (index: number) => {
    const option = options[index];
    if (!option) return;
    if (option.answer) onAnswer(option.answer);
    else setFeedback("");
  };

  useInput((input, key) => {
    if (feedback !== null) {
      if (key.escape) return onAnswer({ kind: "deny" });
      if (key.return) return onAnswer(feedback.trim() ? { kind: "deny", feedback: feedback.trim() } : { kind: "deny" });
      if (key.backspace || key.delete) return setFeedback(feedback.slice(0, -1));
      if (input && !key.ctrl && !key.meta) setFeedback(feedback + input);
      return;
    }
    if (key.escape) return onAnswer({ kind: "deny" });
    if (key.upArrow) return setSelected((s) => (s - 1 + options.length) % options.length);
    if (key.downArrow || key.tab) return setSelected((s) => (s + 1) % options.length);
    if (key.return) return choose(selected);
    const n = Number(input);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) choose(n - 1);
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} marginTop={1}>
      <Text bold color={theme.accent}>
        {title(prompt)}
      </Text>
      <Box marginY={1} paddingLeft={2} flexDirection="column">
        <Preview prompt={prompt} />
      </Box>
      {prompt.reason ? <Text color={theme.muted}>Why: {sanitizeForTerminal(prompt.reason)}</Text> : null}
      {options.map((option, i) => (
        <Text key={option.label} color={i === selected ? theme.accent : undefined}>
          {i === selected ? "› " : "  "}
          {i + 1}. {sanitizeForTerminal(option.label)}
        </Text>
      ))}
      {feedback !== null ? (
        <Text>
          <Text color={theme.muted}>{"  Tell Tropos: "}</Text>
          {sanitizeForTerminal(feedback)}
          <Text inverse> </Text>
        </Text>
      ) : null}
      <Text color={theme.muted}>esc to decline</Text>
    </Box>
  );
}
