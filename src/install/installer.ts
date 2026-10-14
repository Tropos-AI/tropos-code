// src/install/installer.ts
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { isChannel, resolveChannel, type Channel } from "./channels";
import { cleanup } from "./cleanup";
import { decompressZstdFile } from "./decompress";
import { withInstallLock, type EngineDeps, type EngineSession, type LockedRun, type LockOptions } from "./engine";
import { InstallError } from "./errors";
import { downloadToFile } from "./fetch";
import { fsyncDir, fsyncFile, sha256File } from "./files";
import { checkSafeDir, versionPath } from "./layout";
import { linkResolvesTo, readLink, switchLink, type LinkState } from "./link";
import type { LockHandle } from "./locks";
import { tryLockVersionExclusive } from "./locks";
import { expectVersion, verifyManifest, type PlatformEntry, type VerifiedManifest } from "./manifest";
import { dropLink, selectFallback } from "./recovery";
import { SMALL_TIMEOUT_MS, fetchVersionManifest, withRetries } from "./remote";
import type { SkipReason } from "./state";
import { checkFileAgainst, checkHealthy, isManaged, storeManifest, type HealthResult } from "./verify";
import { compareVersions, isVersion } from "./version";

export type InstallSource =
  | { kind: "remote" }
  | { kind: "self"; execPath: string; manifestPath: string; signaturePath: string; compiledVersion: string };

export interface InstallOptions {
  force: boolean;
  source: InstallSource;
}

export interface InstallOutcome {
  version: string;
  previous: string | null;
  changed: boolean;
}

async function obtainManifest(s: EngineSession, version: string, source: InstallSource): Promise<VerifiedManifest> {
  if (source.kind === "remote") return fetchVersionManifest(version, s.deps);
  if (version !== source.compiledVersion) throw new InstallError("integrity", `this binary is ${source.compiledVersion}, not ${version}`);
  let bytes: Buffer;
  let signature: string;
  try {
    [bytes, signature] = await Promise.all([readFile(source.manifestPath), readFile(source.signaturePath, "utf8")]);
  } catch (e) {
    throw new InstallError("usage", `cannot read the manifest or its signature: ${(e as Error).message}`);
  }
  const vm = verifyManifest(new Uint8Array(bytes), signature, s.deps.trusted);
  expectVersion(vm.manifest, source.compiledVersion);
  return vm;
}

/** What the user can do about a foreign ~/.local/bin/tropos; only `tcode install` has a --force. */
export type ForeignRemedy = "force" | "install.sh" | "move";
const FOREIGN_REMEDY: Record<ForeignRemedy, string> = {
  force: "move it away or rerun with --force",
  "install.sh": "move it away (or remove it) and run install.sh again",
  move: "move it away and try again",
};

export async function preSwitchChecks(s: EngineSession, link: LinkState, force: boolean, remedy: ForeignRemedy): Promise<void> {
  const l = s.deps.layout;
  await checkSafeDir(l.data, s.deps.user);
  await checkSafeDir(l.binDir, s.deps.user);
  if (link.kind === "foreign" && !force) {
    throw new InstallError("local", `${l.binLink} exists and is not managed by Tropos; ${FOREIGN_REMEDY[remedy]}`);
  }
}

/** A health check that could not be run is a transient failure (exit 75): nothing is skipped, nothing is activated. */
export function healthNotRun(version: string, detail: string): InstallError {
  return new InstallError("busy", `the health check of ${version} could not be run (the system may be short of processes or memory); ${detail}; try again later`);
}

/**
 * The check through ~/.local/bin/tropos could not be run after switching to a Verified version that passed its own
 * check: a transient result never removes the link or moves back, so `version` stays active (exit 75).
 */
export function staysActive(version: string): InstallError {
  return new InstallError("busy", `the health check of ${version} could not be run after switching; ${version} stays active — try \`tcode --version\``);
}

/** zst first (verified before decompression), raw as fallback; a raw mismatch is retried twice (spec §10.3 step 4). */
async function downloadVerified(s: EngineSession, version: string, entry: PlatformEntry, staged: string): Promise<void> {
  const d = s.deps;
  const opts = { timeoutMs: SMALL_TIMEOUT_MS, fetch: d.fetch, allowLoopbackHttp: d.allowLoopbackHttp };
  const zstPath = `${staged}.zst`;
  try {
    const got = await withRetries(async () => {
      await rm(zstPath, { force: true });
      return downloadToFile(d.urls.asset(version, entry.zst.asset), zstPath, { ...opts, maxBytes: entry.zst.size });
    }, d);
    if (got.size !== entry.zst.size || got.sha256 !== entry.zst.sha256) throw new InstallError("integrity", "the compressed download does not match the manifest");
    await decompressZstdFile(zstPath, staged, entry);
    return;
  } catch (e) {
    if (!(e instanceof InstallError)) throw e;
    s.log(`compressed download failed (${e.message}); downloading the uncompressed binary`);
    await rm(staged, { force: true });
  } finally {
    await rm(zstPath, { force: true });
  }
  for (let attempt = 1; ; attempt++) {
    const got = await withRetries(async () => {
      await rm(staged, { force: true });
      return downloadToFile(d.urls.asset(version, entry.asset), staged, { ...opts, maxBytes: entry.size });
    }, d);
    if (got.size === entry.size && got.sha256 === entry.sha256) return;
    if (attempt === 3) throw new InstallError("integrity", `the download of ${entry.asset} does not match the manifest (tried 3 times)`);
  }
}

async function stage(s: EngineSession, version: string, entry: PlatformEntry, source: InstallSource): Promise<string> {
  const staged = join(s.deps.layout.staging, `${version}.${randomUUID()}`);
  try {
    if (source.kind === "self") {
      await copyFile(source.execPath, staged, constants.COPYFILE_EXCL);
      // Hash the copy that will be installed, not the source, so a later change to the source cannot slip through.
      const got = await sha256File(staged);
      if (got.size !== entry.size || got.sha256 !== entry.sha256) throw new InstallError("integrity", "this binary does not match its signed manifest");
    } else {
      await downloadVerified(s, version, entry, staged);
    }
    await chmod(staged, 0o755);
    await fsyncFile(staged);
    return staged;
  } catch (e) {
    await rm(staged, { force: true });
    throw e;
  }
}

/** Spec §10.3 steps 2–10. Caller holds the install lock and has run recovery. */
export async function installVersion(s: EngineSession, version: string, opts: InstallOptions): Promise<InstallOutcome> {
  const d = s.deps;
  const l = d.layout;
  const link = await readLink(l);
  if (!opts.force && s.state.current === version && link.kind === "ours" && link.version === version && (await checkHealthy(s.ctx, version)).ok) {
    return { version, previous: s.state.previous, changed: false };
  }

  const vm = await obtainManifest(s, version, opts.source);
  await preSwitchChecks(s, link, opts.force, opts.source.kind === "self" ? "install.sh" : "force");
  const entry = vm.manifest.platforms[d.platform];
  const target = versionPath(l, version);

  let exclusive: LockHandle | null = null;
  try {
    const existing = await checkFileAgainst(target, entry, d.user);
    if (!existing.ok && existing.reason !== "missing") {
      // Immutability rule (spec §10.2): replace a damaged file only while no process runs it.
      exclusive = tryLockVersionExclusive(l, version, d.flock);
      if (!exclusive) {
        let fallback: string | null = null;
        if (s.state.current === version) {
          fallback = await selectFallback(s, new Set([version]));
          if (fallback) {
            await switchLink(l, fallback);
            await s.save({ current: fallback, previous: s.state.previous === fallback ? null : s.state.previous });
          }
        }
        if (d.runningVersion === version) {
          // This very process holds the in-use lock, so rerunning it can never succeed.
          throw new InstallError("busy", `version ${version} is damaged and this tcode is running from it${fallback ? ` (now using ${fallback})` : ""}; reinstall it with install.sh`);
        }
        throw new InstallError("busy", `version ${version} is damaged and in use by running sessions; close them and run \`tcode install ${version} --force\` again`);
      }
      const aside = join(l.versions, `${(await isManaged(l, version)) ? ".corrupt" : ".unmanaged"}-${version}-${s.now().getTime()}`);
      await rename(target, aside);
      s.log(`moved the unverifiable ${target} to ${aside}`);
    }
    if (existing.ok) {
      await storeManifest(l, version, vm);
    } else {
      const staged = await stage(s, version, entry, opts.source);
      s.crash("after-download");
      try {
        await storeManifest(l, version, vm); // A10: the signed manifest is stored before the binary appears
      } catch (e) {
        await rm(staged, { force: true });
        throw e;
      }
      try {
        await rename(staged, target);
      } catch (e) {
        await rm(staged, { force: true });
        throw new InstallError("local", `installing ${target}: ${(e as Error).message}`, { cause: e });
      }
      await fsyncDir(l.versions);
      s.crash("after-rename");
    }
  } finally {
    exclusive?.release();
  }

  const healthy = await checkHealthy(s.ctx, version);
  if (!healthy.ok) {
    // Only a check that ran and failed is a verdict on the release; a transient failure records nothing.
    if (healthy.transient) throw healthNotRun(version, `${version} was not activated`);
    await s.save({ skip: { ...s.state.skip, [version]: "health-check" } });
    throw new InstallError("integrity", `release ${version} does not run on this machine`);
  }

  const from = s.state.current;
  await s.save({ pending: { op: "switch", from, to: version } });
  s.crash("after-pending");
  await switchLink(l, version);
  s.crash("after-swap");

  const post: HealthResult = (await linkResolvesTo(l, version)) ? await d.health(l.binLink, version) : "bad";
  const skip = { ...s.state.skip };
  delete skip[version];
  const previous = from !== null && from !== version ? from : s.state.previous;
  if (post === "unknown") {
    await s.save({ current: version, previous, pending: null, skip });
    throw staysActive(version);
  }
  if (post !== "ok") {
    const restored = from !== null && (await checkHealthy(s.ctx, from)).ok ? from : await selectFallback(s, new Set([version]));
    if (restored) await switchLink(l, restored);
    else await dropLink(s);
    const using = restored ? `still using ${restored}` : "no verified version is active";
    await s.save({ current: restored, pending: null, skip: { ...s.state.skip, [version]: "health-check" } });
    throw new InstallError("integrity", `release ${version} failed its check after switching; ${using}`);
  }

  await s.save({ current: version, previous, pending: null, skip });
  s.crash("after-state");
  try {
    await cleanup(s);
  } catch (e) {
    s.log(`cleanup failed: ${(e as Error).message}`);
  }
  return { version, previous: from, changed: from !== version };
}

/** Progress callbacks of the foreground commands: who holds the install lock, and recovery's report as soon as it exists. */
export type Hooks = Pick<LockOptions, "onWait" | "onRecovery">;

/** `tcode install [stable|latest|<version>] [--force]`. An explicit install clears the version's skip entry. */
export async function installTarget(deps: EngineDeps, target: string, force: boolean, hooks: Hooks = {}): Promise<LockedRun<InstallOutcome>> {
  const run = await withInstallLock(deps, { wait: true, ...hooks }, async (s) => {
    const version = isChannel(target) ? (await resolveChannel(target, deps)).version : target;
    if (!isVersion(version)) throw new InstallError("usage", `not a version or channel: ${target}`);
    if (s.state.skip[version]) {
      const skip = { ...s.state.skip };
      delete skip[version];
      await s.save({ skip });
    }
    return installVersion(s, version, { force, source: { kind: "remote" } });
  });
  return run!;
}

/** `tcode install --self …`, run by install.sh from its temporary folder (spec §10.3). */
export async function installSelf(deps: EngineDeps, source: Extract<InstallSource, { kind: "self" }>, hooks: Hooks = {}): Promise<LockedRun<InstallOutcome>> {
  const run = await withInstallLock(deps, { wait: true, ...hooks }, (s) => installVersion(s, source.compiledVersion, { force: false, source }));
  return run!;
}

export type UpdateResult =
  | { kind: "updated"; outcome: InstallOutcome }
  | { kind: "up-to-date"; current: string | null; available: string }
  | { kind: "skipped"; version: string; reason: SkipReason };

/**
 * The lowest version an update may move to. Normally `current`; with no managed current version, the version this
 * process runs from or ~/.local/bin/tropos points to (an unmanaged local build), so an update never goes below it.
 */
async function updateFloor(s: EngineSession): Promise<string | null> {
  if (s.state.current !== null) return s.state.current;
  const link = await readLink(s.deps.layout);
  const candidates = [s.deps.runningVersion ?? null, link.kind === "ours" ? link.version : null].filter((v): v is string => v !== null && isVersion(v));
  return candidates.sort(compareVersions).at(-1) ?? null;
}

/** `tcode update` and background updates: only ever moves forward, never to a skipped version (spec §11). */
export async function updateChannel(deps: EngineDeps, channel: Channel, opts: Hooks & { wait: boolean; background?: boolean }): Promise<LockedRun<UpdateResult> | null> {
  return withInstallLock(deps, opts, async (s, recovery): Promise<UpdateResult> => {
    // Amendment A11: with no verified version active, a background run stops; installing is the user's call.
    if (opts.background && recovery.fatal) throw new InstallError("integrity", recovery.fatal);
    const available = (await resolveChannel(channel, deps)).version;
    const floor = await updateFloor(s);
    if (floor !== null && compareVersions(available, floor) <= 0) return { kind: "up-to-date", current: floor, available };
    const reason = s.state.skip[available];
    if (reason) return { kind: "skipped", version: available, reason };
    return { kind: "updated", outcome: await installVersion(s, available, { force: false, source: { kind: "remote" } }) };
  });
}
