import { stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { PathResolutionError, resolveToolPath } from "../paths";
import { defineTool } from "../types";
import { assertContainedPattern, walkFiles } from "../walk";

const MAX_RESULTS = 100;
const MAX_SCANNED = 20_000;

const schema = z.object({
  pattern: z.string().min(1).describe('Glob pattern, e.g. "src/**/*.ts".'),
  path: z.string().optional().describe("Directory to search in (default: the working directory)."),
});

export const globTool = defineTool({
  name: "Glob",
  kind: "read",
  description:
    'Find files by glob pattern such as "**/*.test.ts". Returns absolute paths, most recently modified first, ' +
    "at most 100. node_modules and .git are skipped unless the pattern names them.",
  schema,
  summarize: (input) => (input.path ? `${input.pattern} in ${input.path}` : input.pattern),
  subject: (input, cwd) => ({ paths: [resolveToolPath(input.path ?? ".", cwd)] }),
  async run(input, ctx) {
    const patternError = assertContainedPattern(input.pattern);
    if (patternError) return { content: patternError, isError: true };
    let base: string;
    try {
      base = resolveToolPath(input.path ?? ".", ctx.cwd());
    } catch (error) {
      if (error instanceof PathResolutionError) {
        return { content: `Cannot search ${input.path}: ${error.message}`, isError: true };
      }
      throw error;
    }
    const info = await stat(base).catch(() => null);
    if (!info?.isDirectory()) return { content: `Not a directory: ${base}`, isError: true };

    const found: Array<{ path: string; mtime: number }> = [];
    for await (const rel of walkFiles(base, input.pattern, { isDenied: ctx.isDenied })) {
      const path = join(base, rel);
      const s = await stat(path).catch(() => null);
      if (s) found.push({ path, mtime: s.mtimeMs });
      if (found.length >= MAX_SCANNED) break;
    }
    if (found.length === 0) return { content: "No files matched.", summary: "0 files" };
    found.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
    const shown = found.slice(0, MAX_RESULTS).map((f) => f.path);
    const more = found.length - shown.length;
    return {
      content: shown.join("\n") + (more > 0 ? `\n[${more} more files not shown; narrow the pattern]` : ""),
      summary: `${found.length} file${found.length === 1 ? "" : "s"}`,
    };
  },
});
