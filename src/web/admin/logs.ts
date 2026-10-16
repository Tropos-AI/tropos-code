// src/web/admin/logs.ts — `logs.tail` / `logs.since`: the three named logs, never an arbitrary path.
import { open, stat } from "node:fs/promises";
import { LOG_SOURCES, logPath, tailFile, type LogSource } from "../../cli/lifecycle/logs";
import { AdminError, type AdminContext, type AdminHandlers } from "./context";

export interface LogsDeps {
  /** Largest chunk `logs.since` returns; the live view polls again for the rest. */
  chunkBytes: number;
}

export const LOG_CHUNK_BYTES = 256 * 1024;
const DEFAULT_LINES = 200;
const MAX_LINES = 2000;

function sourceOf(name: unknown): LogSource {
  // A closed list, so the name can never steer the path.
  if (typeof name !== "string" || !(LOG_SOURCES as readonly string[]).includes(name)) throw new AdminError(`Choose one of: ${LOG_SOURCES.join(", ")}.`);
  return name as LogSource;
}

/** Drops a UTF-8 sequence cut off at the end of `buf`, so a chunk never ends in half a character. */
function wholeUtf8(buf: Buffer): Buffer {
  let i = buf.length;
  // Walk back over continuation bytes (10xxxxxx) to the lead byte of the last character.
  while (i > 0 && i > buf.length - 4 && (buf[i - 1]! & 0xc0) === 0x80) i--;
  if (i === 0) return buf;
  const lead = buf[i - 1]!;
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return buf.length - (i - 1) < need ? buf.subarray(0, i - 1) : buf;
}

export function logsHandlers(ctx: AdminContext, deps: Partial<LogsDeps> = {}): AdminHandlers {
  const chunkBytes = deps.chunkBytes ?? LOG_CHUNK_BYTES;
  const pathOf = (name: LogSource) => logPath(name, ctx.home, ctx.env, ctx.userHome);

  return {
    async "logs.tail"(params) {
      const name = sourceOf(params?.name);
      const wanted = params?.lines === undefined ? DEFAULT_LINES : params.lines;
      if (!Number.isInteger(wanted) || wanted < 1) throw new AdminError("lines must be a positive whole number.");
      const path = pathOf(name);
      // Size first: a line written while we read is then shown again by `since` rather than lost.
      const size = await stat(path).then((s) => s.size, () => null);
      const lines = size === null ? null : await tailFile(path, Math.min(wanted, MAX_LINES)).catch(() => null);
      if (size === null || lines === null) return { path, exists: false, lines: [], offset: 0 };
      return { path, exists: true, lines, offset: size };
    },

    async "logs.since"(params) {
      const name = sourceOf(params?.name);
      const offset = params?.offset;
      if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) throw new AdminError("offset must be a whole number of bytes.");
      const path = pathOf(name);
      const size = await stat(path).then((s) => s.size, () => null);
      if (size === null) return { chunk: "", offset: 0, truncated: offset > 0 };
      // The file is shorter than the reader's position: it was rotated or truncated, so read it from the top.
      const truncated = offset > size;
      const from = truncated ? 0 : offset;
      if (size === from) return { chunk: "", offset: from, truncated };
      const fh = await open(path, "r");
      try {
        const len = Math.min(size - from, chunkBytes);
        const raw = Buffer.alloc(len);
        const { bytesRead } = await fh.read(raw, 0, len, from);
        let buf: Buffer = raw.subarray(0, bytesRead);
        // A full chunk with more behind it ends on a line break when it can, so lines are not torn between polls.
        if (from + bytesRead < size) {
          const nl = buf.lastIndexOf(0x0a);
          if (nl >= 0) buf = buf.subarray(0, nl + 1);
        }
        buf = wholeUtf8(buf);
        return { chunk: buf.toString("utf8"), offset: from + buf.length, truncated };
      } finally {
        await fh.close();
      }
    },
  };
}
