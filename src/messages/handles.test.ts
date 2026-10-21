// src/messages/handles.test.ts
import { describe, expect, test } from "bun:test";
import { appleToUnixMs, handleKeys, normalizeHandle, sameHandle, targetOf } from "./handles";

describe("normalizeHandle", () => {
  test("phones lose spaces, dashes, dots and parentheses and keep the plus", () => {
    expect(normalizeHandle("+30 691-234 5678")).toBe("+306912345678");
    expect(normalizeHandle("(691) 234.5678")).toBe("6912345678");
  });
  test("a leading 00 becomes a plus", () => {
    expect(normalizeHandle("00306912345678")).toBe("+306912345678");
  });
  test("emails are trimmed and lowercased", () => {
    expect(normalizeHandle(" Maria@Example.com ")).toBe("maria@example.com");
  });
  test("anything else is only trimmed", () => {
    expect(normalizeHandle("  Tropos-Bot  ")).toBe("Tropos-Bot");
  });
});

describe("handleKeys / sameHandle", () => {
  test("a phone yields normalized, digits and last ten digits", () => {
    expect(handleKeys("+30 691 234 5678")).toEqual(["+306912345678", "306912345678", "6912345678"]);
  });
  test("an email yields only its normalized form", () => {
    expect(handleKeys("Maria1@Example.com")).toEqual(["maria1@example.com"]);
  });
  test("the same person written differently matches", () => {
    expect(sameHandle("6912345678", "+306912345678")).toBe(true);
    expect(sameHandle("+30 691-234 5678", "00306912345678")).toBe(true);
    expect(sameHandle("Maria@Example.com", "maria@example.com")).toBe(true);
  });
  test("different people do not match", () => {
    expect(sameHandle("+306912345678", "+306912345679")).toBe(false);
    expect(sameHandle("maria1@example.com", "+301")).toBe(false);
  });
});

describe("targetOf", () => {
  test("`to` is normalized", () => {
    expect(targetOf({ to: "+30 691-234 5678" })).toBe("+306912345678");
  });
  test("a 1:1 chat guid gives the handle", () => {
    expect(targetOf({ chat: "iMessage;-;+306912345678" })).toBe("+306912345678");
    expect(targetOf({ chat: "SMS;-;Maria@Example.com" })).toBe("maria@example.com");
  });
  test("a group chat guid gives chat:<guid>", () => {
    expect(targetOf({ chat: "iMessage;+;chat123456" })).toBe("chat:iMessage;+;chat123456");
  });
  test("neither field is an error", () => {
    expect(() => targetOf({})).toThrow();
  });
});

describe("appleToUnixMs", () => {
  test("zero is the Apple epoch", () => {
    expect(appleToUnixMs(0)).toBe(978307200000);
  });
  test("nanoseconds and seconds agree", () => {
    expect(appleToUnixMs(700000000 * 1e9)).toBe(appleToUnixMs(700000000));
  });
});
