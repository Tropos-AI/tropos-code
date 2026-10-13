// src/permissions/rules.test.ts
import { describe, expect, test } from "bun:test";
import { bashPatternMatches, formatRule, parseRule, pathPatternMatches, splitBashCommand } from "./rules";

describe("parseRule / formatRule", () => {
  test("bare tool name", () => {
    expect(parseRule("Read")).toEqual({ tool: "Read" });
  });
  test("tool with pattern", () => {
    expect(parseRule("Bash(npm test:*)")).toEqual({ tool: "Bash", pattern: "npm test:*" });
  });
  test("round trip", () => {
    expect(formatRule(parseRule(" Edit(src/**) "))).toBe("Edit(src/**)");
  });
  test("malformed rules throw", () => {
    expect(() => parseRule("Bash(")).toThrow();
    expect(() => parseRule("")).toThrow();
    expect(() => parseRule("1abc")).toThrow();
  });
});

describe("splitBashCommand", () => {
  test("single command", () => {
    expect(splitBashCommand("git status")).toEqual({ parts: ["git status"], unsafe: false });
  });
  test("splits on && || ; | newline and &", () => {
    expect(splitBashCommand("a && b || c; d | e\nf & g").parts).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
  });
  test("does not split inside quotes", () => {
    expect(splitBashCommand(`echo "a && b" 'c; d'`)).toEqual({ parts: [`echo "a && b" 'c; d'`], unsafe: false });
  });
  test("command substitution is unsafe", () => {
    expect(splitBashCommand("git status $(curl x)").unsafe).toBe(true);
    expect(splitBashCommand("echo `id`").unsafe).toBe(true);
    expect(splitBashCommand(`echo "$(id)"`).unsafe).toBe(true);
    expect(splitBashCommand("diff <(a) <(b)").unsafe).toBe(true);
  });
  test("single-quoted $() is literal and safe", () => {
    expect(splitBashCommand("echo '$(id)'").unsafe).toBe(false);
  });
  test("file redirection is unsafe", () => {
    expect(splitBashCommand("git status > ~/.zshrc").unsafe).toBe(true);
    expect(splitBashCommand("echo x >> out.txt").unsafe).toBe(true);
    expect(splitBashCommand("ls &> all.log").unsafe).toBe(true);
  });
  test("fd and /dev/null redirection are safe", () => {
    expect(splitBashCommand("bun test 2>&1").unsafe).toBe(false);
    expect(splitBashCommand("bun test > /dev/null 2>&1")).toEqual({ parts: ["bun test > /dev/null 2>&1"], unsafe: false });
  });
  test("unterminated quote is unsafe", () => {
    expect(splitBashCommand(`echo "oops`).unsafe).toBe(true);
  });
});

describe("bashPatternMatches", () => {
  test("prefix pattern", () => {
    expect(bashPatternMatches("npm test:*", "npm test")).toBe(true);
    expect(bashPatternMatches("npm test:*", "npm test -- --watch")).toBe(true);
    expect(bashPatternMatches("npm test:*", "npm testing")).toBe(false);
  });
  test("exact pattern with whitespace normalisation", () => {
    expect(bashPatternMatches("git status", "git   status")).toBe(true);
    expect(bashPatternMatches("git status", "git status -s")).toBe(false);
  });
  test("wildcard", () => {
    expect(bashPatternMatches("*", "anything at all")).toBe(true);
  });
});

describe("pathPatternMatches", () => {
  const cwd = "/work/app";
  const home = "/home/u";
  test("relative glob", () => {
    expect(pathPatternMatches("src/**", "/work/app/src/a/b.ts", cwd, home)).toBe(true);
    expect(pathPatternMatches("src/**", "/work/app/test/a.ts", cwd, home)).toBe(false);
  });
  test("plain file", () => {
    expect(pathPatternMatches(".env", "/work/app/.env", cwd, home)).toBe(true);
    expect(pathPatternMatches(".env", "/work/app/.env.local", cwd, home)).toBe(false);
  });
  test("plain directory covers its contents", () => {
    expect(pathPatternMatches("docs", "/work/app/docs/x.md", cwd, home)).toBe(true);
  });
  test("home and absolute patterns", () => {
    expect(pathPatternMatches("~/notes/**", "/home/u/notes/a.md", cwd, home)).toBe(true);
    expect(pathPatternMatches("/etc/**", "/etc/hosts", cwd, home)).toBe(true);
  });
});

describe("splitBashCommand: shell parser differentials (fix round 1)", () => {
  test("ANSI-C and locale quoting ($'...' / $\"...\") is unsafe", () => {
    expect(splitBashCommand(`git status $'\\'' ; rm -rf x #'`).unsafe).toBe(true);
    expect(splitBashCommand(`echo $"x"`).unsafe).toBe(true);
  });
  test("$ quote inside double quotes stays literal and safe", () => {
    expect(splitBashCommand(`echo "$'x'"`).unsafe).toBe(false);
  });
  test("comment at start of a word is unsafe", () => {
    expect(splitBashCommand("git status #'\nrm -rf x").unsafe).toBe(true);
    expect(splitBashCommand("#hello").unsafe).toBe(true);
    expect(splitBashCommand("ls;#x").unsafe).toBe(true);
  });
  test("mid-word # stays safe", () => {
    expect(splitBashCommand("curl http://x/#a").unsafe).toBe(false);
    expect(splitBashCommand("echo a#b").unsafe).toBe(false);
  });
  test("quoted # stays safe", () => {
    expect(splitBashCommand(`echo "#x" '#y'`).unsafe).toBe(false);
  });
  test("any unquoted parenthesis is unsafe", () => {
    expect(splitBashCommand("diff =(ls) b").unsafe).toBe(true);
    expect(splitBashCommand("(cd x && rm y)").unsafe).toBe(true);
    expect(splitBashCommand("ls *(e:'rm -rf x':)").unsafe).toBe(true);
  });
  test("quoted parentheses stay safe", () => {
    expect(splitBashCommand(`echo "(x)"`).unsafe).toBe(false);
    expect(splitBashCommand("echo '(x)'").unsafe).toBe(false);
  });
  test(">& must be followed by only digits or -", () => {
    expect(splitBashCommand("git status >&2/../../.zshrc").unsafe).toBe(true);
    expect(splitBashCommand("git status >&2x").unsafe).toBe(true);
    expect(splitBashCommand("git status >&file").unsafe).toBe(true);
    expect(splitBashCommand("bun test 2>&1").unsafe).toBe(false);
    expect(splitBashCommand("bun test >&-").unsafe).toBe(false);
    expect(splitBashCommand("bun test > /dev/null 2>&1").unsafe).toBe(false);
  });
  test(">& word stops at a control operator", () => {
    expect(splitBashCommand("git status >&2;ls")).toEqual({ parts: ["git status >&2", "ls"], unsafe: false });
  });
});

describe("pathPatternMatches: hardening (fix round 1)", () => {
  const cwd = "/work/app";
  const home = "/home/u";
  test("normalizes .. segments in the candidate path", () => {
    expect(pathPatternMatches("src/**", "/work/app/src/../../etc/passwd", cwd, home)).toBe(false);
  });
  test("cwd containing glob characters", () => {
    const bracketCwd = "/work/[app]";
    expect(pathPatternMatches(".env", "/work/[app]/.env", bracketCwd, home)).toBe(true);
    expect(pathPatternMatches("src/**", "/work/[app]/src/a.ts", bracketCwd, home)).toBe(true);
    expect(pathPatternMatches("src/**", "/work/a/src/a.ts", bracketCwd, home)).toBe(false);
  });
  test("case-insensitive on darwin and win32", () => {
    const insensitive = process.platform === "darwin" || process.platform === "win32";
    expect(pathPatternMatches(".env", "/work/app/.ENV", cwd, home)).toBe(insensitive);
  });
  test("case-insensitive match on darwin", () => {
    if (process.platform !== "darwin") return;
    expect(pathPatternMatches(".env", "/work/app/.ENV", cwd, home)).toBe(true);
  });
});

describe("splitBashCommand: heredocs and herestrings (fix round 2)", () => {
  test("heredoc body with a quote cannot desync the scanner", () => {
    expect(splitBashCommand("git status <<X\n'\nX\nrm -rf y\n'").unsafe).toBe(true);
  });
  test("heredoc is unsafe", () => {
    expect(splitBashCommand("cat <<EOF\nhi\nEOF").unsafe).toBe(true);
    expect(splitBashCommand("cat <<-EOF\nhi\nEOF").unsafe).toBe(true);
    expect(splitBashCommand("cat <<<hello").unsafe).toBe(true);
  });
  test("single < input redirection stays safe", () => {
    expect(splitBashCommand("bun test < input.txt").unsafe).toBe(false);
  });
  test("quoted << stays safe", () => {
    expect(splitBashCommand(`echo "<<"`).unsafe).toBe(false);
    expect(splitBashCommand("echo '<<'").unsafe).toBe(false);
  });
});
