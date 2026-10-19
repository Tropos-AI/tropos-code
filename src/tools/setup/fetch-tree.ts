// src/tools/setup/fetch-tree.ts — brings a plugin's or skill's folder onto this computer, into a staging folder, without
// running anything from it: a shallow, hook-free clone, or a copy of a local folder that refuses links.
import { copyFile, lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { shallowClone } from "./git-clone";
import type { Resolve, Source } from "./sources";

export interface TreeOptions {
  maxBytes: number;
  /** The environment git runs with (tests point HOME at a fixture). */
  cloneEnv?: NodeJS.ProcessEnv;
  /** Looks the repository's host up before git runs; the system resolver by default. */
  resolve?: Resolve;
}

const mb = (n: number): string => (n >= 1024 * 1024 ? `${Math.round(n / 1024 / 1024)} MB` : `${n} bytes`);
const tooBig = (max: number) => new Error(`It is bigger than ${mb(max)}, so I didn't install it.`);
const linked = (rel: string) => new Error(`It holds a link to another file (${rel}); I only install plain files and folders.`);

/** Copies `src` into `dest` (new), skipping .git; any link inside is refused, and so is more than `budget.left` bytes. */
async function copyTree(src: string, dest: string, rel: string, budget: { left: number; max: number }): Promise<void> {
  await mkdir(dest, { recursive: true });
  for (const name of (await readdir(src)).sort()) {
    if (name === ".git") continue;
    const from = join(src, name);
    const path = rel ? `${rel}/${name}` : name;
    const info = await lstat(from);
    if (info.isSymbolicLink()) throw linked(path);
    if (info.isDirectory()) await copyTree(from, join(dest, name), path, budget);
    else if (info.isFile()) {
      budget.left -= info.size;
      if (budget.left < 0) throw tooBig(budget.max);
      await copyFile(from, join(dest, name));
    }
  }
}

/** The bytes of every file under `dir`; a link (which a clone never makes here) is refused. */
async function treeBytes(dir: string, rel = ""): Promise<number> {
  let total = 0;
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw linked(rel ? `${rel}/${name}` : name);
    total += info.isDirectory() ? await treeBytes(path, rel ? `${rel}/${name}` : name) : info.size;
  }
  return total;
}

/** Fetches a git or local source into `dest`, which must not exist yet. A one-file source is the caller's to handle. */
export async function fetchTree(source: Exclude<Source, { kind: "file" }>, dest: string, opts: TreeOptions): Promise<void> {
  if (source.kind === "local") {
    let from: string;
    try {
      from = await realpath(source.path);
      if (!(await lstat(from)).isDirectory()) throw new Error("not a folder");
    } catch {
      throw new Error(`${source.path} isn't a folder on this computer.`);
    }
    await copyTree(from, dest, "", { left: opts.maxBytes, max: opts.maxBytes });
    return;
  }
  await shallowClone(source.url, dest, { ...(opts.cloneEnv ? { env: opts.cloneEnv } : {}), ...(source.ref ? { ref: source.ref } : {}), ...(opts.resolve ? { resolve: opts.resolve } : {}) });
  // Nothing of git's stays: the folder is plain files from here on.
  await rm(join(dest, ".git"), { recursive: true, force: true });
  if ((await treeBytes(dest)) > opts.maxBytes) throw tooBig(opts.maxBytes);
}

/** The folder `subdir` inside a fetched tree, which must be a real folder there. */
export async function folderIn(tree: string, subdir: string | undefined): Promise<string> {
  if (!subdir) return tree;
  const dir = join(tree, subdir);
  const info = await lstat(dir).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`There is no folder ${subdir} in it.`);
  return dir;
}
