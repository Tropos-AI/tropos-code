// src/ui/PermissionDialog.tsx
import { Box, Text, useInput } from "ink";
import { useLayoutEffect, useRef, useState } from "react";
import type { PermissionAnswer, PermissionPrompt } from "../agent/events";
import { makeDiff, patchBody } from "../tools/diff";
import { sanitizeForTerminal } from "./terminal-safe";
import { useTheme } from "./theme-context";

/** Keys are ignored for this long after a prompt appears, so typing that was already in flight cannot answer it. */
export const ANSWER_GRACE_MS = 400;
const PREVIEW_LINES = 20;
const HIDDEN = /[\u202A-\u202E\u2066-\u2069\u200B-\u200F\uFEFF]/g;

/** Terminal-safe text with bidi controls and zero-width characters made visible. */
function safe(text: string): string {
  return sanitizeForTerminal(text).replace(HIDDEN, (c) => `⟨U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}⟩`);
}

function title(prompt: PermissionPrompt): string {
  if (prompt.kind === "exec") return "Run this command?";
  if (prompt.toolName === "Edit") return "Make this edit?";
  if (prompt.kind === "edit") return "Write this file?";
  if (prompt.kind === "read") return "Read outside the project?";
  return `Allow ${safe(prompt.toolName)}?`;
}

interface PreviewLine {
  text: string;
  color?: string;
}

interface PreviewData {
  header?: string;
  lines: PreviewLine[];
  hidden: number;
  hiddenNote: string;
}

function buildPreview(prompt: PermissionPrompt, colors: { add: string; remove: string; muted: string }): PreviewData {
  const input = (prompt.input ?? {}) as Record<string, unknown>;
  const cap = (lines: PreviewLine[], note: string): PreviewData => ({
    lines: lines.slice(0, PREVIEW_LINES),
    hidden: Math.max(0, lines.length - PREVIEW_LINES),
    hiddenNote: note,
  });
  if (prompt.toolName === "Edit" && typeof input.old_string === "string" && typeof input.new_string === "string") {
    const body = patchBody(sanitizeForTerminal(makeDiff(prompt.summary, input.old_string, input.new_string).patch));
    const lines = body.map((l) => ({ text: safe(l), color: l.startsWith("+") ? colors.add : l.startsWith("-") ? colors.remove : colors.muted }));
    const data = cap(lines, "the full edit will be applied");
    return { ...data, header: `${safe(prompt.summary)}${input.replace_all === true ? " (replace all)" : ""}` };
  }
  if (prompt.toolName === "Write" && typeof input.content === "string") {
    const data = cap(input.content.split("\n").map((l) => ({ text: safe(l) })), "the full content will be written");
    return { ...data, header: safe(prompt.summary) };
  }
  if (prompt.kind === "exec") return cap(prompt.summary.split("\n").map((l) => ({ text: safe(l) })), "the full command will run");
  return cap(safe(prompt.summary).split("\n").map((text) => ({ text })), "the full text applies");
}

function Preview({ data }: { data: PreviewData }) {
  const theme = useTheme();
  return (
    <Box flexDirection="column">
      {data.header ? <Text color={theme.muted}>{data.header}</Text> : null}
      <Box flexDirection="column" borderStyle="single" borderColor={theme.muted} borderDimColor borderTop={false} borderBottom={false} borderRight={false} paddingLeft={1}>
        {data.lines.map((line, i) => (
          <Text key={i} color={line.color}>
            {line.text}
          </Text>
        ))}
      </Box>
      {data.hidden > 0 ? (
        <Text color={theme.warning}>
          … {data.hidden} more lines hidden — {data.hiddenNote}
        </Text>
      ) : null}
    </Box>
  );
}

export function PermissionDialog({ prompt, onAnswer }: { prompt: PermissionPrompt; onAnswer(answer: PermissionAnswer): void }) {
  const theme = useTheme();
  const preview = buildPreview(prompt, { add: theme.diffAdd, remove: theme.diffRemove, muted: theme.muted });
  // A command longer than the preview would run unseen, so it can never be allowed permanently.
  const suggestion = prompt.kind === "exec" && preview.hidden > 0 ? undefined : prompt.suggestion;
  const options: Array<{ label: string; answer: PermissionAnswer | null }> = [
    { label: "Yes", answer: { kind: "allow" } },
    ...(suggestion ? [{ label: `Yes, and don't ask again for ${suggestion}`, answer: { kind: "allow_always", rule: suggestion } as PermissionAnswer }] : []),
    { label: "No, tell Tropos what to do instead", answer: null },
  ];
  const [selected, setSelected] = useState(0);
  const [feedback, setFeedback] = useState<string | null>(null);
  const armed = useRef(false);
  const answered = useRef(false);

  // Each prompt starts fresh: nothing selected, no feedback, no answer given, and a quiet period before keys count.
  useLayoutEffect(() => {
    armed.current = false;
    answered.current = false;
    setSelected(0);
    setFeedback(null);
    const timer = setTimeout(() => {
      armed.current = true;
    }, ANSWER_GRACE_MS);
    return () => clearTimeout(timer);
  }, [prompt]);

  const answer = (a: PermissionAnswer) => {
    if (answered.current) return;
    answered.current = true;
    onAnswer(a);
  };

  const choose = (index: number) => {
    const option = options[index];
    if (!option) return;
    if (option.answer) answer(option.answer);
    else setFeedback("");
  };

  useInput((input, key) => {
    if (!armed.current || answered.current) return;
    if (feedback !== null) {
      if (key.escape) return answer({ kind: "deny" });
      if (key.return) return answer(feedback.trim() ? { kind: "deny", feedback: feedback.trim() } : { kind: "deny" });
      if (key.backspace || key.delete) return setFeedback(feedback.slice(0, -1));
      if (input && !key.ctrl && !key.meta) setFeedback(feedback + sanitizeForTerminal(input));
      return;
    }
    if (key.escape) return answer({ kind: "deny" });
    if (key.upArrow) return setSelected((s) => (s - 1 + options.length) % options.length);
    if (key.downArrow || key.tab) return setSelected((s) => (s + 1) % options.length);
    if (key.return) return choose(selected);
    if (input.length === 1 && /^[1-9]$/.test(input)) choose(Number(input) - 1);
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} marginTop={1}>
      <Text bold color={theme.accent}>
        {title(prompt)}
      </Text>
      <Box marginY={1} paddingLeft={2} flexDirection="column">
        <Preview data={preview} />
      </Box>
      {prompt.reason ? <Text color={theme.muted}>Why: {safe(prompt.reason)}</Text> : null}
      {options.map((option, i) => (
        <Text key={option.label} color={i === selected ? theme.accent : undefined}>
          {i === selected ? "› " : "  "}
          {i + 1}. {safe(option.label)}
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
