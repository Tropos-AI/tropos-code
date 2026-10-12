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
