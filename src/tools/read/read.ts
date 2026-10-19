// src/tools/read/read.ts
import { type FileHandle, stat } from "node:fs/promises";
import { extname } from "node:path";
import { z } from "zod";
import { holdSandbox, openVerified, type VerifiedFile } from "../file-guard";
import { PathResolutionError, resolveToolPath } from "../paths";
import { errorText } from "../../error-text";
import { defineTool, type ToolContext, type ToolOutput } from "../types";

const DEFAULT_LIMIT = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_OUTPUT_CHARS = 200_000;
const MAX_TEXT_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 32 * 1024 * 1024;
const IMAGE_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
} as const;

const schema = z.object({
  file_path: z.string().min(1).describe("Path to the file, absolute or relative to the working directory."),
  offset: z.number().int().min(1).optional().describe("1-based line number to start reading from."),
  limit: z.number().int().min(1).optional().describe(`Maximum number of lines to return (default ${DEFAULT_LIMIT}).`),
});

function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function cannotRead(path: string, error: unknown): ToolOutput {
  return { content: `Cannot read ${path}: ${errorText(error)}`, isError: true };
}

/** Reads an opened file's bytes, or returns the error result for the caller to hand back. */
async function readBytes(path: string, handle: FileHandle): Promise<Buffer | ToolOutput> {
  try {
    return await handle.readFile();
  } catch (error) {
    return cannotRead(path, error);
  }
}

export const readTool = defineTool({
  name: "Read",
  kind: "read",
  description:
    "Read a file from the local filesystem. Text comes back with line numbers (number, tab, content). " +
    ".png, .jpg, .gif and .webp files come back as images and .pdf files as documents. " +
    `Returns up to ${DEFAULT_LIMIT} lines by default; use offset and limit to page through longer files. ` +
    "A file must be read before it can be edited or overwritten.",
  schema,
  summarize: (input) => input.file_path,
  subject: (input, cwd) => ({ paths: [resolveToolPath(input.file_path, cwd)] }),
  async run(input, ctx) {
    let path: string;
    try {
      path = resolveToolPath(input.file_path, ctx.cwd());
    } catch (error) {
      if (error instanceof PathResolutionError) return cannotRead(input.file_path, error);
      throw error;
    }
    if (ctx.approvedPaths !== undefined && !ctx.approvedPaths.includes(path)) {
      return { content: `${path} changed after it was approved; nothing was read. Try again.`, isError: true };
    }
    const held = await holdSandbox(ctx);
    if ("content" in held) return held;
    try {
      return await readAt(path, input, ctx);
    } finally {
      held.release();
    }
  },
});

/** Read, once the sandbox is held. */
async function readAt(path: string, input: z.infer<typeof schema>, ctx: ToolContext): Promise<ToolOutput> {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { content: `File not found: ${path}`, isError: true };
    }
    return cannotRead(path, error);
  }
  if (info.isDirectory()) {
    return { content: `${path} is a directory. Use Glob to list its files.`, isError: true };
  }

  let opened: VerifiedFile;
  try {
    opened = await openVerified(path, "read");
  } catch (error) {
    return cannotRead(path, error);
  }
  try {
    return await readOpened(path, opened, input, ctx);
  } finally {
    await opened.handle.close();
  }
}

/** Everything Read returns, from a handle verified to be the file at `path`; sizes and mtime come from that handle. */
async function readOpened(path: string, { handle, info }: VerifiedFile, input: z.infer<typeof schema>, ctx: ToolContext): Promise<ToolOutput> {
  // The path was checked before the open; the handle may still have turned out to be something else.
  if (info.isDirectory()) return { content: `${path} is a directory. Use Glob to list its files.`, isError: true };
  if (info.isFIFO() || info.isSocket()) return { content: `${path} is not a regular file.`, isError: true };

  const ext = extname(path).toLowerCase();
  if (ext in IMAGE_TYPES) {
    if (info.size > MAX_IMAGE_BYTES) {
      return { content: `${path} is ${formatBytes(info.size)}; images over 5 MB can't be read.`, isError: true };
    }
    const bytes = await readBytes(path, handle);
    if (!Buffer.isBuffer(bytes)) return bytes;
    const data = bytes.toString("base64");
    ctx.readState.record(path, info.mtimeMs);
    const media_type = IMAGE_TYPES[ext as keyof typeof IMAGE_TYPES];
    return {
      content: [{ type: "image", source: { type: "base64", media_type, data } }],
      summary: `image, ${formatBytes(info.size)}`,
    };
  }
  if (ext === ".pdf") {
    if (info.size > MAX_PDF_BYTES) {
      return { content: `${path} is ${formatBytes(info.size)}; PDFs over 32 MB can't be read.`, isError: true };
    }
    const bytes = await readBytes(path, handle);
    if (!Buffer.isBuffer(bytes)) return bytes;
    const data = bytes.toString("base64");
    ctx.readState.record(path, info.mtimeMs);
    return {
      content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data } }],
      summary: `PDF, ${formatBytes(info.size)}`,
    };
  }

  if (info.size > MAX_TEXT_BYTES) {
    return {
      content: `${path} is ${formatBytes(info.size)}, over the 10 MB text limit. Search it with Grep instead of reading it whole.`,
      isError: true,
    };
  }
  const buffer = await readBytes(path, handle);
  if (!Buffer.isBuffer(buffer)) return buffer;
  if (buffer.subarray(0, 8192).includes(0)) {
    return { content: `${path} looks like a binary file and can't be shown as text.`, isError: true };
  }
  ctx.readState.record(path, info.mtimeMs);
  const text = buffer.toString("utf8");
  if (text.length === 0) return { content: `${path} is empty.`, summary: "empty" };

  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const start = (input.offset ?? 1) - 1;
  const slice = lines.slice(start, start + (input.limit ?? DEFAULT_LIMIT));
  if (slice.length === 0) {
    return { content: `${path} has ${lines.length} lines; offset ${input.offset} is past the end.`, summary: "past end" };
  }
  const formatted: string[] = [];
  let chars = 0;
  for (const [i, line] of slice.entries()) {
    const shown = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}… [line truncated]` : line;
    const row = `${String(start + i + 1).padStart(6)}\t${shown}`;
    // Cut at a line boundary; always keep at least one line so the offset note makes progress.
    if (formatted.length > 0 && chars + row.length + 1 > MAX_OUTPUT_CHARS) break;
    formatted.push(row);
    chars += row.length + 1;
  }
  let body = formatted.join("\n");
  const last = start + formatted.length;
  if (formatted.length < slice.length) {
    body += `\n\n[Showing lines ${start + 1}-${last} of ${lines.length} (output capped at ${MAX_OUTPUT_CHARS.toLocaleString("en-US")} characters). Use offset ${last + 1} to read more.]`;
  } else if (start > 0 || last < lines.length) {
    body += `\n\n[Showing lines ${start + 1}-${last} of ${lines.length}. Use offset to read more.]`;
  }
  return { content: body, summary: `${formatted.length} lines` };
}
