// src/backup/create.ts — createBackup: stage the selected files, write manifest.json, tar them with the system tar.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isInside } from "../paths";
import { stripSecrets } from "../config/store";
import { BackupError, type ProgressFn } from "./errors";
import { ARCHIVE_PREFIX, FORMAT, MANIFEST_NAME, type BackupManifest, type ManifestFile } from "./manifest";
import { planBackup, type BackupSelection } from "./plan";
import { verifyBackup } from "./verify";

export interface CreateBackupOptions extends Partial<BackupSelection> {
  /** TROPOS_HOME. */
  home: string;
  /** Epoch ms; names the archive and stamps the manifest. */
  now: () => number;
  /** A directory (archive named automatically) or a file ending in .tar.gz / .tgz. Default: <home>/backups. */
  output?: string;
  dryRun?: boolean;
  /** Re-read the finished archive and check every hash. */
  verify?: boolean;
  onProgress?: ProgressFn;
  troposVersion?: string;
  /** Name of the tar program; tests may point it at a missing one. */
  tarBin?: string;
}

export interface CreateBackupResult {
  /** Absent for a dry run. */
  archive?: string;
  fileCount: number;
  totalBytes: number;
  archiveBytes?: number;
  skipped: { path: string; reason: string }[];
  files: string[];
  verified?: boolean;
  dryRun: boolean;
}

export function findTar(tarBin = "tar"): string {
  const found = Bun.which(tarBin);
  if (!found) throw new BackupError("The system `tar` program was not found. Install it (for example: apt install tar / apk add tar) and try again.", "no-tar");
  return found;
}

export const stamp = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");

async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest("hex");
}

/** Where the archive goes: an explicit file, or a fresh name inside a directory. */
async function resolveOutput(opts: CreateBackupOptions): Promise<string> {
  const out = resolve(opts.output ?? join(opts.home, "backups"));
  const isFile = /\.(tar\.gz|tgz)$/i.test(out);
  if (isFile) {
    if (await lstat(out).then(() => true, () => false)) throw new BackupError(`${out} already exists; choose another name or delete it`, "usage");
    return out;
  }
  const dir = out;
  let n = 0;
  for (;;) {
    const candidate = join(dir, `tropos-backup-${stamp(opts.now())}${n ? `-${n}` : ""}.tar.gz`);
    if (!(await lstat(candidate).then(() => true, () => false))) return candidate;
    n++;
  }
}

export async function createBackup(opts: CreateBackupOptions): Promise<CreateBackupResult> {
  const sel: BackupSelection = { quick: opts.quick ?? false, sessions: opts.sessions ?? true, secrets: opts.secrets ?? true, workspace: opts.workspace ?? false };
  const say: ProgressFn = opts.onProgress ?? (() => undefined);
  say({ phase: "scan", message: "Looking for files to back up" });
  const plan = await planBackup(opts.home, sel);
  const totalBytes = plan.entries.reduce((n, e) => n + e.size, 0);
  const files = plan.entries.map((e) => e.rel);
  if (plan.entries.length === 0) throw new BackupError(`Nothing to back up in ${opts.home}.`, "empty");
  const base = { fileCount: plan.entries.length, totalBytes, skipped: plan.skipped, files };
  if (opts.dryRun) return { ...base, dryRun: true };

  const tar = findTar(opts.tarBin);
  const archive = await resolveOutput(opts);
  const outDir = dirname(archive);
  // Never write the archive into the data it is copying (that would also make restore-from-it loop).
  if (isInside(resolve(archive), opts.home) && !isInside(resolve(archive), join(opts.home, "backups")) && opts.output !== undefined) {
    throw new BackupError(`Choose an output outside ${opts.home} (or inside ${join(opts.home, "backups")}).`, "usage");
  }
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(outDir, ".tropos-backup-staging-"));
  const partial = `${archive}.partial`;
  try {
    await chmod(staging, 0o700);
    const manifestFiles: ManifestFile[] = [];
    let n = 0;
    for (const e of plan.entries) {
      const dest = join(staging, ARCHIVE_PREFIX, e.rel);
      await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
      if (e.type === "symlink") {
        await symlink(e.target!, dest);
        manifestFiles.push({ path: e.rel, type: "symlink", size: e.size, sha256: createHash("sha256").update(e.target!).digest("hex"), mode: e.mode, target: e.target });
      } else {
        let stripped = false;
        const secretFile = !sel.secrets && (e.rel === "settings.json" || e.rel === "gateway.json");
        if (secretFile) {
          // Remove secret values (instead of masking them) so a restore never writes "********" over a real key.
          try {
            const clean = stripSecrets(JSON.parse(await readFile(e.abs, "utf8")));
            await writeFile(dest, `${JSON.stringify(clean, null, 2)}\n`, { mode: e.mode | 0o600 });
            stripped = true;
          } catch {
            plan.skipped.push({ path: e.rel, reason: "not valid JSON, so its secrets cannot be removed; left out" });
            continue;
          }
        } else {
          await copyFile(e.abs, dest);
        }
        await chmod(dest, e.mode | 0o200).catch(() => undefined);
        const st = await stat(e.abs).catch(() => null);
        if (st) await utimes(dest, st.atime, st.mtime).catch(() => undefined);
        const info = await stat(dest);
        manifestFiles.push({ path: e.rel, type: "file", size: info.size, sha256: await sha256File(dest), mode: e.mode, ...(stripped ? { stripped } : {}) });
      }
      say({ phase: "stage", message: e.rel, done: ++n, total: plan.entries.length });
    }
    const manifest: BackupManifest = {
      format: FORMAT,
      version: 1,
      createdAt: new Date(opts.now()).toISOString(),
      troposVersion: opts.troposVersion,
      platform: `${process.platform}-${process.arch}`,
      options: sel,
      includes: plan.includes,
      excludes: plan.excludes,
      files: manifestFiles,
    };
    await writeFile(join(staging, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
    const list = [MANIFEST_NAME, ...manifestFiles.map((f) => `${ARCHIVE_PREFIX}/${f.path}`)].join("\n");
    const listFile = join(staging, ".list");
    await writeFile(listFile, `${list}\n`);

    say({ phase: "archive", message: "Writing the archive" });
    // Created private first: tar truncates an existing file and keeps its mode.
    await writeFile(partial, "", { mode: 0o600 });
    await chmod(partial, 0o600);
    const proc = Bun.spawn([tar, "-czf", partial, "-C", staging, "-T", listFile], { stdout: "ignore", stderr: "pipe", env: { ...process.env, COPYFILE_DISABLE: "1" } });
    const [code, errText] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (code !== 0) throw new BackupError(`tar failed (exit ${code}): ${errText.trim()}`, "failed");
    await rename(partial, archive);
    const result: CreateBackupResult = { ...base, skipped: plan.skipped, fileCount: manifestFiles.length, archive, archiveBytes: (await stat(archive)).size, dryRun: false };
    if (opts.verify) {
      say({ phase: "verify", message: "Verifying the archive" });
      const v = await verifyBackup({ archive, onProgress: opts.onProgress });
      result.verified = v.ok;
      if (!v.ok) throw new BackupError(`The archive ${archive} failed verification: ${v.problems[0]}`, "invalid", v.problems);
    }
    say({ phase: "done", message: archive });
    return result;
  } finally {
    await rm(partial, { force: true });
    await rm(staging, { recursive: true, force: true });
  }
}

