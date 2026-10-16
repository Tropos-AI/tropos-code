// src/exec/env.ts — the environment a chat's commands get: an allowlist, not a scrub list, so a secret the
// owner's shell happens to export (tokens, agent sockets, NODE_OPTIONS, LD_PRELOAD …) never reaches them.
import { realpathSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { isInside } from "../paths";

const KEEP = new Set(["PATH", "HOME", "USER", "SHELL", "LANG", "TERM", "TMPDIR"]);
const FALLBACK_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/**
 * Package-manager cache dirs under `<troposHome>/sandbox-cache/<tool>`, so a chat's `npm install` (etc.) writes a
 * sandbox cache, never the owner's host cache: a poisoned download then can't persist into the owner's own builds.
 * These dirs are the only caches the confinement makes writable. Toolchains (`~/.cargo/bin`, rustup) stay readable,
 * so `CARGO_HOME` is left alone; cargo's registry cache is a documented residual (not writable, re-downloads).
 */
export const SANDBOX_CACHE_ENV: readonly (readonly [string, string])[] = [
  ["npm_config_cache", "npm"],
  ["npm_config_store_dir", "pnpm"],
  ["BUN_INSTALL_CACHE_DIR", "bun"],
  ["PIP_CACHE_DIR", "pip"],
  ["YARN_CACHE_FOLDER", "yarn"],
  ["GOMODCACHE", "go-mod"],
  ["GOCACHE", "go-build"],
];

/** The one sandbox cache root; `writable` includes it, so every tool's redirected cache dir is writable. */
export function sandboxCacheDir(troposHome: string): string {
  return join(troposHome, "sandbox-cache");
}

/**
 * Config that makes git run a program, forced off at command-line precedence so neither the repo's config nor the
 * user's can switch it back on. GIT_EXTERNAL_DIFF, GIT_PAGER and PAGER are not on the allowlist, so they never pass.
 * Not `diff.external`: git has no "off" value and an empty one breaks every patch-printing `git diff`. Residual: a
 * diff.external already in the user's or the repo's config runs on `git diff` (a confined chat can't write .git/config).
 */
const GIT_OVERRIDES: readonly (readonly [string, string])[] = [
  ["core.fsmonitor", "false"],
  ["core.pager", "cat"],
  ["core.hooksPath", "/dev/null"],
  ["log.showSignature", "false"],
  ["gpg.program", "/usr/bin/false"],
];

export function chatEnv(env: NodeJS.ProcessEnv, opts: { project: string; troposHome?: string }): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && (KEEP.has(key) || key.startsWith("LC_"))) out[key] = value;
  }
  out.PATH = chatPath(env.PATH, opts.project);
  if (opts.troposHome !== undefined) {
    const cache = sandboxCacheDir(opts.troposHome);
    for (const [key, tool] of SANDBOX_CACHE_ENV) out[key] = join(cache, tool);
  }
  out.GIT_CONFIG_NOSYSTEM = "1";
  out.GIT_CONFIG_COUNT = String(GIT_OVERRIDES.length);
  GIT_OVERRIDES.forEach(([key, value], i) => {
    out[`GIT_CONFIG_KEY_${i}`] = key;
    out[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return out;
}

/** A relative entry resolves against the cwd and a project entry is code the repo controls; both would shadow real tools. */
function chatPath(path: string | undefined, project: string): string {
  const realProject = realOr(project);
  const kept = (path ?? "")
    .split(delimiter)
    .filter((dir) => dir !== "" && isAbsolute(dir) && !isInside(dir, project) && !isInside(realOr(dir), realProject));
  return kept.length > 0 ? kept.join(delimiter) : FALLBACK_PATH;
}

function realOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
