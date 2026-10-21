// src/harness/workspace.ts — where a probe works: a fresh repository holding one revision of the project and nothing of
// its history (so the agent can't look up a later fix, and nothing it does reaches the real repository), the diff it
// left, and the project's own checks run against it. Checks run code the agent wrote, so they run confined.
import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExecBackend } from "../exec/backend";
import { auditDiff, type DiffAudit } from "./audit";
import type { Domain } from "./domain";

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "tropos-lab",
  GIT_AUTHOR_EMAIL: "lab@localhost",
  GIT_COMMITTER_NAME: "tropos-lab",
  GIT_COMMITTER_EMAIL: "lab@localhost",
};

const TAIL_CHARS = 4_000;
const tail = (s: string) => (s.length > TAIL_CHARS ? `…${s.slice(-TAIL_CHARS)}` : s);

async function git(args: string[], cwd: string, env: Record<string, string> = {}): Promise<string> {
  const child = Bun.spawn(["git", ...args], { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code}): ${err.trim()}`);
  return out;
}

/**
 * A fresh git repository at `dest` holding the files of `revision` in `repo` and a single commit. Later history is not
 * copied, so the agent cannot look up the real fix.
 */
export async function createWorkspace(repo: string, revision: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  // The owner's repository: nothing its config names (hooks, fsmonitor, system config) may run.
  const archive = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", repo, "archive", "--format=tar", revision], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  });
  const untar = Bun.spawn(["tar", "-x", "-C", dest], { stdin: archive.stdout, stderr: "pipe" });
  const [archiveCode, untarCode] = await Promise.all([archive.exited, untar.exited]);
  if (archiveCode !== 0) throw new Error(`git archive ${revision} failed: ${(await new Response(archive.stderr).text()).trim()}`);
  if (untarCode !== 0) throw new Error(`extracting ${revision} failed: ${(await new Response(untar.stderr).text()).trim()}`);
  await git(["init", "-q", "-b", "main"], dest);
  await git(["add", "-A"], dest);
  await git(["commit", "-q", "--no-gpg-sign", "-m", "base"], dest, GIT_IDENTITY);
}

export interface WorkspaceDiff {
  audit: DiffAudit;
  /** The whole change as a binary-safe patch against the base commit. */
  patch: string;
}

/** Everything the agent changed, staged, as an audit and a patch. */
export async function workspaceDiff(dir: string): Promise<WorkspaceDiff> {
  await git(["add", "-A"], dir);
  const [numstat, zero, patch] = await Promise.all([
    git(["diff", "--cached", "--no-renames", "--numstat"], dir),
    git(["diff", "--cached", "--no-renames", "-U0"], dir),
    git(["diff", "--cached", "--binary"], dir),
  ]);
  return { audit: auditDiff(numstat, zero), patch };
}

export interface CommandResult {
  command: string;
  ok: boolean;
  exit: number | null;
  timedOut: boolean;
  /** The end of stdout and stderr together. */
  tail: string;
  seconds: number;
}

/** Runs a project's setup (dependency install from its lockfile) on the host, before the agent starts. */
export async function runHostCommand(command: string, cwd: string, timeoutMs: number): Promise<CommandResult> {
  const started = performance.now();
  const child = Bun.spawn(["/bin/sh", "-c", command], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timer);
  return { command, ok: exit === 0 && !timedOut, exit, timedOut, tail: tail(out + err), seconds: Math.round((performance.now() - started) / 1000) };
}

/** Runs one command through an exec backend (the sandbox), collecting its output, killed at `timeoutMs`. */
export async function runBackendCommand(backend: ExecBackend, command: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, signal?: AbortSignal): Promise<CommandResult> {
  const started = performance.now();
  const child = backend.spawn({ shell: "/bin/sh", script: command, cwd, env });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => void (output += chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => void (output += chunk.toString("utf8")));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    backend.signal(child, "SIGKILL");
  }, timeoutMs);
  const stop = () => backend.signal(child, "SIGKILL");
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) stop();
  const exit = await new Promise<number | null>((resolve) => {
    child.on("close", (code) => resolve(code));
    child.on("error", () => resolve(null));
  });
  clearTimeout(timer);
  signal?.removeEventListener("abort", stop);
  return { command, ok: exit === 0 && !timedOut, exit, timedOut, tail: tail(output), seconds: Math.round((performance.now() - started) / 1000) };
}

function packageScripts(dir: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    return pkg.scripts ?? {};
  } catch {
    return {};
  }
}

/** The dependency install a fresh copy of the project needs, from its lockfile; undefined when it needs none. */
export function defaultSetup(dir: string, domain: Domain): string | undefined {
  if (domain === "ts-bun") return "bun install --frozen-lockfile";
  if (domain === "ts-node") return existsSync(join(dir, "package-lock.json")) ? "npm ci --no-audit --no-fund" : existsSync(join(dir, "pnpm-lock.yaml")) ? "pnpm install --frozen-lockfile" : undefined;
  return undefined;
}

/** The project's own verifiers: its tests and its type checker, where they can be found. */
export function defaultChecks(dir: string, domain: Domain): string[] {
  const scripts = packageScripts(dir);
  switch (domain) {
    case "ts-bun":
      return ["bun test", ...(scripts.typecheck ? ["bun run typecheck"] : existsSync(join(dir, "tsconfig.json")) ? ["bun x tsc --noEmit"] : [])];
    case "ts-node":
      return [...(scripts.test ? ["npm test --silent"] : []), ...(scripts.typecheck ? ["npm run typecheck --silent"] : [])];
    case "python":
      return ["python3 -m pytest -q"];
    case "rust":
      return ["cargo test --quiet"];
    case "go":
      return ["go test ./..."];
    default:
      return [];
  }
}
