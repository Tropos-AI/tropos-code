// src/web/admin/backup.ts — `backup.*`: the backup library behind the web admin API. Names are file names only; the
// library does the verifying, the safety backup and the path checks.
import { lstat, readdir, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { BackupError, createBackup, readManifest, restoreBackup, verifyBackup, type BackupManifest } from "../../backup";
import type { BackupInfo } from "./api";
import { AdminError, type AdminContext, type AdminHandlers } from "./context";

export interface BackupDeps {
  create: typeof createBackup;
  verify: typeof verifyBackup;
  restore: typeof restoreBackup;
}

const ARCHIVE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.(tar\.gz|tgz)$/;
/** Archives other Tropos commands leave in the user's home (`tcode uninstall --backup`); nothing else there is ours. */
const USER_HOME_ARCHIVE = /^tropos-[A-Za-z0-9._-]+\.(tar\.gz|tgz)$/;

function failure(err: unknown): never {
  // "untrusted" lists the risky files; the page shows the message, so they must be in it.
  if (err instanceof BackupError) throw new AdminError(err.code === "untrusted" ? `${err.message}\n${err.problems.map((p) => `- ${p}`).join("\n")}` : err.message);
  throw err;
}

export function backupHandlers(ctx: AdminContext, deps: Partial<BackupDeps> = {}): AdminHandlers {
  const create = deps.create ?? createBackup;
  const verify = deps.verify ?? verifyBackup;
  const restore = deps.restore ?? restoreBackup;
  const dirs = [
    { dir: join(ctx.home, "backups"), accepts: ARCHIVE },
    { dir: ctx.userHome, accepts: USER_HOME_ARCHIVE },
  ];
  let busy = false;

  async function exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (busy) throw new AdminError("Another backup operation is running. Try again in a moment.");
    busy = true;
    try {
      return await work();
    } finally {
      busy = false;
    }
  }

  const info = async (path: string, manifest: BackupManifest | undefined): Promise<BackupInfo | undefined> => {
    const st = await stat(path).catch(() => null);
    if (!st?.isFile()) return undefined;
    return {
      name: basename(path),
      path,
      size: st.size,
      createdAt: manifest?.createdAt ?? st.mtime.toISOString(),
      secrets: manifest?.options.secrets ?? false,
      sessions: manifest?.options.sessions ?? false,
    };
  };

  async function list(): Promise<BackupInfo[]> {
    const out: BackupInfo[] = [];
    for (const { dir, accepts } of dirs) {
      const names = await readdir(dir).catch(() => [] as string[]);
      for (const name of names.filter((n) => accepts.test(n))) {
        const path = join(dir, name);
        const entry = await info(path, await readManifest(path));
        if (entry) out.push(entry);
      }
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  }

  /** The archive a name refers to: a plain file name found in one of the two directories, never a path. */
  async function locate(name: unknown): Promise<string> {
    if (typeof name !== "string" || name !== basename(name) || /[\\/\0]/.test(name)) throw new AdminError("Use the backup's file name, not a path.");
    for (const { dir, accepts } of dirs) {
      if (!accepts.test(name)) continue;
      const path = join(dir, name);
      const st = await lstat(path).catch(() => null);
      // A link could lead anywhere: only real files in these two directories count.
      if (st?.isFile()) return path;
    }
    throw new AdminError(`No backup named ${name.slice(0, 120)}.`);
  }

  return {
    "backup.list": () => list(),

    async "backup.create"(params) {
      return exclusive(async () => {
        const r = await create({
          home: ctx.home,
          now: ctx.now,
          quick: params?.quick ?? false,
          sessions: params?.sessions ?? true,
          secrets: params?.secrets ?? true,
          verify: true,
          troposVersion: ctx.version,
        }).catch(failure);
        if (!r.archive) throw new AdminError("The backup was not written.");
        const made = await info(r.archive, await readManifest(r.archive));
        if (!made) throw new AdminError("The backup was not written.");
        return made;
      });
    },

    async "backup.verify"(params) {
      const archive = await locate(params?.name);
      const v = await verify({ archive }).catch(failure);
      return { ok: v.ok, problems: v.problems };
    },

    async "backup.restore"(params) {
      const archive = await locate(params?.name);
      return exclusive(async () => {
        // trustCode only when the page says so after showing `risky` (a dry run returns it): never implied.
        const r = await restore({ archive, home: ctx.home, now: ctx.now, dryRun: params.dryRun === true, trustCode: params.trustCode === true, troposVersion: ctx.version }).catch(failure);
        if (!r.dryRun) await ctx.gateway?.reload().catch(() => undefined);
        return { restored: r.restored.map((f) => f.path), risky: r.risky, ...(r.safetyBackup ? { safetyBackup: r.safetyBackup } : {}) };
      });
    },

    async "backup.delete"(params) {
      const path = await locate(params?.name);
      // Looks like ours by name and by content: a stray file that merely ends in .tar.gz is left alone.
      if (!(await readManifest(path))) throw new AdminError("That file is not a Tropos backup, so it was not deleted.");
      await rm(path);
      return { removed: true };
    },
  };
}
