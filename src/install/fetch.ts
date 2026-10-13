// src/install/fetch.ts
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { InstallError, fromFsError } from "./errors";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface FetchOptions {
  /** Fail as soon as the body exceeds this many bytes. */
  maxBytes: number;
  /** Time allowed for the response headers (fetchBytes: for the whole body). */
  timeoutMs: number;
  /** downloadToFile: fail when no data arrives for this long. Default 30 s. */
  idleTimeoutMs?: number;
  fetch?: FetchLike;
  /** Set only by tests, in code — never from the environment: allow http to 127.0.0.1/localhost. */
  allowLoopbackHttp?: boolean;
}

export interface DownloadResult {
  size: number;
  sha256: string;
}

const MAX_REDIRECTS = 5;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function checkUrl(url: string, allowLoopbackHttp: boolean): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new InstallError("integrity", `invalid download URL: ${url}`);
  }
  if (u.protocol === "https:") return;
  if (allowLoopbackHttp && u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost")) return;
  throw new InstallError("integrity", `refusing a non-HTTPS URL: ${url}`);
}

const timedOut = (url: string, ms: number) => new InstallError("network", `${hostOf(url)} did not respond within ${ms / 1000} s`);

async function openOk(url: string, opts: FetchOptions, signal: AbortSignal): Promise<Response> {
  const doFetch = opts.fetch ?? fetch;
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    checkUrl(current, opts.allowLoopbackHttp ?? false);
    let res: Response;
    try {
      res = await doFetch(current, { redirect: "manual", signal });
    } catch (e) {
      if (signal.aborted) throw timedOut(current, opts.timeoutMs);
      throw new InstallError("network", `could not reach ${hostOf(current)}: ${(e as Error).message}`, { cause: e });
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      await res.body?.cancel();
      if (!location) throw new InstallError("network", `${hostOf(current)} sent a redirect without a location`);
      current = new URL(location, current).toString();
      continue;
    }
    if (res.status === 200) return res;
    await res.body?.cancel();
    throw new InstallError("network", `${hostOf(current)} answered HTTP ${res.status} for ${new URL(current).pathname}`);
  }
  throw new InstallError("network", `too many redirects for ${url}`);
}

/** Small downloads (pointers, manifests, signatures): the whole transfer must finish within timeoutMs. */
export async function fetchBytes(url: string, opts: FetchOptions): Promise<Uint8Array> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await openOk(url, opts, controller.signal);
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (res.body) {
      try {
        for await (const chunk of res.body) {
          total += chunk.length;
          if (total > opts.maxBytes) throw new InstallError("integrity", `${hostOf(url)} sent more than ${opts.maxBytes} bytes`);
          chunks.push(chunk);
        }
      } catch (e) {
        if (e instanceof InstallError) throw e;
        if (controller.signal.aborted) throw timedOut(url, opts.timeoutMs);
        throw new InstallError("network", `download from ${hostOf(url)} failed: ${(e as Error).message}`, { cause: e });
      }
    }
    return new Uint8Array(Buffer.concat(chunks));
  } finally {
    clearTimeout(timer);
  }
}

/** Large downloads (binaries): headers within timeoutMs, then no gap longer than idleTimeoutMs. Hashes while writing. */
export async function downloadToFile(url: string, dest: string, opts: FetchOptions): Promise<DownloadResult> {
  const idle = opts.idleTimeoutMs ?? 30_000;
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  const arm = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), ms);
  };
  let file;
  try {
    file = await open(dest, "wx", 0o600);
  } catch (e) {
    throw fromFsError(e, `creating ${dest}`);
  }
  const hash = createHash("sha256");
  let total = 0;
  try {
    const res = await openOk(url, opts, controller.signal);
    arm(idle);
    if (res.body) {
      const writeFailure = new WeakSet<object>();
      try {
        for await (const chunk of res.body) {
          total += chunk.length;
          if (total > opts.maxBytes) throw new InstallError("integrity", `${hostOf(url)} sent more than the expected ${opts.maxBytes} bytes`);
          hash.update(chunk);
          try {
            await file.write(chunk);
          } catch (e) {
            const mapped = fromFsError(e, `writing ${dest}`) as object;
            writeFailure.add(mapped);
            throw mapped;
          }
          arm(idle);
        }
      } catch (e) {
        if (e instanceof InstallError || (typeof e === "object" && e !== null && writeFailure.has(e))) throw e;
        if (controller.signal.aborted) throw new InstallError("network", `download from ${hostOf(url)} stalled for ${idle / 1000} s`);
        throw new InstallError("network", `download from ${hostOf(url)} failed: ${(e as Error).message}`, { cause: e });
      }
    }
    await file.sync();
    return { size: total, sha256: hash.digest("hex") };
  } finally {
    clearTimeout(timer);
    await file.close();
  }
}
