import { describe, expect, test } from "bun:test";
import { emptyInput, inputReducer, tokenAtCursor, type InputAction, type InputState } from "./input-state";

const run = (...actions: InputAction[]) => actions.reduce(inputReducer, emptyInput);

describe("inputReducer", () => {
  test("insert and backspace at the cursor", () => {
    let s = run({ type: "insert", text: "helo" }, { type: "left" }, { type: "insert", text: "l" });
    expect(s).toMatchObject({ value: "hello", cursor: 4 });
    s = inputReducer(s, { type: "backspace" });
    expect(s).toMatchObject({ value: "helo", cursor: 3 });
  });

  test("home and end work per line", () => {
    const s = run({ type: "insert", text: "ab\ncd" }, { type: "home" });
    expect(s.cursor).toBe(3);
    expect(inputReducer(s, { type: "end" }).cursor).toBe(5);
  });

  test("history navigation keeps the draft", () => {
    const history = ["first", "second"];
    let s: InputState = run({ type: "insert", text: "draft" });
    s = inputReducer(s, { type: "historyPrev", history });
    expect(s.value).toBe("second");
    s = inputReducer(s, { type: "historyPrev", history });
    expect(s.value).toBe("first");
    s = inputReducer(s, { type: "historyNext", history });
    s = inputReducer(s, { type: "historyNext", history });
    expect(s.value).toBe("draft");
  });

  test("delete word back and clear", () => {
    expect(run({ type: "insert", text: "run the tests" }, { type: "deleteWordBack" }).value).toBe("run the ");
    expect(run({ type: "insert", text: "x" }, { type: "clear" })).toEqual(emptyInput);
  });

  test("tokenAtCursor", () => {
    const s = run({ type: "insert", text: "look at @src/ma" });
    expect(tokenAtCursor(s)).toEqual({ start: 8, end: 15, text: "@src/ma" });
  });
});

test("home at the very start stays at 0 when the text starts with a newline", () => {
  const s = run({ type: "insert", text: "\nab" }, { type: "left" }, { type: "left" }, { type: "left" }, { type: "home" });
  expect(s.cursor).toBe(0);
});

test("backspace removes a whole surrogate pair", () => {
  expect(run({ type: "insert", text: "a😀" }, { type: "backspace" }).value).toBe("a");
});

test("left and right step over a surrogate pair", () => {
  const s = run({ type: "insert", text: "a😀" });
  expect(s.cursor).toBe(3);
  expect(inputReducer(s, { type: "left" }).cursor).toBe(1);
  expect(inputReducer(inputReducer(s, { type: "left" }), { type: "right" }).cursor).toBe(3);
});

test("no action leaves a lone surrogate", () => {
  expect(run({ type: "insert", text: "a\uD83Db" }).value).toBe("ab");
  expect(run({ type: "insert", text: "a😀" }, { type: "backspace" }, { type: "backspace" }).value).toBe("");
  expect(run({ type: "insert", text: "😀" }, { type: "left" }, { type: "backspace" }).value).toBe("😀");
  expect(run({ type: "insert", text: "a😀b" }, { type: "left" }, { type: "left" }, { type: "backspace" }).value).toBe("😀b");
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  for (const action of ["backspace", "left", "right", "home", "end", "deleteWordBack"] as const) {
    const s = run({ type: "insert", text: "x😀\n😀y" }, { type: "left" }, { type: "left" }, { type: action });
    expect(lone.test(s.value)).toBe(false);
  }
});
