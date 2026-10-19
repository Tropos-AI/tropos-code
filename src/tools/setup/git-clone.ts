// src/tools/setup/git-clone.ts — the one git clone TroposSetup runs on the host (plugins and skills from a repo). Nothing
// the clone brings may run: no hook (the user's own hooksPath or template included), no fsmonitor, no submodules, no
// LFS filter, no transport but https and file, and symlinks land as plain files so a repo can't point outside itself.
// The host is looked up first and git follows no redirect, so it only ever talks to the public host the owner approved.
import { rm } from "node:fs/promises";
import { cloneUrlProblem, hostProblem, type Resolve } from "./sources";

export interface CloneOptions {
  /** The environment git runs with; the process's by default. Tests point HOME at a fixture config. */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** A branch or tag to check out instead of the default branch. */
  ref?: string;
  /** Looks the host up before git runs; the system resolver by default. */
  resolve?: Resolve;
}

const CLONE_TIMEOUT_MS = 120_000;
const STDERR_CHARS = 500;

export const CLONE_FLAGS = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "-c", "core.symlinks=false",
  "-c", "core.pager=cat",
  "-c", "protocol.allow=never",
  "-c", "protocol.https.allow=always",
  "-c", "protocol.file.allow=always",
  "-c", "submodule.recurse=false",
  // A redirect would reach a host nobody checked (or approved).
  "-c", "http.followRedirects=false",
];

const REF = /^[A-Za-z0-9._/-]{1,100}$/;

function cloneEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !k.startsWith("GIT_")) env[k] = v;
  // No system gitconfig, no prompt that would wait for a terminal, no LFS download.
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_LFS_SKIP_SMUDGE = "1";
  env.GCM_INTERACTIVE = "never";
  return env;
}

/** `git clone --depth 1` of `url` into `dest` (which must not exist). Throws a readable Error; a failure leaves no `dest`. */
export async function shallowClone(url: string, dest: string, opts: CloneOptions = {}): Promise<void> {
  const problem = cloneUrlProblem(url);
  if (problem) throw new Error(problem);
  if (opts.ref !== undefined && (!REF.test(opts.ref) || opts.ref.startsWith("-") || opts.ref.includes(".."))) throw new Error(`${opts.ref.slice(0, 60)} isn't a branch or tag name I can use.`);
  const hostRefused = await hostProblem(new URL(url), opts.resolve);
  if (hostRefused) throw new Error(hostRefused);
  const git = Bun.which("git", { PATH: opts.env?.PATH ?? process.env.PATH ?? "" });
  if (!git) throw new Error("git isn't installed on this computer, so I can't clone a repository.");
  const args = [git, ...CLONE_FLAGS, "clone", "--depth", "1", "--no-recurse-submodules", "--quiet", ...(opts.ref ? ["--branch", opts.ref] : []), "--", url, dest];
  let code: number;
  let stderr: string;
  try {
    const proc = Bun.spawn(args, { env: cloneEnv(opts.env ?? process.env), stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: opts.timeoutMs ?? CLONE_TIMEOUT_MS });
    [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  } catch (e) {
    [stderr, code] = [e instanceof Error ? e.message : String(e), 1];
  }
  if (code !== 0) {
    await rm(dest, { recursive: true, force: true });
    const why = stderr.trim().split("\n").slice(-2).join(" ").slice(0, STDERR_CHARS);
    throw new Error(`${url} couldn't be cloned${why ? `: ${why}` : ""}.`);
  }
}
