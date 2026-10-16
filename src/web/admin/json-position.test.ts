// src/web/admin/json-position.test.ts
import { describe, expect, test } from "bun:test";
import { jsonErrorOffset, lineColumn } from "./json-position";

/** Where the scanner says the text goes wrong, as "line:column" ("ok" when valid). */
function where(text: string): string {
  const at = jsonErrorOffset(text);
  if (at < 0) return "ok";
  const { line, column } = lineColumn(text, at);
  return `${line}:${column}`;
}

describe("valid JSON", () => {
  test.each([
    "{}", "[]", "0", "-0", "1.5e+10", "-12.5E-3", '"x"', "true", "false", "null", ' \t\r\n{"a":[1,2,{"b":null}],"c":"d\\n\\u00e9\\/"}\n',
    '"\\"\\\\\\b\\f\\n\\r\\t"', "[[],[[]],{}]", '{"é":"😀"}',
  ])("%j is accepted", (text) => {
    expect(jsonErrorOffset(text)).toBe(-1);
    expect(() => JSON.parse(text)).not.toThrow();
  });
});

describe("error classes and exact positions", () => {
  test("empty and whitespace-only input is an unexpected end", () => {
    expect(jsonErrorOffset("")).toBe(0);
    expect(where("")).toBe("1:1");
    expect(where("  \n ")).toBe("2:2");
  });

  test("unexpected token at the start", () => {
    expect(where("}")).toBe("1:1");
    expect(where("  x")).toBe("1:3");
    expect(where("undefined")).toBe("1:1");
    expect(where("+1")).toBe("1:1");
    expect(where(".5")).toBe("1:1");
  });

  test("single-quoted strings and unquoted keys", () => {
    expect(where("{'a':1}")).toBe("1:2");
    expect(where("{a:1}")).toBe("1:2");
    expect(where('{"a":\'x\'}')).toBe("1:6");
  });

  test("misspelled literals fail at the literal's start", () => {
    expect(where("[tru]")).toBe("1:2");
    expect(where("[nul]")).toBe("1:2");
    expect(where('{"a":fals}')).toBe("1:6");
  });

  test("bad numbers", () => {
    expect(where("01")).toBe("1:2");
    expect(where("1.")).toBe("1:2");
    expect(where("-")).toBe("1:1");
    expect(where("[1e]")).toBe("1:3");
  });

  test("trailing commas in objects and arrays point at the closing bracket", () => {
    expect(where('{"a":1,}')).toBe("1:8");
    expect(where("[1,2,]")).toBe("1:6");
    expect(where("[,1]")).toBe("1:2");
  });

  test("missing separators", () => {
    expect(where('{"a" 1}')).toBe("1:6");
    expect(where('{"a":1 "b":2}')).toBe("1:8");
    expect(where("[1 2]")).toBe("1:4");
    expect(where('{"a"}')).toBe("1:5");
  });

  test("unterminated string points past its last character", () => {
    expect(where('"abc')).toBe("1:5");
    expect(where('{"a":"b')).toBe("1:8");
  });

  test("unexpected end inside containers", () => {
    expect(where("[")).toBe("1:2");
    expect(where("[1,")).toBe("1:4");
    expect(where("{")).toBe("1:2");
    expect(where('{"a":')).toBe("1:6");
    expect(where('{"a":1')).toBe("1:7");
    expect(where('{"a":1,')).toBe("1:8");
  });

  test("bad escapes point at the escape character, or the bad hex digit run", () => {
    expect(where('"a\\x"')).toBe("1:4");
    expect(where('"\\u12G4"')).toBe("1:4");
    expect(where('"\\u12"')).toBe("1:4");
    expect(where('"\\')).toBe("1:3");
  });

  test("raw control characters in strings are rejected where they sit", () => {
    expect(where('"a\tb"')).toBe("1:3");
    expect(where('"a\nb"')).toBe("1:3");
    expect(where('{"a":"x\u0001"}')).toBe("1:8");
  });

  test("comments are not JSON", () => {
    expect(where("// hi\n{}")).toBe("1:1");
    expect(where("/* c */ {}")).toBe("1:1");
    expect(where('{\n  // note\n  "a": 1\n}')).toBe("2:3");
    expect(where('{"a": 1 /* c */}')).toBe("1:9");
    expect(where('{"a": 1} // tail')).toBe("1:10");
  });

  test("anything after the value is an error", () => {
    expect(where("{} {}")).toBe("1:4");
    expect(where("1 2")).toBe("1:3");
    expect(where("[]]")).toBe("1:3");
  });
});

describe("lines and columns", () => {
  test("multi-line input counts lines and resets columns", () => {
    const text = '{\n  "a": 1,\n  "b": [1, 2,]\n}';
    expect(where(text)).toBe("3:14");
  });

  test("blank lines are counted", () => {
    expect(where('{\n\n\n"a": x}')).toBe("4:6");
  });

  test("CRLF: the \\r is whitespace and the line still advances once per \\n", () => {
    expect(where('{\r\n  "a": 1,\r\n  "b": oops\r\n}')).toBe("3:8");
    expect(where('{\r\n"a":1,\r\n}')).toBe("3:1");
  });

  test("a CR inside a string is a control character", () => {
    expect(where('{"a":"x\r\ny"}')).toBe("1:8");
  });

  test("non-BMP characters count as two UTF-16 units, matching string offsets", () => {
    const text = '{"k":"😀", x}';
    const at = jsonErrorOffset(text);
    expect(text[at]).toBe("x");
    expect(where(text)).toBe("1:12");
    expect(where('["😀😀", ]')).toBe("1:10");
  });

  test("a non-BMP character outside a string is an unexpected token at its first unit", () => {
    expect(where("😀")).toBe("1:1");
  });

  test("a valid multi-line document is accepted", () => {
    expect(where('{\n  "a": [\n    1,\n    2\n  ]\n}\n')).toBe("ok");
  });
});

describe("lineColumn", () => {
  test("is 1-based", () => {
    expect(lineColumn("abc", 0)).toEqual({ line: 1, column: 1 });
    expect(lineColumn("abc", 2)).toEqual({ line: 1, column: 3 });
  });
  test("an offset right after a newline starts a new line", () => {
    expect(lineColumn("a\nbc", 2)).toEqual({ line: 2, column: 1 });
    expect(lineColumn("a\nbc", 3)).toEqual({ line: 2, column: 2 });
  });
  test("an offset at the end of text is one past the last character", () => {
    expect(lineColumn("a\nb", 3)).toEqual({ line: 2, column: 2 });
    expect(lineColumn("", 0)).toEqual({ line: 1, column: 1 });
  });
});
