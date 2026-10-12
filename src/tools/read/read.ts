// src/tools/read/read.ts
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { z } from "zod";
import { resolveToolPath } from "../paths";
import { defineTool } from "../types";

const DEFAULT_LIMIT = 2000;
const MAX_LINE_CHARS = 2000;
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
    const path = resolveToolPath(input.file_path, ctx.cwd());
    let info;
    try {
      info = await stat(path);
    } catch {
      return { content: `File not found: ${path}`, isError: true };
    }
    if (info.isDirectory()) {
      return { content: `${path} is a directory. Use Glob to list its files.`, isError: true };
    }

    const ext = extname(path).toLowerCase();
    if (ext in IMAGE_TYPES) {
      if (info.size > MAX_IMAGE_BYTES) {
        return { content: `${path} is ${formatBytes(info.size)}; images over 5 MB can't be read.`, isError: true };
      }
      const data = (await readFile(path)).toString("base64");
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
      const data = (await readFile(path)).toString("base64");
      ctx.readState.record(path, info.mtimeMs);
      return {
        content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data } }],
        summary: `PDF, ${formatBytes(info.size)}`,
      };
    }

    const buffer = await readFile(path);
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
    let body = slice
      .map((line, i) => {
        const shown = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}… [line truncated]` : line;
        return `${String(start + i + 1).padStart(6)}\t${shown}`;
      })
      .join("\n");
    const last = start + slice.length;
    if (start > 0 || last < lines.length) {
      body += `\n\n[Showing lines ${start + 1}-${last} of ${lines.length}. Use offset to read more.]`;
    }
    return { content: body, summary: `${slice.length} lines` };
  },
});
