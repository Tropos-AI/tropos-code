// src/tools/write/write.ts
import { dirname } from "node:path";
import { z } from "zod";
import { makeDiff } from "../diff";
import { cannotWrite, checkFreshness, makeParentDirs, openVerified, replaceContents, holdSandbox, staleText } from "../file-guard";
import { PathResolutionError, resolveToolPath } from "../paths";
import { defineTool, type ToolContext, type ToolOutput } from "../types";

const schema = z.object({
  file_path: z.string().min(1).describe("Path to the file, absolute or relative to the working directory."),
  content: z.string().describe("The complete new contents of the file."),
});

export const writeTool = defineTool({
  name: "Write",
  kind: "edit",
  description:
    "Create a file, or replace the entire contents of an existing one. To change part of a file, use Edit. " +
    "An existing file must have been read in this session, and must not have changed since.",
  schema,
  summarize: (input) => input.file_path,
  subject: (input, cwd) => ({ paths: [resolveToolPath(input.file_path, cwd)] }),
  async run(input, ctx) {
    let path: string;
    try {
      path = resolveToolPath(input.file_path, ctx.cwd());
    } catch (error) {
      if (error instanceof PathResolutionError) return cannotWrite(input.file_path, error);
      throw error;
    }
    if (ctx.approvedPaths !== undefined && !ctx.approvedPaths.includes(path)) {
      return { content: `${path} changed after it was approved; nothing was written. Try again.`, isError: true };
    }
    const held = await holdSandbox(ctx);
    if ("content" in held) return held;
    try {
      return await writeAt(path, input, ctx);
    } finally {
      held.release();
    }
  },
});

/** Write, once the sandbox is held. */
async function writeAt(path: string, input: z.infer<typeof schema>, ctx: ToolContext): Promise<ToolOutput> {
  let output: ToolOutput;
  try {
    const fresh = await checkFreshness(path, ctx);
    if (!fresh.ok) return { content: fresh.error, isError: true };
    await makeParentDirs(dirname(path));
    const { handle, info } = await openVerified(path, fresh.missing ? "create" : "update", { project: ctx.allowedDirs });
    let before = "";
    try {
      // The file opened must still be the one that was read.
      if (!fresh.missing && info.mtimeMs !== fresh.mtimeMs) return { content: staleText(path), isError: true };
      if (!fresh.missing) before = await handle.readFile("utf8");
      await replaceContents(handle, input.content);
      ctx.readState.record(path, (await handle.stat()).mtimeMs);
    } finally {
      await handle.close();
    }
    const diff = makeDiff(path, before, input.content);
    const lineCount = input.content.split("\n").length - (input.content.endsWith("\n") ? 1 : 0);
    output = fresh.missing
      ? { content: `Created ${path} (${lineCount} lines).`, display: diff, summary: `created, ${lineCount} lines` }
      : { content: `Overwrote ${path}.`, display: diff, summary: `+${diff.added} −${diff.removed}` };
  } catch (error) {
    return cannotWrite(path, error);
  }
  return output;
}
