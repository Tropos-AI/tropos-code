// src/attachments/attachments.test.ts
import { describe, expect, test } from "bun:test";
import { attachmentText, imageNote, isBigPaste, lineCount, parseAttachmentText, sniffImage } from "./attachments";

const bytes = (...b: number[]) => new Uint8Array([...b, ...new Array(16).fill(0)]);

describe("sniffImage", () => {
  test("knows PNG, JPEG, GIF and WebP by their first bytes", () => {
    expect(sniffImage(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image/png");
    expect(sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(sniffImage(new TextEncoder().encode("GIF89a........"))).toBe("image/gif");
    expect(sniffImage(new TextEncoder().encode("GIF87a........"))).toBe("image/gif");
    expect(sniffImage(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
  });

  test("anything else is not an image we accept", () => {
    expect(sniffImage(new TextEncoder().encode("hello world, not an image"))).toBeNull();
    expect(sniffImage(new TextEncoder().encode("RIFF\0\0\0\0WAVEfmt "))).toBeNull();
    expect(sniffImage(new Uint8Array([0x89, 0x50]))).toBeNull();
    // An SVG is text a browser may run script in; never an image here.
    expect(sniffImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
  });
});

describe("attachment text blocks", () => {
  test("a text attachment is a delimited block the model reads as a file, and it parses back", () => {
    const block = attachmentText("pasted-1.txt", "line 1\nline 2");
    expect(block).toBe('<attachment name="pasted-1.txt">\nline 1\nline 2\n</attachment>');
    expect(parseAttachmentText(block)).toEqual({ name: "pasted-1.txt", text: "line 1\nline 2" });
  });

  test("names with quotes or angle brackets survive the round trip", () => {
    const block = attachmentText('a "b" <c>.txt', "x");
    expect(parseAttachmentText(block)).toEqual({ name: 'a "b" <c>.txt', text: "x" });
  });

  test("ordinary text is not an attachment", () => {
    expect(parseAttachmentText("just a message")).toBeNull();
    expect(parseAttachmentText('<attachment name="x">\nno end')).toBeNull();
  });

  test("an image the model can't see becomes a note that names it", () => {
    expect(imageNote("chart.png")).toContain("chart.png");
    expect(imageNote("chart.png")).toMatch(/can't see images/);
  });
});

describe("isBigPaste", () => {
  test("over about 2,000 characters or 40 lines becomes an attachment", () => {
    expect(isBigPaste("short")).toBe(false);
    expect(isBigPaste("x".repeat(2001))).toBe(true);
    expect(isBigPaste("a\n".repeat(40))).toBe(false);
    expect(isBigPaste("a\n".repeat(41))).toBe(true);
  });

  test("lineCount ignores one trailing newline", () => {
    expect(lineCount("a\nb\n")).toBe(2);
    expect(lineCount("a")).toBe(1);
    expect(lineCount("")).toBe(0);
  });
});
