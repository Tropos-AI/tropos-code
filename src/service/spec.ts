// src/service/spec.ts — what both service managers are told to run.
import { basename } from "node:path";

/** Service managers give jobs a bare PATH; Docker lives in one of these. */
const SERVICE_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

/**
 * The command the service runs. A compiled `tcode` is its own executable; run from source, the executable is bun and
 * the script has to come with it.
 */
export function programArguments(execPath: string, scriptPath: string | undefined): string[] {
  const runtime = basename(execPath).toLowerCase();
  return runtime === "bun" || runtime === "node" ? [execPath, scriptPath ?? "", "gateway"].filter(Boolean) : [execPath, "gateway"];
}

/** The environment a service gets: its own PATH and HOME, and TROPOS_HOME when the owner moved it. Never a secret. */
export function serviceEnv(env: NodeJS.ProcessEnv, userHome: string): Record<string, string> {
  const out: Record<string, string> = { HOME: userHome, PATH: SERVICE_PATH };
  if (env.TROPOS_HOME) out.TROPOS_HOME = env.TROPOS_HOME;
  return out;
}
