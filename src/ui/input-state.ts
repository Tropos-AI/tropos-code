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

const HIGH = /[\uD800-\uDBFF]/;
const LOW = /[\uDC00-\uDFFF]/;

/** Drops unpaired surrogates so no edit can leave one in the value. */
function withoutLoneSurrogates(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

/** Code-point boundary before `i`: a surrogate pair counts as one character. */
function prevBoundary(value: string, i: number): number {
  if (i <= 0) return 0;
  if (i >= 2 && LOW.test(value[i - 1]!) && HIGH.test(value[i - 2]!)) return i - 2;
  return i - 1;
}

/** Code-point boundary after `i`: a surrogate pair counts as one character. */
function nextBoundary(value: string, i: number): number {
  if (i >= value.length) return value.length;
  if (i + 1 < value.length && HIGH.test(value[i]!) && LOW.test(value[i + 1]!)) return i + 2;
  return i + 1;
}

export function inputReducer(s: InputState, a: InputAction): InputState {
  switch (a.type) {
    case "insert": {
      const text = withoutLoneSurrogates(a.text);
      return { ...s, value: s.value.slice(0, s.cursor) + text + s.value.slice(s.cursor), cursor: s.cursor + text.length, historyIndex: null };
    }
    case "backspace": {
      if (s.cursor === 0) return s;
      const from = prevBoundary(s.value, s.cursor);
      return { ...s, value: s.value.slice(0, from) + s.value.slice(s.cursor), cursor: from };
    }
    case "left":
      return { ...s, cursor: prevBoundary(s.value, s.cursor) };
    case "right":
      return { ...s, cursor: nextBoundary(s.value, s.cursor) };
    case "home":
      return { ...s, cursor: s.cursor === 0 ? 0 : s.value.lastIndexOf("\n", s.cursor - 1) + 1 };
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
      const text = withoutLoneSurrogates(a.text);
      const value = s.value.slice(0, a.start) + text + s.value.slice(a.end);
      return { ...s, value, cursor: a.start + text.length };
    }
  }
}

/** The whitespace-delimited word that ends at the cursor. */
export function tokenAtCursor(s: InputState): { start: number; end: number; text: string } {
  let start = s.cursor;
  while (start > 0 && !/\s/.test(s.value[start - 1]!)) start--;
  return { start, end: s.cursor, text: s.value.slice(start, s.cursor) };
}
