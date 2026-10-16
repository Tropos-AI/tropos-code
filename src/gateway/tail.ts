// src/gateway/tail.ts — the last lines of a log file, without reading all of a big one.
import { open } from "node:fs/promises";

const CHUNK = 64 * 1024;

/** The last `lines` lines of the file, or undefined when it doesn't exist. */
export async function tailFile(path: string, lines: number): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  try {
    const { size } = await handle.stat();
    let start = size;
    let text = "";
    // Read backwards a chunk at a time until there are enough newlines (or the file's start).
    while (start > 0 && text.split("\n").length <= lines + 1) {
      const length = Math.min(CHUNK, start);
      start -= length;
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, start);
      text = buf.toString("utf8") + text;
    }
    const all = text.split("\n");
    if (all.at(-1) === "") all.pop();
    // A cut chunk starts mid-line (and maybe mid-character): drop that partial first line.
    const whole = start > 0 ? all.slice(1) : all;
    const out = whole.slice(-lines).join("\n");
    return out === "" ? "" : `${out}\n`;
  } finally {
    await handle.close();
  }
}
