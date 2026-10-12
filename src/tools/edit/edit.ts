// src/tools/edit/edit.ts
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { makeDiff } from "../diff";
import { cannotWrite, checkFreshness, writeFileNoFollow } from "../file-guard";
import { PathResolutionError, resolveToolPath } from "../paths";
import { defineTool, type ToolOutput } from "../types";

const schema = z.object({
  file_path: z.string().min(1).describe("Path to the file, absolute or relative to the working directory."),
  old_string: z.string().describe("Exact text to replace. Use an empty string to create a new file."),
  new_string: z.string().describe("Replacement text."),
  replace_all: z.boolean().optional().describe("Replace every occurrence instead of requiring a unique match."),
});

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) count++;
  return count;
}

export const editTool = defineTool({
  name: "Edit",
  kind: "edit",
  description:
    "Replace an exact piece of text in a file. old_string must match the file character for character, " +
    "including indentation, and must occur exactly once unless replace_all is true. Read the file first. " +
    "Leave out the line-number prefix that Read adds. With an empty old_string, creates a file that doesn't exist yet.",
  schema,
  summarize: (input) => input.file_path,
  subject: (input, cwd) => ({ paths: [resolveToolPath(input.file_path, cwd)] }),
  async run(input, ctx) {
    if (input.old_string === input.new_string) {
      return { content: "old_string and new_string are identical, so there is nothing to change.", isError: true };
    }
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
    let output: ToolOutput;
    try {
      const fresh = await checkFreshness(path, ctx);
      if (!fresh.ok) return { content: fresh.error, isError: true };

      if (fresh.missing) {
        if (input.old_string !== "") return { content: `File not found: ${path}`, isError: true };
        await mkdir(dirname(path), { recursive: true });
        await writeFileNoFollow(path, input.new_string);
        ctx.readState.record(path, (await stat(path)).mtimeMs);
        return { content: `Created ${path}.`, display: makeDiff(path, "", input.new_string), summary: "created" };
      }
      if (input.old_string === "") {
        return { content: `${path} already exists; give the text to replace in old_string.`, isError: true };
      }

      const original = await readFile(path, "utf8");
      const crlf = original.includes("\r\n");
      const toFile = (s: string) => (crlf ? s.replace(/\r?\n/g, "\r\n") : s);
      const oldText = toFile(input.old_string);
      const newText = toFile(input.new_string);

      const count = countOccurrences(original, oldText);
      if (count === 0) {
        return {
          content: `old_string was not found in ${path}. Read the file again and copy the text exactly, including whitespace.`,
          isError: true,
        };
      }
      if (count > 1 && !input.replace_all) {
        return {
          content: `old_string appears ${count} times in ${path}. Include more surrounding lines to make it unique, or set replace_all to true.`,
          isError: true,
        };
      }

      // split/join and slicing insert newText literally; String.replace would expand $&, $1, $$.
      let updated: string;
      if (input.replace_all) {
        updated = original.split(oldText).join(newText);
      } else {
        const at = original.indexOf(oldText);
        updated = original.slice(0, at) + newText + original.slice(at + oldText.length);
      }
      await writeFileNoFollow(path, updated);
      ctx.readState.record(path, (await stat(path)).mtimeMs);
      const diff = makeDiff(path, original.replace(/\r\n/g, "\n"), updated.replace(/\r\n/g, "\n"));
      const replaced = input.replace_all ? count : 1;
      output = {
        content: `Edited ${path} (${replaced} replacement${replaced === 1 ? "" : "s"}).`,
        display: diff,
        summary: `+${diff.added} −${diff.removed}`,
      };
    } catch (error) {
      return cannotWrite(path, error);
    }
    return output;
  },
});
