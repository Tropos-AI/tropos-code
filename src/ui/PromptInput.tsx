// src/ui/PromptInput.tsx
import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { completeFile } from "./complete";
import { emptyInput, inputReducer, type InputState } from "./input-state";
import { ShortcutsHelp } from "./ShortcutsHelp";
import { leadingCommand, needsArgs, rankCommands, suggestionState, type SuggestCommand } from "./suggest";
import { Suggestions, type Suggestion } from "./Suggestions";
import { sanitizeForTerminal } from "./terminal-safe";
import type { Theme } from "./theme";
import { useTheme } from "./theme-context";

export const PLACEHOLDER = "Ask Tropos… (/ for commands, @ for files)";
export const BUSY_PLACEHOLDER = "Queue a message…";

export interface PromptInputProps {
  onSubmit(text: string): void;
  history: string[];
  cwd: string;
  /** Built-ins, custom commands and skills for the `/` dropdown and name highlighting. */
  commands?: SuggestCommand[];
  /** A turn is running: the glyph dims and the placeholder says enter will queue. */
  busy?: boolean;
  /** Drawn under the input when neither suggestions nor the shortcuts grid is showing. */
  footer?: ReactNode;
  onShortcutsToggle?(open: boolean): void;
  /** Lets the owner know the dropdown is open, so esc closes it instead of interrupting the turn. */
  onSuggestionsToggle?(open: boolean): void;
  /** Messages waiting for the turn to end; ↑ on an empty input takes them back via onRecallQueued. */
  queued?: string[];
  onRecallQueued?(): string | null;
  /** Reports whether the input is empty, so the footer can say "? for shortcuts" only then. */
  onEmptyChange?(empty: boolean): void;
  width?: number;
}

function kindColor(theme: Theme, command: SuggestCommand): string {
  return { builtin: theme.command, custom: theme.customCommand, skill: theme.skill }[command.kind];
}

interface Segment {
  text: string;
  highlight: boolean;
  cursor: boolean;
}

/** Splits a line at the highlight end and around the cursor so each piece can be styled on its own. */
export function lineSegments(line: string, cursorCol: number | null, highlightLen: number): Segment[] {
  const cursorEnd = cursorCol === null || cursorCol >= line.length ? null : cursorCol + String.fromCodePoint(line.codePointAt(cursorCol)!).length;
  const cuts = new Set([0, line.length, Math.min(highlightLen, line.length)]);
  if (cursorCol !== null && cursorEnd !== null) {
    cuts.add(cursorCol);
    cuts.add(cursorEnd);
  }
  const points = [...cuts].sort((a, b) => a - b);
  const segments: Segment[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const [from, to] = [points[i]!, points[i + 1]!];
    segments.push({ text: line.slice(from, to), highlight: from < highlightLen, cursor: from === cursorCol });
  }
  if (cursorCol !== null && cursorEnd === null) segments.push({ text: " ", highlight: false, cursor: true });
  return segments;
}

/**
 * The prompt: a ruled input box with live `/` and `@` suggestions, history, queue recall and a footer slot.
 * It stays mounted while a turn runs, so everything here must work while busy (enter then queues in App).
 */
export function PromptInput({
  onSubmit,
  history,
  cwd,
  commands = [],
  busy = false,
  footer,
  onShortcutsToggle,
  onSuggestionsToggle,
  queued = [],
  onRecallQueued,
  onEmptyChange,
  width,
}: PromptInputProps) {
  const theme = useTheme();
  const [state, dispatch] = useReducer(inputReducer, emptyInput);
  const safeHistory = useMemo(() => history.map(sanitizeForTerminal), [history]);
  const [submitted, setSubmitted] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  /** The suggestion context esc closed; the dropdown stays shut until the token differs from it. */
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ key: string; index: number }>({ key: "", index: 0 });
  const [files, setFiles] = useState<{ token: string; items: string[] }>({ token: "", items: [] });

  const clearing = useRef(false);
  useEffect(() => {
    clearing.current = false;
  }, [state]);
  const isEmpty = state.value === "";
  useEffect(() => onEmptyChange?.(isEmpty), [isEmpty, onEmptyChange]);

  const context = suggestionState(state.value, state.cursor);
  const fileToken = context.kind === "file" ? context.token.text : null;

  useEffect(() => {
    if (fileToken === null) return;
    let live = true;
    completeFile(fileToken, cwd)
      .then((items) => {
        if (live) setFiles({ token: fileToken, items: items.map(sanitizeForTerminal) });
      })
      .catch(() => {
        if (live) setFiles({ token: fileToken, items: [] });
      });
    return () => {
      live = false;
    };
  }, [fileToken, cwd]);

  let key = "";
  let items: Suggestion[] = [];
  if (context.kind === "command") {
    key = `c:${context.query}`;
    items = rankCommands(context.query, commands).map((command) => ({ type: "command", command }));
  } else if (context.kind === "file") {
    key = `f:${context.token.start}:${context.token.text}`;
    items = files.token === context.token.text ? files.items.map((path) => ({ type: "file", path })) : [];
  }
  const open = items.length > 0 && key !== dismissed;
  const selected = open && selection.key === key ? Math.min(selection.index, items.length - 1) : 0;

  useEffect(() => {
    onSuggestionsToggle?.(open);
  }, [open, onSuggestionsToggle]);

  const setHelp = (next: boolean) => {
    setHelpOpen(next);
    onShortcutsToggle?.(next);
  };

  const submit = (text: string) => {
    // Two enters in one tick both see the old value; only the first may send it (a second would queue a duplicate).
    if (clearing.current) return;
    clearing.current = true;
    onSubmit(text);
    dispatch({ type: "clear" });
    setSubmitted(true);
    setDismissed(null);
  };

  /** Applies the selected suggestion; enter on a command that needs no argument also submits it. */
  const accept = (andSubmit: boolean): void => {
    const item = items[selected]!;
    if (item.type === "file") {
      if (context.kind !== "file") return;
      const text = `${item.path}${item.path.endsWith("/") ? "" : " "}`;
      dispatch({ type: "replaceRange", start: context.token.start, end: context.token.end, text });
      return;
    }
    const name = `/${item.command.name}`;
    if (andSubmit && !needsArgs(item.command)) return submit(name);
    dispatch({ type: "replaceRange", start: 0, end: state.value.length, text: `${name} ` });
  };

  const recallQueued = (): boolean => {
    if (state.value !== "" || queued.length === 0 || !onRecallQueued) return false;
    const text = onRecallQueued();
    if (text === null) return false;
    const clean = sanitizeForTerminal(text);
    dispatch({ type: "replaceRange", start: 0, end: 0, text: clean });
    return true;
  };

  useInput((input, k) => {
    if (helpOpen) {
      setHelp(false);
      if (k.escape || input === "?") return;
    } else if (input === "?" && state.value === "" && !k.ctrl && !k.meta) {
      return setHelp(true);
    }

    if (open) {
      const move = (delta: number) => setSelection({ key, index: (selected + delta + items.length) % items.length });
      if (k.upArrow) return move(-1);
      if (k.downArrow) return move(1);
      if (k.tab && !k.shift) return accept(false);
      if (k.return) return accept(true);
      if (k.escape) return setDismissed(key);
    }

    if (k.return) {
      if (state.value[state.cursor - 1] === "\\") {
        dispatch({ type: "replaceRange", start: state.cursor - 1, end: state.cursor, text: "\n" });
        return;
      }
      if (state.value.trim()) submit(state.value);
      return;
    }
    if (k.tab && !k.shift) {
      // Tab after esc reopens the dropdown for the same token.
      if (dismissed === key) setDismissed(null);
      return;
    }
    if (k.upArrow) {
      if (recallQueued()) return;
      return dispatch({ type: "historyPrev", history: safeHistory });
    }
    if (k.downArrow) return dispatch({ type: "historyNext", history: safeHistory });
    if (k.leftArrow) return dispatch({ type: "left" });
    if (k.rightArrow) return dispatch({ type: "right" });
    if (k.backspace || k.delete) return dispatch({ type: "backspace" });
    if (k.ctrl && input === "a") return dispatch({ type: "home" });
    if (k.ctrl && input === "e") return dispatch({ type: "end" });
    if (k.ctrl && input === "u") return dispatch({ type: "clear" });
    if (k.ctrl && input === "w") return dispatch({ type: "deleteWordBack" });
    if (k.ctrl || k.meta || k.escape || k.tab) return;
    if (input) dispatch({ type: "insert", text: sanitizeForTerminal(input.replace(/\r\n?/g, "\n")) });
  });

  const below = open ? (
    <Suggestions items={items} selected={selected} width={width} />
  ) : helpOpen ? (
    <ShortcutsHelp />
  ) : (
    footer ?? null
  );

  return (
    <Box flexDirection="column" marginTop={1} width={width}>
      <Box borderStyle="round" borderLeft={false} borderRight={false} borderColor={theme.promptBorder} flexDirection="column">
        <InputLines state={state} theme={theme} busy={busy} placeholder={busy ? BUSY_PLACEHOLDER : submitted ? "" : PLACEHOLDER} commands={commands} />
      </Box>
      {below}
    </Box>
  );
}

function InputLines({
  state,
  theme,
  busy,
  placeholder,
  commands,
}: {
  state: InputState;
  theme: Theme;
  busy: boolean;
  placeholder: string;
  commands: SuggestCommand[];
}) {
  const glyph = (first: boolean) => (
    <Text color={theme.accent} dimColor={busy}>
      {first ? "❯ " : "  "}
    </Text>
  );
  if (state.value === "") {
    return (
      <Text>
        {glyph(true)}
        <Text inverse>{placeholder.slice(0, 1) || " "}</Text>
        <Text dimColor>{placeholder.slice(1)}</Text>
      </Text>
    );
  }
  const command = leadingCommand(state.value, commands);
  const highlightLen = command ? command.name.length + 1 : 0;
  const highlightColor = command ? kindColor(theme, command) : undefined;
  let offset = 0;
  return (
    <>
      {state.value.split("\n").map((line, i) => {
        const start = offset;
        offset += line.length + 1;
        const col = state.cursor - start;
        const cursorCol = col >= 0 && col <= line.length ? col : null;
        const segments = lineSegments(line, cursorCol, i === 0 ? highlightLen : 0);
        return (
          <Text key={i}>
            {glyph(i === 0)}
            {segments.map((s, j) => (
              <Text key={j} inverse={s.cursor} color={s.highlight ? highlightColor : undefined}>
                {s.text}
              </Text>
            ))}
          </Text>
        );
      })}
    </>
  );
}
