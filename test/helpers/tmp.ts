// test/helpers/tmp.ts
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Creates a temp dir and returns its canonical path (macOS /var → /private/var). */
export async function makeTmpDir(prefix = "tropos-test-"): Promise<string> {
  return realpathSync(await mkdtemp(join(tmpdir(), prefix)));
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
