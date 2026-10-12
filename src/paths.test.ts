// src/paths.test.ts
import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { expandHome, isInside, troposHome } from "./paths";

describe("troposHome", () => {
  test("uses TROPOS_HOME when set", () => {
    expect(troposHome({ TROPOS_HOME: "/tmp/th" })).toBe("/tmp/th");
  });
  test("falls back to ~/.tropos", () => {
    expect(troposHome({})).toBe(join(homedir(), ".tropos"));
  });
  test("ignores an empty TROPOS_HOME", () => {
    expect(troposHome({ TROPOS_HOME: "" })).toBe(join(homedir(), ".tropos"));
  });
});

describe("expandHome", () => {
  test("expands a leading ~/", () => {
    expect(expandHome("~/x/y", "/home/u")).toBe("/home/u/x/y");
  });
  test("expands a bare ~", () => {
    expect(expandHome("~", "/home/u")).toBe("/home/u");
  });
  test("leaves other paths alone", () => {
    expect(expandHome("/a/~b", "/home/u")).toBe("/a/~b");
  });
});

describe("isInside", () => {
  test("the dir itself counts as inside", () => {
    expect(isInside("/a/b", "/a/b")).toBe(true);
  });
  test("a child is inside", () => {
    expect(isInside("/a/b/c.ts", "/a/b")).toBe(true);
  });
  test("a sibling with a shared prefix is outside", () => {
    expect(isInside("/a/bc/d", "/a/b")).toBe(false);
  });
  test("a parent is outside", () => {
    expect(isInside("/a", "/a/b")).toBe(false);
  });
});
