// src/extensions/sources.ts
import { realpath } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { gitRoot } from "../context/memory";

export type ExtensionKind = "commands" | "skills" | "agents";

/** Where an extension came from. Project files arrive with the code and grant nothing. */
export type ExtensionSource = "user" | "project" | "plugin";

export interface ExtensionDir {
  dir: string;
  source: ExtensionSource;
  /** Plugin name, for source "plugin"; names from it are namespaced `plugin:name`. */
  plugin?: string;
  /** For project dirs: the project root (git root, or cwd outside git) every file must really live in. */
  root?: string;
}

export interface PluginRoot {
  name: string;
  root: string;
}

/** Project folders that hold extensions: Tropos's own, plus Claude Code's and the agentskills.io one for skills. */
function projectFolders(kind: ExtensionKind): string[] {
  const folders = [join(".tropos", kind), join(".claude", kind)];
  if (kind === "skills") folders.push(join(".agents", "skills"));
  return folders;
}

/** Directories from cwd up to the git root (only cwd outside git), nearest first. */
export function projectChain(cwd: string): string[] {
  const root = gitRoot(cwd);
  if (!root) return [cwd];
  const chain: string[] = [];
  let dir = cwd;
  while (true) {
    chain.push(dir);
    if (dir === root) return chain;
    const parent = dirname(dir);
    if (parent === dir) return chain;
    dir = parent;
  }
}

/**
 * Where extensions of one kind are looked for, highest precedence first: the user's ~/.tropos, then
 * the project (nearest directory first), then plugins. Loaders keep the first of each name, so a
 * cloned repo can't replace a command or skill the user wrote.
 */
export function extensionDirs(kind: ExtensionKind, opts: { cwd: string; home: string; plugins?: PluginRoot[] }): ExtensionDir[] {
  const dirs: ExtensionDir[] = [{ dir: join(opts.home, kind), source: "user" }];
  const chain = projectChain(opts.cwd);
  const root = chain.at(-1)!;
  for (const base of chain) {
    for (const folder of projectFolders(kind)) dirs.push({ dir: join(base, folder), source: "project", root });
  }
  for (const plugin of opts.plugins ?? []) dirs.push({ dir: join(plugin.root, kind), source: "plugin", plugin: plugin.name });
  return dirs;
}

/**
 * False when a project file resolves outside its project: a repo could otherwise link
 * `.tropos/commands/x.md` to `~/.aws/credentials` and have it sent to the model as a command.
 * Non-project dirs always pass.
 */
export async function staysInProject(dir: ExtensionDir, path: string): Promise<boolean> {
  if (dir.source !== "project" || !dir.root) return true;
  try {
    const [real, root] = await Promise.all([realpath(path), realpath(dir.root)]);
    return real === root || real.startsWith(root.endsWith(sep) ? root : root + sep);
  } catch {
    return false;
  }
}

/** The name an extension is called by: plugin ones are `plugin:name`. */
export function qualifiedName(dir: ExtensionDir, name: string): string {
  return dir.plugin ? `${dir.plugin}:${name}` : name;
}
