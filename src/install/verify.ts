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

export type HealthCheck = (bin: string, version: string) => Promise<boolean>;

export interface VerifyContext {
  layout: Layout;
  platform: Platform;
  trusted: readonly TrustedKey[];
  health: HealthCheck;
  user?: DirOwner;
}

export type Check = { ok: true } | { ok: false; reason: string };

export const HEALTH_TIMEOUT_MS = 10_000;

/** `<bin> --version` must exit 0 printing exactly "<v> (Tropos Code)\n" within the timeout (spec §10.2). */
export async function defaultHealthCheck(bin: string, version: string, env: NodeJS.ProcessEnv = process.env, timeoutMs = HEALTH_TIMEOUT_MS): Promise<boolean> {
  let proc;
  try {
    proc = Bun.spawn([bin, "--version"], { env: minimalEnv(env), stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  } catch {
    return false;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve(false);
    }, timeoutMs);
  });
  const run = Promise.all([new Response(proc.stdout).text(), proc.exited]).then(([out, code]) => code === 0 && out === `${version} (Tropos Code)\n`);
  try {
    // A killed shell's children can keep stdout open, so never wait on the pipe past the timeout.
    return await Promise.race([run, timedOut]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    run.catch(() => {});
  }
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

export async function checkHealthy(ctx: VerifyContext, version: string): Promise<Check> {
  const verified = await checkVerified(ctx, version);
  if (!verified.ok) return verified;
  return (await ctx.health(versionPath(ctx.layout, version), version)) ? { ok: true } : { ok: false, reason: "failed its health check" };
}

async function versionEntries(dir: string): Promise<string[]> {
  try {
    return newestFirst((await readdir(dir)).filter(isVersion));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

export const listVersionFiles = (l: Layout) => versionEntries(l.versions);
/** Versions with a stored manifest.json (their binary may be missing); a half-written manifests/<v>/ does not count. */
export async function listManagedVersions(l: Layout): Promise<string[]> {
  const found = await versionEntries(l.manifests);
  const managed = await Promise.all(found.map((v) => isManaged(l, v)));
  return found.filter((_, i) => managed[i]);
}
