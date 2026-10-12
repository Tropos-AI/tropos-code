// src/tools/file-guard.ts
import { stat } from "node:fs/promises";
import type { ToolContext, ToolOutput } from "./types";

export type Freshness = { ok: true; missing: true } | { ok: true; missing: false; mtimeMs: number } | { ok: false; error: string };

/**
 * A file may be changed only if it doesn't exist yet, or was read this session and hasn't changed since.
 * Stat failures other than "not found" propagate so the caller reports them rather than treating the file as absent.
 */
export async function checkFreshness(path: string, ctx: ToolContext): Promise<Freshness> {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, missing: true };
    throw error;
  }
  if (info.isDirectory()) return { ok: false, error: `${path} is a directory.` };
  const check = ctx.readState.check(path, info.mtimeMs);
  if (check === "unread") return { ok: false, error: `${path} already exists. Read it before changing it.` };
  if (check === "stale") return { ok: false, error: `${path} changed on disk since you last read it. Read it again first.` };
  return { ok: true, missing: false, mtimeMs: info.mtimeMs };
}

/** Error result for a write that failed on disk or in path resolution. */
export function cannotWrite(path: string, error: unknown): ToolOutput {
  const message = error instanceof Error ? error.message : String(error);
  return { content: `Cannot write ${path}: ${message}`, isError: true };
}
