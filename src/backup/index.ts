// src/backup/index.ts — library entry points (the CLI and the web admin API call these).
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { manifestSchema, MANIFEST_NAME, type BackupManifest } from "./manifest";
import { readTarGz } from "./tar";

export { BackupError, type BackupErrorCode, type ProgressEvent, type ProgressFn } from "./errors";
export { createBackup, findTar, stamp, type CreateBackupOptions, type CreateBackupResult } from "./create";
export { verifyBackup, type VerifyResult } from "./verify";
export { classifyRisky, type RiskyFile } from "./risky";
export { gatewayRunning, parseParts, restoreBackup, type RestoreOptions, type RestoreResult } from "./restore";
export { PARTS, partOf, type BackupManifest, type BackupPart } from "./manifest";

/** The manifest of an archive: only its first entry is read (Tropos writes it first), so listing never walks a whole archive. */
export async function readManifest(archive: string): Promise<BackupManifest | undefined> {
  try {
    for await (const e of readTarGz(archive, { maxEntryBytes: 32 * 1024 ** 2, maxEntries: 1 })) {
      if (e.name !== MANIFEST_NAME) return undefined;
      const parsed = manifestSchema.safeParse(JSON.parse(e.data.toString("utf8")));
      return parsed.success ? parsed.data : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export interface BackupListing {
  path: string;
  name: string;
  bytes: number;
  modifiedAt: string;
  createdAt?: string;
  fileCount?: number;
}

/** Archives in <home>/backups, newest first. */
export async function listBackups(home: string): Promise<BackupListing[]> {
  const dir = join(home, "backups");
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => /\.(tar\.gz|tgz)$/.test(n));
  } catch {
    return [];
  }
  const out: BackupListing[] = [];
  for (const name of names) {
    const path = join(dir, name);
    const st = await stat(path).catch(() => null);
    if (!st?.isFile()) continue;
    const m = await readManifest(path);
    out.push({ path, name, bytes: st.size, modifiedAt: st.mtime.toISOString(), createdAt: m?.createdAt, fileCount: m?.files.length });
  }
  return out.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1));
}
