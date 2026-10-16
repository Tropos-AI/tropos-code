// src/doctor/util.ts — small helpers the checks share.
import { constants, existsSync, statSync } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Finding, Level } from "./types";

export const finding = (id: string, level: Level, message: string, extra: Partial<Finding> = {}): Finding => ({ id, level, message, ...extra });

/** Permission bits as octal text: 0o600 -> "600". */
export const octal = (mode: number): string => (mode & 0o777).toString(8).padStart(3, "0");

export function formatBytes(n: number): string {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GiB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MiB`;
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(1)} KiB`;
  return `${n} B`;
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Parsed JSON, `undefined` when the file is missing, `null` when it cannot be read or parsed. */
export async function readJsonFile(path: string): Promise<unknown | undefined | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? undefined : null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Where `bin` is on `pathVar` (first match), or null. A name with a slash is checked as given. */
export function findOnPath(bin: string, pathVar: string | undefined): string | null {
  const candidates = bin.includes("/") ? [bin] : (pathVar ?? "").split(":").filter(Boolean).map((d) => join(d, bin));
  for (const c of candidates) {
    try {
      if (statSync(c).isFile()) {
        // X_OK via a sync stat of mode keeps this usable without awaiting.
        if ((statSync(c).mode & 0o111) !== 0) return c;
      }
    } catch {
      // not here
    }
  }
  return null;
}

export const exists = (path: string): boolean => existsSync(path);

export async function modeOf(path: string): Promise<{ mode: number; dir: boolean } | null> {
  try {
    const st = await stat(path);
    return { mode: st.mode & 0o777, dir: st.isDirectory() };
  } catch {
    return null;
  }
}

export async function canExecute(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface GatewayStateFile {
  pid: number;
  startedAt?: string;
  webPort?: number;
  telegram?: boolean;
}

/** gateway/state.json: `undefined` when absent, `null` when it is not a usable state file. */
export async function readStateFile(home: string): Promise<GatewayStateFile | undefined | null> {
  const raw = await readJsonFile(join(home, "gateway", "state.json"));
  if (raw === undefined) return undefined;
  if (!isRecord(raw) || typeof raw.pid !== "number" || !Number.isInteger(raw.pid) || raw.pid <= 0) return null;
  return raw as unknown as GatewayStateFile;
}
