// src/cli/lifecycle/context.test.ts
import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { homedir } from "node:os";
import { VERSION } from "../../version";
import { createLifecycleContext, readlineTerminal, type LifecycleDeps, type LifecycleTerminal } from "./context";

function fakeTerminal(answers: string[], interactive = true) {
  const asked: string[] = [];
  const secrets: string[] = [];
  const terminal: LifecycleTerminal = {
    interactive,
    ask: async (q) => (asked.push(q), answers.shift() ?? ""),
    askSecret: async (q) => (secrets.push(q), answers.shift() ?? ""),
  };
  return { terminal, asked, secrets };
}

const deps = (terminal: LifecycleTerminal, env: NodeJS.ProcessEnv = { TROPOS_HOME: "/tmp/x-tropos" }): LifecycleDeps => ({
  out: () => {},
  err: () => {},
  env,
  cwd: "/work",
  execPath: "/bin/tcode",
  scriptPath: "/s.ts",
  terminal,
});

describe("field wiring", () => {
  test("home comes from TROPOS_HOME, userHome from the OS, plus version, paths and now", () => {
    const out: string[] = [];
    const err: string[] = [];
    const ctx = createLifecycleContext({ ...deps(fakeTerminal([]).terminal), out: (t) => out.push(t), err: (t) => err.push(t) });
    expect(ctx.home).toBe("/tmp/x-tropos");
    expect(ctx.userHome).toBe(homedir());
    expect(ctx.version).toBe(VERSION);
    expect(ctx.cwd).toBe("/work");
    expect(ctx.execPath).toBe("/bin/tcode");
    expect(ctx.scriptPath).toBe("/s.ts");
    expect(ctx.interactive).toBe(true);
    ctx.out("a");
    ctx.err("b");
    expect([out, err]).toEqual([["a"], ["b"]]);
    expect(Math.abs(ctx.now() - Date.now())).toBeLessThan(1000);
  });

  test("overrides win over the defaults", () => {
    const ctx = createLifecycleContext(deps(fakeTerminal([]).terminal), { now: () => 42, home: "/h" });
    expect(ctx.now()).toBe(42);
    expect(ctx.home).toBe("/h");
  });

  test("without an injected terminal it still builds (stdio-derived interactivity)", () => {
    const ctx = createLifecycleContext({ ...deps(fakeTerminal([]).terminal), terminal: undefined });
    expect(ctx.interactive).toBe(Boolean(process.stdin.isTTY && process.stdout.isTTY));
  });
});

describe("confirm", () => {
  const run = async (answer: string, defaultYes?: boolean) => {
    const t = fakeTerminal([answer]);
    const ctx = createLifecycleContext(deps(t.terminal));
    return { result: await ctx.confirm("Sure?", defaultYes), asked: t.asked };
  };

  test("accepts y / yes in any case, with whitespace", async () => {
    for (const a of ["y", "Y", "yes", "YES", "  yes  "]) expect((await run(a)).result).toBe(true);
  });
  test("anything else is no, even when the default is yes", async () => {
    for (const a of ["n", "no", "nope", "yy", "maybe"]) expect((await run(a, true)).result).toBe(false);
  });
  test("an empty answer takes the default", async () => {
    expect((await run("", true)).result).toBe(true);
    expect((await run("   ")).result).toBe(false);
    expect((await run("", false)).result).toBe(false);
  });
  test("the question shows which answer is the default", async () => {
    expect((await run("", true)).asked).toEqual(["Sure? [Y/n] "]);
    expect((await run("")).asked).toEqual(["Sure? [y/N] "]);
  });
  test("without a terminal it answers the default and asks nothing", async () => {
    const t = fakeTerminal(["y"], false);
    const ctx = createLifecycleContext(deps(t.terminal));
    expect(ctx.interactive).toBe(false);
    expect(await ctx.confirm("q")).toBe(false);
    expect(await ctx.confirm("q", true)).toBe(true);
    expect(t.asked).toEqual([]);
  });
});

describe("prompt", () => {
  test("returns the trimmed answer", async () => {
    const ctx = createLifecycleContext(deps(fakeTerminal(["  hello  "]).terminal));
    expect(await ctx.prompt("Name?")).toBe("hello");
  });
  test("an empty answer returns the default, or empty text", async () => {
    const ctx = createLifecycleContext(deps(fakeTerminal(["", "  ", ""]).terminal));
    expect(await ctx.prompt("Name?", { default: "bob" })).toBe("bob");
    expect(await ctx.prompt("Name?", { default: "bob" })).toBe("bob");
    expect(await ctx.prompt("Name?")).toBe("");
  });
  test("the default is shown in brackets", async () => {
    const t = fakeTerminal(["x", "y"]);
    const ctx = createLifecycleContext(deps(t.terminal));
    await ctx.prompt("Name?", { default: "bob" });
    await ctx.prompt("Name?");
    expect(t.asked).toEqual(["Name? [bob] ", "Name? "]);
  });
  test("secret prompts go through askSecret, not ask", async () => {
    const t = fakeTerminal([" sk-123 "]);
    const ctx = createLifecycleContext(deps(t.terminal));
    expect(await ctx.prompt("Key?", { secret: true })).toBe("sk-123");
    expect(t.secrets).toEqual(["Key? "]);
    expect(t.asked).toEqual([]);
  });
  test("without a terminal it returns the default and asks nothing", async () => {
    const t = fakeTerminal(["typed"], false);
    const ctx = createLifecycleContext(deps(t.terminal));
    expect(await ctx.prompt("q", { default: "d" })).toBe("d");
    expect(await ctx.prompt("q", { secret: true })).toBe("");
    expect(t.asked.concat(t.secrets)).toEqual([]);
  });
});

describe("readlineTerminal over in-memory streams", () => {
  const streams = () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let written = "";
    output.on("data", (d) => (written += d));
    return { input, output, written: () => written };
  };

  test("ask prints the question and resolves with the typed line", async () => {
    const s = streams();
    const term = readlineTerminal(s.input, s.output, true);
    expect(term.interactive).toBe(true);
    const pending = term.ask("Name? ");
    s.input.write("alice\n");
    expect(await pending).toBe("alice");
    expect(s.written()).toContain("Name? ");
  });

  test("askSecret never echoes the typed text but still shows the question and ends the line", async () => {
    const s = streams();
    const term = readlineTerminal(s.input, s.output, false);
    expect(term.interactive).toBe(false);
    const pending = term.askSecret("Key? ");
    s.input.write("sk-secret\n");
    expect(await pending).toBe("sk-secret");
    expect(s.written()).toContain("Key? ");
    expect(s.written()).not.toContain("sk-secret");
    expect(s.written().endsWith("\n")).toBe(true);
  });
});
