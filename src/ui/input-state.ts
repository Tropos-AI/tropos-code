export interface InputState {
  value: string;
  cursor: number;
  historyIndex: number | null;
  draft: string;
}

export const emptyInput: InputState = { value: "", cursor: 0, historyIndex: null, draft: "" };

export type InputAction =
  | { type: "insert"; text: string }
  | { type: "backspace" }
  | { type: "left" }
  | { type: "right" }
  | { type: "home" }
  | { type: "end" }
  | { type: "clear" }
  | { type: "deleteWordBack" }
  | { type: "historyPrev"; history: string[] }
  | { type: "historyNext"; history: string[] }
  | { type: "replaceRange"; start: number; end: number; text: string };

export function inputReducer(s: InputState, a: InputAction): InputState {
  switch (a.type) {
    case "insert":
      return { ...s, value: s.value.slice(0, s.cursor) + a.text + s.value.slice(s.cursor), cursor: s.cursor + a.text.length, historyIndex: null };
    case "backspace":
      if (s.cursor === 0) return s;
      return { ...s, value: s.value.slice(0, s.cursor - 1) + s.value.slice(s.cursor), cursor: s.cursor - 1 };
    case "left":
      return { ...s, cursor: Math.max(0, s.cursor - 1) };
    case "right":
      return { ...s, cursor: Math.min(s.value.length, s.cursor + 1) };
    case "home":
      return { ...s, cursor: s.value.lastIndexOf("\n", s.cursor - 1) + 1 };
    case "end": {
      const newline = s.value.indexOf("\n", s.cursor);
      return { ...s, cursor: newline === -1 ? s.value.length : newline };
    }
    case "clear":
      return emptyInput;
    case "deleteWordBack": {
      const before = s.value.slice(0, s.cursor).replace(/\S+\s*$/, "");
      return { ...s, value: before + s.value.slice(s.cursor), cursor: before.length };
    }
    case "historyPrev": {
      if (a.history.length === 0) return s;
      const index = s.historyIndex === null ? a.history.length - 1 : Math.max(0, s.historyIndex - 1);
      const value = a.history[index]!;
      return { value, cursor: value.length, historyIndex: index, draft: s.historyIndex === null ? s.value : s.draft };
    }
    case "historyNext": {
      if (s.historyIndex === null) return s;
      const index = s.historyIndex + 1;
      if (index >= a.history.length) return { value: s.draft, cursor: s.draft.length, historyIndex: null, draft: "" };
      const value = a.history[index]!;
      return { ...s, value, cursor: value.length, historyIndex: index };
    }
    case "replaceRange": {
      const value = s.value.slice(0, a.start) + a.text + s.value.slice(a.end);
      return { ...s, value, cursor: a.start + a.text.length };
    }
  }
}

/** The whitespace-delimited word that ends at the cursor. */
export function tokenAtCursor(s: InputState): { start: number; end: number; text: string } {
  let start = s.cursor;
  while (start > 0 && !/\s/.test(s.value[start - 1]!)) start--;
  return { start, end: s.cursor, text: s.value.slice(start, s.cursor) };
}
