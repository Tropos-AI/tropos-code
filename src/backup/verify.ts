// src/backup/verify.ts — checks an archive against its manifest and against the rules restore relies on.
import { createHash } from "node:crypto";
import { ARCHIVE_PREFIX, MANIFEST_NAME, manifestSchema, unsafeLinkTarget, unsafeRelPath, type BackupManifest } from "./manifest";
import { readTarGz, type TarEntry } from "./tar";
import type { ProgressFn } from "./errors";

export interface VerifyResult {
  ok: boolean;
  problems: string[];
  manifest?: BackupManifest;
  /** Number of files in the manifest that were checked. */
  files: number;
}

const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

/** The home-relative path of an archive member, or a reason it is not acceptable. */
export function memberPath(name: string): { rel: string } | { problem: string } {
  const prefix = `${ARCHIVE_PREFIX}/`;
  if (!name.startsWith(prefix)) return { problem: `unexpected entry "${name}" (outside ${ARCHIVE_PREFIX}/)` };
  const rel = name.slice(prefix.length).replace(/\/$/, "");
  const bad = unsafeRelPath(rel);
  return bad ? { problem: `unsafe entry "${name}": ${bad}` } : { rel };
}

/** Judges one entry on its own, without the manifest: used by verify and again by restore while extracting. */
export function entryProblem(e: TarEntry): string | undefined {
  if (e.name === MANIFEST_NAME) return e.kind === "file" ? undefined : "manifest.json is not a regular file";
  const mp = memberPath(e.name);
  if ("problem" in mp) return mp.problem;
  if (e.kind === "dir") return undefined;
  if (e.kind === "file") return undefined;
  if (e.kind === "symlink") {
    const bad = unsafeLinkTarget(mp.rel, e.linkname);
    return bad ? `unsafe link "${e.name}" -> "${e.linkname}": ${bad}` : undefined;
  }
  return `entry "${e.name}" is a ${e.kind === "hardlink" ? "hard link" : "special file"}, which backups never contain`;
}

/** Files a backup never restores: the gateway's token is minted per machine, so an archive must not set it. */
export const NOT_RESTORABLE = new Set(["gateway/token"]);

export interface VerifyOptions {
  archive: string;
  onProgress?: ProgressFn;
  /** Restore skips the not-restorable files itself (with a warning); verify reports them by default. */
  allowNotRestorable?: boolean;
}

export async function verifyBackup(opts: VerifyOptions): Promise<VerifyResult> {
  const problems: string[] = [];
  const seen = new Map<string, { size: number; sha256: string; kind: TarEntry["kind"] }>();
  let manifestText: string | undefined;
  let count = 0;
  try {
    for await (const e of readTarGz(opts.archive)) {
      const bad = entryProblem(e);
      if (bad) {
        problems.push(bad);
        continue;
      }
      if (e.kind === "dir") continue;
      if (seen.has(e.name)) {
        problems.push(`duplicate entry "${e.name}"`);
        continue;
      }
      if (e.name === MANIFEST_NAME) {
        manifestText = e.data.toString("utf8");
        seen.set(e.name, { size: e.size, sha256: "", kind: "file" });
        continue;
      }
      seen.set(e.name, { size: e.kind === "symlink" ? Buffer.byteLength(e.linkname) : e.size, sha256: sha(e.kind === "symlink" ? e.linkname : e.data), kind: e.kind });
      opts.onProgress?.({ phase: "verify", message: e.name, done: ++count });
    }
  } catch (err) {
    return { ok: false, problems: [`${opts.archive} is not a readable backup: ${(err as Error).message}`], files: 0 };
  }
  if (manifestText === undefined) return { ok: false, problems: [...problems, `${MANIFEST_NAME} is missing from the archive`], files: 0 };

  let manifest: BackupManifest;
  try {
    const parsed = manifestSchema.safeParse(JSON.parse(manifestText));
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      return { ok: false, problems: [...problems, `${MANIFEST_NAME} is invalid: ${i?.path.join(".") || "(root)"}: ${i?.message}`], files: 0 };
    }
    manifest = parsed.data;
  } catch {
    return { ok: false, problems: [...problems, `${MANIFEST_NAME} is not valid JSON`], files: 0 };
  }

  // A member whose directory is (or sits under) a link of the archive would be written wherever that link leads; Tropos
  // never makes such archives, and the link text alone cannot show where the combination ends up.
  const linkPaths = new Set<string>();
  for (const name of seen.keys()) if (seen.get(name)?.kind === "symlink") linkPaths.add(name);
  for (const name of seen.keys()) {
    const parts = name.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (linkPaths.has(parts.slice(0, i).join("/"))) {
        problems.push(`"${name}" would be written through a link of the archive (${parts.slice(0, i).join("/")})`);
        break;
      }
    }
  }

  const listed = new Set<string>();
  for (const f of manifest.files) {
    if (NOT_RESTORABLE.has(f.path) && !opts.allowNotRestorable) problems.push(`${f.path} is not restorable: it is made per machine and is never taken from a backup`);
    const name = `${ARCHIVE_PREFIX}/${f.path}`;
    const bad = unsafeRelPath(f.path) ?? (f.type === "symlink" ? unsafeLinkTarget(f.path, f.target ?? "") : undefined);
    if (bad) {
      problems.push(`manifest lists an unsafe path "${f.path}": ${bad}`);
      continue;
    }
    if (listed.has(name)) {
      problems.push(`manifest lists "${f.path}" twice`);
      continue;
    }
    listed.add(name);
    const got = seen.get(name);
    if (!got) problems.push(`missing from the archive: ${f.path}`);
    else if (got.kind !== f.type) problems.push(`${f.path} is a ${got.kind} in the archive but the manifest says ${f.type}`);
    else if (got.size !== f.size) problems.push(`size mismatch: ${f.path} (manifest ${f.size}, archive ${got.size})`);
    else if (got.sha256 !== f.sha256) problems.push(`checksum mismatch: ${f.path}`);
  }
  for (const name of seen.keys()) if (name !== MANIFEST_NAME && !listed.has(name)) problems.push(`not in the manifest: ${name}`);
  return { ok: problems.length === 0, problems, manifest, files: manifest.files.length };
}
