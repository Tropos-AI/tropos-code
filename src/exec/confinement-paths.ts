// src/exec/confinement-paths.ts — the paths a confined chat command may write, must not touch, and must not read.
// One source for both confinements (sandboxProfile on macOS, bwrapArgs on Linux).
import { type Dirent, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { workspaceInstructionPaths, workspaceOwnPaths } from "../home/layout";
import { agentsDir, isInside, worktreesDir } from "../paths";
import { SANDBOX_CACHE_ENV, sandboxCacheDir } from "./env";

export class ConfinementError extends Error {
  override name = "ConfinementError";
}

/** Secrets a chat command may not read, relative to the user's home (an absolute entry stands for itself). */
export const SECRET_PATHS: readonly string[] = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".config/gh",
  ".docker/config.json",
  ".netrc",
  ".pgpass",
  ".git-credentials",
  ".config/git/credentials",
  ".npmrc",
  ".pypirc",
  ".kube",
  ".config/gcloud",
  ".azure",
  ".password-store",
  ".cargo/credentials",
  ".cargo/credentials.toml",
  ".vault-token",
  ".terraform.d/credentials.tfrc.json",
  ".config/op",
  // Other coding agents: their sign-ins and past sessions.
  ".claude",
  ".codex",
  ".gemini",
  ".local/share/keyrings",
  "Library/Keychains",
  // Shell and REPL histories: commands typed with a token or password in them.
  ".zsh_history",
  ".zsh_sessions",
  ".bash_history",
  ".bash_sessions",
  ".history",
  ".local/share/fish/fish_history",
  ".python_history",
  ".node_repl_history",
  ".psql_history",
  ".mysql_history",
  ".sqlite_history",
  ".lesshst",
  // Browser profiles: cookies and saved passwords.
  "Library/Application Support/Google/Chrome",
  "Library/Application Support/Chromium",
  "Library/Application Support/BraveSoftware",
  "Library/Application Support/Microsoft Edge",
  "Library/Application Support/Arc",
  "Library/Application Support/Firefox",
  "Library/Safari",
  "Library/Cookies",
  ".mozilla",
  ".config/google-chrome",
  ".config/chromium",
  ".config/BraveSoftware",
  ".config/microsoft-edge",
  "/Library/Keychains",
];

/** Package-manager caches a chat command may write, relative to the user's home. */
export const CACHE_PATHS: readonly string[] = [
  ".npm",
  ".bun/install/cache",
  ".pnpm-store",
  ".local/share/pnpm",
  ".yarn/berry/cache",
  ".cargo/registry",
  ".cargo/git",
  "go/pkg/mod",
  ".gradle/caches",
  ".m2/repository",
  ".cache/pip",
  ".cache/pnpm",
  ".cache/yarn",
  ".cache/go-build",
  ".cache/uv",
  ".cache/deno",
  ".cache/ms-playwright",
  "Library/Caches/pip",
  "Library/Caches/pnpm",
  "Library/pnpm",
  "Library/Caches/Yarn",
  "Library/Caches/go-build",
  "Library/Caches/Homebrew",
  "Library/Caches/uv",
  "Library/Caches/deno",
  "Library/Caches/ms-playwright",
  "Library/Caches/node-gyp",
];

export interface ConfinementPaths {
  project: string;
  /** Writable besides the project: temp dirs (not the per-sandbox cache, which `cacheDir` handles). */
  writable: string[];
  /** The per-sandbox package-cache root `<home>/sandbox-cache`; writable and readable although it sits inside the denied `~/.tropos`. */
  cacheDir: string;
  /** `<project>/.git` and, when it is a link, its target inside the project. */
  gitDirs: string[];
  /** `<project>/.husky` and, when it is a link, its target inside the project. */
  husky: string[];
  /** Tropos's worktrees folder: the only place a `.git` file (a linked worktree's pointer) is accepted. */
  worktreesRoot: string;
  /** A linked worktree's git dirs outside the project (its admin dir and the repo's common dir); hooks and config in them are protected. */
  linkedGitDirs: string[];
  deniedReads: string[];
  /** Readable although inside a denied path: Tropos's default project and the chats' git worktrees. */
  readCarveOuts: string[];
  /** The chief's own files inside that project (USER.md, the journal …): neither readable nor writable, though the workspace is. */
  ownFiles: string[];
  /**
   * For a session that isn't the owner's: the workspace's root instruction files (TROPOS.md, CLAUDE.md …), which the
   * owner's sessions there load. Read-only, and a missing one can't be created. Empty for the owner.
   */
  instructionFiles: string[];
  /**
   * The owner's other projects (real roots): their `.env` files are unreadable. The macOS profile matches them by
   * pattern, at any depth and including ones created later; bwrap can only hide files that exist (otherProjectSecrets).
   * Never a project that lies inside the session's or holds it (a monorepo root, the repo a worktree belongs to):
   * those are the session's own files. One that holds the user's home is in otherProjectsShallow instead.
   */
  otherProjects: string[];
  /**
   * Other projects that hold the user's home (a registered `/`, say): only their `.env` files up to two folders below
   * the root are denied, and never in the session's own project, since a pattern at any depth there would cover every
   * project of the user's.
   */
  otherProjectsShallow: string[];
  /**
   * Concrete paths to deny besides that: the real targets of linked `.env` files (both platforms) and, on Linux, the
   * `.env` files found, or a whole project too big to search. Denied after the read carve-outs, since the default
   * project, inside one, is usually one of those projects.
   */
  otherProjectSecrets: string[];
  platform: NodeJS.Platform;
}

/** `.env`, `.env.local`, `.env.production` …, and direnv's `.envrc`; not the templates (ENV_TEMPLATE) committed with them. */
const ENV_FILE = /^\.env(\..+)?$|^\.envrc$/;
const ENV_TEMPLATE = /^\.env\.(example|sample|template)$/i;
/** How far below a project's root its `.env` files are looked for: `apps/web/.env` is found. */
const ENV_SCAN_DEPTH = 2;
/** Folders the search reads in one project; on Linux a project with more is denied whole instead (otherProjectSecrets). */
export const ENV_SCAN_DIRS = 2_000;
/** Folders searched for linked `.env` files on macOS, where only their targets need listing. */
const ENV_LINK_SCAN_DIRS = 500;
const ENV_SCAN_SKIPPED: ReadonlySet<string> = new Set(["node_modules", ".git", ".venv", "venv", "vendor", "target"]);

/** The other projects whose `.env` files are denied: real roots, without the session's own, its parents or children. */
function otherProjectRoots(project: string, others: readonly string[], userHome: string): { deep: string[]; shallow: string[] } {
  const roots = unique(others.map(real)).filter((root) => !isInside(root, project));
  return {
    deep: roots.filter((root) => !isInside(project, root) && !isInside(userHome, root)),
    shallow: roots.filter((root) => isInside(userHome, root)),
  };
}

/**
 * The concrete `.env` paths to deny in the other projects. Real paths: a linked `.env` is denied where it points. On
 * macOS a pattern covers the files themselves, so only linked ones are looked for (the targets lie elsewhere); on
 * Linux every file is, and a project with more folders than the search reads is denied whole, so a file is never
 * missed for lack of time. Found when the confinement is built: on Linux a file created later in another project isn't
 * covered until the next session.
 */
function otherProjectSecrets(roots: readonly string[], shallow: readonly string[], project: string, platform: NodeJS.Platform): string[] {
  const found: string[] = [];
  // A project holding the home can't be denied whole: on Linux, a search that can't finish refuses the sandbox. On
  // macOS a pattern covers the files there, and only where linked ones point is listed.
  for (const root of platform === "darwin" ? shallow : []) found.push(...envScan(root, ENV_LINK_SCAN_DIRS, true, project).found);
  for (const root of platform === "darwin" ? [] : shallow) {
    const scan = envScan(root, ENV_SCAN_DIRS, false, project);
    if (!scan.complete) throw new ConfinementError(`${root} is registered as a project but holds your home folder, and has too many folders to search for .env files; remove it from your projects.`);
    found.push(...scan.found);
  }
  for (const root of roots) {
    if (platform === "darwin") {
      found.push(...envScan(root, ENV_LINK_SCAN_DIRS, true).found);
      continue;
    }
    const scan = envScan(root, ENV_SCAN_DIRS, false);
    found.push(...(scan.complete ? scan.found : [root, ...envScan(root, ENV_LINK_SCAN_DIRS, true).found]));
  }
  return unique(found);
}

/** The projects (real paths) a confined chat elsewhere on Linux can't read at all: too many folders to search. */
export function tooBigToSearch(projects: readonly string[]): string[] {
  return unique(projects.map(real)).filter((root) => !envScan(root, ENV_SCAN_DIRS, false).complete);
}

/**
 * One project's `.env` files (real paths), reading at most `maxDirs` folders; `complete` is false when it had more.
 * With `linksOnly`, only `.env` files that are links (to somewhere else) are collected.
 */
function envScan(root: string, maxDirs: number, linksOnly: boolean, skip?: string): { found: string[]; complete: boolean } {
  const found: string[] = [];
  // Level by level, names in order: a cut-short search has still covered the levels nearest the root.
  const queue: [string, number][] = [[root, 0]];
  for (let dirs = 0; queue.length > 0; ) {
    const [dir, depth] = queue.shift()!;
    if (skip !== undefined && isInside(dir, skip)) continue;
    if (++dirs > maxDirs) return { found, complete: false };
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    } catch {
      continue; // unreadable to the owner, so to the command as well
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < ENV_SCAN_DEPTH && !ENV_SCAN_SKIPPED.has(entry.name)) queue.push([path, depth + 1]);
      } else if (ENV_FILE.test(entry.name) && !ENV_TEMPLATE.test(entry.name) && ((entry.isFile() && !linksOnly) || (entry.isSymbolicLink() && isFile(path)))) {
        found.push(real(path));
      }
    }
  }
  return { found, complete: true };
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** All paths are real paths: the macOS sandbox matches the resolved path, so `/tmp/x` in a profile never matches. */
export function confinementPaths(opts: {
  project: string;
  home: string;
  userHome: string;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  protectInstructions?: boolean;
  /** The owner's other projects (the registered ones and the built-in workspaces); the session's own may be among them. */
  otherProjects?: readonly string[];
  /** Folders commands may read although they sit inside a denied one: the harness in effect, whose scripts they run. */
  readable?: readonly string[];
}): ConfinementPaths {
  const platform = opts.platform ?? process.platform;
  const userHome = real(opts.userHome);
  const project = real(opts.project);

  const writable: (string | undefined)[] = [];
  const temp = writablePath(opts.env.TMPDIR ?? tmpdir());
  writable.push(temp);
  // The system temp dir itself is root's; a chat can't swap it for a link, so it is simply resolved.
  writable.push(real(platform === "darwin" ? "/private/tmp" : "/tmp"));
  // macOS keeps a per-user cache dir (`getconf DARWIN_USER_CACHE_DIR`) next to the per-user temp dir.
  if (platform === "darwin" && temp && /^\/private\/var\/folders\/[^/]+\/[^/]+\/T$/.test(temp)) writable.push(writablePath(join(dirname(temp), "C")));

  // Only the per-sandbox cache root is writable; the owner's host caches (CACHE_PATHS) stay readable but not writable,
  // so a poisoned download can't reach the owner's own builds. `chatEnv` points each tool's cache var in here. It sits
  // inside the denied `~/.tropos`, so the builders carve it back out for read and write (like the workspace).
  // Residual: a project at `~` makes the host caches under it writable through the project itself.
  const home = real(opts.home);
  const { deep, shallow } = otherProjectRoots(project, opts.otherProjects ?? [], userHome);
  const paths: ConfinementPaths = {
    project,
    writable: unique(writable),
    cacheDir: prepareCacheDir(home),
    gitDirs: withLinkTarget(join(project, ".git"), project),
    husky: withLinkTarget(join(project, ".husky"), project),
    worktreesRoot: real(worktreesDir(opts.home)),
    linkedGitDirs: linkedGitDirs(project, real(worktreesDir(opts.home))),
    // The default Tropos home as well as this one: a session whose TROPOS_HOME points elsewhere (a harness probe's
    // fresh home) must not reach the owner's keys and memory either.
    deniedReads: unique([...SECRET_PATHS.map((p) => real(resolve(userHome, p))), home, real(resolve(userHome, ".tropos"))]),
    readCarveOuts: unique([
      real(join(opts.home, "workspace")),
      real(worktreesDir(opts.home)),
      // A project kept inside the Tropos home (a probe's copy of one) is still the session's to read.
      ...(isInside(project, home) || isInside(project, real(resolve(userHome, ".tropos"))) ? [project] : []),
      ...(opts.readable ?? []).map(real),
    ]),
    ownFiles: unique(workspaceOwnPaths(home).map(real)),
    instructionFiles: opts.protectInstructions ? unique(workspaceInstructionPaths(home).map(real)) : [],
    otherProjects: deep,
    otherProjectsShallow: shallow,
    otherProjectSecrets: otherProjectSecrets(deep, shallow, project, platform),
    platform,
  };
  // A second hard link elsewhere (in the project, say) would reach the same file under a name no rule protects.
  // The specialists' folders too: their notes and skills are the chief's as much as the journal is.
  if (opts.protectInstructions) requireSingleLinks([...paths.instructionFiles, ...paths.ownFiles, real(agentsDir(opts.home))]);
  return paths;
}

/** How many entries the hard-link check looks at before it gives up (and refuses). */
export const MAX_LINK_CHECK_ENTRIES = 10_000;

/**
 * Refuses a protected file that has another hard link: masking or write-denying one name leaves the file open
 * through the other. A folder is walked (links inside it are not followed); past `maxEntries` it fails closed.
 * Missing paths are fine.
 */
export function requireSingleLinks(paths: readonly string[], maxEntries: number = MAX_LINK_CHECK_ENTRIES): void {
  let seen = 0;
  const visit = (path: string): void => {
    if (++seen > maxEntries) throw new ConfinementError(`The chief's folders hold too many files to check for hard links (over ${maxEntries}); the sandbox won't run.`);
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(path);
    } catch {
      return;
    }
    if (info.isFile() && info.nlink > 1) throw new ConfinementError(`${path} has another hard link; the sandbox won't run until that other link is removed.`);
    if (!info.isDirectory()) return;
    let names: string[];
    try {
      names = readdirSync(path);
    } catch {
      throw new ConfinementError(`${path} can't be read to check it for hard links; the sandbox won't run.`);
    }
    for (const name of names) visit(join(path, name));
  };
  for (const path of paths) visit(path);
}

/**
 * Creates `<home>/sandbox-cache` and one dir per tool, and returns its real path. A chat may write inside the cache
 * (its tool dirs included), so it could swap a tool dir for a link to `~/.ssh`; following that when the next
 * confinement is built would widen what a command may write. So any link or non-directory there is refused.
 */
function prepareCacheDir(realHome: string): string {
  const cache = sandboxCacheDir(realHome);
  for (const dir of [cache, ...SANDBOX_CACHE_ENV.map(([, tool]) => join(cache, tool))]) {
    requireDirOrAbsent(dir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  if (realpathSync(cache) !== cache) throw new ConfinementError(`${cache} can't be used as the sandbox cache: it resolves to ${realpathSync(cache)}.`);
  return cache;
}

function requireDirOrAbsent(path: string): void {
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(path);
  } catch {
    return;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new ConfinementError(`${path} can't be used as the sandbox cache: it must be a real directory, not a symlink or file.`);
}

/** The real path, or for a missing path the real path of its nearest existing parent with the rest joined on. */
function real(path: string): string {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    const parent = dirname(abs);
    return parent === abs ? abs : join(real(parent), basename(abs));
  }
}

/**
 * A writable path is resolved up to its last part, and left out when that last part is a link. A chat may write the
 * path itself (a subpath rule covers it), so it can replace `~/.npm` with a link to `~/.ssh`; following that link
 * when the next confinement is built would widen what the next command may write.
 */
function writablePath(path: string): string | undefined {
  const abs = resolve(path);
  const parent = dirname(abs);
  const candidate = parent === abs ? abs : join(real(parent), basename(abs));
  try {
    return lstatSync(candidate).isSymbolicLink() ? undefined : candidate;
  } catch {
    return candidate; // missing: the tool may create it
  }
}

/**
 * The path itself (always, so a missing `.git` can't be created) plus, when it is a link, its target while that stays
 * in the project: the link text resolved lexically (the next hop of a chain, which could otherwise be swapped) and the
 * real target. A target outside the project is outside every writable path already.
 */
function withLinkTarget(path: string, project: string): string[] {
  const out = [path];
  let target: string;
  try {
    if (!lstatSync(path).isSymbolicLink()) return out;
    target = readlinkSync(path);
  } catch {
    return out;
  }
  const lexical = resolve(dirname(path), target);
  const hop = join(real(dirname(lexical)), basename(lexical));
  if (isInside(hop, project)) out.push(hop);
  try {
    const resolved = realpathSync(path);
    if (isInside(resolved, project)) out.push(resolved);
  } catch {
    // dangling: nothing further to protect
  }
  return unique(out);
}

/**
 * A `.git` file points at a git dir that may sit inside the project, where its hooks and config would be writable, so
 * only a Tropos worktree (under the worktrees folder) may have one. Then the dirs it names are returned so they can
 * be protected like `.git` is: the worktree's admin dir and the repo's common dir.
 */
function linkedGitDirs(project: string, worktreesRoot: string): string[] {
  const gitFile = join(project, ".git");
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(gitFile);
  } catch {
    return [];
  }
  if (!info.isFile()) return [];
  if (!isInside(project, worktreesRoot) || project === worktreesRoot) throw new ConfinementError(`${gitFile} is a gitfile; only a Tropos worktree may have one.`);
  const target = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(gitFile, "utf8"))?.[1];
  if (!target) throw new ConfinementError(`${gitFile} doesn't name a git dir.`);
  const admin = real(resolve(project, target));
  const out = [admin];
  const pointer = join(admin, "commondir");
  if (existsSync(pointer)) out.push(real(resolve(admin, readFileSync(pointer, "utf8").trim())));
  return unique(out);
}

/**
 * A worktree's linked git dirs live in the owner's repo, outside every writable path, so a missing hooks or config there
 * cannot be created from inside the sandbox. If one resolves inside a writable path it could be, and the "protected"
 * hooks and config would not be: refuse to confine rather than run with weaker protection.
 */
export function requireLinkedGitDirsOutsideWritable(paths: Pick<ConfinementPaths, "project" | "writable" | "cacheDir" | "linkedGitDirs">): void {
  const writable = [paths.project, paths.cacheDir, ...paths.writable];
  for (const dir of paths.linkedGitDirs) {
    if (writable.some((w) => isInside(dir, w))) throw new ConfinementError(`${dir} can't be confined: a worktree's git dir lies inside a path the sandbox can write.`);
  }
}

function unique(paths: (string | undefined)[]): string[] {
  return [...new Set(paths.filter((p): p is string => p !== undefined))];
}
