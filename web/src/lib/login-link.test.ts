import { expect, test } from "bun:test";

import { takeLoginFragment } from "@/lib/login-link";

function spy() {
  const calls: unknown[][] = [];
  return { calls, history: { replaceState: (...args: unknown[]) => void calls.push(args) } as Pick<History, "replaceState"> };
}

test("#login=VALUE is returned and stripped to #/chat with replaceState", () => {
  const { calls, history } = spy();
  expect(takeLoginFragment({ hash: "#login=abc-DEF_123" }, history)).toBe("abc-DEF_123");
  expect(calls).toEqual([[null, "", "#/chat"]]);
});

test("any other hash: null, history untouched", () => {
  const { calls, history } = spy();
  expect(takeLoginFragment({ hash: "#/settings" }, history)).toBeNull();
  expect(takeLoginFragment({ hash: "" }, history)).toBeNull();
  expect(takeLoginFragment({ hash: "#login=" }, history)).toBeNull();
  expect(calls).toEqual([]);
});
