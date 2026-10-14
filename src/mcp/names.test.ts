// src/mcp/names.test.ts
import { describe, expect, test } from "bun:test";
import { expandEnvVars, mcpToolName } from "./names";

describe("mcpToolName", () => {
  test("joins server and tool with the mcp prefix", () => {
    expect(mcpToolName("github", "get_issue")).toBe("mcp__github__get_issue");
  });

  test("replaces characters outside [A-Za-z0-9_-]", () => {
    expect(mcpToolName("my.server", "read file/v2")).toBe("mcp__my_server__read_file_v2");
  });

  test("keeps empty parts non-empty", () => {
    expect(mcpToolName("", "")).toBe("mcp______");
  });

  test("the server part is never cut into another server's prefix; long tool names end in a hash", () => {
    const name = mcpToolName("githubcommunity", "t".repeat(100));
    expect(name.length).toBe(64);
    expect(name.startsWith("mcp__githubcommunity__")).toBe(true);
    expect(name).toMatch(/_[0-9a-f]{6}$/);
    expect(mcpToolName("githubcommunity", `${"t".repeat(99)}x`)).not.toBe(name);
  });

  test("over-long server names are capped at 32 characters", () => {
    expect(mcpToolName("s".repeat(60), "tool")).toBe(`mcp__${"s".repeat(32)}__tool`);
  });
});

describe("expandEnvVars", () => {
  const env = { HOME: "/home/me", EMPTY: "", TOKEN: "abc" };

  test("expands ${VAR}", () => {
    expect(expandEnvVars("Bearer ${TOKEN}", env)).toBe("Bearer abc");
    expect(expandEnvVars("${HOME}/x:${HOME}", env)).toBe("/home/me/x:/home/me");
  });

  test("unset variables become empty", () => {
    expect(expandEnvVars("a${MISSING}b", env)).toBe("ab");
  });

  test("${VAR:-default} falls back when unset or empty", () => {
    expect(expandEnvVars("${MISSING:-dflt}", env)).toBe("dflt");
    expect(expandEnvVars("${EMPTY:-dflt}", env)).toBe("dflt");
    expect(expandEnvVars("${TOKEN:-dflt}", env)).toBe("abc");
    expect(expandEnvVars("${MISSING:-}", env)).toBe("");
  });

  test("leaves other dollar text alone", () => {
    expect(expandEnvVars("$TOKEN ${1BAD} $", env)).toBe("$TOKEN ${1BAD} $");
  });
});
