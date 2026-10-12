import { constants, existsSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, join, parse, sep } from "node:path";

export interface MemoryFile {
  path: string;
  content: string;
  /** "user" for the file under the Tropos home; "project" for anything found in the repo. */
  source: "user" | "project";
}

/** Characters kept from one memory file. */
export const MAX_FILE_CHARS = 40_000;
const TRUNCATION_NOTE = "\n[truncated: file is larger than 40,000 characters]";
/** UTF-8 uses at most 4 bytes per character, so this many bytes always covers MAX_FILE_CHARS. */
const MAX_READ_BYTES = MAX_FILE_CHARS * 4;

export function gitRoot(cwd: string): string | null {
  let dir = cwd;
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function canonical(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

function isInside(file: string, boundary: string): boolean {
  const prefix = boundary.endsWith(sep) ? boundary : boundary + sep;
  return file.startsWith(prefix);
}

/**
 * Reads one memory candidate. Returns its trimmed, capped content (possibly empty), or null when
 * the candidate is not usable: missing, not a regular file (directories, FIFOs, devices), or a
 * symlink whose target lies outside `boundary`. Reads at most MAX_READ_BYTES from the file.
 */
async function readMemoryFile(path: string, boundary: string | null): Promise<string | null> {
  if (boundary === null) return null;
  try {
    const link = await lstat(path);
    if (!link.isFile() && !link.isSymbolicLink()) return null;
    const real = await realpath(path);
    if (!isInside(real, boundary)) return null;
    // O_NONBLOCK keeps a FIFO swapped in after the checks from blocking the open; fstat rejects it.
    const handle = await open(real, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile()) return null;
      const want = Math.min(info.size, MAX_READ_BYTES);
      const buf = Buffer.alloc(want);
      let got = 0;
      while (got < want) {
        const { bytesRead } = await handle.read(buf, got, want - got, got);
        if (bytesRead === 0) break;
        got += bytesRead;
      }
      const text = buf.subarray(0, got).toString("utf8");
      const truncated = got < info.size || text.length > MAX_FILE_CHARS;
      const body = text.slice(0, MAX_FILE_CHARS).trim();
      return truncated ? `${body}${TRUNCATION_NOTE}` : body;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/**
 * Memory files in load order: ~/.tropos/TROPOS.md, then TROPOS.md (or AGENTS.md when TROPOS.md is
 * not a usable file) in each directory from the git root (filesystem root outside git) down to
 * cwd, then TROPOS.local.md. Symlinks are followed only when they resolve inside the directory
 * they belong to (the Tropos home, or the walk's top directory).
 */
export async function loadMemory(cwd: string, home: string): Promise<MemoryFile[]> {
  const files: MemoryFile[] = [];
  const seen = new Set<string>();
  const add = async (path: string, boundary: string | null, source: MemoryFile["source"]) => {
    const content = await readMemoryFile(path, boundary);
    if (content === null) return false;
    const key = (await canonical(path)) ?? path;
    if (seen.has(key)) return true;
    seen.add(key);
    if (content) files.push({ path, content, source });
    return true;
  };

  await add(join(home, "TROPOS.md"), await canonical(home), "user");

  const top = gitRoot(cwd) ?? parse(cwd).root;
  const topBoundary = await canonical(top);
  const chain: string[] = [];
  for (let dir = cwd; ; dir = dirname(dir)) {
    chain.unshift(dir);
    if (dir === top || dirname(dir) === dir) break;
  }
  for (const dir of chain) {
    if (!(await add(join(dir, "TROPOS.md"), topBoundary, "project"))) {
      await add(join(dir, "AGENTS.md"), topBoundary, "project");
    }
  }
  await add(join(cwd, "TROPOS.local.md"), topBoundary, "project");
  return files;
}
