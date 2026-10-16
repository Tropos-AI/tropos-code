// src/web/admin/json-position.ts — where a JSON text first goes wrong. Bun's JSON.parse names no position, and the
// raw editor needs one ("line 3"), so this is a small strict scanner that only finds the offset.

/** Offset of the first syntax error in `text`, or -1 when it is valid JSON. */
export function jsonErrorOffset(text: string): number {
  let i = 0;
  const ws = () => {
    while (i < text.length && " \t\n\r".includes(text[i]!)) i++;
  };
  const fail = (): never => {
    throw i;
  };
  const literal = (word: string) => {
    if (!text.startsWith(word, i)) fail();
    i += word.length;
  };
  const string = () => {
    i++;
    for (;;) {
      const c = text[i];
      if (c === undefined || c < " ") fail();
      if (c === '"') return void i++;
      if (c === "\\") {
        const e = text[i + 1];
        if (e === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
            i += 2;
            fail();
          }
          i += 6;
        } else if (e !== undefined && '"\\/bfnrt'.includes(e)) i += 2;
        else {
          i++;
          fail();
        }
      } else i++;
    }
  };
  const value = (): void => {
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      ws();
      if (text[i] === "}") return void i++;
      for (;;) {
        ws();
        if (text[i] !== '"') fail();
        string();
        ws();
        if (text[i] !== ":") fail();
        i++;
        value();
        ws();
        if (text[i] === ",") i++;
        else if (text[i] === "}") return void i++;
        else fail();
      }
    } else if (c === "[") {
      i++;
      ws();
      if (text[i] === "]") return void i++;
      for (;;) {
        value();
        ws();
        if (text[i] === ",") i++;
        else if (text[i] === "]") return void i++;
        else fail();
      }
    } else if (c === '"') string();
    else if (c === "t") literal("true");
    else if (c === "f") literal("false");
    else if (c === "n") literal("null");
    else {
      const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i));
      if (!m) fail();
      i += m![0].length;
    }
  };
  try {
    value();
    ws();
    if (i < text.length) fail();
    return -1;
  } catch (at) {
    return typeof at === "number" ? at : 0;
  }
}

/** "line 3, column 5" for an offset in `text` (1-based). */
export function lineColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  return { line, column: offset - (before.lastIndexOf("\n") + 1) + 1 };
}
