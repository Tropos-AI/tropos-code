// src/context/tags.test.ts
import { expect, test } from "bun:test";
import { harnessNonce, neutraliseHarnessTags, nonceBlock } from "./tags";

test("every harness tag is broken, opening or closing, in any case or spacing", () => {
  for (const tag of ["context", "memory", "environment", "mode", "skill", "skills", "notes", "reminder", "hook-context", "harness-nonce", "command", "file"]) {
    expect(neutraliseHarnessTags(`<${tag} x="1">`)).toBe(`<\\${tag} x="1">`);
    expect(neutraliseHarnessTags(`< / ${tag.toUpperCase()}>`)).toBe(`<\\ / ${tag.toUpperCase()}>`);
  }
});

test("other markup is left alone", () => {
  expect(neutraliseHarnessTags("<div> <context-menu> <files> a < b")).toBe("<div> <context-menu> <files> a < b");
});

test("the nonce is stable per session and differs between sessions", () => {
  expect(harnessNonce("s1")).toBe(harnessNonce("s1"));
  expect(harnessNonce("s1")).not.toBe(harnessNonce("s2"));
  expect(harnessNonce("s1")).toMatch(/^[0-9a-f]{12}$/);
  expect(nonceBlock("abc")).toBe("<harness-nonce>abc</harness-nonce>");
});
