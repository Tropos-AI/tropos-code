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

const schema = z.object({
  command: z.string().min(1).describe("The shell command to run."),
  timeout_ms: z.number().int().min(1000).max(MAX_TIMEOUT_MS).optional().describe("Timeout in milliseconds (default 120000, max 600000)."),
  description: z.string().optional().describe("A few words on what the command does, shown to the user."),
});

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
      env: process.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = new OutputBuffer();
    const stderr = new OutputBuffer();
    child.stdout.setEncoding("utf8").on("data", (d: string) => stdout.push(d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => stderr.push(d));

    let timedOut = false;
    let aborted = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const signalGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        // already gone
      }
    };
    const terminate = () => {
      signalGroup("SIGTERM");
      killTimer ??= setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS);
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
    await Promise.race([new Promise((r) => child.once("close", r)), Bun.sleep(DRAIN_MS)]);
    child.stdout.destroy();
    child.stderr.destroy();
    clearTimeout(timer);
    if (killTimer && !timedOut && !aborted) clearTimeout(killTimer);
    ctx.signal.removeEventListener("abort", onAbort);

    const notes: string[] = [];
    if (existsSync(cwdFile)) {
      const next = readFileSync(cwdFile, "utf8").trim();
      rmSync(cwdFile, { force: true });
      if (next && next !== startDir && existsSync(next) && statSync(next).isDirectory()) {
        if (ctx.allowedDirs.some((d) => isInside(next, d))) ctx.setCwd(next);
        else notes.push(`[working directory stays at ${startDir}: ${next} is outside the project]`);
      }
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
