// src/backup/restore.ts — restoreBackup: verify, safety-backup, then write the files back, refusing anything unsafe.
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readlink, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { settingsLayerSchema } from "../config/settings";
import { gatewayConfigSchema } from "../gateway/config";
import { isInside } from "../paths";
import { createBackup, stamp } from "./create";
import { BackupError, type ProgressFn } from "./errors";
import { ARCHIVE_PREFIX, PARTS, partOf, type BackupManifest, type BackupPart, type ManifestFile } from "./manifest";
import { classifyRisky, INSPECTED, type RiskyFile } from "./risky";
import { readTarGz } from "./tar";
import { entryProblem, memberPath, NOT_RESTORABLE, verifyBackup } from "./verify";

export interface RestoreOptions {
  archive: string;
  /** TROPOS_HOME to restore into. */
  home: string;
  now: () => number;
  dryRun?: boolean;
  /** Only these parts (see PARTS). */
  only?: BackupPart[];
  /** Default true. Backs up the current state into <home>/backups before anything is overwritten. */
  safetyBackup?: boolean;
  onProgress?: ProgressFn;
  troposVersion?: string;
  /**
   * The caller has been told which files can run code or let people in (see `risky`) and accepts them. Without it a
   * restore that includes any of them is refused (BackupError "untrusted").
   */
  trustCode?: boolean;
}

export interface RestoreResult {
  dryRun: boolean;
  manifest: BackupManifest;
  /** Files that are (or, in a dry run, would be) written. */
  restored: ManifestFile[];
  /** Files that exist now and will be (or were) replaced. */
  overwritten: string[];
  safetyBackup?: string;
  warnings: string[];
  /** Files among `restored` that can run code or let people in; also filled by a dry run. */
  risky: RiskyFile[];
}

export function parseParts(list: string[]): BackupPart[] {
  const wanted = list.flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
  const bad = wanted.find((p) => !(PARTS as readonly string[]).includes(p));
  if (bad) throw new BackupError(`Unknown part "${bad}". Parts: ${PARTS.join(", ")}`, "usage");
  return wanted as BackupPart[];
}

/** True when state.json names a live process: the gateway is running now. */
export async function gatewayRunning(home: string): Promise<boolean> {
  try {
    const state = JSON.parse(await readFile(join(home, "gateway", "state.json"), "utf8")) as { pid?: number };
    if (typeof state.pid !== "number") return false;
    process.kill(state.pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Where `rel` may be written: its deepest existing ancestor must really live inside the home (no symlinked directory
 * on the way may lead out), and the file itself must not be a directory.
 */
async function destinationFor(homeReal: string, rel: string): Promise<string> {
  const dest = join(homeReal, rel);
  if (!isInside(dest, homeReal)) throw new BackupError(`refusing to write outside the Tropos home: ${rel}`, "unsafe");
  let probe = dirname(dest);
  for (;;) {
    try {
      const real = await realpath(probe);
      if (!isInside(real, homeReal)) throw new BackupError(`refusing to write through a link that leaves the Tropos home: ${rel}`, "unsafe");
      break;
    } catch (err) {
      if (err instanceof BackupError) throw err;
      if ((err as NodeJS.ErrnoException).code !== "ENOENT" || probe === homeReal) throw err;
      probe = dirname(probe);
    }
  }
  await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
  // mkdir -p followed what exists; check again now that every directory is there.
  if (!isInside(await realpath(dirname(dest)), homeReal)) throw new BackupError(`refusing to write through a link that leaves the Tropos home: ${rel}`, "unsafe");
  const st = await lstat(dest).catch(() => null);
  if (st?.isDirectory()) throw new BackupError(`${rel} is a directory here but a file in the backup; not replacing it`, "unsafe");
  return dest;
}

/** Where `path` really ends up, following links (also dangling ones, whose target is resolved as if it existed). */
async function resolveReal(path: string, depth = 0): Promise<string> {
  if (depth > 40) throw new BackupError(`too many levels of links at ${path}`, "unsafe");
  try {
    return await realpath(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const parent = dirname(path);
  const st = await lstat(path).catch(() => null);
  if (st?.isSymbolicLink()) return resolveReal(resolve(await resolveReal(parent, depth + 1), await readlink(path)), depth + 1);
  if (parent === path) return path;
  return join(await resolveReal(parent, depth + 1), basename(path));
}

/** Why a restored settings.json / gateway.json cannot be used, or undefined. Checked before anything is written. */
function contentProblem(rel: string, text: string): string | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return `${rel} is not valid JSON`;
  }
  const parsed = (rel === "gateway.json" ? gatewayConfigSchema : settingsLayerSchema).safeParse(json);
  if (parsed.success) return undefined;
  const i = parsed.error.issues[0];
  return `${rel} is invalid: ${i?.path.join(".") || "(root)"}: ${i?.message}`;
}

export async function restoreBackup(opts: RestoreOptions): Promise<RestoreResult> {
  const say: ProgressFn = opts.onProgress ?? (() => undefined);
  const warnings: string[] = [];
  say({ phase: "verify", message: "Verifying the archive before touching anything" });
  const v = await verifyBackup({ archive: opts.archive, onProgress: opts.onProgress, allowNotRestorable: true });
  if (!v.ok || !v.manifest) throw new BackupError(`${opts.archive} did not pass verification: ${v.problems[0]}`, "invalid", v.problems);
  const manifest = v.manifest;
  const only = opts.only?.length ? new Set(opts.only) : undefined;
  const chosen = manifest.files.filter((f) => !NOT_RESTORABLE.has(f.path) && (!only || only.has(partOf(f.path))));
  for (const f of manifest.files) {
    if (!NOT_RESTORABLE.has(f.path)) continue;
    const w = `${f.path} is in this backup but is never restored: it is made per machine.`;
    warnings.push(w);
    say({ phase: "warn", message: w });
  }
  const byName = new Map(chosen.map((f) => [`${ARCHIVE_PREFIX}/${f.path}`, f]));
  if (chosen.length === 0) throw new BackupError(only ? `The backup has nothing for: ${[...only].join(", ")}` : "The backup is empty.", "empty");

  // Settings files are read and checked in full before the first write: a broken one aborts the restore untouched.
  const texts = new Map<string, string>();
  const inspect = new Map(chosen.filter((f) => INSPECTED(f.path)).map((f) => [`${ARCHIVE_PREFIX}/${f.path}`, f]));
  if (inspect.size) {
    for await (const e of readTarGz(opts.archive)) {
      const f = inspect.get(e.name);
      if (!f || e.kind !== "file") continue;
      if (createHash("sha256").update(e.data).digest("hex") !== f.sha256) throw new BackupError(`archive changed during restore: checksum mismatch for ${f.path}`, "invalid");
      texts.set(f.path, e.data.toString("utf8"));
    }
  }
  const content = [...texts].map(([rel, text]) => contentProblem(rel, text)).filter((p): p is string => p !== undefined);
  if (content.length) throw new BackupError(`Nothing was restored: ${content[0]}`, "invalid", content);
  const risky = classifyRisky(chosen, (p) => texts.get(p));

  const overwritten: string[] = [];
  for (const f of chosen) if (await lstat(join(opts.home, f.path)).then(() => true, () => false)) overwritten.push(f.path);

  if (await gatewayRunning(opts.home)) {
    const w = "The gateway is running. Stop it (tcode gateway stop) before restoring, or it may overwrite what is restored.";
    warnings.push(w);
    say({ phase: "warn", message: w });
  }
  if (opts.dryRun) return { dryRun: true, manifest, restored: chosen, overwritten, warnings, risky };
  if (risky.length && !opts.trustCode) {
    throw new BackupError(
      `This backup replaces files that can run code or let people in (${risky.map((r) => r.path).join(", ")}); nothing was restored. Restore it only if you trust whoever made it.`,
      "untrusted",
      risky.map((r) => `${r.path}: ${r.why}`),
    );
  }

  await mkdir(opts.home, { recursive: true, mode: 0o700 });
  let safetyBackup: string | undefined;
  if (opts.safetyBackup !== false) {
    say({ phase: "safety", message: "Backing up the current state first" });
    try {
      const safe = await createBackup({
        home: opts.home,
        now: opts.now,
        output: join(opts.home, "backups", `tropos-safety-${stamp(opts.now())}.tar.gz`),
        verify: true,
        workspace: false,
        troposVersion: opts.troposVersion,
        onProgress: opts.onProgress,
      });
      safetyBackup = safe.archive;
    } catch (err) {
      // An empty home has nothing to lose; any other failure stops the restore before it changes anything.
      if (!(err instanceof BackupError && err.code === "empty")) throw err;
    }
  }

  const homeReal = await realpath(opts.home);
  let done = 0;
  const skippedLinks = new Set<string>();
  for await (const e of readTarGz(opts.archive)) {
    const f = byName.get(e.name);
    if (!f) continue;
    // Judged again: the file may have changed since verification.
    const bad = entryProblem(e);
    if (bad) throw new BackupError(`archive changed during restore: ${bad}`, "unsafe");
    const mp = memberPath(e.name);
    if ("problem" in mp) throw new BackupError(mp.problem, "unsafe");
    const digest = createHash("sha256").update(e.kind === "symlink" ? e.linkname : e.data).digest("hex");
    if (digest !== f.sha256) throw new BackupError(`archive changed during restore: checksum mismatch for ${f.path}`, "invalid");
    const dest = await destinationFor(homeReal, mp.rel);
    const tmp = `${dest}.restore-${process.pid}`;
    try {
      if (e.kind === "symlink") {
        await rm(tmp, { force: true });
        await symlink(e.linkname, tmp);
        // The text was checked on its own; where the link really ends up depends on what is on disk (other links on the way).
        const real = await resolveReal(tmp);
        if (!isInside(real, homeReal)) {
          await rm(tmp, { force: true });
          const w = `skipped the link ${mp.rel}: it leads outside the Tropos home (${real})`;
          warnings.push(w);
          skippedLinks.add(mp.rel);
          say({ phase: "warn", message: w });
          say({ phase: "extract", message: f.path, done: ++done, total: chosen.length });
          continue;
        }
      } else {
        // Group/other write is never restored; owner can always read and write.
        const mode = (f.mode & 0o755) | 0o600;
        await writeFile(tmp, e.data, { mode });
        await chmod(tmp, mode);
        await utimes(tmp, new Date(), new Date()).catch(() => undefined);
      }
      await rename(tmp, dest);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    say({ phase: "extract", message: f.path, done: ++done, total: chosen.length });
  }
  if (done !== chosen.length) throw new BackupError(`restored ${done} of ${chosen.length} files: the archive changed during restore`, "invalid");
  say({ phase: "done", message: `restored ${done} files` });
  return { dryRun: false, manifest, restored: chosen.filter((f) => !skippedLinks.has(f.path)), overwritten, safetyBackup, warnings, risky };
}

