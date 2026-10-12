import { expect, test } from "bun:test";
import { sanitizeForTerminal } from "./terminal-safe";

const DANGEROUS = ["\x1b]", "\x1b[2J", "\u009d", "\r"];

test("removes escape sequences that rewrite the terminal", () => {
  const inputs = [
    "\x1b]0;PWNED\x07",
    "\x1b]52;c;aGk=\x07",
    "\x1b[2J\x1b[H",
    "\u009d0;x\u0007",
    "text\x1b",
    "safe\rPWNED",
  ];
  for (const input of inputs) {
    const out = sanitizeForTerminal(input);
    for (const bad of DANGEROUS) expect(out).not.toContain(bad);
  }
});

test("removes each sequence family cleanly", () => {
  expect(sanitizeForTerminal("\x1b]0;PWNED\x07title")).toBe("title");
  expect(sanitizeForTerminal("\x1b]52;c;aGk=\x07")).toBe("");
  expect(sanitizeForTerminal("\x1b[2J\x1b[H")).toBe("");
  expect(sanitizeForTerminal("\x1b[31mred\x1b[0m")).toBe("red");
  expect(sanitizeForTerminal("\u009d0;x\u0007")).toBe("0;x");
  expect(sanitizeForTerminal("\x1bPq#0\x1b\\after")).toBe("after");
  expect(sanitizeForTerminal("\x1bXsos\x1b\\a\x1b^pm\x1b\\b\x1b_apc\x1b\\c")).toBe("abc");
  expect(sanitizeForTerminal("\x1bc")).toBe("");
  expect(sanitizeForTerminal("abc\x1b")).toBe("abc");
});

test("an unterminated OSC runs to the end of the string", () => {
  expect(sanitizeForTerminal("ok\x1b]0;never ends")).toBe("ok");
});

test("C0 controls other than newline and tab are removed", () => {
  expect(sanitizeForTerminal("a\rb\x07c\x08d")).toBe("abcd");
});

test("normal text, newlines, tabs and unicode are untouched", () => {
  const text = "line one\n\tindented\ncafé 😀 日本語";
  expect(sanitizeForTerminal(text)).toBe(text);
});
