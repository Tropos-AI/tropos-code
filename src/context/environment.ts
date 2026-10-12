import { release } from "node:os";

const GIT_TIMEOUT_MS = 3_000;

/** Keeps untrusted strings (paths, shell, git output) from forging extra lines in the block. */
function oneLine(s: string): string {
  return s.replace(/[\r\n]/g, " ");
}

/**
 * Runs git with repo-configured hooks and optional locks neutralised, no credential prompts, and a
 * hard timeout. Returns stdout, or null on any failure (including the timeout).
 */
async function git(cwd: string, args: string[]): Promise<string | null> {
  const proc = Bun.spawn(
    ["git", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...args],
    { cwd, stdout: "pipe", stderr: "ignore", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve(null);
    }, GIT_TIMEOUT_MS);
  });
  const result = (async () => {
    const out = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? out : null;
  })().catch(() => null);
  try {
    return await Promise.race([result, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function gitSummary(cwd: string): Promise<string> {
  // symbolic-ref works in a repo with no commits yet (rev-parse --abbrev-ref does not).
  const branch = await git(cwd, ["symbolic-ref", "--short", "HEAD"]).catch(() => null);
  const status = await git(cwd, ["status", "--porcelain"]).catch(() => null);
  if (status === null) return "not a git repository";
  const changed = status.split("\n").filter(Boolean).length;
  const name = branch?.trim() || "(no branch)";
  return `branch ${name}, ${changed === 0 ? "clean" : `${changed} changed file${changed === 1 ? "" : "s"}`}`;
}

export async function environmentBlock(cwd: string, opts: { now?: Date; shell?: string } = {}): Promise<string> {
  const now = opts.now ?? new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return [
    `Working directory: ${oneLine(cwd)}`,
    `Platform: ${process.platform} ${release()}`,
    `Shell: ${oneLine(opts.shell ?? process.env.SHELL ?? "/bin/sh")}`,
    `Date: ${date}`,
    `Git: ${oneLine(await gitSummary(cwd))}`,
  ].join("\n");
}
