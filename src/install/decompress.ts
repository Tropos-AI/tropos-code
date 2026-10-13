// src/install/decompress.ts
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";
import { InstallError } from "./errors";

/**
 * Decompresses an already hash-verified .zst into `dest` (created, never overwritten).
 * The decoder reports corrupt frames and trailing data; the byte guard stops extra frames and bombs
 * before they are written; the exact size and sha256 catch truncated or empty input (spec §10.3 step 4).
 */
export async function decompressZstdFile(src: string, dest: string, expected: { size: number; sha256: string }): Promise<void> {
  const hash = createHash("sha256");
  let count = 0;
  const guard = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      count += chunk.length;
      if (count > expected.size) {
        done(new InstallError("integrity", `decompressed data exceeds the expected ${expected.size} bytes`));
        return;
      }
      hash.update(chunk);
      done(null, chunk);
    },
  });
  try {
    await pipeline(createReadStream(src), createZstdDecompress(), guard, createWriteStream(dest, { flags: "wx", mode: 0o600 }));
  } catch (e) {
    if (e instanceof InstallError) throw e;
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw e;
    throw new InstallError("integrity", `zstd data is invalid: ${(e as Error).message}`, { cause: e });
  }
  if (count !== expected.size) throw new InstallError("integrity", `decompressed ${count} bytes, expected ${expected.size}`);
  if (hash.digest("hex") !== expected.sha256) throw new InstallError("integrity", "decompressed data does not match the manifest's sha256");
}
