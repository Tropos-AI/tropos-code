// src/tools/file-guard.ts
import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, mkdir, open, realpath, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { errorText } from "../error-text";
import { isInside } from "../paths";
import type { ToolContext, ToolOutput } from "./types";

/**
 * Writes a file's contents, creating or truncating it, but never follows a symlink at the leaf.
 * Callers resolve the path first; this closes the window where the leaf is swapped for a link.
 * A symlinked leaf fails with ELOOP. Only the leaf is protected: parent directories are not, so the file tools use
 * openVerified instead; this stays for Tropos's own stores, which no sandboxed command can reach.
 */
export async function writeFileNoFollow(path: string, content: string): Promise<void> {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW;
  const handle = await open(path, flags, 0o666);
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
}

/**
 * A folder on the way to a file became a link (or the file was replaced) between the check and the open. A sandboxed
 * command shares the project with the file tools, which run on the host as the owner: it can swap a folder for a link
 * to ~/.ssh at just that moment.
 */
export class PathSwapError extends Error {
  override name = "PathSwapError";
  constructor() {
    super("the path changed while it was being opened (a folder on its way now leads somewhere else), so it was left untouched");
  }
}

/** Folded the way the disk compares names, so a path typed in another case (macOS, Windows) still matches its real form. */
function fold(path: string): string {
  return process.platform === "darwin" || process.platform === "win32" ? path.normalize("NFC").toLowerCase() : path;
}

/** The real path, refused unless it is `path` itself or, with a scope, inside one of `within`. */
async function realInPlace(path: string, within?: readonly string[]): Promise<string> {
  let real: string;
  try {
    real = await realpath(path);
  } catch {
    throw new PathSwapError();
  }
  const ok = within ? within.some((dir) => isInside(fold(real), fold(dir))) : fold(real) === fold(path);
  if (!ok) throw new PathSwapError();
  return real;
}

/**
 * Confirms that an open handle is the file now at `path`: the path's real form must be the path itself (or lie inside
 * `within`), and the file there must be the handle's (same device and inode). A handle opened through a folder that
 * was a link for a moment fails the inode check even when the link is gone again by now.
 */
export async function verifyOpened(handle: FileHandle, path: string, within?: readonly string[]): Promise<{ info: Stats; real: string }> {
  const info = await handle.stat();
  const real = await realInPlace(path, within);
  let now: Stats;
  try {
    now = await lstat(real);
  } catch {
    throw new PathSwapError();
  }
  if (now.dev !== info.dev || now.ino !== info.ino) throw new PathSwapError();
  return { info, real };
}

export type OpenPurpose = "read" | "update" | "create";

export interface VerifiedFile {
  handle: FileHandle;
  info: Stats;
  /** The file's real path. */
  real: string;
}

/**
 * Opens a file the model named and proves the handle is the file at that path before anything is read or written.
 * The leaf is never followed (O_NOFOLLOW) and nothing waits on a FIFO (O_NONBLOCK). Nothing is truncated at open:
 * "update" opens an existing file as it is (the caller replaces its contents once verified), and "create" only makes a
 * new file (O_EXCL) in a parent checked just before, so an outside file is never opened for writing through a swapped
 * path. With `within` (a search's folders), a real path anywhere inside them is accepted instead of only the path
 * itself. On a mismatch the handle is closed and PathSwapError thrown.
 */
export async function openVerified(path: string, purpose: OpenPurpose, within?: readonly string[]): Promise<VerifiedFile> {
  const base = constants.O_NOFOLLOW | constants.O_NONBLOCK;
  let flags = base | constants.O_RDONLY;
  if (purpose === "update") flags = base | constants.O_RDWR;
  if (purpose === "create") {
    await realInPlace(dirname(path));
    flags = base | constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;
  }
  const handle = await open(path, flags, 0o666);
  try {
    const { info, real } = await verifyOpened(handle, path, within);
    return { handle, info, real };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Replaces an open file's contents from the start: truncated only now, after the handle was verified. */
export async function replaceContents(handle: FileHandle, content: string): Promise<void> {
  const data = Buffer.from(content, "utf8");
  await handle.truncate(0);
  for (let at = 0; at < data.length; ) {
    const { bytesWritten } = await handle.write(data, at, data.length - at, at);
    at += bytesWritten;
  }
}

/**
 * Creates `dir` and its missing parents one folder at a time, checking after each that it really is where it was
 * asked for: `mkdir -p` would follow a parent swapped for a link and build the rest outside the project. The deepest
 * folder that already exists is checked the same way.
 */
export async function makeParentDirs(dir: string): Promise<void> {
  const missing: string[] = [];
  let at = dir;
  for (;;) {
    try {
      await lstat(at);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    missing.unshift(at);
    const up = dirname(at);
    if (up === at) break;
    at = up;
  }
  await realInPlace(at);
  for (const folder of missing) {
    try {
      await mkdir(folder);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await realInPlace(folder);
  }
}

/**
 * Before a file tool touches the project: a sandbox that sweeps (a guest's container) stops what earlier commands
 * left running, so nothing there can swap a folder while the tool works. The error result while it can't.
 */
export async function sandboxBusy(ctx: ToolContext): Promise<ToolOutput | undefined> {
  const problem = await ctx.exec?.quiesce?.();
  return problem === undefined ? undefined : { content: problem, isError: true };
}

export type Freshness = { ok: true; missing: true } | { ok: true; missing: false; mtimeMs: number } | { ok: false; error: string };

/**
 * A file may be changed only if it doesn't exist yet, or was read this session and hasn't changed since.
 * Stat failures other than "not found" propagate so the caller reports them rather than treating the file as absent.
 */
export async function checkFreshness(path: string, ctx: ToolContext): Promise<Freshness> {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, missing: true };
    throw error;
  }
  if (info.isDirectory()) return { ok: false, error: `${path} is a directory.` };
  const check = ctx.readState.check(path, info.mtimeMs);
  if (check === "unread") return { ok: false, error: `${path} already exists. Read it before changing it.` };
  if (check === "stale") return { ok: false, error: staleText(path) };
  return { ok: true, missing: false, mtimeMs: info.mtimeMs };
}

/** Why a file read earlier can't be changed now. */
export function staleText(path: string): string {
  return `${path} changed on disk since you last read it. Read it again first.`;
}

/** Error result for a write that failed on disk or in path resolution. */
export function cannotWrite(path: string, error: unknown): ToolOutput {
  return { content: `Cannot write ${path}: ${errorText(error)}`, isError: true };
}
