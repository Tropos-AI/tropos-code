// src/tools/bash/bash.ts
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { constants } from "node:os";
import { z } from "zod";
import type { ExecBackend } from "../../exec/backend";
import { localBackend } from "../../exec/local";
import { isInside } from "../../paths";
import { defineTool } from "../types";
import { OutputBuffer } from "./output-buffer";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const KILL_GRACE_MS = 5_000;
const KILL_TRIES = 10;
const KILL_RETRY_MS = 100;
const DRAIN_MS = 200;
const STREAM_LIMIT = 15_000; // stdout and stderr each; about 30k characters combined

const schema = z.object({
  command: z.string().min(1).describe("The shell command to run."),
  timeout_ms: z.number().int().min(1000).max(MAX_TIMEOUT_MS).optional().describe("Timeout in milliseconds (default 120000, max 600000)."),
  description: z.string().optional().describe("A few words on what the command does."),
  run_in_background: z
    .boolean()
    .optional()
    .describe("Start the command as a background job and return its id at once, without waiting. timeout_ms does not apply."),
});

const SECRET_ENV = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_ADMIN_KEY",
  "ANTHROPIC_IDENTITY_TOKEN",
  "ANTHROPIC_IDENTITY_TOKEN_FILE",
]);

/**
 * Names that look like they hold a credential: GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY, OPENAI_API_KEY,
 * PGPASSWORD and the like. Deliberately broad, but never PATH-like everyday names (PWD, SSH_AUTH_SOCK,
 * TOKENIZERS_PARALLELISM, KEYTIMEOUT).
 */
export function isSecretEnvName(name: string): boolean {
  return (
    SECRET_ENV.has(name) ||
    /^TROPOS_.*(KEY|TOKEN|SECRET)/i.test(name) ||
    /PASSWORD|PASSWD|SECRET|CREDENTIAL|PRIVATE_?KEY|ACCESS_KEY/i.test(name) ||
    /TOKEN(_|$)/i.test(name) ||
    /(^|_)(API_?)?KEY$/i.test(name) ||
    /_PWD$/i.test(name)
  );
}

/** The environment shell commands run with: ours, minus anything that looks like a credential. */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (isSecretEnvName(name)) continue;
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
    "Default timeout is 2 minutes (timeout_ms, up to 10 minutes). Output over 15,000 characters per stream (stdout/stderr) is cut in the middle. " +
    "Use Read, Glob, Grep, Edit and Write instead of cat, find, grep, sed or echo-redirection. " +
    "Start long-running processes such as dev servers or watchers with run_in_background, then read their output with BashOutput " +
    "and stop them with KillShell. A background job starts in the current working directory and never changes it.",
  schema,
  summarize: (input) => input.command,
  subject: (input, cwd) => ({ command: input.command, paths: [], cwd }),
  async run(input, ctx) {
    const startDir = ctx.cwd();
    const exec: ExecBackend = ctx.exec ?? localBackend;
    if (input.run_in_background) {
      const child = exec.spawn({
        shell: ctx.shell,
        script: `cd ${quote(startDir)} || exit 1\n${input.command}\n`,
        cwd: startDir,
        env: childEnv(),
        background: true,
      });
      const id = ctx.jobs.add(input.command, child, exec);
      return { content: `Started background job ${id}. Read its output with BashOutput and stop it with KillShell.`, summary: id };
    }
    const marker = exec.cwdMarker(randomUUID());
    const cwdFile = marker.host;
    const script = `cd ${quote(startDir)} || exit 1\n${input.command}\n__tropos_status=$?\npwd -P > ${quote(marker.inside)} 2>/dev/null\nexit $__tropos_status\n`;

    const child = exec.spawn({ shell: ctx.shell, script, cwd: startDir, env: childEnv() });
    const stdout = new OutputBuffer(STREAM_LIMIT);
    const stderr = new OutputBuffer(STREAM_LIMIT);
    const collectOut = (d: string) => stdout.push(d);
    const collectErr = (d: string) => stderr.push(d);
    child.stdout!.setEncoding("utf8").on("data", collectOut);
    child.stderr!.setEncoding("utf8").on("data", collectErr);
    // Registered now, not after exit: in Bun "exit" and "close" can fire in the same tick.
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));

    let timedOut = false;
    let aborted = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const groupAlive = (): boolean => exec.alive(child);
    const signalGroup = (sig: NodeJS.Signals) => exec.signal(child, sig);
    const terminate = () => {
      signalGroup("SIGTERM");
      // One SIGKILL to a group can miss a child the shell forks at that moment (macOS), so it is repeated until none is left.
      let tries = 0;
      const kill = () => {
        if (!groupAlive() || tries++ >= KILL_TRIES) return;
        signalGroup("SIGKILL");
        killTimer = setTimeout(kill, KILL_RETRY_MS);
        killTimer.unref();
      };
      killTimer ??= setTimeout(kill, KILL_GRACE_MS);
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
      stream!.off("data", collect);
      stream!.on("data", () => {});
      (stream as unknown as { unref?: () => void }).unref?.();
    }
    child.unref();
    // A guest's sandbox stops what the command left running before the next tool call (DockerBackend.quiesce).
    await exec.quiesce?.();

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
