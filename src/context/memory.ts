import { constants, existsSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, join, parse, sep } from "node:path";

export interface MemoryFile {
  path: string;
  content: string;
  /** "user" for the file under the Tropos home; "project" for anything found in the repo. */
  source: "user" | "project";
}

/** Characters kept from one memory file (markers aside). */
export const MAX_FILE_CHARS = 40_000;
/** UTF-8 uses at most 4 bytes per character, so this many bytes always covers MAX_FILE_CHARS. */
const MAX_READ_BYTES = MAX_FILE_CHARS * 4;

/** Shares of MAX_FILE_CHARS an oversized file keeps: its start, its end, and the rules from between. */
const HEAD_CHARS = Math.floor(MAX_FILE_CHARS * 0.45);
const TAIL_CHARS = Math.floor(MAX_FILE_CHARS * 0.15);
const DIGEST_CHARS = Math.floor(MAX_FILE_CHARS * 0.35);
/** Bytes read from the end of a file too large to read whole; always covers TAIL_CHARS. */
const TAIL_BYTES = TAIL_CHARS * 4;

/** Lines that state a rule: cutting them out of the middle would silently drop a constraint. */
const POLICY_LINE = /\b(must|never|always|don't|do not|security|secret|credential|password|token|test)\b/i;

/** Drops the partial UTF-8 character a byte offset may have cut into. */
function fromCharBoundary(buf: Buffer): string {
  let i = 0;
  while (i < buf.length && i < 4 && (buf[i]! & 0xc0) === 0x80) i++;
  return buf.subarray(i).toString("utf8");
}

/**
 * Shortens an oversized memory file: 45% head and 15% tail (cut at line breaks where possible) and, in
 * between, up to 35% of the omitted middle's policy lines (must/never/security/test...), in order and
 * deduplicated. `start` is the file's text from its first byte; `end`, when the file was too large to
 * read whole, is text from its last bytes. Markers name the file so the model can Read all of it.
 */
export function truncateMemoryText(path: string, start: string, end: string | null, size: string): string {
  let headEnd = Math.min(HEAD_CHARS, start.length);
  const headBreak = start.lastIndexOf("\n", headEnd);
  if (headBreak > HEAD_CHARS / 2) headEnd = headBreak;
  const source = end ?? start;
  let tailStart = Math.max(end === null ? headEnd : 0, source.length - TAIL_CHARS);
  const tailBreak = source.indexOf("\n", tailStart);
  if (tailBreak >= 0 && tailBreak < tailStart + TAIL_CHARS / 2) tailStart = tailBreak + 1;
  const head = start.slice(0, headEnd).trimEnd();
  const tail = source.slice(tailStart).trim();
  const middle = end === null ? start.slice(headEnd, tailStart) : start.slice(headEnd);

  const digest: string[] = [];
  const seen = new Set<string>();
  let used = 0;
  for (const raw of middle.split("\n")) {
    const line = raw.trim();
    if (!line || seen.has(line) || !POLICY_LINE.test(line)) continue;
    if (used + line.length + 1 > DIGEST_CHARS) break;
    seen.add(line);
    used += line.length + 1;
    digest.push(line);
  }
  const parts = [head, `[… truncated: ${path} is ${size}; read it for the full text …]`];
  if (digest.length > 0) parts.push("[policy lines from the omitted middle:]", ...digest, "[… end of policy lines; the file ends with: …]");
  if (tail) parts.push(tail);
  return parts.join("\n");
}

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
      const readAt = async (offset: number, want: number): Promise<Buffer> => {
        const buf = Buffer.alloc(want);
        let got = 0;
        while (got < want) {
          const { bytesRead } = await handle.read(buf, got, want - got, offset + got);
          if (bytesRead === 0) break;
          got += bytesRead;
        }
        return buf.subarray(0, got);
      };
      if (info.size > MAX_READ_BYTES) {
        // Too large to read whole: the start and the last TAIL_BYTES, MAX_READ_BYTES in all.
        const start = (await readAt(0, MAX_READ_BYTES - TAIL_BYTES)).toString("utf8");
        const end = fromCharBoundary(await readAt(info.size - TAIL_BYTES, TAIL_BYTES));
        return truncateMemoryText(path, start, end, `${info.size.toLocaleString("en-US")} bytes`);
      }
      const text = (await readAt(0, info.size)).toString("utf8").trim();
      if (text.length <= MAX_FILE_CHARS) return text;
      return truncateMemoryText(path, text, null, `${text.length.toLocaleString("en-US")} chars`);
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
