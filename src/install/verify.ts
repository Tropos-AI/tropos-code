// src/install/verify.ts
import { lstat, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { minimalEnv } from "./env";
import { sha256File, writeFileAtomic } from "./files";
import { currentUser, manifestDir, versionPath, type DirOwner, type Layout } from "./layout";
import { expectVersion, verifyManifest, type PlatformEntry, type VerifiedManifest } from "./manifest";
import type { Platform } from "./platform";
import type { TrustedKey } from "./sshsig";
import { isVersion, newestFirst } from "./version";

/**
 * "ok": ran and answered correctly; "bad": ran and failed (non-zero exit, wrong output) or cannot be executed at all;
 * "unknown": could not be run to a conclusion (resource exhaustion at spawn, timeout) — a transient error, never a verdict.
 */
export type HealthResult = "ok" | "bad" | "unknown";
export type HealthCheck = (bin: string, version: string) => Promise<HealthResult>;

export interface VerifyContext {
  layout: Layout;
  platform: Platform;
  trusted: readonly TrustedKey[];
  health: HealthCheck;
  user?: DirOwner;
}

export type Check = { ok: true } | { ok: false; reason: string };
/** `transient` is true only when the version is Verified but its health check could not be run to a conclusion. */
export type Health = { ok: true } | { ok: false; reason: string; transient: boolean };

export const HEALTH_TIMEOUT_MS = 10_000;
/** Spawn failures that say nothing about the binary: the machine is short of processes, memory or descriptors. */
const TRANSIENT_SPAWN_CODES = new Set(["EAGAIN", "ENOMEM", "EMFILE", "ENFILE"]);

async function healthCheckOnce(bin: string, version: string, env: NodeJS.ProcessEnv, timeoutMs: number, spawn: typeof Bun.spawn): Promise<HealthResult> {
  let proc;
  try {
    proc = spawn([bin, "--version"], { env: minimalEnv(env), stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  } catch (e) {
    return TRANSIENT_SPAWN_CODES.has((e as NodeJS.ErrnoException | undefined)?.code ?? "") ? "unknown" : "bad";
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<HealthResult>((resolve) => {
    timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve("unknown");
    }, timeoutMs);
  });
  const run = Promise.all([new Response(proc.stdout).text(), proc.exited]).then(([out, code]): HealthResult => (code === 0 && out === `${version} (Tropos Code)\n` ? "ok" : "bad"));
  try {
    // A killed shell's children can keep stdout open, so never wait on the pipe past the timeout.
    return await Promise.race([run, timedOut]);
  } catch {
    return "unknown";
  } finally {
    clearTimeout(timer);
    run.catch(() => {});
  }
}

/**
 * `<bin> --version` must exit 0 printing exactly "<v> (Tropos Code)\n" within the timeout.
 * A run that cannot reach a verdict is retried once before it is reported as "unknown".
 */
export async function defaultHealthCheck(bin: string, version: string, env: NodeJS.ProcessEnv = process.env, timeoutMs = HEALTH_TIMEOUT_MS, spawn: typeof Bun.spawn = Bun.spawn): Promise<HealthResult> {
  const first = await healthCheckOnce(bin, version, env, timeoutMs, spawn);
  return first === "unknown" ? healthCheckOnce(bin, version, env, timeoutMs, spawn) : first;
}

/** manifest.json is written last: its presence is what makes a version "managed". */
export async function storeManifest(l: Layout, version: string, vm: VerifiedManifest): Promise<void> {
  const dir = manifestDir(l, version);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFileAtomic(join(dir, "manifest.json.sig"), vm.signature);
  await writeFileAtomic(join(dir, "manifest.json"), vm.bytes);
}

export async function readStoredManifest(ctx: VerifyContext, version: string): Promise<VerifiedManifest> {
  const dir = manifestDir(ctx.layout, version);
  const [bytes, signature] = await Promise.all([readFile(join(dir, "manifest.json")), readFile(join(dir, "manifest.json.sig"), "utf8")]);
  const vm = verifyManifest(new Uint8Array(bytes), signature, ctx.trusted);
  expectVersion(vm.manifest, version);
  return vm;
}

export async function isManaged(l: Layout, version: string): Promise<boolean> {
  return lstat(join(manifestDir(l, version), "manifest.json")).then(
    () => true,
    () => false,
  );
}

export async function checkFileAgainst(path: string, entry: PlatformEntry, user: DirOwner = currentUser()): Promise<Check> {
  let st;
  try {
    st = await lstat(path);
  } catch {
    return { ok: false, reason: "missing" };
  }
  if (st.isSymbolicLink()) return { ok: false, reason: "is a symbolic link" };
  if (!st.isFile()) return { ok: false, reason: "is not a regular file" };
  if (st.uid !== user.uid) return { ok: false, reason: "is owned by another user" };
  if (st.size !== entry.size) return { ok: false, reason: `has ${st.size} bytes, expected ${entry.size}` };
  return (await sha256File(path)).sha256 === entry.sha256 ? { ok: true } : { ok: false, reason: "does not match its signed sha256" };
}

export async function checkVerified(ctx: VerifyContext, version: string): Promise<Check> {
  if (!isVersion(version)) return { ok: false, reason: "not a version" };
  let vm: VerifiedManifest;
  try {
    vm = await readStoredManifest(ctx, version);
  } catch (e) {
    return { ok: false, reason: `stored manifest: ${(e as Error).message}` };
  }
  return checkFileAgainst(versionPath(ctx.layout, version), vm.manifest.platforms[ctx.platform], ctx.user);
}

export async function checkHealthy(ctx: VerifyContext, version: string): Promise<Health> {
  const verified = await checkVerified(ctx, version);
  if (!verified.ok) return { ...verified, transient: false };
  const result = await ctx.health(versionPath(ctx.layout, version), version);
  if (result === "ok") return { ok: true };
  return result === "unknown" ? { ok: false, reason: "its health check could not be run", transient: true } : { ok: false, reason: "failed its health check", transient: false };
}

async function versionEntries(dir: string): Promise<string[]> {
  try {
    return newestFirst((await readdir(dir)).filter(isVersion));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

/** Versions with a stored manifest.json (their binary may be missing); a half-written manifests/<v>/ does not count. */
export async function listManagedVersions(l: Layout): Promise<string[]> {
  const found = await versionEntries(l.manifests);
  const managed = await Promise.all(found.map((v) => isManaged(l, v)));
  return found.filter((_, i) => managed[i]);
}
