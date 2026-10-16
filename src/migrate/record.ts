// src/migrate/record.ts — what was imported, so a re-run skips unchanged items: <home>/migrations/<source>.json.
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../memory/notes";

export interface RecordItem {
  hash: string;
  dest?: string;
  at: string;
}
export interface MigrationRecord {
  version: 1;
  source: string;
  root: string;
  updatedAt: string;
  items: Record<string, RecordItem>;
}

export const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

export const recordPath = (home: string, source: string): string => join(home, "migrations", `${source}.json`);

export async function readRecord(home: string, source: string): Promise<MigrationRecord | undefined> {
  try {
    const v = JSON.parse(await readFile(recordPath(home, source), "utf8")) as MigrationRecord;
    return v && v.version === 1 && v.items && typeof v.items === "object" ? v : undefined;
  } catch {
    return undefined;
  }
}

export async function writeRecord(home: string, rec: MigrationRecord): Promise<void> {
  await mkdir(join(home, "migrations"), { recursive: true, mode: 0o700 });
  await atomicWrite(recordPath(home, rec.source), `${JSON.stringify(rec, null, 2)}\n`);
}
