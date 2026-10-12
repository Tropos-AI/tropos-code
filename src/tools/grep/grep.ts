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

/**
 * Turns `--null` ripgrep output back into the usual `path:line:text` lines, dropping
 * every record whose file is denied. Records are NUL-terminated after the path, so the
 * path is unambiguous even when it contains colons.
 */
function ripgrepLines(out: string, mode: string, isDenied?: (path: string) => boolean): string[] {
  if (mode === "files_with_matches") {
    return out.split("\0").filter(Boolean).filter((file) => !isDenied?.(file));
  }
  return out.split("\n").filter(Boolean).flatMap((line) => {
    const nul = line.indexOf("\0");
    if (nul < 0) return [line]; // group separator between context blocks
    const file = line.slice(0, nul);
    if (isDenied?.(file)) return [];
    const rest = line.slice(nul + 1);
    // Context lines are "N-text"; matches and counts are "N:text" or "N".
    return [`${file}${/^\d+-/.test(rest) ? "-" : ":"}${rest}`];
  });
}

async function runRipgrep(
  rgPath: string,
  base: string,
  input: GrepInput,
  signal: AbortSignal,
  isDenied?: (path: string) => boolean,
): Promise<ToolOutput> {
  const mode = input.output_mode ?? "files_with_matches";
  const args = ["--color", "never", "--no-heading", "--with-filename", "--null", "--sort", "path"];
  if (mode === "files_with_matches") args.push("--files-with-matches");
  if (mode === "count") args.push("--count");
  if (mode === "content") {
    args.push("--line-number");
    if (input.context) args.push("--context", String(input.context));
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
  return finish(ripgrepLines(out, mode, isDenied), input.head_limit ?? DEFAULT_HEAD_LIMIT);
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
