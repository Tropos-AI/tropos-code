// src/service/spec.ts — what both service managers are told to run.
import { basename } from "node:path";
import { homebrewInstall } from "../install/homebrew";
import { nativeVersionOf, realOrSelf, resolveLayout } from "../install/layout";

/** Service managers give jobs a bare PATH; Docker lives in one of these. */
const SERVICE_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

/**
 * The command the service runs. A compiled `tcode` is its own executable; run from source, the executable is bun and
 * the script has to come with it.
 */
export function programArguments(execPath: string, scriptPath: string | undefined, env: NodeJS.ProcessEnv = process.env): string[] {
  const runtime = basename(execPath).toLowerCase();
  if (runtime === "bun" || runtime === "node") return [execPath, scriptPath ?? "", "gateway"].filter(Boolean);
  return [stableCommand(execPath, env), "gateway"];
}

/**
 * An installed version runs as ~/.local/share/tropos/versions/<v>; the service is pointed at the ~/.local/bin/tcode
 * link to it instead, which every update moves, so a restart after an update runs the new version, not the old one.
 * A Homebrew install is pointed at its opt link for the same reason: `brew upgrade` moves it and deletes the old keg.
 */
function stableCommand(execPath: string, env: NodeJS.ProcessEnv): string {
  const brew = homebrewInstall(execPath);
  if (brew) return brew.command;
  const layout = resolveLayout(env);
  if (!nativeVersionOf(layout, execPath)) return execPath;
  return realOrSelf(layout.binLink) === realOrSelf(execPath) ? layout.binLink : execPath;
}

/** The environment a service gets: its own PATH and HOME, and TROPOS_HOME when the owner moved it. Never a secret. */
export function serviceEnv(env: NodeJS.ProcessEnv, userHome: string): Record<string, string> {
  const out: Record<string, string> = { HOME: userHome, PATH: SERVICE_PATH };
  if (env.TROPOS_HOME) out.TROPOS_HOME = env.TROPOS_HOME;
  return out;
}
