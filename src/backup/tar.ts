// src/backup/tar.ts — a streaming reader for .tar.gz files (ustar, pax and GNU long names), plus a small writer
// for tests. Archives are READ here, never extracted by the system tar: restore needs to judge every entry itself.
import { createReadStream } from "node:fs";
import { createGunzip, gzipSync } from "node:zlib";
import { BackupError } from "./errors";

export type TarKind = "file" | "dir" | "symlink" | "hardlink" | "other";

export interface TarEntry {
  name: string;
  kind: TarKind;
  size: number;
  mode: number;
  linkname: string;
  data: Buffer;
}

const BLOCK = 512;

const str = (b: Buffer, start: number, len: number) => {
  const end = b.indexOf(0, start);
  return b.toString("utf8", start, end === -1 || end > start + len ? start + len : end);
};

function octal(b: Buffer, start: number, len: number): number {
  if (b[start]! & 0x80) {
    // base-256 (GNU) for sizes over 8 GiB
    let n = b[start]! & 0x7f;
    for (let i = 1; i < len; i++) n = n * 256 + b[start + i]!;
    return n;
  }
  const text = str(b, start, len).trim();
  return text === "" ? 0 : Number.parseInt(text, 8);
}

function checksumOk(h: Buffer): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
  return sum === octal(h, 148, 8);
}

function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space === -1) break;
    const len = Number.parseInt(data.toString("utf8", pos, space), 10);
    if (!Number.isFinite(len) || len <= space - pos + 1 || pos + len > data.length) break;
    const record = data.toString("utf8", space + 1, pos + len - 1);
    const eq = record.indexOf("=");
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    pos += len;
  }
  return out;
}

class ByteReader {
  private chunks: Buffer[] = [];
  private length = 0;
  private done = false;
  private readonly it: AsyncIterator<Buffer>;
  constructor(stream: AsyncIterable<Buffer>) {
    this.it = stream[Symbol.asyncIterator]();
  }
  /** Exactly `n` bytes, or fewer when the stream ended. */
  async take(n: number): Promise<Buffer> {
    while (this.length < n && !this.done) {
      const next = await this.it.next();
      if (next.done) this.done = true;
      else {
        this.chunks.push(next.value);
        this.length += next.value.length;
      }
    }
    if (this.chunks.length > 1) this.chunks = [Buffer.concat(this.chunks)];
    const all = this.chunks[0] ?? Buffer.alloc(0);
    const out = all.subarray(0, n);
    this.chunks = all.length > n ? [all.subarray(n)] : [];
    this.length = Math.max(0, this.length - out.length);
    return out;
  }
  async close(): Promise<void> {
    await this.it.return?.();
  }
}

/** Largest entry the reader will buffer; a backup file bigger than this is refused rather than exhausting memory. */
export const MAX_ENTRY_BYTES = 256 * 1024 ** 2;
/** Sum of all entry sizes, and the number of entries, one archive may hold (a tar bomb is refused before it is buffered). */
export const MAX_TOTAL_BYTES = 2 * 1024 ** 3;
export const MAX_ENTRIES = 100_000;

export interface TarLimits {
  maxEntryBytes?: number;
  maxTotalBytes?: number;
  maxEntries?: number;
}

const mib = (n: number) => (n < 1024 ** 2 ? `${n} bytes` : n >= 1024 ** 3 ? `${n / 1024 ** 3} GiB` : `${Math.round(n / 1024 ** 2)} MiB`);

/** Yields each entry of a .tar.gz in order. Throws on a corrupt or truncated archive. Stops cleanly if the consumer breaks. */
export async function* readTarGz(path: string, limits: TarLimits = {}): AsyncGenerator<TarEntry> {
  const maxEntry = limits.maxEntryBytes ?? MAX_ENTRY_BYTES;
  const maxTotal = limits.maxTotalBytes ?? MAX_TOTAL_BYTES;
  const maxEntries = limits.maxEntries ?? MAX_ENTRIES;
  let total = 0;
  let entries = 0;
  const source = createReadStream(path);
  const stream = createGunzip();
  // pipe() does not forward errors: a missing or unreadable file must fail the iteration, not crash the process.
  source.on("error", (err) => stream.destroy(err));
  source.pipe(stream);
  const reader = new ByteReader(stream);
  let pending: { path?: string; linkpath?: string; size?: string } = {};
  let longName: string | undefined;
  let longLink: string | undefined;
  try {
    for (;;) {
      const header = await reader.take(BLOCK);
      if (header.length === 0 || header.every((x) => x === 0)) return;
      if (header.length < BLOCK) throw new Error("the archive is truncated");
      if (!checksumOk(header)) throw new Error("the archive has a damaged header (this is not a .tar.gz, or it is corrupt)");
      const type = String.fromCharCode(header[156] || 0x30);
      let size = octal(header, 124, 12);
      const isPax = type === "x";
      if (!isPax && pending.size !== undefined) size = Number.parseInt(pending.size, 10);
      if (!Number.isSafeInteger(size) || size < 0) throw new Error(`an entry has an impossible size (${size})`);
      // Checked on the header, before the body is read into memory.
      if (size > maxEntry) throw new BackupError(`the archive has an entry larger than ${mib(maxEntry)}, which is refused`, "invalid");
      if (!isPax && type !== "g" && type !== "L" && type !== "K") {
        total += size;
        if (total > maxTotal) throw new BackupError(`the archive's entries total more than ${mib(maxTotal)}, which is refused`, "invalid");
        if (++entries > maxEntries) throw new BackupError(`the archive has more than ${maxEntries} entries, which is refused`, "invalid");
      }
      const padded = Math.ceil(size / BLOCK) * BLOCK;
      const block = await reader.take(padded);
      if (block.length < padded) throw new Error("the archive is truncated");
      const data = block.subarray(0, size);

      if (type === "g") continue;
      if (isPax) {
        pending = { ...pending, ...parsePax(data) };
        continue;
      }
      if (type === "L") {
        longName = str(data, 0, data.length);
        continue;
      }
      if (type === "K") {
        longLink = str(data, 0, data.length);
        continue;
      }
      const prefix = str(header, 345, 155);
      const base = str(header, 0, 100);
      const name = pending.path ?? longName ?? (prefix ? `${prefix}/${base}` : base);
      const linkname = pending.linkpath ?? longLink ?? str(header, 157, 100);
      pending = {};
      longName = undefined;
      longLink = undefined;
      const kind: TarKind = type === "0" || type === "\0" || type === "7" ? "file" : type === "5" ? "dir" : type === "2" ? "symlink" : type === "1" ? "hardlink" : "other";
      yield { name, kind, size, mode: octal(header, 100, 8), linkname, data: Buffer.from(data) };
    }
  } finally {
    await reader.close();
    stream.destroy();
    source.destroy();
  }
}

// ---- writer (tests, and fixtures for hostile archives) ------------------------------------------------------------------

export interface TarSpec {
  name: string;
  kind?: TarKind;
  data?: string | Buffer;
  linkname?: string;
  mode?: number;
  /** Tests only: the size written in the header, whatever the data is. */
  declaredSize?: number;
}

function headerFor(name: string, size: number, typeflag: string, mode: number, linkname: string): Buffer {
  const h = Buffer.alloc(BLOCK);
  h.write(name.slice(0, 100), 0, "utf8");
  h.write(`${mode.toString(8).padStart(7, "0")}\0`, 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148);
  h.write(typeflag, 156);
  h.write(linkname.slice(0, 100), 157);
  h.write("ustar\0" + "00", 257);
  let sum = 0;
  for (const x of h) sum += x;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return h;
}

/** Builds a .tar.gz in memory. Names over 100 bytes use a pax header. Nothing is validated: that is the point. */
export function buildTarGz(entries: TarSpec[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const data = e.data === undefined ? Buffer.alloc(0) : Buffer.from(e.data);
    const kind = e.kind ?? "file";
    const flag = kind === "dir" ? "5" : kind === "symlink" ? "2" : kind === "hardlink" ? "1" : kind === "other" ? "3" : "0";
    const body = kind === "file" ? data : Buffer.alloc(0);
    if (Buffer.byteLength(e.name) > 100 || Buffer.byteLength(e.linkname ?? "") > 100) {
      const rec = (k: string, v: string) => {
        const base = ` ${k}=${v}\n`;
        let len = Buffer.byteLength(base) + 1;
        while (String(len).length + Buffer.byteLength(base) !== len) len = String(len).length + Buffer.byteLength(base);
        return `${len}${base}`;
      };
      const pax = Buffer.from(rec("path", e.name) + (e.linkname ? rec("linkpath", e.linkname) : ""));
      parts.push(headerFor("PaxHeader", pax.length, "x", 0o644, ""), pax, Buffer.alloc(Math.ceil(pax.length / BLOCK) * BLOCK - pax.length));
    }
    parts.push(headerFor(e.name, e.declaredSize ?? body.length, flag, e.mode ?? (kind === "dir" ? 0o755 : 0o644), e.linkname ?? ""));
    if (body.length) parts.push(body, Buffer.alloc(Math.ceil(body.length / BLOCK) * BLOCK - body.length));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return gzipSync(Buffer.concat(parts));
}
