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
 * Reads one memory candidate and returns its trimmed, capped content (possibly empty), or null when
 * the candidate is not usable. `scope` is the canonical directory the file must resolve inside, or
 * null outside git: there, symlinks are refused outright and regular files are read as they are.
 * Reads at most MAX_READ_BYTES from the file, so no file is read in full.
 */
async function readMemoryFile(path: string, scope: string | null): Promise<string | null> {
  try {
    const link = await lstat(path);
    if (link.isSymbolicLink()) {
      if (scope === null) return null;
    } else if (!link.isFile()) {
      return null; // directories, FIFOs, devices, sockets
    }
    const real = await realpath(path);
    if (scope !== null && !isInside(real, scope)) return null;
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

/** Per directory, the first of these that is a usable file is loaded; the rest are ignored. */
const PROJECT_MEMORY_NAMES = ["TROPOS.md", "AGENTS.md", "CLAUDE.md"];

/**
 * Memory files in load order: ~/.tropos/TROPOS.md, then the first usable PROJECT_MEMORY_NAMES file
 * in each directory from the git root (filesystem root outside git) down to cwd, then
 * TROPOS.local.md. The user file may be a symlink only into the Tropos home. Project files may be
 * symlinks only inside a git repository and only when they resolve inside its root; outside git no
 * project symlink is followed.
 */
export async function loadMemory(cwd: string, home: string): Promise<MemoryFile[]> {
  const files: MemoryFile[] = [];
  const seen = new Set<string>();
  const add = async (path: string, scope: string | null, source: MemoryFile["source"]) => {
    const content = await readMemoryFile(path, scope);
    if (content === null) return false;
    const key = (await canonical(path)) ?? path;
    if (seen.has(key)) return true;
    seen.add(key);
    if (content) files.push({ path, content, source });
    return true;
  };

  const homeRoot = await canonical(home);
  if (homeRoot !== null) await add(join(home, "TROPOS.md"), homeRoot, "user");

  const gitTop = gitRoot(cwd);
  const top = gitTop ?? parse(cwd).root;
  const scope = gitTop === null ? null : await canonical(gitTop);
  const chain: string[] = [];
  for (let dir = cwd; ; dir = dirname(dir)) {
    chain.unshift(dir);
    if (dir === top || dirname(dir) === dir) break;
  }
  for (const dir of chain) {
    for (const name of PROJECT_MEMORY_NAMES) {
      if (await add(join(dir, name), scope, "project")) break;
    }
  }
  await add(join(cwd, "TROPOS.local.md"), scope, "project");
  return files;
}
