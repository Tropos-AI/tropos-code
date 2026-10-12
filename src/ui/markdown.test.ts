import { expect, test } from "bun:test";
import { renderMarkdown } from "./markdown";

test("renders markdown for the terminal", () => {
  const out = renderMarkdown("# Title\n\nSome **bold** text and `code`.\n\n- one\n- two", 60);
  const plain = Bun.stripANSI(out);
  expect(plain).toContain("Title");
  expect(plain).toContain("bold");
  expect(plain).not.toContain("**");
  expect(plain).toContain("one");
});

test("strips terminal control sequences from the input before rendering", () => {
  const out = renderMarkdown("# T\n\x1b]52;c;aGk=\x07", 60);
  expect(out).not.toContain("\x1b]");
  expect(Bun.stripANSI(out)).toContain("T");
});

test("sequences inside a paragraph never reach the terminal", () => {
  for (const input of ["para \x1b]0;PWNED\x07 end", "para \x1b[2J\x1b[H end", "a\rb"]) {
    const out = renderMarkdown(input, 60);
    expect(out).not.toContain("\x1b]");
    expect(out).not.toContain("\x1b[2J");
    expect(out).not.toContain("\r");
  }
});
