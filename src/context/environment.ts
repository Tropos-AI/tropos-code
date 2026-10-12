import { release } from "node:os";

async function git(cwd: string, args: string[]): Promise<string | null> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  return (await proc.exited) === 0 ? out : null;
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
    `Working directory: ${cwd}`,
    `Platform: ${process.platform} ${release()}`,
    `Shell: ${opts.shell ?? process.env.SHELL ?? "/bin/sh"}`,
    `Date: ${date}`,
    `Git: ${await gitSummary(cwd)}`,
  ].join("\n");
}
