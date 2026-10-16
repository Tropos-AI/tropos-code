// src/exec/env.ts — the environment a chat's commands get: an allowlist, not a scrub list, so a secret the
// owner's shell happens to export (tokens, agent sockets, NODE_OPTIONS, LD_PRELOAD …) never reaches them.
import { realpathSync } from "node:fs";
import { delimiter, isAbsolute } from "node:path";
import { isInside } from "../paths";

const KEEP = new Set(["PATH", "HOME", "USER", "SHELL", "LANG", "TERM", "TMPDIR"]);
const FALLBACK_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/**
 * Config that makes git run a program, forced off at command-line precedence so neither the repo's config nor the
 * user's can switch it back on. GIT_EXTERNAL_DIFF, GIT_PAGER and PAGER are not on the allowlist, so they never pass.
 * `diff.external` empty (P2 ruling): git has no setting that turns an external diff off, so an empty one makes every
 * patch-printing `git diff` fail with "cannot run" (`--stat`, log and status still work) rather than run a program.
 */
const GIT_OVERRIDES: readonly (readonly [string, string])[] = [
  ["core.fsmonitor", "false"],
  ["core.pager", "cat"],
  ["diff.external", ""],
  ["core.hooksPath", "/dev/null"],
  ["log.showSignature", "false"],
  ["gpg.program", "/usr/bin/false"],
];

export function chatEnv(env: NodeJS.ProcessEnv, opts: { project: string }): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && (KEEP.has(key) || key.startsWith("LC_"))) out[key] = value;
  }
  out.PATH = chatPath(env.PATH, opts.project);
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
