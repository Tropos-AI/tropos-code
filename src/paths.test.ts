// src/paths.test.ts
import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { expandHome, isInside, projectKey, troposHome } from "./paths";

describe("projectKey", () => {
  test("starts with a readable, sanitized form of the path", () => {
    expect(projectKey("/work/my app").startsWith("-work-my-app-")).toBe(true);
  });
  test("ends with 12 hex characters of a sha256 hash", () => {
    expect(projectKey("/work/my app")).toMatch(/-[0-9a-f]{12}$/);
  });
  test("is deterministic", () => {
    expect(projectKey("/work/my app")).toBe(projectKey("/work/my app"));
  });
  test("paths that flatten to the same prefix do not collide", () => {
    expect(projectKey("/a/b-c")).not.toBe(projectKey("/a-b/c"));
  });
});

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
  test("a child whose name starts with .. is inside", () => {
    expect(isInside("/a/b/..cache/x", "/a/b")).toBe(true);
  });
});
