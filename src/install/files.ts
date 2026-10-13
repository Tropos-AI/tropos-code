// src/install/files.ts
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fromFsError } from "./errors";

export async function sha256File(path: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { sha256: hash.digest("hex"), size };
}

export async function fsyncDir(dir: string): Promise<void> {
  const fh = await open(dir, "r");
  try {
    await fh.sync();
  } catch (e) {
    // Some filesystems refuse fsync on directories; the rename itself is still atomic.
    if (!["EINVAL", "EBADF", "EISDIR", "ENOTSUP"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e;
  } finally {
    await fh.close();
  }
}

export async function fsyncFile(path: string): Promise<void> {
  const fh = await open(path, "r+");
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** Temp file in the same directory, fsync, rename over `path`, fsync the directory (spec §9). */
export async function writeFileAtomic(path: string, data: string | Uint8Array, mode = 0o600): Promise<void> {
  const tmp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    const fh = await open(tmp, "wx", mode);
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
    await fsyncDir(dirname(path));
  } catch (e) {
    await rm(tmp, { force: true });
    throw fromFsError(e, `writing ${path}`);
  }
}
