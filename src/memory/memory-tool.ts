// src/memory/memory-tool.ts
import { z } from "zod";
import { errorText } from "../error-text";
import { defineTool, type AnyTool, type ToolOutput } from "../tools/types";
import { ENTRY_SEPARATOR, MEMORY_LIMITS, notesLabel, notesSize, usageHeader, type NotesResult, type NotesStore, type NotesTarget } from "./notes";

const ACTION = z.enum(["add", "replace", "remove"]);

const schema = z.object({
  target: z
    .enum(["memory", "user", "lessons", "heartbeat"])
    .describe(
      '"memory" for your own notes (project facts, conventions); "user" for facts about the user (preferences, role, habits); ' +
        '"lessons" for how to work with this user that you learned the hard way (a correction, an approach that failed and the one that worked), one line each; kept in your workspace AGENTS.md.' +
        ' "heartbeat" for what the owner wants checked in the background (a job, a deploy, a deadline), one line each; kept in your workspace AGENTS.md.',
    ),
  action: ACTION.optional().describe("A single change. Omit it when you pass operations."),
  content: z.string().optional().describe("The entry text for add and replace."),
  old_text: z.string().optional().describe("For replace and remove: a substring that occurs in exactly one existing entry."),
  operations: z
    .array(
      z.object({
        action: ACTION,
        content: z.string().optional(),
        old_text: z.string().optional(),
      }),
    )
    .min(1)
    .max(50)
    .optional()
    .describe("Several changes to one target, applied together or not at all; the size limit is checked on the result. action, content and old_text are then ignored."),
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

type Action = z.infer<typeof ACTION>;

const PAST: Record<Action, string> = { add: "Added to", replace: "Replaced in", remove: "Removed from" };

function report(input: Input, result: NotesResult): ToolOutput {
  if (!result.ok) {
    return { content: `${result.error}\n\n${listing(input.target, result.entries)}`, isError: true, summary: "not saved" };
  }
  const label = notesLabel(input.target);
  if (input.operations) {
    const n = input.operations.length;
    const line = `Applied ${n} change${n === 1 ? "" : "s"} to ${label}`;
    return {
      content: `${line}\n\n${listing(input.target, result.entries)}`,
      display: { kind: "text", text: line },
      summary: `${n} change${n === 1 ? "" : "s"} to ${label}`,
    };
  }
  const action = input.action!;
  const what = action === "remove" ? (input.old_text ?? "") : (input.content ?? "");
  const line = `${PAST[action]} ${label}: ${what.trim()}`;
  return {
    content: `${line}\n\n${listing(input.target, result.entries)}`,
    display: { kind: "text", text: line },
    summary: `${PAST[action].toLowerCase()} ${label}`,
  };
}

function summarize(input: Input): string {
  if (input.operations) return `batch ${input.target}: ${input.operations.length} change${input.operations.length === 1 ? "" : "s"}`;
  const action = input.action ?? "change";
  return `${action} ${input.target}: ${clip(action === "remove" ? (input.old_text ?? "") : (input.content ?? ""))}`;
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
      `communication style, up to ${MEMORY_LIMITS.user.toLocaleString("en-US")} chars); ` +
      `target "lessons" holds how to work with this user (up to ${MEMORY_LIMITS.lessons.toLocaleString("en-US")} chars); ` +
      `target "heartbeat" holds what to check in the background (up to ${MEMORY_LIMITS.heartbeat.toLocaleString("en-US")} chars). ` +
      'Write entries as declarative facts, not commands: "User prefers concise answers" (good), not "Always answer concisely". ' +
      "Save only what will still matter next week; never save secrets, task progress, one-off errors or things the code already says. " +
      "How to do a recurring task is a procedure: put it in a skill (SkillManage), not here. " +
      "Keep entries short. add needs content; replace needs old_text and content; remove needs old_text, where old_text " +
      "is a substring of exactly one entry. To make several changes at once, pass operations (a list of {action, content, old_text}) " +
      "instead of action: they apply together or not at all. A write over the limit fails and shows the current entries: " +
      "then consolidate in one call with operations (remove or merge entries and add the merged one).",
    schema,
    summarize,
    subject: (input) => ({ paths: [store.path(input.target)] }),
    async run(input, ctx) {
      if (!store.allows(input.target)) {
        return { content: 'This agent keeps only its own notes (target "memory").', isError: true };
      }
      const actor = ctx.actor;
      if (!input.operations) {
        if (!input.action) return { content: "Give either action or operations.", isError: true };
        const missing = input.action === "add" ? ["content"] : input.action === "replace" ? ["old_text", "content"] : ["old_text"];
        const absent = missing.filter((k) => input[k as "content" | "old_text"] === undefined);
        if (absent.length > 0) {
          return { content: `${input.action} needs ${absent.join(" and ")}.`, isError: true };
        }
      }
      try {
        const result = input.operations
          ? await store.batch(input.target, input.operations, actor)
          : input.action === "add"
            ? await store.add(input.target, input.content!, actor)
            : input.action === "replace"
              ? await store.replace(input.target, input.old_text!, input.content!, actor)
              : await store.remove(input.target, input.old_text!, actor);
        return report(input, result);
      } catch (error) {
        return { content: `Could not update the ${notesLabel(input.target)}: ${errorText(error)}`, isError: true };
      }
    },
  }) as AnyTool;
}
