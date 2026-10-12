import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { release } from "node:os";
import { dirname, join, resolve } from "node:path";

const HEAD_MAX_BYTES = 4096;

/** Keeps untrusted strings (paths, shell, git output) from forging extra lines in the block. */
function oneLine(s: string): string {
  return s.replace(/[\r\n]/g, " ");
}

/**
 * Reads a small regular file. O_NONBLOCK plus fstat keeps a FIFO or device from blocking the read.
 * Returns null when the path is not a readable regular file.
 */
async function readSmallFile(path: string): Promise<string | null> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile()) return null;
      const buf = Buffer.alloc(Math.min(info.size, HEAD_MAX_BYTES));
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      return buf.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/**
 * Finds the git directory by walking up from cwd, without running git. A `.git` directory is used
 * as is; a `.git` file must contain `gitdir: <path>`, resolved against the file's own directory,
 * and is used only when that target is a directory (linked worktrees and submodules).
 */
async function findGitDir(cwd: string): Promise<string | null> {
  let dir = cwd;
  while (true) {
    const candidate = join(dir, ".git");
    const info = await stat(candidate).catch(() => null);
    if (info?.isDirectory()) return candidate;
    if (info?.isFile()) {
      const text = await readSmallFile(candidate);
      const target = text?.match(/^gitdir:[ \t]*(.+)$/m)?.[1]?.trim();
      if (!target) return null;
      const resolved = resolve(dir, target);
      const targetInfo = await stat(resolved).catch(() => null);
      return targetInfo?.isDirectory() ? resolved : null;
    }
    if (info) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Describes the checkout from its HEAD file alone. Git itself is never run here: repo-configured
 * hooks and filters (fsmonitor, clean/smudge) would otherwise execute on every launch.
 */
export async function gitSummary(cwd: string): Promise<string> {
  const gitDir = await findGitDir(cwd);
  const head = ((gitDir && (await readSmallFile(join(gitDir, "HEAD")))) ?? "").trim();
  const branch = head.match(/^ref: refs\/heads\/(.+)$/);
  if (branch) {
    // The name is repo-controlled text that lands in the prompt, so only conventional names are shown.
    const name = branch[1] ?? "";
    return /^[A-Za-z0-9._\/-]{1,100}$/.test(name) ? `branch ${name}` : "branch (unusual name)";
  }
  if (/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(head)) return "detached HEAD";
  return "not a git repository";
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
