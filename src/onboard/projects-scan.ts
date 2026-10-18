// src/onboard/projects-scan.ts — finds the user's git repositories in the usual folders so setup can offer them as
// projects. Bounded on purpose (depth, time, count) and it never follows a symlink, so a loop or a huge tree can't hang it.
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { workspaceProblem } from "../gateway/policy";
import { addProject, listProjects, ProjectError } from "../gateway/projects";
import type { RepoCandidateView } from "../web/admin/api";

export const SCAN_ROOTS = ["Desktop", "Documents", "Developer", "code", "Projects", "src", "dev"] as const;
export const SCAN_LIMITS = { maxDepth: 3, timeMs: 3_000, maxRepos: 50, recentDays: 30 } as const;

const DAY_MS = 86_400_000;
const GIT_STAMPS = ["index", "HEAD", "logs/HEAD", "FETCH_HEAD"];

export interface ScanOptions {
  home: string;
  userHome: string;
  now(): number;
  roots?: readonly string[];
  limits?: Partial<Record<keyof typeof SCAN_LIMITS, number>>;
}

async function mtime(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

/** Newest sign of life in a repo: the .git file itself, or the newest of the files git touches on use. */
async function touchedAt(dir: string): Promise<number> {
  const git = join(dir, ".git");
  const own = await mtime(git);
  if (own === null) return 0;
  if (!(await stat(git)).isDirectory()) return own;
  const stamps = await Promise.all(GIT_STAMPS.map((f) => mtime(join(git, f))));
  const found = stamps.filter((m): m is number => m !== null);
  return found.length ? Math.max(...found) : own; // the folder's own mtime changes when git writes a lock, so it is only a fallback
}

async function hasGit(dir: string): Promise<boolean> {
  try {
    await lstat(join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

export async function scanForRepos(opts: ScanOptions): Promise<{ repos: RepoCandidateView[]; truncated: boolean }> {
  const limits = { ...SCAN_LIMITS, ...opts.limits };
  const started = opts.now();
  const registered = new Set((await listProjects(opts.home)).map((p) => p.path));
  const seen = new Set<string>();
  const repos: RepoCandidateView[] = [];
  let truncated = false;

  for (const rootName of opts.roots ?? SCAN_ROOTS) {
    const rootDir = join(opts.userHome, rootName);
    let rootStat;
    try {
      rootStat = await lstat(rootDir);
    } catch {
      continue;
    }
    if (!rootStat.isDirectory()) continue; // a symlinked root is not followed either
    const queue: Array<{ dir: string; depth: number }> = [{ dir: rootDir, depth: 0 }];
    while (queue.length) {
      if (opts.now() - started >= limits.timeMs) return finish(true);
      const { dir, depth } = queue.shift()!;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue; // isDirectory() is false for symlinks
        const child = join(dir, e.name);
        const childDepth = depth + 1;
        if (await hasGit(child)) {
          const real = await realpath(child).catch(() => null);
          if (!real || seen.has(real) || workspaceProblem(real, opts.home, opts.userHome)) continue;
          if (repos.length >= limits.maxRepos) return finish(true);
          seen.add(real);
          const touched = await touchedAt(child);
          repos.push({ path: real, name: basename(real), touchedAt: touched, recent: opts.now() - touched <= limits.recentDays * DAY_MS, registered: registered.has(real) });
        } else if (childDepth < limits.maxDepth) {
          queue.push({ dir: child, depth: childDepth });
        }
      }
    }
  }
  return finish(truncated);

  function finish(cut: boolean): { repos: RepoCandidateView[]; truncated: boolean } {
    truncated = cut;
    repos.sort((a, b) => Number(b.recent) - Number(a.recent) || b.touchedAt - a.touchedAt);
    return { repos, truncated };
  }
}

/** Registers the chosen repos; one that is already a project is skipped, one that is refused is reported in the owner's words. */
export async function addScannedProjects(home: string, paths: string[], userHome: string): Promise<{ added: string[]; failed: { path: string; error: string }[] }> {
  const added: string[] = [];
  const failed: { path: string; error: string }[] = [];
  const before = new Set((await listProjects(home)).map((p) => p.id));
  for (const path of paths) {
    try {
      const project = await addProject(home, { path }, { userHome, reuse: true });
      if (!before.has(project.id)) {
        before.add(project.id);
        added.push(project.path);
      }
    } catch (err) {
      if (!(err instanceof ProjectError)) throw err;
      failed.push({ path, error: err.message });
    }
  }
  return { added, failed };
}
