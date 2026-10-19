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

test("daily-notes is a harness tag", () => {
  expect(neutraliseHarnessTags("</daily-notes><Daily-Notes>")).toBe("<\\/daily-notes><\\Daily-Notes>");
  expect(neutraliseHarnessTags("<daily-notesx>")).toBe("<daily-notesx>");
});

test("identity and bootstrap are harness tags", () => {
  expect(neutraliseHarnessTags('</identity><Identity source="user"><bootstrap>')).toBe('<\\/identity><\\Identity source="user"><\\bootstrap>');
  expect(neutraliseHarnessTags("<identity-card> <bootstrapper>")).toBe("<identity-card> <bootstrapper>");
});

test("the specialists and delegations blocks can't be opened or closed by untrusted text", () => {
  expect(neutraliseHarnessTags("</delegations><delegations>x</specialists><specialists>")).toBe("<\\/delegations><\\delegations>x<\\/specialists><\\specialists>");
});
