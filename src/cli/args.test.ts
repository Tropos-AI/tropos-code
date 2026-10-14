// src/cli/args.test.ts
import { describe, expect, test } from "bun:test";
import { CliError, parseCli, parseInvocation } from "./args";

const ID = "3f2b8c1e-9a4d-4e2f-8b1c-0d9e8f7a6b5c";

describe("parseCli", () => {
  test("defaults", () => {
    const o = parseCli([]);
    expect(o).toMatchObject({
      print: false,
      outputFormat: "text",
      allowedTools: [],
      continue: false,
      resume: false,
      dangerouslySkipPermissions: false,
      addDir: [],
      help: false,
      version: false,
    });
    expect(o.prompt).toBeUndefined();
  });

  test("print mode with a prompt", () => {
    const o = parseCli(["-p", "explain", "this"]);
    expect(o.print).toBe(true);
    expect(o.prompt).toBe("explain this");
  });

  test("output format, max turns, model, effort", () => {
    const o = parseCli(["-p", "x", "--output-format", "json", "--max-turns", "3", "--model", "claude-sonnet-5-5", "--effort", "low"]);
    expect(o.outputFormat).toBe("json");
    expect(o.maxTurns).toBe(3);
    expect(o.model).toBe("claude-sonnet-5-5");
    expect(o.effort).toBe("low");
  });

  test("allowed tools split on top-level commas only", () => {
    const o = parseCli(["--allowed-tools", "Read,Bash(git diff:*),Edit(src/{a,b}/**)"]);
    expect(o.allowedTools).toEqual(["Read", "Bash(git diff:*)", "Edit(src/{a,b}/**)"]);
  });

  test("resume with and without an id", () => {
    expect(parseCli(["-r"])).toMatchObject({ resume: true, resumeId: undefined });
    expect(parseCli(["--resume", ID])).toMatchObject({ resume: true, resumeId: ID });
  });

  test("resume does not swallow a non-uuid prompt", () => {
    const o = parseCli(["-r", "fix the bug"]);
    expect(o.resumeId).toBeUndefined();
    expect(o.prompt).toBe("fix the bug");
  });

  test("add-dir is repeatable", () => {
    expect(parseCli(["--add-dir", "../a", "--add-dir", "/b"]).addDir).toEqual(["../a", "/b"]);
  });

  test("rejects bad values", () => {
    expect(() => parseCli(["--output-format", "xml"])).toThrow(CliError);
    expect(() => parseCli(["--max-turns", "0"])).toThrow(CliError);
    expect(() => parseCli(["--effort", "huge"])).toThrow(CliError);
    expect(() => parseCli(["--permission-mode", "bypass"])).toThrow(CliError);
    expect(() => parseCli(["-c", "-r"])).toThrow(CliError);
    expect(() => parseCli(["--nope"])).toThrow(CliError);
  });

  test("permission mode", () => {
    expect(parseCli(["--permission-mode", "plan"]).permissionMode).toBe("plan");
  });
});

describe("tcode web", () => {
  test("web flags, then the usual session options", () => {
    const inv = parseInvocation(["web", "--port", "5000", "--no-open", "--model", "claude-sonnet-5-5", "--permission-mode", "plan"]);
    expect(inv).toMatchObject({ kind: "session", options: { web: { port: 5000, open: false, dev: false }, model: "claude-sonnet-5-5", permissionMode: "plan" } });
    expect(parseInvocation(["web", "--port=6000", "--dev"])).toMatchObject({ options: { web: { port: 6000, dev: true, open: true } } });
    expect(parseInvocation(["web"])).toMatchObject({ options: { web: { open: true, dev: false } } });
  });
  test("bad ports, prompts and print mode are refused; `tcode -- web` is still a prompt", () => {
    expect(() => parseInvocation(["web", "--port", "99999"])).toThrow("--port must be a port number");
    expect(() => parseInvocation(["web", "--port"])).toThrow("--port must be a port number");
    expect(() => parseInvocation(["web", "hello"])).toThrow("takes no prompt");
    expect(() => parseInvocation(["web", "-p"])).toThrow("print mode");
    expect(parseInvocation(["--", "web"])).toMatchObject({ kind: "session", options: { prompt: "web" } });
  });
});
