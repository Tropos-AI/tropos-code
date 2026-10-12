// src/tools/bash/bash.ts
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { isInside } from "../../paths";
import { defineTool } from "../types";
import { OutputBuffer } from "./output-buffer";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const KILL_GRACE_MS = 5_000;
const DRAIN_MS = 200;
const STREAM_LIMIT = 15_000; // stdout and stderr each; about 30k characters combined

const schema = z.object({
  command: z.string().min(1).describe("The shell command to run."),
  timeout_ms: z.number().int().min(1000).max(MAX_TIMEOUT_MS).optional().describe("Timeout in milliseconds (default 120000, max 600000)."),
  description: z.string().optional().describe("A few words on what the command does, shown to the user."),
});

const SECRET_ENV = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_ADMIN_KEY",
  "ANTHROPIC_IDENTITY_TOKEN",
  "ANTHROPIC_IDENTITY_TOKEN_FILE",
]);

/** The environment shell commands run with: ours, minus Anthropic credentials and Tropos secrets. */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (SECRET_ENV.has(name) || /^TROPOS_.*(KEY|TOKEN|SECRET)/i.test(name)) continue;
    env[name] = value;
  }
  return env;
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export const bashTool = defineTool({
  name: "Bash",
  kind: "exec",
  description:
    "Run a command in the user's shell and return its output. The working directory carries over between calls, so cd works. " +
    "Default timeout is 2 minutes (timeout_ms, up to 10 minutes). Output over 30,000 characters is cut in the middle. " +
    "Use Read, Glob, Grep, Edit and Write instead of cat, find, grep, sed or echo-redirection. " +
    "Start long-running processes such as dev servers or watchers in the background with &.",
  schema,
  summarize: (input) => input.command,
  subject: (input) => ({ command: input.command, paths: [] }),
  async run(input, ctx) {
    const startDir = ctx.cwd();
    const cwdFile = join(tmpdir(), `tropos-cwd-${randomUUID()}`);
    const script = `cd ${quote(startDir)} || exit 1\n${input.command}\n__tropos_status=$?\npwd -P > ${quote(cwdFile)} 2>/dev/null\nexit $__tropos_status\n`;

    const child = spawn(ctx.shell, ["-c", script], {
      cwd: startDir,
      env: childEnv(),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = new OutputBuffer(STREAM_LIMIT);
    const stderr = new OutputBuffer(STREAM_LIMIT);
    const collectOut = (d: string) => stdout.push(d);
    const collectErr = (d: string) => stderr.push(d);
    child.stdout.setEncoding("utf8").on("data", collectOut);
    child.stderr.setEncoding("utf8").on("data", collectErr);
    // Registered now, not after exit: in Bun "exit" and "close" can fire in the same tick.
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));

    let timedOut = false;
    let aborted = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const groupAlive = (): boolean => {
      try {
        if (!child.pid) return false;
        process.kill(-child.pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const signalGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        // already gone
      }
    };
    const terminate = () => {
      signalGroup("SIGTERM");
      killTimer ??= setTimeout(() => {
        if (groupAlive()) signalGroup("SIGKILL");
      }, KILL_GRACE_MS);
    };
    const timeoutMs = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    if (ctx.signal.aborted) onAbort();

    let exitCode: number;
    try {
      exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, sig) => resolve(code ?? 128 + (sig ? (constants.signals[sig] ?? 0) : 0)));
      });
    } catch (err) {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
      return { content: `Could not start ${ctx.shell}: ${(err as Error).message}`, isError: true };
    }
    clearTimeout(timer);
    ctx.signal.removeEventListener("abort", onAbort);
    if (killTimer) {
      // Group already gone: nothing left to kill. Otherwise keep the escalation, but never let it hold the process open.
      if (!groupAlive()) clearTimeout(killTimer);
      else killTimer.unref();
    }

    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([closed, new Promise<void>((r) => (drainTimer = setTimeout(r, DRAIN_MS)))]);
    clearTimeout(drainTimer);
    // Leave the pipes open but drained, so a background job that writes later doesn't die on a broken pipe.
    for (const [stream, collect] of [[child.stdout, collectOut], [child.stderr, collectErr]] as const) {
      stream.off("data", collect);
      stream.on("data", () => {});
      (stream as unknown as { unref?: () => void }).unref?.();
    }
    child.unref();

    const notes: string[] = [];
    try {
      if (existsSync(cwdFile)) {
        const next = readFileSync(cwdFile, "utf8").trim();
        if (next && next !== startDir && existsSync(next) && statSync(next).isDirectory()) {
          if (ctx.allowedDirs.some((d) => isInside(next, d))) ctx.setCwd(next);
          else notes.push(`[working directory stays at ${startDir}: ${next} is outside the project]`);
        }
      }
    } finally {
      rmSync(cwdFile, { force: true });
    }

    const sections: string[] = [];
    const out = stdout.toString().trimEnd();
    const err = stderr.toString().trimEnd();
    if (out) sections.push(out);
    if (err) sections.push(`[stderr]\n${err}`);
    if (timedOut) sections.push(`[timed out after ${timeoutMs / 1000}s; process killed]`);
    if (aborted) sections.push("[interrupted by user]");
    if (exitCode !== 0 && !timedOut && !aborted) sections.push(`[exit code ${exitCode}]`);
    sections.push(...notes);

    const failed = exitCode !== 0 || timedOut || aborted;
    const result = { content: sections.join("\n") || "(no output)", summary: failed ? `exit ${exitCode}` : "ok" };
    return failed ? { ...result, isError: true } : result;
  },
});
