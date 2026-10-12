// src/tools/bash/output-buffer.test.ts
import { expect, test } from "bun:test";
import { OutputBuffer } from "./output-buffer";

test("keeps short output intact", () => {
  const b = new OutputBuffer(10);
  b.push("hello");
  expect(b.toString()).toBe("hello");
  expect(b.truncated).toBe(false);
});

test("keeps the head and tail of long output", () => {
  const b = new OutputBuffer(10);
  b.push("0123456789");
  b.push("abcdefghij");
  b.push("KLMNOPQRST");
  expect(b.truncated).toBe(true);
  expect(b.toString()).toBe("01234\n… [20 characters truncated] …\nPQRST");
});
