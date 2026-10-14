// src/memory/memory-tool.ts
import { z } from "zod";
import { errorText } from "../error-text";
import { defineTool, type AnyTool, type ToolOutput } from "../tools/types";
import { ENTRY_SEPARATOR, MEMORY_LIMITS, notesLabel, notesSize, usageHeader, type NotesResult, type NotesStore, type NotesTarget } from "./notes";

const schema = z.object({
  target: z
    .enum(["memory", "user"])
    .describe('"memory" for your own notes (project facts, conventions, lessons learned); "user" for facts about the user (preferences, role, habits).'),
  action: z.enum(["add", "replace", "remove"]),
  content: z.string().optional().describe("The entry text for add and replace."),
  old_text: z.string().optional().describe("For replace and remove: a substring that occurs in exactly one existing entry."),
});

type Input = z.infer<typeof schema>;

const SUMMARY_CHARS = 60;

function clip(text: string, max = SUMMARY_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function listing(target: NotesTarget, entries: string[]): string {
  const header = usageHeader(notesSize(entries), MEMORY_LIMITS[target]);
  if (entries.length === 0) return `Current ${notesLabel(target)} ${header}: (empty)`;
  return `Current ${notesLabel(target)} ${header}:\n${entries.join(ENTRY_SEPARATOR)}`;
}

const PAST: Record<Input["action"], string> = { add: "Added to", replace: "Replaced in", remove: "Removed from" };

function report(input: Input, result: NotesResult): ToolOutput {
  if (!result.ok) {
    return { content: `${result.error}\n\n${listing(input.target, result.entries)}`, isError: true, summary: "not saved" };
  }
  const label = notesLabel(input.target);
  const what = input.action === "remove" ? (input.old_text ?? "") : (input.content ?? "");
  const line = `${PAST[input.action]} ${label}: ${what.trim()}`;
  return {
    content: `${line}\n\n${listing(input.target, result.entries)}`,
    display: { kind: "text", text: line },
    summary: `${PAST[input.action].toLowerCase()} ${label}`,
  };
}

/**
 * Memory: small, budgeted notes that persist across sessions. Kind "edit" on files outside the project,
 * so every write asks: a page or file the model read could otherwise plant instructions that ride
 * along into every later session. Changes reach the model in the next session's context.
 */
export function createMemoryTool(store: NotesStore): AnyTool {
  return defineTool({
    name: "Memory",
    kind: "edit",
    description:
      "Save durable facts for future sessions. Notes are loaded into the context of every new session (not this one). " +
      'target "memory" holds your notes (project conventions, environment quirks, lessons learned, ' +
      `up to ${MEMORY_LIMITS.memory.toLocaleString("en-US")} chars); target "user" holds the user profile (preferences, role, ` +
      `communication style, up to ${MEMORY_LIMITS.user.toLocaleString("en-US")} chars). ` +
      "Save only what will still matter next week; never save secrets, task progress or things the code already says. " +
      "Keep entries short. add needs content; replace needs old_text and content; remove needs old_text, where old_text " +
      "is a substring of exactly one entry. A write over the limit fails and shows the current entries: merge or remove some, then retry.",
    schema,
    summarize: (input) => `${input.action} ${input.target}: ${clip(input.action === "remove" ? (input.old_text ?? "") : (input.content ?? ""))}`,
    subject: (input) => ({ paths: [store.path(input.target)] }),
    async run(input) {
      const missing = input.action === "add" ? ["content"] : input.action === "replace" ? ["old_text", "content"] : ["old_text"];
      const absent = missing.filter((k) => input[k as "content" | "old_text"] === undefined);
      if (absent.length > 0) {
        return { content: `${input.action} needs ${absent.join(" and ")}.`, isError: true };
      }
      try {
        const result =
          input.action === "add"
            ? await store.add(input.target, input.content!)
            : input.action === "replace"
              ? await store.replace(input.target, input.old_text!, input.content!)
              : await store.remove(input.target, input.old_text!);
        return report(input, result);
      } catch (error) {
        return { content: `Could not update the ${notesLabel(input.target)}: ${errorText(error)}`, isError: true };
      }
    },
  }) as AnyTool;
}
