// src/hooks/runner.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import type { HookCommand } from "../config/settings";
import { HookRunner, type HookRunnerConfig } from "./runner";

let dir: string;

beforeEach(async () => {
  dir = await makeTmpDir("tropos-hooks-");
});
afterEach(async () => {
  await removeDir(dir);
});

/** Writes an executable bash script into the temp dir and returns its path. */
function script(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const cmd = (command: string, timeout?: number): HookCommand => ({ type: "command", command, ...(timeout === undefined ? {} : { timeout }) });

function runner(config: HookRunnerConfig, extra: { shell?: string; env?: NodeJS.ProcessEnv; cwd?: string } = {}) {
  return new HookRunner(config, {
    sessionId: () => "sess-1",
    transcriptPath: () => "/tmp/t.jsonl",
    cwd: extra.cwd ?? dir,
    mode: () => "default",
    env: extra.env ?? { PATH: process.env.PATH, HOME: process.env.HOME },
    shell: extra.shell,
  });
}

describe("HookRunner", () => {
  test("has() reports configured events only", () => {
    const r = runner({ hooks: { PreToolUse: [{ hooks: [cmd("true")] }], Stop: [{ hooks: [] }] }, plugins: [{ name: "p", root: dir, hooks: { SessionEnd: [{ hooks: [cmd("true")] }] } }] });
    expect(r.has("PreToolUse")).toBe(true);
    expect(r.has("SessionEnd")).toBe(true);
    expect(r.has("Stop")).toBe(false);
    expect(r.has("PostToolUse")).toBe(false);
  });

  test("no matching hook returns an empty outcome without spawning", async () => {
    const r = runner({ hooks: { PreToolUse: [{ matcher: "Edit", hooks: [cmd("exit 2")] }] } });
    expect(await r.run("PreToolUse", { tool_name: "Bash" }, "Bash")).toEqual({ additionalContext: [], messages: [], errors: [] });
    expect(await r.run("Stop", {})).toEqual({ additionalContext: [], messages: [], errors: [] });
  });

  test("stdin carries the base fields plus the event input; env has the project dir", async () => {
    const out = join(dir, "stdin.json");
    const envOut = join(dir, "env.txt");
    const s = script("dump.sh", `cat > ${out}\necho "$TROPOS_PROJECT_DIR|$CLAUDE_PROJECT_DIR|$PWD|\${TROPOS_PLUGIN_ROOT-unset}" > ${envOut}`);
    const r = runner({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [cmd(s)] }] } });
    const res = await r.run("PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "t1" }, "Bash");
    expect(res.errors).toEqual([]);
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({
      session_id: "sess-1",
      transcript_path: "/tmp/t.jsonl",
      cwd: dir,
      permission_mode: "default",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_use_id: "t1",
    });
    expect(readFileSync(envOut, "utf8").trim()).toBe(`${dir}|${dir}|${dir}|unset`);
  });

  test("exit 2 blocks with stderr; other exits are errors", async () => {
    const block = script("block.sh", "echo 'not allowed' >&2\nexit 2");
    const fail = script("fail.sh", "echo 'oops' >&2\necho more >&2\nexit 1");
    const r = runner({ hooks: { PreToolUse: [{ hooks: [cmd(block), cmd(fail)] }] } });
    const res = await r.run("PreToolUse", { tool_name: "Bash" }, "Bash");
    expect(res.blocked).toBe("not allowed");
    expect(res.errors).toEqual([`${fail}: exit 1: oops`]);
  });

  test("JSON output: permission, updatedInput, context and messages merge in config order", async () => {
    const a = script("a.sh", `echo '{"systemMessage":"from a","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"command":"ls -a"},"additionalContext":"ctx a"}}'`);
    // b sleeps so it finishes last; order must still follow config, not completion.
    const b = script("b.sh", `sleep 0.2\necho '{"hookSpecificOutput":{"permissionDecision":"ask","permissionDecisionReason":"check","updatedInput":{"command":"ls -b"},"additionalContext":"ctx b"}}'`);
    const c = script("c.sh", `echo '{"systemMessage":"from c"}'`);
    const r = runner({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [cmd(a)] }, { matcher: "*", hooks: [cmd(b), cmd(c)] }] } });
    const res = await r.run("PreToolUse", { tool_name: "Bash" }, "Bash");
    expect(res).toEqual({
      permission: "ask",
      permissionReason: "check",
      updatedInput: { command: "ls -b" },
      additionalContext: ["ctx a", "ctx b"],
      messages: ["from a", "from c"],
      errors: [],
    });
  });

  test("invalid JSON is an error", async () => {
    const s = script("bad.sh", "echo '{not json'");
    const res = await runner({ hooks: { Stop: [{ hooks: [cmd(s)] }] } }).run("Stop", { stop_hook_active: false });
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toStartWith(`${s}: invalid JSON output:`);
  });

  test("plain stdout becomes context for UserPromptSubmit", async () => {
    const r = runner({ hooks: { UserPromptSubmit: [{ hooks: [cmd("echo 'today is Tuesday'")] }] } });
    expect((await r.run("UserPromptSubmit", { prompt: "hi" })).additionalContext).toEqual(["today is Tuesday"]);
  });

  test("Stop exit 2 sets blocked so the agent continues", async () => {
    const r = runner({ hooks: { Stop: [{ hooks: [cmd("echo 'run the tests' >&2; exit 2")] }] } });
    expect((await r.run("Stop", {})).blocked).toBe("run the tests");
  });

  test("regex matcher and match=undefined", async () => {
    const r = runner({ hooks: { PreToolUse: [{ matcher: "mcp__.*", hooks: [cmd("exit 2")] }] } });
    expect((await r.run("PreToolUse", {}, "mcp__gh__search")).blocked).toBeDefined();
    expect((await r.run("PreToolUse", {}, "Bash")).blocked).toBeUndefined();
    expect((await r.run("PreToolUse", {})).blocked).toBeDefined();
    const bad = runner({ hooks: { PreToolUse: [{ matcher: "(oops", hooks: [cmd("exit 2")] }] } });
    expect((await bad.run("PreToolUse", {}, "(oops")).blocked).toBeUndefined();
  });

  test("identical commands run once", async () => {
    const log = join(dir, "count.log");
    const command = `echo x >> ${log}`;
    const r = runner({
      hooks: { PostToolUse: [{ hooks: [cmd(command)] }, { matcher: "Write", hooks: [cmd(command)] }] },
      plugins: [{ name: "p", root: dir, hooks: { PostToolUse: [{ hooks: [cmd(command)] }] } }],
    });
    await r.run("PostToolUse", { tool_name: "Write" }, "Write");
    expect(readFileSync(log, "utf8")).toBe("x\n");
  });

  test("plugin hooks get the plugin root in env and substituted in the command", async () => {
    const pluginRoot = join(dir, "plugin");
    await Bun.write(join(pluginRoot, "hooks", "go.sh"), `#!/bin/bash\necho "{\\"systemMessage\\":\\"$TROPOS_PLUGIN_ROOT|$CLAUDE_PLUGIN_ROOT|$(basename "$0")\\"}"\n`);
    chmodSync(join(pluginRoot, "hooks", "go.sh"), 0o755);
    const r = runner({
      hooks: { SessionStart: [{ hooks: [cmd("echo settings first")] }] },
      plugins: [
        { name: "p", root: pluginRoot, hooks: { SessionStart: [{ matcher: "startup", hooks: [cmd("${TROPOS_PLUGIN_ROOT}/hooks/go.sh"), cmd("bash ${CLAUDE_PLUGIN_ROOT}/hooks/go.sh x")] }] } },
      ],
    });
    const res = await r.run("SessionStart", { source: "startup" }, "startup");
    expect(res.errors).toEqual([]);
    expect(res.additionalContext).toEqual(["settings first"]);
    expect(res.messages).toEqual([`${pluginRoot}|${pluginRoot}|go.sh`, `${pluginRoot}|${pluginRoot}|go.sh`]);
    expect((await r.run("SessionStart", { source: "resume" }, "resume")).messages).toEqual([]);
  });

  test("a hook past its timeout is killed and reported", async () => {
    const marker = join(dir, "survived");
    const s = script("slow.sh", `sleep 5\ntouch ${marker}`);
    const r = runner({ hooks: { PreToolUse: [{ hooks: [cmd(s, 0.2), cmd("echo fast >&2; exit 2")] }] } });
    const started = Date.now();
    const res = await r.run("PreToolUse", {}, "Bash");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(res.errors).toEqual([`${s}: timed out after 0.2s`]);
    expect(res.blocked).toBe("fast");
    await Bun.sleep(100);
    expect(existsSync(marker)).toBe(false);
  });

  test("a hook that ignores SIGTERM is killed after the grace period", async () => {
    const s = "trap '' TERM; sleep 10";
    const started = Date.now();
    const res = await runner({ hooks: { Stop: [{ hooks: [cmd(s, 0.1)] }] } }).run("Stop", {});
    const took = Date.now() - started;
    expect(res.errors).toEqual([`${s}: timed out after 0.1s`]);
    expect(took).toBeGreaterThanOrEqual(1_900);
    expect(took).toBeLessThan(5_000);
  });

  test("aborting kills running hooks; an already-aborted signal spawns nothing", async () => {
    const marker = join(dir, "ran");
    const s = script("long.sh", `touch ${marker}\nsleep 5`);
    const r = runner({ hooks: { Stop: [{ hooks: [cmd(s)] }] } });

    const pre = new AbortController();
    pre.abort();
    expect((await r.run("Stop", {}, undefined, pre.signal)).errors).toEqual([`${s}: cancelled`]);
    expect(existsSync(marker)).toBe(false);

    const ac = new AbortController();
    const started = Date.now();
    const pending = r.run("Stop", {}, undefined, ac.signal);
    setTimeout(() => ac.abort(), 150);
    const res = await pending;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(res.errors).toEqual([`${s}: cancelled`]);
  });

  test("output is capped at 64 KB per stream", async () => {
    const s = script("big.sh", "head -c 200000 /dev/zero | tr '\\0' 'a'");
    const res = await runner({ hooks: { UserPromptSubmit: [{ hooks: [cmd(s)] }] } }).run("UserPromptSubmit", { prompt: "x" });
    expect(res.additionalContext[0]).toHaveLength(64 * 1024);
  });

  test("a background grandchild holding stdout open does not stall the run", async () => {
    const res = await runner({ hooks: { UserPromptSubmit: [{ hooks: [cmd("(sleep 3 &) ; echo quick")] }] } }).run("UserPromptSubmit", { prompt: "x" });
    expect(res.additionalContext).toEqual(["quick"]);
  });

  test("spawn failure is an error, never a throw", async () => {
    const res = await runner({ hooks: { Stop: [{ hooks: [cmd("true")] }] } }, { shell: join(dir, "no-such-shell") }).run("Stop", {});
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toStartWith(`true: could not start ${join(dir, "no-such-shell")}:`);
  });

  test("a throwing base accessor becomes an error", async () => {
    const r = new HookRunner(
      { hooks: { Stop: [{ hooks: [cmd("true")] }] } },
      { sessionId: () => { throw new Error("no session"); }, transcriptPath: () => "", cwd: dir, mode: () => "default" },
    );
    expect((await r.run("Stop", {})).errors).toEqual(["Stop hooks: no session"]);
  });

  test("default env is process.env and default timeout is used for bad values", async () => {
    const r = new HookRunner(
      { hooks: { SessionStart: [{ hooks: [cmd("echo $HOME", -1)] }] } },
      { sessionId: () => "s", transcriptPath: () => "", cwd: dir, mode: () => "default" },
    );
    expect((await r.run("SessionStart", { source: "startup" }, "startup")).additionalContext).toEqual([process.env.HOME ?? ""]);
  });

  test("hooks with an empty command are skipped", async () => {
    const r = runner({ hooks: { Stop: [{ hooks: [cmd("  "), cmd("exit 2")] }] } });
    expect((await r.run("Stop", {})).blocked).toBe("Blocked by a hook (exit 2)");
  });
});
