// src/error-text.test.ts
import { describe, expect, test } from "bun:test";
import { errorText } from "./error-text";

describe("errorText", () => {
  test("uses an Error's message and stringifies anything else", () => {
    expect(errorText(new Error("boom"))).toBe("boom");
    expect(errorText("plain")).toBe("plain");
    expect(errorText(null)).toBe("null");
    expect(errorText(42)).toBe("42");
  });

  test("never throws, whatever was thrown", () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const badMessage = new Error("x");
    Object.defineProperty(badMessage, "message", {
      get() {
        throw new Error("getter");
      },
    });
    const cases: unknown[] = [
      Object.create(null),
      { toString: () => { throw new Error("no"); } },
      { [Symbol.toPrimitive]: () => ({}) },
      revoked.proxy,
      badMessage,
      Symbol("s"),
    ];
    for (const value of cases) expect(typeof errorText(value)).toBe("string");
    expect(errorText(Object.create(null))).toBe("[object Object]");
    expect(errorText(Symbol("s"))).toBe("Symbol(s)");
    expect(errorText(revoked.proxy)).toBe("an unprintable value");
  });

  test("an Error whose message is not a string is stringified", () => {
    const err = new Error("x");
    (err as { message: unknown }).message = 7;
    expect(errorText(err)).toBe("7");
  });
});
