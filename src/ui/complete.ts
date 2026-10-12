import { readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { COMMANDS } from "./commands";

const MAX_SUGGESTIONS = 50;

function isOutside(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === ".." || rel.startsWith("../") || isAbsolute(rel);
}

/** "@src/co" → ["@src/components/", "@src/config/"]. Hidden entries only when the prefix starts with ".". */
export async function completeFile(token: string, cwd: string): Promise<string[]> {
  const partial = token.slice(1);
  const slash = partial.lastIndexOf("/");
  const dir = slash === -1 ? "" : partial.slice(0, slash + 1);
  const base = partial.slice(dir.length);
  const abs = resolve(cwd, dir);
  if (isOutside(cwd, abs)) return [];
  // Lexical containment is not enough: a symlink inside cwd can point anywhere, so compare real paths.
  const [realDir, realCwd] = await Promise.all([realpath(abs).catch(() => null), realpath(cwd).catch(() => null)]);
  if (!realDir || !realCwd || isOutside(realCwd, realDir)) return [];
  const entries = await readdir(realDir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.name.startsWith(base) && e.name !== "node_modules" && (base.startsWith(".") || !e.name.startsWith(".")))
    .map((e) => `@${dir}${e.name}${e.isDirectory() ? "/" : ""}`)
    .sort()
    .slice(0, MAX_SUGGESTIONS);
}

export function completeCommand(token: string): string[] {
  return COMMANDS.map((c) => `/${c.name}`)
    .filter((name) => name.startsWith(token))
    .sort();
}

export function commonPrefix(items: string[]): string {
  if (items.length === 0) return "";
  let prefix = items[0]!;
  for (const item of items.slice(1)) {
    while (!item.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  return prefix;
}
