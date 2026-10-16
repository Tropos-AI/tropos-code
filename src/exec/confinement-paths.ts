// src/exec/confinement-paths.ts — the paths a confined chat command may write, must not touch, and must not read.
// One source for both confinements (sandboxProfile on macOS, bwrapArgs on Linux).
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isInside } from "../paths";
import { sandboxCacheDir } from "./env";

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
  ".claude",
  ".local/share/keyrings",
  "Library/Keychains",
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
  deniedReads: string[];
  /** Readable although inside a denied path: Tropos's default project. */
  readCarveOut: string;
  platform: NodeJS.Platform;
}

/** All paths are real paths: the macOS sandbox matches the resolved path, so `/tmp/x` in a profile never matches. */
export function confinementPaths(opts: { project: string; home: string; userHome: string; env: NodeJS.ProcessEnv; platform?: NodeJS.Platform }): ConfinementPaths {
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
  const home = real(opts.home);
  return {
    project,
    writable: unique(writable),
    cacheDir: real(sandboxCacheDir(opts.home)),
    gitDirs: withLinkTarget(join(project, ".git"), project),
    husky: withLinkTarget(join(project, ".husky"), project),
    deniedReads: unique([...SECRET_PATHS.map((p) => real(resolve(userHome, p))), home]),
    readCarveOut: real(join(opts.home, "workspace")),
    platform,
  };
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

function unique(paths: (string | undefined)[]): string[] {
  return [...new Set(paths.filter((p): p is string => p !== undefined))];
}
