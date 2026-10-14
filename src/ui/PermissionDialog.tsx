// src/ui/PermissionDialog.tsx
import { Box, Text, useInput } from "ink";
import { useLayoutEffect, useRef, useState } from "react";
import type { PermissionAnswer, PermissionPrompt } from "../agent/events";
import { makeDiff, patchBody } from "../tools/diff";
import { Pane } from "./design/Pane";
import { learningPermissionTitle } from "./permission-titles";
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

/** The dialog title names the action, the way the transcript names the tool, so the prompt reads at a glance. */
export function permissionTitle(prompt: PermissionPrompt, newFile?: boolean): string {
  const learned = learningPermissionTitle(prompt.toolName);
  if (learned) return learned;
  if (prompt.toolName === "Bash" || prompt.kind === "exec") return "Bash command";
  if (prompt.toolName === "Write") return newFile ? "Create file" : "Write file";
  if (prompt.toolName === "Edit" || prompt.kind === "edit") return "Edit file";
  if (prompt.toolName === "WebFetch") return "Fetch";
  if (prompt.kind === "read") return "Read outside the project";
  return `Use ${safe(prompt.toolName)}`;
}

interface PreviewLine {
  text: string;
  color?: string;
  /** Full-line background for added and removed diff lines. */
  background?: string;
}

interface PreviewData {
  header?: string;
  lines: PreviewLine[];
  hidden: number;
  hiddenNote: string;
}

interface PreviewColors {
  text: string;
  addBg: string;
  removeBg: string;
  muted: string;
}

function buildPreview(prompt: PermissionPrompt, colors: PreviewColors): PreviewData {
  const input = (prompt.input ?? {}) as Record<string, unknown>;
  const cap = (lines: PreviewLine[], note: string): PreviewData => ({
    lines: lines.slice(0, PREVIEW_LINES),
    hidden: Math.max(0, lines.length - PREVIEW_LINES),
    hiddenNote: note,
  });
  if (prompt.preview) {
    const data = cap(prompt.preview.text.split("\n").map((l) => ({ text: safe(l) })), "the full text will be written");
    return { ...data, header: safe(prompt.preview.header) };
  }
  if (prompt.toolName === "Edit" && typeof input.old_string === "string" && typeof input.new_string === "string") {
    const body = patchBody(sanitizeForTerminal(makeDiff(prompt.summary, input.old_string, input.new_string).patch));
    const lines = body.map((l): PreviewLine => {
      if (l.startsWith("+")) return { text: safe(l), color: colors.text, background: colors.addBg };
      if (l.startsWith("-")) return { text: safe(l), color: colors.text, background: colors.removeBg };
      return { text: safe(l), color: colors.muted };
    });
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

/**
 * The preview sits behind a dim left gutter so that lines in a command or file (say "1. Yes") can never
 * pass for the dialog's own options. Diff lines get backgrounds padded to the widest line so the
 * change reads as a block.
 */
function Preview({ data }: { data: PreviewData }) {
  const theme = useTheme();
  const width = Math.max(1, ...data.lines.filter((l) => l.background).map((l) => l.text.length));
  return (
    <Box flexDirection="column">
      {data.header ? <Text bold>{data.header}</Text> : null}
      <Box flexDirection="column" borderStyle="single" borderColor={theme.muted} borderDimColor borderTop={false} borderBottom={false} borderRight={false} paddingLeft={1}>
        {data.lines.map((line, i) => (
          <Text key={i} color={line.color} backgroundColor={line.background}>
            {line.background ? line.text.padEnd(width) : line.text}
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

/**
 * Asks before a tool runs. Options are numbered (1 allow, 2 allow a rule for good when one is offered,
 * last: decline and tell Tropos what to do instead). Tab on any option opens that feedback line, so an
 * amendment is always a decline with instructions, never an approval of something unseen. Keys are
 * ignored for ANSWER_GRACE_MS after a prompt appears, and each prompt is answered at most once.
 *
 * `newFile` tells a Write that creates a file from one that overwrites, for the title only.
 */
export function PermissionDialog({ prompt, onAnswer, newFile }: { prompt: PermissionPrompt; onAnswer(answer: PermissionAnswer): void; newFile?: boolean }) {
  const theme = useTheme();
  const preview = buildPreview(prompt, { text: theme.text, addBg: theme.diffAddBg, removeBg: theme.diffRemoveBg, muted: theme.muted });
  // A command longer than the preview would run unseen, so it can never be allowed permanently.
  const suggestion = prompt.kind === "exec" && preview.hidden > 0 ? undefined : prompt.suggestion;
  const options: Array<{ label: string; answer: PermissionAnswer | null }> = [
    { label: "Yes", answer: { kind: "allow" } },
    ...(suggestion ? [{ label: `Yes, and don't ask again for ${suggestion}`, answer: { kind: "allow_always", rule: suggestion } as PermissionAnswer }] : []),
    { label: "No, and tell Tropos what to do differently", answer: null },
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
      if (input && !key.ctrl && !key.meta && !key.tab) setFeedback(feedback + sanitizeForTerminal(input));
      return;
    }
    if (key.escape) return answer({ kind: "deny" });
    // Tab amends: whatever is highlighted, it opens the "tell Tropos" line and the answer becomes a decline.
    if (key.tab) return setFeedback("");
    if (key.upArrow) return setSelected((s) => (s - 1 + options.length) % options.length);
    if (key.downArrow) return setSelected((s) => (s + 1) % options.length);
    if (key.return) return choose(selected);
    if (input.length === 1 && /^[1-9]$/.test(input)) choose(Number(input) - 1);
  });

  return (
    <Pane title={permissionTitle(prompt, newFile)} footer={feedback === null ? "Esc to cancel · Tab to amend" : "Enter to send · Esc to cancel"}>
      <Preview data={preview} />
      {prompt.reason ? (
        <Box marginTop={1}>
          <Text color={theme.muted}>Why: {safe(prompt.reason)}</Text>
        </Box>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        <Text>Do you want to proceed?</Text>
        {options.map((option, i) => {
          const active = i === selected && feedback === null;
          return (
            <Text key={option.label} color={active ? theme.accent : undefined}>
              <Text color={theme.accent}>{active ? "❯ " : "  "}</Text>
              <Text color={active ? theme.accent : theme.muted}>{`${i + 1}. `}</Text>
              {safe(option.label)}
            </Text>
          );
        })}
      </Box>
      {feedback !== null ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.muted}>Tell Tropos what to do differently:</Text>
          <Text>
            <Text color={theme.accent}>{"❯ "}</Text>
            {sanitizeForTerminal(feedback)}
            <Text inverse> </Text>
          </Text>
        </Box>
      ) : null}
    </Pane>
  );
}
