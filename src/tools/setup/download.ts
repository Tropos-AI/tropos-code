// src/tools/setup/download.ts — TroposSetup's `download`: one https file, from a public host, into the project the
// session works in. Size-capped while it streams, never over an existing file unless the owner asked for that, and
// reported with its sha256 so the owner can check it.
import { randomBytes } from "node:crypto";
import { chmod, link, lstat, mkdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { downloadToFile } from "../../install/fetch";
import { InstallError } from "../../install/errors";
import { isInside } from "../../paths";
import { inGitControlDir, isProjectSettingsFile } from "../../permissions/engine";
import { resolveToolPath } from "../paths";
import { cloneUrlProblem, guardedFetch, HostRefused, hostProblem, privateHostProblem, type Resolve } from "./sources";

export const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;

export interface DownloadRequest {
  url: string;
  /** Where to save it, relative to the project; the URL's file name by default. */
  path?: string;
  overwrite?: boolean;
}

export interface DownloadPlace {
  cwd: string;
  /** The folders the session may write in: the file must land inside one. */
  allowedDirs: string[];
}

export interface DownloadOptions {
  fetch?: typeof fetch;
  /** Looks each host up before it is fetched from; the system resolver by default. */
  resolve?: Resolve;
  maxBytes?: number;
  timeoutMs?: number;
}

export interface Downloaded {
  path: string;
  size: number;
  sha256: string;
}

/** A refusal that reads well as it is (the fetch layer would otherwise wrap it as "could not reach …"). */
class Refused extends Error {}

const mb = (n: number): string => `${Math.round(n / 1024 / 1024)} MB`;

/** The URL's last path segment as a file name, or "download" when it has none usable. */
export function downloadName(url: string): string {
  let name: string;
  try {
    name = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
  } catch {
    return "download";
  }
  if (!name || name === "." || name === ".." || /[/\\\0]/.test(name) || /[\p{Cc}\p{Cf}]/u.test(name)) return "download";
  return name;
}

/** Where the file will be saved: the path as the OS resolves it, from the project folder. */
export function downloadTarget(req: DownloadRequest, cwd: string): string {
  return resolveToolPath(req.path ?? downloadName(req.url), cwd);
}

/** Why this URL isn't fetched, or undefined: https only, no credentials in it, a public host. */
export function downloadUrlProblem(url: string): string | undefined {
  const problem = cloneUrlProblem(url);
  if (problem) return problem;
  const u = new URL(url);
  if (u.protocol !== "https:") return "I only download https:// URLs.";
  return privateHostProblem(u);
}

export async function download(req: DownloadRequest, place: DownloadPlace, opts: DownloadOptions = {}): Promise<Downloaded> {
  const urlProblem = downloadUrlProblem(req.url);
  if (urlProblem) throw new Refused(urlProblem);
  const target = downloadTarget(req, place.cwd);
  if (!place.allowedDirs.some((dir) => isInside(target, dir) && target !== dir)) throw new Refused(`${target} isn't inside this project; I only save downloads inside it.`);
  // A file there would run on a later git command or change the project's settings.
  if (inGitControlDir(target) || isProjectSettingsFile(target)) throw new Refused(`${target} is a file that runs code later; I don't download into it.`);
  const existing = await lstat(target).catch(() => null);
  if (existing && !existing.isFile()) throw new Refused(`${target} already exists and isn't a plain file.`);
  if (existing && !req.overwrite) throw new Refused(`${target} already exists. Ask me to replace it if that's what you want.`);

  const maxBytes = opts.maxBytes ?? MAX_DOWNLOAD_BYTES;
  const tooBig = () => new Refused(`${req.url} is bigger than ${maxBytes >= 1024 * 1024 ? mb(maxBytes) : `${maxBytes} bytes`}; nothing was saved.`);
  // Every hop, the first URL included, is looked up before it is fetched (and before anything touches the disk).
  // Residual: fetch resolves the name again, so DNS rebinding between the check and the fetch isn't stopped here; the owner approves each URL.
  const guarded = guardedFetch(opts.fetch ?? fetch, opts.resolve);
  const first = await hostProblem(new URL(req.url), opts.resolve);
  if (first) throw new Refused(first);
  const capped = async (url: string, init?: RequestInit): Promise<Response> => {
    const res = await guarded(url, init).catch((e: unknown) => {
      throw e instanceof HostRefused ? new Refused(e.message) : e;
    });
    const declared = Number(res.headers.get("content-length"));
    if (res.status === 200 && Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel().catch(() => {});
      throw tooBig();
    }
    return res;
  };

  await mkdir(dirname(target), { recursive: true });
  const temp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString("hex")}.part`);
  try {
    const { size, sha256 } = await downloadToFile(req.url, temp, { maxBytes, timeoutMs: opts.timeoutMs ?? 60_000, idleTimeoutMs: opts.timeoutMs ?? 60_000, fetch: capped }).catch((e: unknown) => {
      if (e instanceof InstallError && e.cause instanceof Refused) throw e.cause;
      if (e instanceof InstallError && /more than the expected/.test(e.message)) throw tooBig();
      throw e;
    });
    await chmod(temp, 0o644);
    if (req.overwrite) await rename(temp, target);
    else {
      // link() fails on an existing name: a file that appeared meanwhile is still never replaced.
      await link(temp, target).catch((e: NodeJS.ErrnoException) => {
        throw e.code === "EEXIST" ? new Refused(`${target} already exists. Ask me to replace it if that's what you want.`) : e;
      });
    }
    return { path: target, size, sha256 };
  } finally {
    await rm(temp, { force: true });
  }
}
