// src/tools/file-guard.ts
import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, mkdir, open, realpath, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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

export interface OpenOptions {
  /** A search's folders: a real path anywhere inside them is accepted instead of only the path itself. */
  within?: readonly string[];
  /** The folders a sandboxed command can change (the session's allowed dirs), for removeStray after a failed create. */
  project?: readonly string[];
}

/**
 * Opens a file the model named and proves the handle is the file at that path before anything is read or written.
 * The leaf is never followed (O_NOFOLLOW) and nothing waits on a FIFO (O_NONBLOCK). Nothing is truncated at open:
 * "update" opens an existing file as it is (the caller replaces its contents once verified), and "create" only makes a
 * new file (O_EXCL) in a parent checked just before, so an outside file is never opened for writing through a swapped
 * path; one created elsewhere anyway (the parent swapped after its check) is removed again where that is safe. On a
 * mismatch the handle is closed and PathSwapError thrown.
 */
export async function openVerified(path: string, purpose: OpenPurpose, opts: OpenOptions = {}): Promise<VerifiedFile> {
  const base = constants.O_NOFOLLOW | constants.O_NONBLOCK;
  let flags = base | constants.O_RDONLY;
  if (purpose === "update") flags = base | constants.O_RDWR;
  if (purpose === "create") {
    await realInPlace(dirname(path));
    flags = base | constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;
  }
  const handle = await open(path, flags, 0o666);
  try {
    const { info, real } = await verifyOpened(handle, path, opts.within);
    return { handle, info, real };
  } catch (error) {
    if (purpose === "create" && opts.project) await removeStray(handle, path, opts.project);
    await handle.close();
    throw error;
  }
}

/**
 * Removes the empty file a create just made somewhere other than `path` (a folder on its way became a link between
 * the check and the open). Where it landed is found from its folder's real path now; it is unlinked only if the file
 * there is still this handle's, still empty, and lies outside `project`. Outside the project no folder on the way can
 * be changed by a sandboxed command, so the unlink can't be redirected; inside it the command could have made the file
 * itself, so it is left. A file that can't be found again (the link swapped back already) stays, empty. True when
 * removed.
 */
export async function removeStray(handle: FileHandle, path: string, project: readonly string[]): Promise<boolean> {
  try {
    const info = await handle.stat();
    const landed = join(await realpath(dirname(path)), basename(path));
    if (project.some((dir) => isInside(fold(landed), fold(dir)))) return false;
    const now = await lstat(landed);
    if (now.dev !== info.dev || now.ino !== info.ino || now.size !== 0) return false;
    await unlink(landed);
    return true;
  } catch {
    return false;
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

/** Throws PathSwapError unless `path`'s real form is the path itself: for a path-based step (a rename) right before it. */
export async function assertInPlace(path: string): Promise<void> {
  await realInPlace(path);
}

export interface SandboxHold {
  release: () => void;
}

/**
 * Taken before a file tool touches the project and released when it is done: a sandbox that sweeps (a guest's
 * container) stops what earlier commands left running and holds new ones back meanwhile, so nothing there can swap a
 * folder while the tool works. The error result while it can't be taken.
 */
export async function holdSandbox(ctx: ToolContext): Promise<SandboxHold | ToolOutput> {
  const hold = await ctx.exec?.holdForFiles?.(ctx.signal);
  if (hold === undefined) return { release: () => {} };
  return hold.ok ? hold : { content: hold.reason, isError: true };
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
