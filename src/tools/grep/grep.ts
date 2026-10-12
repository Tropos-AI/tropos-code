import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { PathResolutionError, resolveToolPath } from "../paths";
import { defineTool, type ToolOutput } from "../types";
import { assertContainedPattern, namesDir, walkFiles } from "../walk";

const DEFAULT_HEAD_LIMIT = 200;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const FALLBACK_TYPES: Record<string, string> = {
  ts: "**/*.{ts,tsx,mts,cts}",
  js: "**/*.{js,jsx,mjs,cjs}",
  py: "**/*.py",
  go: "**/*.go",
  rust: "**/*.rs",
  md: "**/*.md",
  json: "**/*.json",
  css: "**/*.css",
  html: "**/*.html",
};

const schema = z.object({
  pattern: z.string().min(1).describe("Regular expression (ripgrep syntax)."),
  path: z.string().optional().describe("File or directory to search (default: the working directory)."),
  glob: z.string().optional().describe('Only search files matching this glob, e.g. "*.ts".'),
  type: z.string().optional().describe('Only search files of this type, e.g. "ts", "py".'),
  output_mode: z.enum(["files_with_matches", "content", "count"]).optional().describe("Default files_with_matches."),
  case_insensitive: z.boolean().optional(),
  context: z.number().int().min(0).max(20).optional().describe("Lines of context around each match (content mode)."),
  head_limit: z.number().int().min(1).optional().describe(`Maximum output lines (default ${DEFAULT_HEAD_LIMIT}).`),
});
type GrepInput = z.infer<typeof schema>;

function finish(lines: string[], limit: number): ToolOutput {
  if (lines.length === 0) return { content: "No matches found.", summary: "0 matches" };
  const shown = lines.slice(0, limit);
  const more = lines.length - shown.length;
  return {
    content: shown.join("\n") + (more > 0 ? `\n[${more} more lines not shown; narrow the search or raise head_limit]` : ""),
    summary: `${lines.length} result${lines.length === 1 ? "" : "s"}`,
  };
}

interface RgText {
  text?: string;
  bytes?: string;
}

interface RgEvent {
  type: string;
  data?: { path?: RgText; lines?: RgText; line_number?: number | null };
}

/** Decodes a ripgrep JSON text-or-bytes field (bytes are base64 for non-UTF-8 data). */
function rgField(field: RgText | undefined): string {
  if (!field) return "";
  return field.text ?? Buffer.from(field.bytes ?? "", "base64").toString("utf8");
}

/**
 * Paths from `rg --null -l` output. NUL cannot occur in a path, so records are unambiguous;
 * denied paths are dropped.
 */
function ripgrepFiles(out: string, isDenied?: (path: string) => boolean): string[] {
  return out.split("\0").filter(Boolean).filter((file) => !isDenied?.(file));
}

/**
 * Output lines from `rg --json` content or count events. Each file's path comes from its own
 * JSON field, so a newline in a directory name cannot split a record. A file is checked
 * against isDenied before any of its lines are emitted.
 */
function ripgrepJsonLines(
  out: string,
  mode: "content" | "count",
  context: number,
  isDenied?: (path: string) => boolean,
): string[] {
  const deniedCache = new Map<string, boolean>();
  const denied = (file: string): boolean => {
    let hit = deniedCache.get(file);
    if (hit === undefined) {
      hit = isDenied?.(file) ?? false;
      deniedCache.set(file, hit);
    }
    return hit;
  };
  const lines: string[] = [];
  const counts = new Map<string, number>();
  let last: { file: string; line: number } | null = null;
  for (const raw of out.split("\n")) {
    if (raw === "") continue;
    const event = JSON.parse(raw) as RgEvent;
    if ((event.type !== "match" && event.type !== "context") || !event.data) continue;
    const file = rgField(event.data.path);
    if (denied(file)) continue;
    if (mode === "count") {
      if (event.type === "match") counts.set(file, (counts.get(file) ?? 0) + 1);
      continue;
    }
    const number = event.data.line_number ?? 0;
    const text = rgField(event.data.lines).replace(/\n$/, "");
    if (context > 0 && last && (last.file !== file || number > last.line + 1)) lines.push("--");
    lines.push(event.type === "match" ? `${file}:${number}:${text}` : `${file}-${number}-${text}`);
    last = { file, line: number };
  }
  for (const [file, n] of counts) lines.push(`${file}:${n}`);
  return lines;
}

async function runRipgrep(
  rgPath: string,
  base: string,
  input: GrepInput,
  signal: AbortSignal,
  isDenied?: (path: string) => boolean,
): Promise<ToolOutput> {
  const mode = input.output_mode ?? "files_with_matches";
  // --no-config keeps a RIPGREP_CONFIG_PATH from adding -L, --hidden or other search flags.
  const args = ["--no-config"];
  if (mode === "files_with_matches") {
    args.push("--color", "never", "--no-heading", "--with-filename", "--null", "--sort", "path", "--files-with-matches");
  } else {
    // Parsed as JSON events so paths and lines are never split on separator characters.
    args.push("--json", "--sort", "path");
    if (mode === "content" && input.context) args.push("--context", String(input.context));
  }
  if (input.case_insensitive) args.push("--ignore-case");
  // rg only skips node_modules via .gitignore; skip it and .git everywhere unless the search names them.
  const scope = `${input.path ?? ""} ${input.glob ?? ""}`;
  if (!namesDir(scope, "node_modules")) args.push("--glob", "!**/node_modules/**");
  if (!namesDir(scope, ".git")) args.push("--glob", "!**/.git/**");
  if (input.glob) args.push("--glob", input.glob);
  if (input.type) args.push("--type", input.type);
  args.push("--", input.pattern, base);

  const child = spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"], signal });
  let out = "";
  let err = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
  child.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
  const code = await new Promise<number>((resolve) => {
    child.once("error", () => resolve(2));
    child.once("close", (c) => resolve(c ?? 2));
  });
  if (code === 2) return { content: `ripgrep failed: ${err.trim() || "unknown error"}`, isError: true };
  const limit = input.head_limit ?? DEFAULT_HEAD_LIMIT;
  if (mode === "files_with_matches") return finish(ripgrepFiles(out, isDenied), limit);
  try {
    return finish(ripgrepJsonLines(out, mode, input.context ?? 0, isDenied), limit);
  } catch {
    return { content: "ripgrep returned output that could not be parsed", isError: true };
  }
}

async function runFallback(
  base: string,
  input: GrepInput,
  isDenied?: (path: string) => boolean,
): Promise<ToolOutput> {
  let regex: RegExp;
  try {
    regex = new RegExp(input.pattern, input.case_insensitive ? "i" : "");
  } catch (e) {
    return { content: `Invalid regular expression: ${(e as Error).message}`, isError: true };
  }
  if (input.type !== undefined && !Object.hasOwn(FALLBACK_TYPES, input.type)) {
    return { content: `unknown file type "${input.type}"`, isError: true };
  }
  const mode = input.output_mode ?? "files_with_matches";
  const ctxLines = input.context ?? 0;
  const info = await stat(base).catch(() => null);
  if (!info) return { content: `Path not found: ${base}`, isError: true };

  let files: string[];
  if (info.isFile()) {
    files = isDenied?.(base) ? [] : [base];
  } else {
    const pattern = input.glob
      ? input.glob.includes("/") ? input.glob : `**/${input.glob}`
      : input.type !== undefined ? FALLBACK_TYPES[input.type] : "**/*";
    files = [];
    for await (const rel of walkFiles(base, pattern, { isDenied })) files.push(join(base, rel));
    files.sort();
  }

  const lines: string[] = [];
  for (const file of files) {
    const buffer = await readFile(file).catch(() => null);
    if (!buffer || buffer.length > MAX_FILE_BYTES || buffer.subarray(0, 8192).includes(0)) continue;
    const fileLines = buffer.toString("utf8").split(/\r?\n/);
    const hits = fileLines.flatMap((line, i) => (regex.test(line) ? [i] : []));
    if (hits.length === 0) continue;
    if (mode === "files_with_matches") lines.push(file);
    else if (mode === "count") lines.push(`${file}:${hits.length}`);
    else {
      const emitted = new Set<number>();
      for (const hit of hits) {
        for (let i = Math.max(0, hit - ctxLines); i <= Math.min(fileLines.length - 1, hit + ctxLines); i++) {
          if (emitted.has(i)) continue;
          emitted.add(i);
          lines.push(`${file}${hits.includes(i) ? ":" : "-"}${i + 1}${hits.includes(i) ? ":" : "-"}${fileLines[i]}`);
        }
      }
    }
  }
  return finish(lines, input.head_limit ?? DEFAULT_HEAD_LIMIT);
}

export function createGrepTool(opts: { rgPath: string | null }) {
  return defineTool({
    name: "Grep",
    kind: "read",
    description:
      "Search file contents with a regular expression (ripgrep syntax). output_mode files_with_matches (default) lists matching files; " +
      "content shows matching lines as path:line:text, with optional surrounding context; count shows matches per file. " +
      'Narrow the search with glob (e.g. "*.ts") or type (e.g. "ts", "py").',
    schema,
    summarize: (input) => (input.path ? `${input.pattern} in ${input.path}` : input.pattern),
    subject: (input, cwd) => ({ paths: [resolveToolPath(input.path ?? ".", cwd)] }),
    async run(input, ctx) {
      if (input.glob) {
        const globError = assertContainedPattern(input.glob);
        if (globError) return { content: globError, isError: true };
      }
      let base: string;
      try {
        base = resolveToolPath(input.path ?? ".", ctx.cwd());
      } catch (error) {
        if (error instanceof PathResolutionError) {
          return { content: `Cannot search ${input.path}: ${error.message}`, isError: true };
        }
        throw error;
      }
      return opts.rgPath
        ? runRipgrep(opts.rgPath, base, input, ctx.signal, ctx.isDenied)
        : runFallback(base, input, ctx.isDenied);
    },
  });
}
