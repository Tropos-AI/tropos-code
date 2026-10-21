// src/messages/attributed-body.test.ts
import { describe, expect, test } from "bun:test";
import { decodeAttributedBody } from "./attributed-body";

const enc = new TextEncoder();

/** Builds a blob shaped like a real attributedBody around the string. */
function typedstream(text: string): Uint8Array {
  const body = enc.encode(text);
  const n = body.length;
  const len =
    n < 0x80
      ? [n]
      : n <= 0xffff
        ? [0x81, n & 0xff, n >> 8]
        : [0x82, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
  const head = [...enc.encode("\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString"), 0x01, 0x94, 0x84, 0x01, 0x2b, ...len];
  const tail = enc.encode("\x86\x84\x02iI\x01");
  const out = new Uint8Array(head.length + n + tail.length);
  out.set(head, 0);
  out.set(body, head.length);
  out.set(tail, head.length + n);
  return out;
}

describe("decodeAttributedBody", () => {
  test("round-trips a short string", () => {
    expect(decodeAttributedBody(typedstream("hello"))).toBe("hello");
  });
  test("round-trips a 300-byte-plus Greek string (2-byte length)", () => {
    const text = "Καλημέρα ".repeat(40);
    expect(enc.encode(text).length).toBeGreaterThan(300);
    expect(decodeAttributedBody(typedstream(text))).toBe(text);
  });
  test("round-trips 70 000 bytes (4-byte length)", () => {
    const text = "a".repeat(70000);
    expect(decodeAttributedBody(typedstream(text))).toBe(text);
  });
  test("round-trips emoji", () => {
    expect(decodeAttributedBody(typedstream("👍🏽"))).toBe("👍🏽");
  });
  test("null, empty and unrelated blobs give undefined", () => {
    expect(decodeAttributedBody(null)).toBeUndefined();
    expect(decodeAttributedBody(new Uint8Array())).toBeUndefined();
    expect(decodeAttributedBody(enc.encode("no marker here +abc"))).toBeUndefined();
  });
  test("a truncated blob gives undefined", () => {
    const blob = typedstream("hello world");
    const cut = blob.indexOf(0x2b, 20) + 4;
    expect(decodeAttributedBody(blob.slice(0, cut))).toBeUndefined();
    expect(decodeAttributedBody(enc.encode("NSString"))).toBeUndefined();
    expect(decodeAttributedBody(enc.encode("NSString\x01+"))).toBeUndefined();
    expect(decodeAttributedBody(new Uint8Array([...enc.encode("NSString+"), 0x82, 1]))).toBeUndefined();
  });
  test("invalid UTF-8 gives undefined", () => {
    const blob = new Uint8Array([...enc.encode("NSString+"), 2, 0xff, 0xfe]);
    expect(decodeAttributedBody(blob)).toBeUndefined();
  });
});
