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
