// src/ui/PromptInput.tsx
import { Box, Text, useInput } from "ink";
import { useMemo, useReducer, useState } from "react";
import { commonPrefix, completeCommand, completeFile } from "./complete";
import { emptyInput, inputReducer, tokenAtCursor } from "./input-state";
import { sanitizeForTerminal } from "./terminal-safe";
import { useTheme } from "./theme-context";

const PLACEHOLDER = "Ask Tropos… (/ for commands, @ for files)";

export function PromptInput({
  onSubmit,
  history,
  cwd,
  commands = [],
}: {
  onSubmit(text: string): void;
  history: string[];
  cwd: string;
  /** Custom command and skill names for `/` completion. */
  commands?: string[];
}) {
  const theme = useTheme();
  const [state, dispatch] = useReducer(inputReducer, emptyInput);
  const safeHistory = useMemo(() => history.map(sanitizeForTerminal), [history]);
  const [suggestions, setSuggestions] = useState<string[]>([]);

  const complete = async () => {
    const token = tokenAtCursor(state);
    let items: string[] = [];
    if (token.text.startsWith("@")) items = await completeFile(token.text, cwd);
    else if (token.start === 0 && token.text.startsWith("/")) items = completeCommand(token.text, commands);
    if (items.length === 0) return;
    items = items.map(sanitizeForTerminal);
    const replacement = items.length === 1 ? `${items[0]}${items[0]!.endsWith("/") ? "" : " "}` : commonPrefix(items);
    if (replacement.length > token.text.length) dispatch({ type: "replaceRange", start: token.start, end: token.end, text: replacement });
    setSuggestions(items.length > 1 ? items.slice(0, 8) : []);
  };

  useInput((input, key) => {
    if (key.return) {
      if (state.value[state.cursor - 1] === "\\") {
        dispatch({ type: "replaceRange", start: state.cursor - 1, end: state.cursor, text: "\n" });
        return;
      }
      if (state.value.trim()) {
        onSubmit(state.value);
        dispatch({ type: "clear" });
        setSuggestions([]);
      }
      return;
    }
    if (key.tab && !key.shift) return void complete();
    if (key.upArrow) return dispatch({ type: "historyPrev", history: safeHistory });
    if (key.downArrow) return dispatch({ type: "historyNext", history: safeHistory });
    if (key.leftArrow) return dispatch({ type: "left" });
    if (key.rightArrow) return dispatch({ type: "right" });
    if (key.backspace || key.delete) return dispatch({ type: "backspace" });
    if (key.ctrl && input === "a") return dispatch({ type: "home" });
    if (key.ctrl && input === "e") return dispatch({ type: "end" });
    if (key.ctrl && input === "u") return dispatch({ type: "clear" });
    if (key.ctrl && input === "w") return dispatch({ type: "deleteWordBack" });
    if (key.ctrl || key.meta || key.escape || key.tab) return;
    if (input) {
      dispatch({ type: "insert", text: sanitizeForTerminal(input.replace(/\r\n?/g, "\n")) });
      setSuggestions([]);
    }
  });

  const lines = state.value.split("\n");
  let offset = 0;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box borderStyle="round" borderColor={theme.muted} paddingX={1} flexDirection="column">
        {state.value === "" ? (
          <Text>
            <Text color={theme.accent}>{"› "}</Text>
            <Text inverse> </Text>
            <Text color={theme.muted}>{PLACEHOLDER}</Text>
          </Text>
        ) : (
          lines.map((line, i) => {
            const start = offset;
            offset += line.length + 1;
            const col = state.cursor - start;
            const hasCursor = col >= 0 && col <= line.length;
            return (
              <Text key={i}>
                <Text color={theme.accent}>{i === 0 ? "› " : "  "}</Text>
                {hasCursor ? (
                  <>
                    {line.slice(0, col)}
                    <Text inverse>{line[col] ?? " "}</Text>
                    {line.slice(col + 1)}
                  </>
                ) : (
                  line
                )}
              </Text>
            );
          })
        )}
      </Box>
      {suggestions.length > 0 ? (
        <Box flexDirection="column" paddingX={3}>
          {suggestions.map((s) => (
            <Text key={s} color={theme.muted}>
              {sanitizeForTerminal(s)}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
