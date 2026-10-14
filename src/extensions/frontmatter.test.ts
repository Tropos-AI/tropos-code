import { expect, test } from "bun:test";
import { fmBool, fmList, fmString, parseFrontmatter, splitList } from "./frontmatter";

test("splits YAML frontmatter from the body", () => {
  const { data, body } = parseFrontmatter("---\nname: x\ntools: [Read, Grep]\n---\nHello\n");
  expect(data).toEqual({ name: "x", tools: ["Read", "Grep"] });
  expect(body).toBe("Hello\n");
});

test("a file without frontmatter is all body", () => {
  expect(parseFrontmatter("just text")).toEqual({ data: {}, body: "just text" });
  expect(parseFrontmatter("---\n- a\n---\nb").data).toEqual({});
});

test("unparseable YAML falls back to key: value lines", () => {
  const { data, body } = parseFrontmatter("﻿---\ndescription: Run: the tests\nallowed-tools: Bash(git *): x, Read\nkey: [unclosed\nname: 'q'\n---\nbody");
  expect(data.description).toBe("Run: the tests");
  expect(data.name).toBe("q");
  expect(body).toBe("body");
});

test("value helpers", () => {
  const data = { s: " a ", n: 3, b: true, e: "", list: ["Read", " Grep "], csv: "Read, Bash(git diff:*, x), Grep", t: "true", f: "false", o: {} };
  expect(fmString(data, "s")).toBe("a");
  expect(fmString(data, "n")).toBe("3");
  expect(fmString(data, "b")).toBe("true");
  expect(fmString(data, "e")).toBeUndefined();
  expect(fmString(data, "o")).toBeUndefined();
  expect(fmList(data, "list")).toEqual(["Read", "Grep"]);
  expect(fmList(data, "csv")).toEqual(["Read", "Bash(git diff:*, x)", "Grep"]);
  expect(fmList(data, "missing")).toBeUndefined();
  expect(fmList(data, "o")).toBeUndefined();
  expect(fmBool(data, "b")).toBe(true);
  expect(fmBool(data, "t")).toBe(true);
  expect(fmBool(data, "f")).toBe(false);
  expect(fmBool(data, "s")).toBeUndefined();
  expect(splitList("")).toEqual([]);
});
