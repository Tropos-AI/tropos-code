import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, parse } from "node:path";

export interface MemoryFile {
  path: string;
  content: string;
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

/**
 * Memory files in load order: ~/.tropos/TROPOS.md, then TROPOS.md (or AGENTS.md) in each
 * directory from the git root (filesystem root outside git) down to cwd, then TROPOS.local.md.
 */
export async function loadMemory(cwd: string, home: string): Promise<MemoryFile[]> {
  const files: MemoryFile[] = [];
  const seen = new Set<string>();
  const add = async (path: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    try {
      const content = (await readFile(path, "utf8")).trim();
      if (content) files.push({ path, content });
    } catch {
      // missing or unreadable: skip
    }
  };

  await add(join(home, "TROPOS.md"));
  const top = gitRoot(cwd) ?? parse(cwd).root;
  const chain: string[] = [];
  for (let dir = cwd; ; dir = dirname(dir)) {
    chain.unshift(dir);
    if (dir === top || dirname(dir) === dir) break;
  }
  for (const dir of chain) {
    if (existsSync(join(dir, "TROPOS.md"))) await add(join(dir, "TROPOS.md"));
    else if (existsSync(join(dir, "AGENTS.md"))) await add(join(dir, "AGENTS.md"));
  }
  await add(join(cwd, "TROPOS.local.md"));
  return files;
}
